/**
 * PI-10 per-category retention policies.
 *
 * Separate lifetimes for run metadata, tool-call metadata, source rows, raw
 * fetched-content refs, model request/response artifact refs, and image/asset
 * rows. Null/absent fields keep that category forever. Deletes are ordered so
 * child rows are purged before run metadata (which cascades whatever remains);
 * PI-8 import records are marked stale before any run is deleted.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/27
 */
import { z } from 'zod';
import { getDb } from '../db/connection';
import {
  clearPiSourceArtifactRefsOlderThan,
  clearPiToolCallArtifactRefsOlderThan,
  deletePiAssetsOlderThan,
  deletePiSourcesOlderThan,
  deletePiToolCallsOlderThan,
  getPiRetentionPolicyRow,
  upsertPiRetentionPolicyRow,
} from '../db/repositories/pi-ops-repo';
import { deletePiRunsOlderThan } from '../db/repositories/product-intelligence-repo';

export const PiRetentionPolicySchema = z.object({
  metadataDays: z.number().int().positive().nullish(),
  toolCallsDays: z.number().int().positive().nullish(),
  sourcesDays: z.number().int().positive().nullish(),
  rawContentDays: z.number().int().positive().nullish(),
  modelArtifactsDays: z.number().int().positive().nullish(),
  imagesDays: z.number().int().positive().nullish(),
});
export type PiRetentionPolicy = z.infer<typeof PiRetentionPolicySchema>;

/** The workspace retention policy (defaults to keep-everything when unset). */
export function getPiRetentionPolicy(workspaceId: string): PiRetentionPolicy {
  const row = getPiRetentionPolicyRow(workspaceId);
  if (!row) return {};
  return PiRetentionPolicySchema.parse(JSON.parse(row.policyJson));
}

/** Persist the workspace retention policy; returns the validated policy. */
export function setPiRetentionPolicy(workspaceId: string, policy: PiRetentionPolicy): PiRetentionPolicy {
  const parsed = PiRetentionPolicySchema.parse(policy);
  upsertPiRetentionPolicyRow(workspaceId, JSON.stringify(parsed));
  return parsed;
}

export interface PiRetentionResult {
  toolCallsDeleted: number;
  sourcesDeleted: number;
  assetsDeleted: number;
  runsDeleted: number;
  toolArtifactRefsCleared: number;
  sourceArtifactRefsCleared: number;
}

/**
 * Apply the retention policy for a workspace. Per-category deletes run first
 * (tool calls, sources, assets, artifact-ref clearing) and run-metadata
 * cleanup last so its cascade removes only what the category policies did not
 * already purge. Returns per-category counts.
 */
export function applyPiRetention(workspaceId: string, policy: PiRetentionPolicy): PiRetentionResult {
  const DAY = 86_400_000;
  const cutoff = (days?: number | null): string | null =>
    days ? new Date(Date.now() - days * DAY).toISOString() : null;

  const toolCallsCutoff = cutoff(policy.toolCallsDays);
  const modelCutoff = cutoff(policy.modelArtifactsDays);
  const sourcesCutoff = cutoff(policy.sourcesDays);
  const rawCutoff = cutoff(policy.rawContentDays);
  const imagesCutoff = cutoff(policy.imagesDays);
  const metadataCutoff = cutoff(policy.metadataDays);

  // Single transaction: retention either fully applies or nothing does —
  // partial cleanup would leave per-category counts that lie (PI-10-NIT).
  return getDb().transaction((): PiRetentionResult => {
    const result: PiRetentionResult = {
      toolCallsDeleted: 0,
      sourcesDeleted: 0,
      assetsDeleted: 0,
      runsDeleted: 0,
      toolArtifactRefsCleared: 0,
      sourceArtifactRefsCleared: 0,
    };

    if (toolCallsCutoff) result.toolCallsDeleted = deletePiToolCallsOlderThan(workspaceId, toolCallsCutoff);
    if (modelCutoff) result.toolArtifactRefsCleared = clearPiToolCallArtifactRefsOlderThan(workspaceId, modelCutoff);
    if (sourcesCutoff) result.sourcesDeleted = deletePiSourcesOlderThan(workspaceId, sourcesCutoff);
    if (rawCutoff) result.sourceArtifactRefsCleared = clearPiSourceArtifactRefsOlderThan(workspaceId, rawCutoff);
    if (imagesCutoff) result.assetsDeleted = deletePiAssetsOlderThan(workspaceId, imagesCutoff);
    if (metadataCutoff) result.runsDeleted = deletePiRunsOlderThan(workspaceId, metadataCutoff);

    return result;
  })();
}

/**
 * Backward-compatible policy applying a single age to every category (the
 * legacy explicit-retention route shape).
 */
export function olderThanDaysPolicy(days: number): PiRetentionPolicy {
  return {
    metadataDays: days,
    toolCallsDays: days,
    sourcesDays: days,
    rawContentDays: days,
    modelArtifactsDays: days,
    imagesDays: days,
  };
}

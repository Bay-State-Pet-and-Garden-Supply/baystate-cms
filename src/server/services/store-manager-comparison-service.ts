/**
 * Store Manager run-comparison service (operations console, Issue 7).
 *
 * Comparison operates ONLY over compatible immutable normalized artifacts
 * (same kind + same schema version). Reports compare deterministic numeric/
 * scalar fields; action/verification diffs compare typed before/after fields.
 * Incompatible versions/kinds return a clear `comparable: false` result with a
 * bounded reason — never a model-generated judgment over raw payloads.
 */

import { getDb } from '../../db/connection';
import { getStoreManagerRunArtifacts } from '../../db/repositories/store-manager-session-repo';
import type { StoreManagerCompareResult } from '../../shared/schemas/store-manager-history';

export class StoreManagerComparisonError extends Error {
  readonly code: 'run_not_found' | 'no_comparable_artifact';
  constructor(code: StoreManagerComparisonError['code'], message: string) {
    super(message);
    this.name = 'StoreManagerComparisonError';
    this.code = code;
  }
}

const COMPARABLE_KINDS = ['report', 'audit', 'diff', 'verification_diff', 'outcome'] as const;
type ComparableKind = (typeof COMPARABLE_KINDS)[number];

function latestArtifactByKind(
  workspaceId: string,
  runId: string,
): { kind: ComparableKind; schemaVersion: number; content: unknown } | null {
  const artifacts = getStoreManagerRunArtifacts(workspaceId, runId, 200);
  for (let i = artifacts.length - 1; i >= 0; i -= 1) {
    const kind = artifacts[i].kind as string;
    if ((COMPARABLE_KINDS as readonly string[]).includes(kind)) {
      let content: unknown = null;
      try {
        content = JSON.parse(artifacts[i].content_json);
      } catch {
        content = null;
      }
      return { kind: kind as ComparableKind, schemaVersion: artifacts[i].schema_version, content };
    }
  }
  return null;
}

/** Deterministic scalar delta over normalized artifact content. */
function scalarDelta(
  kind: ComparableKind,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Array<{ field: string; before: string | number | null; after: string | number | null }> {
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  const delta: Array<{ field: string; before: string | number | null; after: string | number | null }> = [];
  for (const field of fields) {
    const before = a[field];
    const after = b[field];
    if (typeof before === 'number' || typeof after === 'number') {
      const bv = typeof before === 'number' ? before : Number(before);
      const av = typeof after === 'number' ? after : Number(after);
      if (Number.isFinite(bv) || Number.isFinite(av)) {
        if (bv !== av) delta.push({ field, before: Number.isFinite(bv) ? bv : null, after: Number.isFinite(av) ? av : null });
      }
      continue;
    }
    if (typeof before === 'string' || typeof after === 'string') {
      const bs = typeof before === 'string' ? before : null;
      const as = typeof after === 'string' ? after : null;
      if (bs !== as) delta.push({ field, before: bs, after: as });
    }
  }
  // Kind-specific normalized fields (action/verification diffs).
  if (kind === 'diff' || kind === 'verification_diff') {
    const aSkuCount = numeric(a.skuCount ?? a.affectedSkuCount ?? a.verifiedSkuCount);
    const bSkuCount = numeric(b.skuCount ?? b.affectedSkuCount ?? b.verifiedSkuCount);
    if (aSkuCount !== bSkuCount) {
      delta.push({ field: 'skuCount', before: aSkuCount, after: bSkuCount });
    }
    const aState = stringValue(a.changeSetState ?? a.state);
    const bState = stringValue(b.changeSetState ?? b.state);
    if (aState !== bState) delta.push({ field: 'changeSetState', before: aState, after: bState });
  }
  return delta.slice(0, 200);
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, 1000);
}

/**
 * Compare two workspace-scoped runs. Both runs must exist in the workspace and
 * carry a comparable immutable artifact (same kind + schema version); the
 * newest such artifact of each run is used. Foreign/unknown runs throw
 * `StoreManagerComparisonError('run_not_found')` (indistinguishable outcome).
 */
export function compareStoreManagerRuns(
  workspaceId: string,
  runIdA: string,
  runIdB: string,
): StoreManagerCompareResult {
  if (runIdA === runIdB) {
    return { comparable: false, runIdA, runIdB, kind: null, delta: null, reason: 'A run cannot be compared to itself.' };
  }
  const db = getDb();
  const existsA = db.query('SELECT id FROM store_manager_sessions WHERE workspace_id = ? AND id = ?').get(workspaceId, runIdA);
  const existsB = db.query('SELECT id FROM store_manager_sessions WHERE workspace_id = ? AND id = ?').get(workspaceId, runIdB);
  if (!existsA || !existsB) {
    throw new StoreManagerComparisonError('run_not_found', 'One or both runs were not found in this workspace.');
  }
  const artifactA = latestArtifactByKind(workspaceId, runIdA);
  const artifactB = latestArtifactByKind(workspaceId, runIdB);
  if (!artifactA || !artifactB) {
    return {
      comparable: false,
      runIdA,
      runIdB,
      kind: null,
      delta: null,
      reason: 'Neither run has a comparable normalized artifact.',
    };
  }
  if (artifactA.kind !== artifactB.kind) {
    return {
      comparable: false,
      runIdA,
      runIdB,
      kind: null,
      delta: null,
      reason: `Run A exposes a ${artifactA.kind} artifact while run B exposes ${artifactB.kind}; kinds are not comparable without a reviewed transform.`,
    };
  }
  if (artifactA.schemaVersion !== artifactB.schemaVersion) {
    return {
      comparable: false,
      runIdA,
      runIdB,
      kind: artifactA.kind,
      delta: null,
      reason: `Artifact schema versions differ (${artifactA.schemaVersion} vs ${artifactB.schemaVersion}); not comparable without a reviewed deterministic migration.`,
    };
  }
  const contentA = (artifactA.content ?? {}) as Record<string, unknown>;
  const contentB = (artifactB.content ?? {}) as Record<string, unknown>;
  const delta = scalarDelta(artifactA.kind, contentA, contentB);
  return { comparable: true, runIdA, runIdB, kind: artifactA.kind, delta, reason: null };
}

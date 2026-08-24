/**
 * bay-state-v4 Shadow Observer (P4 — plan section B.P4.4).
 *
 * Mirrors the established cohort-shadow discipline (ADR 0013 PR4 precedent):
 * observe-only, writes nothing to proposals/decisions/cohort state. When
 * `BAYSTATE_CMS_TAXONOMY_V4_SHADOW` is enabled AND the workspace pin is NOT
 * `bay-state-v4`, the pin-aware loader compiles the V4 release in parallel,
 * builds a deterministic CONFIG-LEVEL diff summary (taxonomy payload of the
 * pinned arm vs the V4 release) and appends it to a run-scoped JSONL log under
 * `<workspace>/store/classification/shadow/v4-shadow.jsonl`.
 *
 * Scope honesty (plan B.P4.4): full PROPOSAL-level divergence measurement is
 * an operational rollout step (runbook: flip a scratch workspace, review
 * divergence reports). This observer makes the config-level delta visible on
 * every load without changing any runtime behavior — the returned authority is
 * never altered, and observer failures are swallowed (never break loads).
 *
 * Change-deduped like PR4 C5: a line is appended only when the summary digest
 * changes, so steady-state traffic stays quiet while real drift surfaces.
 */

import fs from 'node:fs';
import path from 'node:path';
import { hashCanonicalJson } from '../shared/stable-id';
import type { TaxonomyReleaseBundleV4 } from './release-validation';
import { V4_TAXONOMY_REVISION } from './release-compiler';

/** Env gate. Default OFF; truthy values: '1', 'true', 'on' (case-insensitive). */
export function isTaxonomyV4ShadowEnabled(): boolean {
  const raw = process.env.BAYSTATE_CMS_TAXONOMY_V4_SHADOW;
  if (raw === undefined || raw === '') return false;
  return ['1', 'true', 'on'].includes(raw.trim().toLowerCase());
}

/** Minimal structural view of whichever arm currently serves the runtime. */
export interface ShadowActiveArmView {
  productTypeIds: string[];
  attributeIds: string[];
  mappings: Array<{ attributeId: string; catalogField: string }>;
}

export interface V4ShadowDiffSummary {
  observedAt: string;
  pinnedRevision: string | null;
  shadowRevision: typeof V4_TAXONOMY_REVISION;
  counts: {
    activeProductTypes: number;
    v4ProductTypes: number;
    activeAttributes: number;
    v4Attributes: number;
    activeMappings: number;
    v4Mappings: number;
  };
  productTypesAddedToV4: string[];
  productTypesRemovedInV4: string[];
  attributesAddedToV4: string[];
  attributesRemovedInV4: string[];
  mappingChanges: Array<{ attributeId: string; from: string | null; to: string }>;
  pageProjectionRoles: Record<string, number>;
}

/**
 * Pure, deterministic diff between the active (pinned) taxonomy payload and
 * the compiled-from-release V4 payload. Sorted id sets + canonical hashing —
 * identical inputs always produce an identical summary.
 */
export function buildV4ShadowDiffSummary(
  active: ShadowActiveArmView,
  v4Bundle: TaxonomyReleaseBundleV4,
  pinnedRevision: string | null,
  observedAt: string,
): V4ShadowDiffSummary {
  const v4Classifiable = new Set(v4Bundle.hierarchy.filter(node => node.classifiable).map(node => node.id));
  const v4AttributeIds = [...new Set(v4Bundle.attributes.map(attribute => attribute.id))].sort();
  const v4MappingByAttribute = new Map(
    v4Bundle.exportMappings.map(mapping => [mapping.attributeId, mapping.catalogField]),
  );

  const activeTypeSet = new Set(active.productTypeIds);
  const activeAttrSet = new Set(active.attributeIds);
  const v4AttributeIdSet = new Set(v4AttributeIds);
  const activeMappingByAttribute = new Map(active.mappings.map(m => [m.attributeId, m.catalogField]));

  const mappingChanges: V4ShadowDiffSummary['mappingChanges'] = [];
  for (const attributeId of [...v4MappingByAttribute.keys()].sort()) {
    const to = v4MappingByAttribute.get(attributeId)!;
    const from = activeMappingByAttribute.get(attributeId) ?? null;
    if (from !== to) mappingChanges.push({ attributeId, from, to });
  }

  const pageProjectionRoles: Record<string, number> = {};
  for (const page of v4Bundle.pageProjections) {
    pageProjectionRoles[page.role] = (pageProjectionRoles[page.role] ?? 0) + 1;
  }

  return {
    observedAt,
    pinnedRevision,
    shadowRevision: V4_TAXONOMY_REVISION,
    counts: {
      activeProductTypes: active.productTypeIds.length,
      v4ProductTypes: v4Classifiable.size,
      activeAttributes: active.attributeIds.length,
      v4Attributes: v4AttributeIds.length,
      activeMappings: active.mappings.length,
      v4Mappings: v4MappingByAttribute.size,
    },
    productTypesAddedToV4: [...v4Classifiable].filter(id => !activeTypeSet.has(id)).sort(),
    productTypesRemovedInV4: active.productTypeIds.filter(id => !v4Classifiable.has(id)).sort(),
    attributesAddedToV4: v4AttributeIds.filter(id => !activeAttrSet.has(id)),
    attributesRemovedInV4: active.attributeIds.filter(id => !v4AttributeIdSet.has(id)),
    mappingChanges,
    pageProjectionRoles,
  };
}

/** Stable digest used for change-detection dedupe across loads. */
function summaryDigest(summary: V4ShadowDiffSummary): string {
  return hashCanonicalJson({
    counts: summary.counts,
    productTypesAddedToV4: summary.productTypesAddedToV4,
    productTypesRemovedInV4: summary.productTypesRemovedInV4,
    attributesAddedToV4: summary.attributesAddedToV4,
    attributesRemovedInV4: summary.attributesRemovedInV4,
    mappingChanges: summary.mappingChanges,
    pageProjectionRoles: summary.pageProjectionRoles,
  });
}

let lastShadowDigest: string | null = null;

/**
 * Append one deduped JSONL line to the run-scoped shadow log. NEVER throws:
 * observation failures are logged and swallowed so config loading is untouched.
 * Exported purely for tests (`__resetV4ShadowObserverForTests` restores the
 * in-memory dedupe state).
 */
export function recordV4ShadowObservation(workspacePath: string, summary: V4ShadowDiffSummary): void {
  try {
    const digest = summaryDigest(summary);
    if (digest === lastShadowDigest) return; // unchanged since last observation
    const dir = path.join(workspacePath, 'store', 'classification', 'shadow');
    fs.mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify({ digest: digest.slice(0, 12), ...summary })}\n`;
    fs.appendFileSync(path.join(dir, 'v4-shadow.jsonl'), line, 'utf8');
    lastShadowDigest = digest;
  } catch (error) {
    console.warn('[V4ShadowObserver] observation failed (non-fatal):', error instanceof Error ? error.message : error);
  }
}

/** Test-only: clear the in-memory change-detection state. */
export function __resetV4ShadowObserverForTests(): void {
  lastShadowDigest = null;
}

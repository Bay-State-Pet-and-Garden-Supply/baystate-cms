// fallow-ignore-file unused-export

/**
 * Canonical field-metadata service (issue #31 commit 1, D1 + D2).
 *
 * Single owner of every R1 (`field_registry` DB) / R2 (`store/field-registry.json`)
 * mutation:
 * - R1 (SQLite) is the authoritative representation.
 * - R2 is a deterministic attestation projection of R1, rebuilt by
 *   `repairAttestation()` — it is never independent truth.
 * - `curated_fields_json` on each R1 row records which properties an operator
 *   curated through the canonical path; sync merges per-property and never
 *   clobbers curated metadata (D2).
 *
 * Invariants:
 * - `updateFieldMetadata` resolves the row by `xmlField` (not a partial
 *   payload's `xmlField ?? ''`), snapshots the old R1 state in memory, mutates
 *   R1, then atomically rewrites R2 from R1. An R2 failure is logged and the
 *   R1 write is NEVER rolled back (R1 is authority); `repairAttestation` can
 *   rebuild a stale R2 later, and the failure marks the projection stale (F2)
 *   so consumers fail closed instead of trusting a drifted R2.
 * - `syncRegistryFromProductIndex` is additive-only (missing keys); rows it
 *   creates are observed-only (`curated_fields_json` stays null).
 * - `updateFieldMetadata` creating a NEW row records the supplied patch
 *   properties as curated (F4) — an operator-created field is never treated as
 *   observed-only, so the next sync cannot overwrite the supplied metadata.
 * - `bootstrapSyncRegistry` applies the D2 property-level merge: a property in
 *   `curated_fields_json` keeps its DB value; otherwise the incoming (synced)
 *   value wins. `sampleValuesJson` is always refreshed (observed, never
 *   curated); `curated_fields_json` is never overwritten by sync; rows absent
 *   from a pull are kept (no `clearRegistry`).
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  listRegistry,
  upsertRegistryEntry,
  markProjectionStale,
  clearProjectionStale,
  isProjectionStale,
  type FieldRegistryRow,
} from '../../db/repositories/field-registry-repo';
import { getDb } from '../../db/connection';
import { writeStoreConfig, readStoreConfig } from '../../git/workspace-files';
import type { FieldRegistryEntry } from '../../shared/types';

/** The workspace identity the service needs to mutate R1 + R2. */
export interface FieldMetadataWorkspace {
  id: string;
  workspacePath: string;
}

/** Curated, operator-editable metadata properties (partial patch). */
export const FieldMetadataPatchSchema = z.object({
  label: z.string().optional(),
  kind: z.string().optional(),
  dataType: z.enum(['string', 'number', 'boolean', 'html', 'image', 'list', 'raw_xml']).optional(),
  editable: z.boolean().optional(),
  required: z.boolean().optional(),
  uiGroup: z.string().nullable().optional(),
}).strict();
export type FieldMetadataPatch = z.infer<typeof FieldMetadataPatchSchema>;

/** Sync defaults for brand-new rows, mirroring the normalizer/legacy writer. */
const DEFAULT_LABEL = '';
const DEFAULT_KIND = 'custom';
const DEFAULT_DATA_TYPE = 'string';
const DEFAULT_EDITABLE = true;
const DEFAULT_REQUIRED = false;
const DEFAULT_UI_GROUP: string | null = null;

/**
 * Rebuild `store/field-registry.json` as a deterministic canonical projection
 * of R1 (`{ schemaVersion: 1, entries: listRegistry(...) }`). R2 is never
 * independent truth — this function exists so a stale/missing attestation can
 * always be repaired from the authoritative DB.
 *
 * F2 (issue #31 cleanup): a successful rewrite clears the stale-projection
 * marker; a failed rewrite marks it (durably recording that R2 must not be
 * consumed as authority) before rethrowing.
 */
export function repairAttestation(workspace: FieldMetadataWorkspace): FieldRegistryRow[] {
  const entries = listRegistry(workspace.id);
  try {
    writeStoreConfig(workspace.workspacePath, 'field-registry.json', {
      schemaVersion: 1,
      entries,
    });
    clearProjectionStale(workspace.id);
  } catch (err) {
    markProjectionStale(workspace.id, new Date().toISOString());
    throw err;
  }
  return entries;
}

/**
 * Explicit repair surface for a stale or missing R2 attestation
 * (`store/field-registry.json`): rebuilds it from R1 (the authoritative
 * `field_registry` DB) as the canonical projection. Wired to
 * `POST /api/field-registry/repair` and used as a lazy fallback in the
 * registry GET handler when the attestation file is missing (D1, issue #31
 * commit 3). Returns the entries written.
 */
export function repairFieldRegistryAttestation(workspace: FieldMetadataWorkspace): FieldRegistryRow[] {
  return repairAttestation(workspace);
}

// ─── Attestation freshness gate (F2, issue #31 cleanup) ───────────────────────

/** Result of {@link ensureAttestationFresh}. */
export interface AttestationFreshness {
  fresh: boolean;
  /** True when R2 was rewritten from R1 because the xmlField sets differed. */
  repaired?: boolean;
  /** Fields present in R1 but absent from the stale R2 (when repaired). */
  added?: string[];
  /** Fields present in the stale R2 but absent from R1 (when repaired). */
  removed?: string[];
  /** Fail-closed condition when `fresh: false`. */
  condition?: 'field_registry_projection_stale';
}

function sortedUniqueXmlFields(xmlFields: string[]): string[] {
  return [...new Set(xmlFields.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/**
 * Verify that the R2 attestation file's xmlField set matches R1 (the
 * authoritative DB) and repair it when it does not.
 *
 * - equal → `{ fresh: true }` (clears the stale marker if somehow set);
 * - differ → attempt {@link repairAttestation}; success →
 *   `{ fresh: true, repaired: true, added, removed }` (marker cleared by the
 *   repair); failure → `{ fresh: false, condition: 'field_registry_projection_stale' }`
 *   (the repair itself marked the projection stale, so callers fail closed
 *   instead of consuming a de-facto-authoritative R2).
 * - R1 is EMPTY → `{ fresh: true }` with no repair: an empty R1 is the
 *   activation/bootstrap window where a committed R2 file legitimately
 *   stands in for the catalog field set before the DB mirror is populated
 *   (e.g. the I7/I8 v2-activation flow). There is nothing authoritative to
 *   compare against, so the freshness judgment is deferred until R1 has rows;
 *   the legacy direct-R2 read is preserved.
 *
 * A missing/malformed R2 (with a non-empty R1) parses as an empty set and is
 * therefore repaired from R1 — the same convergence the existing ENOENT
 * fallback provided.
 */
export function ensureAttestationFresh(workspace: FieldMetadataWorkspace): AttestationFreshness {
  const r1Fields = sortedUniqueXmlFields(listRegistry(workspace.id).map(entry => entry.xmlField));
  if (r1Fields.length === 0) {
    // No authoritative R1 content yet: defer (see doc comment).
    return { fresh: true };
  }
  let r2Fields: string[] = [];
  try {
    const registry = readStoreConfig<{ entries?: Array<{ xmlField?: unknown }> }>(workspace.workspacePath, 'field-registry.json');
    r2Fields = sortedUniqueXmlFields((registry?.entries ?? []).map(entry => String(entry.xmlField ?? '')));
  } catch {
    // Missing or malformed R2: the repair path rebuilds it from R1.
    r2Fields = [];
  }

  if (r1Fields.length === r2Fields.length && r1Fields.every((field, index) => field === r2Fields[index])) {
    if (isProjectionStale(workspace.id)) clearProjectionStale(workspace.id);
    return { fresh: true };
  }

  const added = r1Fields.filter(field => !r2Fields.includes(field));
  const removed = r2Fields.filter(field => !r1Fields.includes(field));
  try {
    repairAttestation(workspace);
    return { fresh: true, repaired: true, added, removed };
  } catch (err) {
    // repairAttestation already marked the projection stale before rethrowing;
    // fail closed so no consumer treats R2 as authority.
    console.error('[FieldMetadataService] ensureAttestationFresh: R2 repair failed; marking projection stale:', err);
    return { fresh: false, condition: 'field_registry_projection_stale' };
  }
}

/**
 * Apply a zod-validated metadata patch to the R1 row identified by `xmlField`,
 * then rewrite R2 from R1. Patched property names are merged into
 * `curated_fields_json` (deduped, sorted) so sync knows the operator curated
 * them (D2). For a brand-new row the supplied patch properties ARE the
 * operator's curation (F4, issue #31 cleanup): they are recorded as curated
 * (or null when the patch carries no properties — bare creation), so a
 * subsequent sync can never overwrite the operator-supplied metadata.
 *
 * R2 write failures are logged and never roll back the R1 write.
 */
export function updateFieldMetadata(
  workspace: FieldMetadataWorkspace,
  xmlField: string,
  patchInput: FieldMetadataPatch,
): FieldRegistryRow {
  const patch = FieldMetadataPatchSchema.parse(patchInput);
  const existing = listRegistry(workspace.id).find(entry => entry.xmlField === xmlField);
  const now = new Date().toISOString();

  const patchedProperties = (Object.keys(patch) as Array<keyof FieldMetadataPatch>)
    .filter(key => patch[key] !== undefined);
  // D2: canonical edits add the edited property to curated_fields. Rows
  // created through this path by an OPERATOR carry the supplied patch
  // properties as their curation (F4); rows created by sync discovery stay
  // observed-only (they bypass this service and set curatedFieldsJson: null
  // directly in upsertRegistryEntry).
  const curatedFieldsJson = existing
    ? mergeCurated(existing.curatedFieldsJson, patchedProperties)
    : patchedProperties.length > 0
      ? JSON.stringify([...new Set(patchedProperties)].sort())
      : null;

  upsertRegistryEntry({
    id: existing?.id ?? randomUUID(),
    workspaceId: workspace.id,
    xmlField,
    label: patch.label ?? existing?.label ?? DEFAULT_LABEL,
    kind: patch.kind ?? existing?.kind ?? DEFAULT_KIND,
    dataType: patch.dataType ?? existing?.dataType ?? DEFAULT_DATA_TYPE,
    editable: patch.editable ?? existing?.editable ?? DEFAULT_EDITABLE,
    required: patch.required ?? existing?.required ?? DEFAULT_REQUIRED,
    uiGroup: patch.uiGroup !== undefined ? patch.uiGroup : (existing?.uiGroup ?? DEFAULT_UI_GROUP),
    sampleValuesJson: existing?.sampleValuesJson ?? null,
    curatedFieldsJson,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  try {
    repairAttestation(workspace);
  } catch (err) {
    // D1: R2 is a projection; a failed rewrite must never roll back R1.
    console.error(
      `[FieldMetadataService] updateFieldMetadata(${xmlField}): R2 rewrite failed (R1 remains authoritative):`,
      err,
    );
  }

  const updated = listRegistry(workspace.id).find(entry => entry.xmlField === xmlField);
  if (!updated) {
    throw new Error(`[FieldMetadataService] updateFieldMetadata(${xmlField}): R1 write did not persist.`);
  }
  return updated;
}

/**
 * Additive field-registry sync from `product_index.custom_fields`: adds
 * missing ProductField keys only, routing through `updateFieldMetadata` so R2
 * is always refreshed alongside R1. Existing rows are never overwritten, and
 * new rows are observed-only (`curated_fields_json` = null). Returns the count
 * of rows added.
 */
export function syncRegistryFromProductIndex(workspace: FieldMetadataWorkspace): number {
  const db = getDb();
  const rows = db
    .query("SELECT custom_fields FROM product_index WHERE custom_fields IS NOT NULL AND custom_fields != '' AND custom_fields != '{}' LIMIT 5000")
    .all() as Array<{ custom_fields: string | null }>;

  const allKeys = new Set<string>();
  for (const row of rows) {
    if (!row.custom_fields) continue;
    try {
      const customFields = JSON.parse(String(row.custom_fields)) as Record<string, unknown>;
      for (const key of Object.keys(customFields)) {
        if (key.startsWith('ProductField')) allKeys.add(key);
      }
    } catch { /* skip malformed */ }
  }

  if (allKeys.size === 0) return 0;

  const existingNames = new Set(listRegistry(workspace.id).map(entry => entry.xmlField));

  // N-writes batching: collect all missing-key DB upserts first, then ONE
  // R2 rewrite instead of one updateFieldMetadata/repairAttestation per key
  // (each rewrite is a full canonical projection of R1). New rows are
  // observed-only (`curated_fields_json` stays null).
  const now = new Date().toISOString();
  let added = 0;
  for (const key of allKeys) {
    if (existingNames.has(key)) continue;
    upsertRegistryEntry({
      id: randomUUID(),
      workspaceId: workspace.id,
      xmlField: key,
      label: key,
      kind: 'custom',
      dataType: 'string',
      editable: true,
      required: false,
      uiGroup: 'Custom Fields',
      sampleValuesJson: null,
      curatedFieldsJson: null, // observed-only — sync discovery is not curation
      createdAt: now,
      updatedAt: now,
    });
    existingNames.add(key);
    added += 1;
  }
  if (added > 0) {
    try {
      repairAttestation(workspace);
    } catch (err) {
      // D1: R1 is authority; a failed R2 rewrite is logged, never fatal here.
      console.error('[FieldMetadataService] syncRegistryFromProductIndex: R2 rewrite failed (R1 remains authoritative):', err);
    }
  }
  return added;
}

/**
 * D2 property-level merge of a fresh ShopSite pull into R1 + R2.
 *
 * For each incoming entry:
 * - a property listed in the existing row's `curated_fields_json` keeps its DB
 *   value (curated metadata survives the pull);
 * - otherwise the incoming value wins;
 * - `sampleValuesJson` is always refreshed from the incoming observation
 *   (never curated);
 * - `curated_fields_json` is never overwritten by sync;
 * - rows in R1 that are absent from the pull are KEPT (no clearRegistry) so a
 *   sync can never silently delete curated metadata (D2, C10).
 *
 * Legacy label preservation: when the incoming label is the bare tag-name
 * default (`label === xmlField`), an existing non-default label is kept — this
 * is the pre-D2 curated-label contract and remains the tag-name default case
 * inside the label property merge.
 */
export function bootstrapSyncRegistry(
  workspace: FieldMetadataWorkspace,
  entries: Array<Omit<FieldRegistryEntry, 'id'>>,
): void {
  const now = new Date().toISOString();
  const existingByField = new Map(
    listRegistry(workspace.id).map(entry => [entry.xmlField, entry] as const),
  );

  for (const incoming of entries) {
    const existing = existingByField.get(incoming.xmlField);
    if (!existing) {
      const row: FieldRegistryRow = {
        id: randomUUID(),
        workspaceId: workspace.id,
        xmlField: incoming.xmlField,
        label: incoming.label,
        kind: incoming.kind,
        dataType: incoming.dataType,
        editable: incoming.editable,
        required: incoming.required,
        uiGroup: incoming.uiGroup,
        sampleValuesJson: incoming.sampleValuesJson,
        curatedFieldsJson: null, // observed-only — sync defaults are not curation
        createdAt: now,
        updatedAt: now,
      };
      upsertRegistryEntry(row);
      existingByField.set(incoming.xmlField, row);
      continue;
    }

    const curated = new Set(parseCurated(existing.curatedFieldsJson));
    const merged: FieldRegistryRow = {
      id: existing.id,
      workspaceId: workspace.id,
      xmlField: incoming.xmlField,
      label: curated.has('label')
        ? existing.label
        : incoming.label === incoming.xmlField && existing.label !== existing.xmlField
          ? existing.label
          : incoming.label,
      kind: curated.has('kind') ? existing.kind : incoming.kind,
      dataType: curated.has('dataType') ? existing.dataType : incoming.dataType,
      editable: curated.has('editable') ? existing.editable : incoming.editable,
      required: curated.has('required') ? existing.required : incoming.required,
      uiGroup: curated.has('uiGroup') ? existing.uiGroup : incoming.uiGroup,
      sampleValuesJson: incoming.sampleValuesJson,
      curatedFieldsJson: existing.curatedFieldsJson, // never overwritten by sync
      createdAt: existing.createdAt,
      updatedAt: now,
    };
    upsertRegistryEntry(merged);
  }

  try {
    repairAttestation(workspace);
  } catch (err) {
    // D1: R1 is authority; a failed R2 rewrite is logged, never fatal here.
    console.error('[FieldMetadataService] bootstrapSyncRegistry: R2 rewrite failed (R1 remains authoritative):', err);
  }
}

function parseCurated(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function mergeCurated(existingJson: string | null | undefined, patched: string[]): string {
  const merged = [...new Set([...parseCurated(existingJson), ...patched])].sort();
  return JSON.stringify(merged);
}

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
 *   rebuild a stale R2 later.
 * - `syncRegistryFromProductIndex` is additive-only (missing keys) and routes
 *   through `updateFieldMetadata` so R2 is always refreshed; rows it creates
 *   are observed-only (`curated_fields_json` stays null).
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
  type FieldRegistryRow,
} from '../../db/repositories/field-registry-repo';
import { getDb } from '../../db/connection';
import { writeStoreConfig } from '../../git/workspace-files';
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
 */
export function repairAttestation(workspace: FieldMetadataWorkspace): FieldRegistryRow[] {
  const entries = listRegistry(workspace.id);
  writeStoreConfig(workspace.workspacePath, 'field-registry.json', {
    schemaVersion: 1,
    entries,
  });
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

/**
 * Apply a zod-validated metadata patch to the R1 row identified by `xmlField`,
 * then rewrite R2 from R1. Patched property names are merged into
 * `curated_fields_json` (deduped, sorted) so sync knows the operator curated
 * them (D2) — unless the row is brand new, in which case the row is
 * observed-only (`curated_fields_json` stays null).
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
  // created through this path (e.g. additive sync discovery) are observed-only.
  const curatedFieldsJson = existing
    ? mergeCurated(existing.curatedFieldsJson, patchedProperties)
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

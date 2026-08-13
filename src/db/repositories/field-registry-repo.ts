import { getDb } from '../connection';

export interface FieldRegistryRow {
  id: string;
  workspaceId: string;
  xmlField: string;
  label: string;
  kind: string;
  dataType: string;
  editable: boolean;
  required: boolean;
  uiGroup: string | null;
  sampleValuesJson: string | null;
  /** JSON array of property names an operator curated through the canonical
   * field-metadata path (e.g. ["label","uiGroup"]). NULL = never curated;
   * sync merges per-property and never clobbers curated metadata (D2). */
  curatedFieldsJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function listRegistry(workspaceId: string): FieldRegistryRow[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM field_registry WHERE workspace_id = ? ORDER BY xml_field ASC').all(workspaceId) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function upsertRegistryEntry(entry: FieldRegistryRow): void {
  const db = getDb();
  // F1 (issue #31 cleanup): every column is assigned DIRECTLY from the merged
  // row (`= EXCLUDED.<col>`, never COALESCE with the existing value). The
  // canonical service (`updateFieldMetadata` / `bootstrapSyncRegistry`) is the
  // only caller and ALWAYS passes a complete merged row, so COALESCE could
  // only swallow a deliberately cleared value — e.g. a canonical PATCH of
  // `uiGroup: null` or a fresh pull with null observed samples — making null
  // inexpressible. Direct assignment keeps null clearable while curated
  // metadata still wins through the service-layer merge (curated_fields_json
  // decides which properties keep their DB value, not this upsert).
  db.run(
    `INSERT INTO field_registry (id, workspace_id, xml_field, label, kind, data_type, editable, required, ui_group, sample_values_json, curated_fields_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, xml_field) DO UPDATE SET
       label = EXCLUDED.label,
       kind = EXCLUDED.kind,
       data_type = EXCLUDED.data_type,
       editable = EXCLUDED.editable,
       required = EXCLUDED.required,
       ui_group = EXCLUDED.ui_group,
       sample_values_json = EXCLUDED.sample_values_json,
       curated_fields_json = EXCLUDED.curated_fields_json,
       updated_at = EXCLUDED.updated_at`,
    [
      entry.id, entry.workspaceId, entry.xmlField, entry.label, entry.kind, entry.dataType,
      entry.editable ? 1 : 0, entry.required ? 1 : 0, entry.uiGroup, entry.sampleValuesJson,
      entry.curatedFieldsJson ?? null,
      entry.createdAt, entry.updatedAt,
    ],
  );
}

function mapRow(row: Record<string, unknown>): FieldRegistryRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    xmlField: String(row.xml_field),
    label: String(row.label),
    kind: String(row.kind),
    dataType: String(row.data_type),
    editable: Number(row.editable) === 1,
    required: Number(row.required) === 1,
    uiGroup: row.ui_group ? String(row.ui_group) : null,
    sampleValuesJson: row.sample_values_json ? String(row.sample_values_json) : null,
    curatedFieldsJson: row.curated_fields_json ? String(row.curated_fields_json) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// ─── Stale-projection marker (F2, issue #31 cleanup) ──────────────────────────
//
// R2 (`store/field-registry.json`) is a deterministic attestation projection of
// R1 (`field_registry` DB). When an R2 rewrite fails the file can silently
// drift from R1; this durable app_meta marker records that the projection is
// stale so evidence scans and live-field reads fail closed instead of
// consuming a de-facto-authoritative R2. The marker is cleared whenever R2 is
// successfully rebuilt from R1.

const PROJECTION_STALE_KEY = (workspaceId: string) => `field_registry_projection_stale:${workspaceId}`;

/** Record that the R2 attestation for a workspace is stale (ISO timestamp). */
export function markProjectionStale(workspaceId: string, at: string): void {
  getDb().run(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
    [PROJECTION_STALE_KEY(workspaceId), at],
  );
}

/** Clear the stale-projection marker for a workspace. */
export function clearProjectionStale(workspaceId: string): void {
  getDb().run('DELETE FROM app_meta WHERE key = ?', [PROJECTION_STALE_KEY(workspaceId)]);
}

/** True when the R2 attestation for a workspace is marked stale. */
export function isProjectionStale(workspaceId: string): boolean {
  // bun:sqlite returns null (not undefined) when no row matches.
  const row = getDb().query('SELECT value FROM app_meta WHERE key = ?').get(PROJECTION_STALE_KEY(workspaceId)) as { value: string } | null;
  return row !== null && row !== undefined;
}

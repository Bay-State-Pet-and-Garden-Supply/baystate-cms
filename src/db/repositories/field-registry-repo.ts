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
  db.run(
    `INSERT INTO field_registry (id, workspace_id, xml_field, label, kind, data_type, editable, required, ui_group, sample_values_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, xml_field) DO UPDATE SET
       label = COALESCE(EXCLUDED.label, field_registry.label),
       kind = COALESCE(EXCLUDED.kind, field_registry.kind),
       data_type = COALESCE(EXCLUDED.data_type, field_registry.data_type),
       editable = COALESCE(EXCLUDED.editable, field_registry.editable),
       required = COALESCE(EXCLUDED.required, field_registry.required),
       ui_group = COALESCE(EXCLUDED.ui_group, field_registry.ui_group),
       sample_values_json = COALESCE(EXCLUDED.sample_values_json, field_registry.sample_values_json),
       updated_at = EXCLUDED.updated_at`,
    [
      entry.id, entry.workspaceId, entry.xmlField, entry.label, entry.kind, entry.dataType,
      entry.editable ? 1 : 0, entry.required ? 1 : 0, entry.uiGroup, entry.sampleValuesJson,
      entry.createdAt, entry.updatedAt,
    ],
  );
}

export function clearRegistry(workspaceId: string): void {
  const db = getDb();
  db.run('DELETE FROM field_registry WHERE workspace_id = ?', [workspaceId]);
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

// fallow-ignore-file unused-export

/**
 * Mapping-validity findings (issue #31 commit 3, D4).
 *
 * Catalog sync records per-mapping Catalog Field presence here — the sync
 * writer is intentionally limited to findings and NEVER writes `isStale` on
 * `attributeMappings` (isStale is mapping-authority state written only by
 * classification-config operations: the mapping editor and activation). A
 * future canonical classification-config reconciliation operation reads these
 * findings and writes isStale through the mapping-editor/activation path.
 *
 * One row per (workspace_id, catalog_field); `field_present` is the LATEST
 * sync observation (1 = present in the pull, 0 = absent).
 */

import { getDb } from '../connection';

export interface MappingValidityFindingRow {
  workspaceId: string;
  catalogField: string;
  fieldPresent: number;
  detectedAt: string;
}

export function upsertMappingValidityFinding(finding: MappingValidityFindingRow): void {
  const db = getDb();
  db.run(
    `INSERT INTO mapping_validity_findings (workspace_id, catalog_field, field_present, detected_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, catalog_field) DO UPDATE SET
       field_present = excluded.field_present,
       detected_at = excluded.detected_at`,
    [finding.workspaceId, finding.catalogField, finding.fieldPresent, finding.detectedAt],
  );
}

export function listMappingValidityFindings(workspaceId: string): MappingValidityFindingRow[] {
  const db = getDb();
  const rows = db
    .query(
      'SELECT workspace_id, catalog_field, field_present, detected_at FROM mapping_validity_findings WHERE workspace_id = ? ORDER BY catalog_field ASC',
    )
    .all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    workspaceId: String(row.workspace_id),
    catalogField: String(row.catalog_field),
    fieldPresent: Number(row.field_present),
    detectedAt: String(row.detected_at),
  }));
}

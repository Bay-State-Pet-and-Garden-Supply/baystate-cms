import type { Database } from 'bun:sqlite';
import { VariantMatrixSchema, type VariantMatrix } from '../../shared/schemas/variant-resolution';

export interface VariantResolutionRow {
  id: string;
  onboarding_item_id: string;
  source_url: string;
  canonical_parent_key: string;
  platform: string;
  parser_version: number;
  identity_matrix_hash: string;
  source_content_hash: string | null;
  status: string;
  reason_codes_json: string;
  candidates_json: string;
  automatic_variant_key: string | null;
  selected_variant_key: string | null;
  decision_origin: string | null;
  decided_at: string | null;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}

export function createVariantResolutionRepo(db: Database) {
  return {
    create(row: VariantResolutionRow): void {
      db.prepare(
        `INSERT INTO onboarding_variant_resolutions
        (id, onboarding_item_id, source_url, canonical_parent_key, platform, parser_version, identity_matrix_hash, source_content_hash, status, reason_codes_json, candidates_json, automatic_variant_key, selected_variant_key, decision_origin, decided_at, superseded_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.onboarding_item_id,
        row.source_url,
        row.canonical_parent_key,
        row.platform,
        row.parser_version,
        row.identity_matrix_hash,
        row.source_content_hash,
        row.status,
        row.reason_codes_json,
        row.candidates_json,
        row.automatic_variant_key,
        row.selected_variant_key,
        row.decision_origin,
        row.decided_at,
        row.superseded_at,
        row.created_at,
        row.updated_at,
      );
    },
    getCurrentForItem(itemId: string): VariantResolutionRow | null {
      const row = db
        .prepare(`SELECT * FROM onboarding_variant_resolutions WHERE onboarding_item_id = ? AND superseded_at IS NULL LIMIT 1`)
        .get(itemId) as VariantResolutionRow | null;
      return row ?? null;
    },
    getById(id: string): VariantResolutionRow | null {
      const row = db.prepare(`SELECT * FROM onboarding_variant_resolutions WHERE id = ? LIMIT 1`).get(id) as VariantResolutionRow | null;
      return row ?? null;
    },
    supersedeCurrent(itemId: string, supersededAt: string): void {
      db.prepare(`UPDATE onboarding_variant_resolutions SET superseded_at = ?, updated_at = ? WHERE onboarding_item_id = ? AND superseded_at IS NULL`).run(
        supersededAt,
        supersededAt,
        itemId,
      );
    },
    listForItem(itemId: string): VariantResolutionRow[] {
      return db.prepare(`SELECT * FROM onboarding_variant_resolutions WHERE onboarding_item_id = ? ORDER BY created_at DESC`).all(itemId) as VariantResolutionRow[];
    },
    parseMatrix(row: VariantResolutionRow): VariantMatrix | null {
      try {
        const candidates = JSON.parse(row.candidates_json);
        const matrix = {
          parserVersion: row.parser_version,
          platform: row.platform,
          canonicalParentUrl: row.canonical_parent_key,
          sourceFinalUrl: row.source_url,
          sourceContentHash: row.source_content_hash,
          candidates,
          warnings: JSON.parse(row.reason_codes_json),
          createdAt: row.created_at,
        };
        return VariantMatrixSchema.parse(matrix);
      } catch {
        return null;
      }
    },
  };
}

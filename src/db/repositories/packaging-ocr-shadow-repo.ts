/**
 * Packaging-OCR shadow comparison repository (packaging-ocr overhaul P2-T4).
 *
 * Function module following the classification-cohort-output-repo conventions:
 * snake_case rows + camelCase mappers, `randomUUID()` ids, ISO timestamps,
 * positional params. Rows are OBSERVATIONS of a dual-run (legacy inline OCR vs
 * the new packaging_ocr classification stage) — write-once diagnostics that
 * never feed any authority decision, so there is no update path.
 */
import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redactTransportText } from '../../classification/model-policy-gateway';

const now = () => new Date().toISOString();

/** Reason columns are bounded AND redacted at write time (post-review fixup
 *  7d): legacy/stage failure text is transport-derived, so it passes through
 *  `redactTransportText` (credential scrubbing) and is capped at 500 chars —
 *  an observation row can never smuggle a secret or bloat unboundedly. */
const REASON_MAX_LENGTH = 500;
function sanitizeReason(reason: string | null | undefined): string | null {
  if (reason == null) return null;
  // Redact first (credential scrubbing); redactTransportText appends an
  // ellipsis when it truncates, so the hard cap is enforced afterwards.
  const redacted = redactTransportText(String(reason), REASON_MAX_LENGTH);
  return redacted.length > REASON_MAX_LENGTH ? redacted.slice(0, REASON_MAX_LENGTH) : redacted;
}

/** Default comparison-row retention window in days (post-review fixup 6). */
const DEFAULT_OCR_SHADOW_RETENTION_DAYS = 30;

/**
 * Parse `BAYSTATE_CMS_OCR_SHADOW_RETENTION_DAYS` (post-review fixup 6):
 * integer ≥ 0, default 30; missing/blank/unparseable/negative → the default.
 * Exported for tests.
 */
export function parseOcrShadowRetentionDays(raw: string | undefined | null): number {
  if (raw === undefined || raw === null) return DEFAULT_OCR_SHADOW_RETENTION_DAYS;
  const trimmed = String(raw).trim();
  if (!/^(?:0|[1-9][0-9]*)$/.test(trimmed)) return DEFAULT_OCR_SHADOW_RETENTION_DAYS;
  return Number.parseInt(trimmed, 10);
}

/** Validated insert shape for one dual-run comparison row. */
export const InsertPackagingOcrShadowComparisonSchema = z.object({
  itemId: z.string().min(1),
  batchId: z.string().nullable().default(null),
  runId: z.string().nullable().default(null),
  /** Legacy inline path's OcrAttemptOutcome.status when available, else null. */
  legacyStatus: z.string().nullable().default(null),
  /** Legacy coded failure reason / error text (already redacted upstream). */
  legacyReason: z.string().nullable().default(null),
  /** Stage outcome status — always present (the stage always emits an outcome). */
  stageStatus: z.string().min(1),
  stageReason: z.string().nullable().default(null),
  /** JSON map fieldName → {agree, legacyValue?, stageValue?} (size-capped upstream). */
  fieldAgreementJson: z.string().nullable().default(null),
});
export type InsertPackagingOcrShadowComparison = z.infer<typeof InsertPackagingOcrShadowComparisonSchema>;

/** One persisted comparison row (camelCase mapper over the snake_case table). */
export interface PackagingOcrShadowComparisonRow {
  id: string;
  itemId: string;
  batchId: string | null;
  runId: string | null;
  legacyStatus: string | null;
  legacyReason: string | null;
  stageStatus: string;
  stageReason: string | null;
  fieldAgreementJson: string | null;
  createdAt: string;
}

function mapRow(row: Record<string, any>): PackagingOcrShadowComparisonRow {
  return {
    id: String(row.id),
    itemId: String(row.item_id),
    batchId: row.batch_id ?? null,
    runId: row.run_id ?? null,
    legacyStatus: row.legacy_status ?? null,
    legacyReason: row.legacy_reason ?? null,
    stageStatus: String(row.stage_status),
    stageReason: row.stage_reason ?? null,
    fieldAgreementJson: row.field_agreement_json ?? null,
    createdAt: String(row.created_at),
  };
}

export function insertPackagingOcrShadowComparison(
  input: InsertPackagingOcrShadowComparison,
): PackagingOcrShadowComparisonRow {
  const payload = InsertPackagingOcrShadowComparisonSchema.parse(input);
  const id = randomUUID();
  const legacyReason = sanitizeReason(payload.legacyReason);
  const stageReason = sanitizeReason(payload.stageReason);
  getDb().query(
    `INSERT INTO packaging_ocr_shadow_comparisons
       (id, item_id, batch_id, run_id, legacy_status, legacy_reason, stage_status, stage_reason, field_agreement_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    payload.itemId,
    payload.batchId,
    payload.runId,
    payload.legacyStatus,
    legacyReason,
    payload.stageStatus,
    stageReason,
    payload.fieldAgreementJson,
    now(),
  );
  return {
    id,
    itemId: payload.itemId,
    batchId: payload.batchId,
    runId: payload.runId,
    legacyStatus: payload.legacyStatus,
    legacyReason,
    stageStatus: payload.stageStatus,
    stageReason,
    fieldAgreementJson: payload.fieldAgreementJson,
    createdAt: now(),
  };
}

/** All comparison rows for one item, newest first (stable observation order). */
export function listPackagingOcrShadowComparisonsByItem(itemId: string): PackagingOcrShadowComparisonRow[] {
  const rows = getDb().query(
    `SELECT * FROM packaging_ocr_shadow_comparisons WHERE item_id = ? ORDER BY created_at DESC, rowid DESC`,
  ).all(itemId) as Record<string, any>[];
  return rows.map(mapRow);
}

export function countPackagingOcrShadowComparisons(itemId: string): number {
  const row = getDb().query(
    'SELECT COUNT(*) AS cnt FROM packaging_ocr_shadow_comparisons WHERE item_id = ?',
  ).get(itemId) as { cnt: number };
  return Number(row?.cnt ?? 0);
}

/**
 * Retention (post-review fixup 6): delete observation rows created strictly
 * before `cutoffIso`. Single DELETE — cheap enough to run after every stage
 * write. Returns the number of pruned rows.
 */
export function deleteOlderThan(cutoffIso: string): number {
  const result = getDb().query(
    'DELETE FROM packaging_ocr_shadow_comparisons WHERE created_at < ?',
  ).run(cutoffIso);
  return Number(result.changes ?? 0);
}

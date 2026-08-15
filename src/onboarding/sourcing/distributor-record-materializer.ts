import { getDb } from '../../db/connection';
import {
  findItemById,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import { findBatchById } from '../../db/repositories/onboarding-batch-repo';
import {
  getCurrentSourcingGeneration,
  getEvidenceAttemptsByItemAndGeneration,
} from '../../db/repositories/onboarding-evidence-repo';
import { getCurrentGenerationAcceptedAttemptIds } from '../../db/repositories/onboarding-acceptance-repo';
import { listResolvedConflictResolutions } from '../../db/repositories/onboarding-conflict-repo';
import {
  insertExtraction,
  findDistributorRecordExtraction,
} from '../../db/repositories/onboarding-extraction-repo';
import {
  buildDistributorRecordProjection,
  type SourcingProjectionReasonCode,
  type DistributorRecordProjection,
} from './distributor-record-projection';
import { normalizeGtin } from './contracts';
import { SourcingDecisionV2Schema } from '../../shared/schemas/onboarding';
import { EvidenceAttemptSchema } from '../../shared/schemas/distributor-evidence';

/**
 * Deterministic distributor-record extraction materializer (Amendment A,
 * Milestone D).
 *
 * `materializeDistributorRecordExtraction(itemId, workspaceId)` executes
 * entirely inside a single repository transaction and rechecks every
 * authority BEFORE writing:
 *
 * - the item is workspace-owned and `extraction/in_progress`;
 * - the current V2 decision is `distributor_record_to_extraction`;
 * - the decision's generation is exactly the current (non-superseded) one;
 * - relational accepted IDs exactly match the decision's accepted set;
 * - every accepted attempt is schema-valid, `found`, exact-identifier,
 *   same item/workspace/generation, and connection-owned;
 * - no current open hard identity conflict exists;
 * - the recomputed canonical projection/hash equals the decision hash.
 *
 * Integrity failures return a stable error code and perform NO partial
 * insert/update (the transaction never starts). Unchanged evidence can never
 * heal an integrity error, so a failed materialization is NOT blindly
 * retried. A retry of the SAME generation/hash after success is idempotent:
 * the existing row is reused, never duplicated.
 *
 * This module performs ZERO external calls: no page fetch, extractor profile
 * lookup, DOM tooling, OCR, VLM, LLM, or image processing.
 */

export const DISTRIBUTOR_MATERIALIZATION_ERROR_CODES = {
  not_owned: 'not_owned',
  wrong_stage: 'wrong_stage',
  wrong_decision: 'wrong_decision',
  /** The serialized decision authority is absent or malformed (Milestone D round-8). */
  malformed_decision: 'malformed_decision',
  /** Defense-in-depth: an unexpected materializer throw maps here (job-queue catch). */
  internal_error: 'internal_error',
  stale_generation: 'stale_generation',
  superseded_generation: 'superseded_generation',
  acceptance_mismatch: 'acceptance_mismatch',
  invalid_attempt: 'invalid_attempt',
  open_conflict: 'open_conflict',
  hash_mismatch: 'hash_mismatch',
  already_completed: 'already_completed',
  stored_payload_diverged: 'stored_payload_diverged',
} as const;
export type DistributorMaterializationErrorCode =
  (typeof DISTRIBUTOR_MATERIALIZATION_ERROR_CODES)[keyof typeof DISTRIBUTOR_MATERIALIZATION_ERROR_CODES];

export type DistributorMaterializationResult =
  | {
      ok: true;
      extractionId: string;
      idempotent: boolean;
      extractionData: Record<string, unknown>;
    }
  | {
      ok: false;
      code: DistributorMaterializationErrorCode;
      reasonCodes: SourcingProjectionReasonCode[];
    };

/** Deterministic helper: exact set equality (order-insensitive). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((v) => setB.has(v));
}

/**
 * Build the identity-only ExtractionData (Milestone D field map): title,
 * noncanonical brand, weight, exact identifiers (distributor SKU / MPN),
 * whitelisted variant attributes, and the dedicated distributor-record
 * provenance object. Description/bullets/price/images stay empty; URL stays
 * null; confidence is non-authoritative (0); OCR fields are null/disabled.
 *
 * PURE and DETERMINISTIC: given the same projection + decision hash, this
 * always returns the same payload. The fresh-insert path and the idempotent
 * re-validation path both use it, so a stored payload can be trusted only
 * when it deep-equals a freshly recomputed one.
 */
function buildDistributorExtractionData(
  p: DistributorRecordProjection,
  evidenceHash: string,
): Record<string, unknown> {
  return {
    title: p.name,
    brand: p.brand,
    description: null,
    bulletPoints: [],
    primaryImage: null,
    additionalImages: [],
    price: null,
    weight: p.weight,
    dimensions: null,
    seoFileName: null,
    searchKeywords: null,
    sourceType: 'distributor_record',
    distributorProviderId: p.provenance.providerIds[0] ?? null,
    distributorEvidenceAttemptIds: p.provenance.acceptedAttemptIds,
    distributorProviderIds: p.provenance.providerIds,
    distributorSku: p.distributorSku,
    manufacturerPartNumber: p.manufacturerPartNumber,
    variantAttributes: {
      ...(p.size !== null ? { size: p.size } : {}),
      ...(p.count !== null ? { count: p.count } : {}),
      ...(p.packCount !== null ? { packCount: p.packCount } : {}),
      ...(p.flavor !== null ? { flavor: p.flavor } : {}),
      ...(p.formula !== null ? { formula: p.formula } : {}),
      ...p.customVariantAxes,
    },
    distributorRecordProvenance: {
      sourcingGenerationId: p.provenance.sourcingGenerationId,
      evidenceHash,
      acceptedEvidenceAttemptIds: p.provenance.acceptedAttemptIds,
      providerIds: p.provenance.providerIds,
      catalogVersions: p.provenance.catalogVersions,
    },
    sourceUrl: null,
    confidence: 0,
    fieldProvenance: Object.fromEntries(
      Object.entries(p.provenance.fieldProvenance).map(([field, entries]) => [
        field,
        entries[0]?.providerId ?? null,
      ]),
    ),
    packagingTitle: null,
    packagingOcrData: null,
    ocrOutcome: null,
    customFields: {},
  };
}

/**
 * Materialize the distributor-record extraction for one item.
 *
 * All rechecks and all writes happen inside ONE SQLite transaction. Any
 * integrity failure returns `{ ok: false, code }` BEFORE any write is
 * attempted — the caller marks the item `extraction/failed` with the stable
 * code (the materializer itself never performs a partial write).
 */
export function materializeDistributorRecordExtraction(
  itemId: string,
  workspaceId: string,
): DistributorMaterializationResult {
  const db = getDb();

  return db.transaction(() => {
    const item = findItemById(itemId);
    if (!item) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.not_owned, reasonCodes: [] };
    }
    if (item.sourceType !== 'distributor_record') {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.wrong_decision, reasonCodes: [] };
    }
    if (item.stage !== 'extraction' || item.stageStatus !== 'in_progress') {
      return {
        ok: false as const,
        code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.wrong_stage,
        reasonCodes: [],
      };
    }

    // Workspace ownership (fail closed; never materialize a foreign item).
    const batch = findBatchById(item.batchId);
    if (!batch || batch.workspaceId !== workspaceId) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.not_owned, reasonCodes: [] };
    }

    // The current V2 decision must be distributor_record_to_extraction.
    // Absent / malformed / schema-invalid decision authority fails closed
    // with the stable malformed_decision code (never throws — the row mapper
    // hydrates malformed JSON as null).
    if (item.sourcingDecision == null) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.malformed_decision, reasonCodes: [] };
    }
    const decisionParse = SourcingDecisionV2Schema.safeParse(item.sourcingDecision);
    if (!decisionParse.success) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.malformed_decision, reasonCodes: [] };
    }
    const decision = decisionParse.data;
    if (decision.route !== 'distributor_record_to_extraction') {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.wrong_decision, reasonCodes: [] };
    }

    // The decision's generation must be exactly the CURRENT generation
    // (a superseded generation can never materialize).
    const generation = getCurrentSourcingGeneration(itemId);
    if (!generation || generation.id !== decision.sourcingGenerationId) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.stale_generation, reasonCodes: [] };
    }
    // A generation that is itself marked superseded (e.g. cancelled mid-run
    // without a successor) must never materialize — fail closed distinctly.
    if (generation.status === 'superseded') {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.superseded_generation, reasonCodes: [] };
    }

    // Relational acceptances must exactly match the decision's accepted set.
    const acceptedIds = getCurrentGenerationAcceptedAttemptIds(itemId);
    if (!sameSet(acceptedIds, decision.acceptedEvidenceAttemptIds)) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.acceptance_mismatch, reasonCodes: [] };
    }

    // No current open hard conflict may exist.
    const openConflict = db
      .query(
        `SELECT 1 FROM onboarding_evidence_conflicts
         WHERE item_id = ? AND severity = 'hard' AND status = 'open'
           AND sourcing_generation_id IS (
             SELECT id FROM sourcing_generations
             WHERE item_id = ?
             ORDER BY rowid DESC LIMIT 1
           )
         LIMIT 1`,
      )
      .get(itemId, itemId);
    if (openConflict) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.open_conflict, reasonCodes: [] };
    }

    // Every accepted attempt must be schema-valid (full EvidenceAttemptSchema
    // recheck — the repo hydrates rows without validation), found,
    // exact-identifier, current-generation, and connection-owned in THIS
    // workspace. The projection recompute additionally enforces schema-valid
    // identity JSON.
    const attempts = getEvidenceAttemptsByItemAndGeneration(itemId, generation.id);
    const attemptsById = new Map(attempts.map((a) => [a.id, a]));
    const normalizedItemUpc = normalizeGtin(item.upc);
    for (const attemptId of decision.acceptedEvidenceAttemptIds) {
      const attempt = attemptsById.get(attemptId);
      if (!attempt) {
        return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt, reasonCodes: [] };
      }
      if (!EvidenceAttemptSchema.safeParse(attempt).success) {
        return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt, reasonCodes: [] };
      }
      if (attempt.outcome !== 'found') {
        return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt, reasonCodes: [] };
      }
      if (normalizeGtin(attempt.lookupUpc) !== normalizedItemUpc) {
        return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt, reasonCodes: [] };
      }
      if (!attempt.distributorConnectionId) {
        return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt, reasonCodes: [] };
      }
      // Connection ownership: the attempt's connection must belong to the
      // ITEM's workspace (cross-workspace evidence can never materialize).
      const connection = db
        .query(
          `SELECT c.id FROM distributor_connections c
           WHERE c.id = ? AND c.workspace_id = ?`,
        )
        .get(attempt.distributorConnectionId, workspaceId) as { id: string } | undefined;
      if (!connection) {
        return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt, reasonCodes: [] };
      }
    }

    // Recompute the canonical projection over the SAME inputs the decision
    // was made from — INCLUDING the item's persisted operator conflict
    // resolutions (candidate/custom/dismiss), which routing applied when it
    // produced the decision hash (final conflict resolution and the manual
    // use_distributor_record action both recompute with
    // `listResolvedConflictResolutions`). Omitting them here would make a
    // legitimate custom/candidate override fail with hash_mismatch. The hash
    // must match exactly (hash mismatch = the evidence or decision is not
    // what was qualified).
    const declaredVariantAxes = Array.from(
      new Set(
        attempts.flatMap((a) => (a.variantAxisDeclarations ?? []).map((d) => d.normalizedAxis)),
      ),
    );
    const projection = buildDistributorRecordProjection({
      itemId,
      itemUpc: item.upc,
      sourcingGenerationId: generation.id,
      attempts,
      acceptedAttemptIds: decision.acceptedEvidenceAttemptIds,
      declaredVariantAxes,
      resolutions: listResolvedConflictResolutions(itemId),
    });
    if (!projection.qualified) {
      return {
        ok: false as const,
        code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.hash_mismatch,
        reasonCodes: projection.reasonCodes,
      };
    }
    if (projection.evidenceHash !== decision.evidenceHash) {
      return {
        ok: false as const,
        code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.hash_mismatch,
        reasonCodes: [],
      };
    }

    // Idempotent retry: if ANY durable distributor-record extraction row
    // exists for this item, it must EXACTLY match the recomputed/decision
    // provenance — never insert a second (possibly divergent) row. The
    // finder locates by immutable identity (item + method) ONLY, so every
    // provenance column below is genuinely revalidated rather than being
    // tautologically re-read from a filtered lookup. The retried item must
    // still reach the completed state when everything matches (payload
    // restored + stage marked), otherwise it would remain claimable at
    // extraction/in_progress forever.
    const existing = findDistributorRecordExtraction(itemId);
    if (existing) {
      // Deterministic idempotency: the stored payload is a DERIVED artifact
      // and must STILL EQUAL a freshly recomputed one (materialization is
      // pure). A diverged payload means the row was altered outside the
      // materializer (e.g. a generic item-edit route) and must NEVER be
      // restored — fail closed with no restore, no completion, no partial
      // write.
      const storedData = parseStoredExtractionData(existing.extraction_data_json);
      const expectedData = buildDistributorExtractionData(projection.projection, decision.evidenceHash);
      // The durable ROW's provenance columns are part of the shared
      // row/item/decision/projection invariant and must ALSO equal the
      // recomputed/decision values: source type, null URL, exact current
      // generation, decision-equal accepted attempt set, and the decision
      // hash. Any divergence fails closed (no restore, no completion, no
      // second insert).
      const rowAcceptedIds = parseStoredAcceptedIds(existing.accepted_evidence_attempt_ids_json);
      const rowDiverged =
        existing.source_type !== 'distributor_record' ||
        existing.source_url !== null ||
        existing.sourcing_generation_id !== generation.id ||
        existing.evidence_hash !== decision.evidenceHash ||
        !sameSet(rowAcceptedIds, decision.acceptedEvidenceAttemptIds) ||
        JSON.stringify(storedData) !== JSON.stringify(expectedData);
      if (rowDiverged) {
        return {
          ok: false as const,
          code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.stored_payload_diverged,
          reasonCodes: [],
        };
      }
      const now = new Date().toISOString();
      db.query(
        'UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?',
      ).run(existing.extraction_data_json, now, itemId);
      updateItemStageStatus(itemId, 'completed');
      return {
        ok: true as const,
        extractionId: existing.id,
        idempotent: true,
        extractionData: storedData,
      };
    }

    // Materialize the identity-only ExtractionData from the canonical
    // projection (same deterministic builder used by the idempotent path).
    const extractionData = buildDistributorExtractionData(projection.projection, decision.evidenceHash);
    const extractionDataJson = JSON.stringify(extractionData);
    const now = new Date().toISOString();

    const row = insertExtraction({
      itemId,
      sourceType: 'distributor_record',
      sourceUrl: null,
      extractionDataJson,
      extractionMethod: 'distributor_record_v1',
      confidence: 0,
      imagesJson: null,
      rawStructuredDataJson: JSON.stringify(extractionData.fieldProvenance),
      sourcingGenerationId: generation.id,
      acceptedEvidenceAttemptIds: projection.projection.provenance.acceptedAttemptIds,
      evidenceHash: decision.evidenceHash,
    });

    // Item payload + stage completion, atomically in the same transaction.
    db.query(
      'UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?',
    ).run(extractionDataJson, now, itemId);
    updateItemStageStatus(itemId, 'completed');

    return {
      ok: true as const,
      extractionId: row.id,
      idempotent: false,
      extractionData,
    };
  })();
}

/** Parse stored extraction JSON back for idempotent success (safe fallback). */
function parseStoredExtractionData(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Parse the durable row's accepted-attempt ids JSON column (null → empty). */
function parseStoredAcceptedIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Onboarding PI asset persistence (ADR-0030 Phase 2 relocation).
 *
 * Durable verified-image rows for onboarding distributor imagery
 * (origin 'onboarding_distributor'). Canonical home of the
 * `product_intelligence_assets` row shape and SELECT projection — the
 * remaining Product Intelligence asset functions in
 * product-intelligence-repo.ts import these definitions so this module
 * survives the Phase 3 PI deletion. Table names are unchanged by ruling:
 * the table stays `product_intelligence_assets` (renaming buys nothing and
 * risks live onboarding rows).
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';

/** Row shape of `product_intelligence_assets`. */
export interface PiAssetRow {
  id: string;
  runId: string;
  sourceId: string | null;
  sourceUrl: string;
  sourcePageUrl: string | null;
  sourceType: string;
  sourcePath: string | null;
  sourceArtifactId: string | null;
  extractionMethod: string;
  retrievedAt: string;
  originalContentHash: string;
  perceptualHash: string | null;
  variantReference: string | null;
  rightsStatus: string;
  rightsBasis: string | null;
  rightsEvidenceRef: string | null;
  observedBrand: string | null;
  observedProductName: string | null;
  observedVariant: string | null;
  observedNetContentJson: string | null;
  observedPackCount: number | null;
  observedGtin: string | null;
  exactProductMatch: number;
  exactVariantMatch: number | null;
  qualityStatus: string;
  commerceApproved: number;
  conflictsJson: string;
  payloadJson: string;
  createdAt: string;
  /** Round-4: canonical identity snapshot (runId+gtin+name) the asset was
   *  verified against — binds the asset to the run's immutable identity. */
  verifiedAgainstJson: string | null;
  verifiedAgainstHash: string | null;
  /** Round-4: durable source-kind derived from the source row at
   *  verification time (never the agent's declared string). */
  declaredSourceType: string | null;
  /** Round-10/11: exact pi_image_candidates FK the asset was verified from
   *  (same-run + image_url === source_url enforced by trigger). */
  candidateId: string | null;
  /** Round-12: qualifying brand evidence binding (row id + content hash). */
  brandEvidenceId?: string | null;
  brandEvidenceHash?: string | null;
}

export const ASSET_SELECT = `
  SELECT id, run_id AS runId, source_id AS sourceId, source_url AS sourceUrl,
         source_page_url AS sourcePageUrl, source_type AS sourceType,
         source_path AS sourcePath, source_artifact_id AS sourceArtifactId,
         extraction_method AS extractionMethod, retrieved_at AS retrievedAt,
         original_content_hash AS originalContentHash, perceptual_hash AS perceptualHash,
         variant_reference AS variantReference, rights_status AS rightsStatus,
         rights_basis AS rightsBasis, rights_evidence_ref AS rightsEvidenceRef,
         observed_brand AS observedBrand, observed_product_name AS observedProductName,
         observed_variant AS observedVariant, observed_net_content_json AS observedNetContentJson,
         observed_pack_count AS observedPackCount, observed_gtin AS observedGtin,
         exact_product_match AS exactProductMatch, exact_variant_match AS exactVariantMatch,
         quality_status AS qualityStatus, commerce_approved AS commerceApproved,
         conflicts_json AS conflictsJson, payload_json AS payloadJson, created_at AS createdAt,
         verified_against_json AS verifiedAgainstJson, verified_against_hash AS verifiedAgainstHash,
         declared_source_type AS declaredSourceType,
         candidate_id AS candidateId, brand_evidence_id AS brandEvidenceId,
         brand_evidence_hash AS brandEvidenceHash
  FROM product_intelligence_assets
`;

const now = () => new Date().toISOString();

export function insertOnboardingPiAsset(input: {
  onboardingItemId: string;
  sourceUrl: string;
  sourceType: string;
  extractionMethod: string;
  retrievedAt: string;
  originalContentHash: string;
  perceptualHash?: string | null;
  rightsStatus: 'approved' | 'restricted' | 'unknown';
  rightsBasis?: string | null;
  rightsEvidenceRef?: string | null;
  observedBrand?: string | null;
  observedProductName?: string | null;
  observedVariant?: string | null;
  observedNetContent?: unknown;
  observedPackCount?: number | null;
  observedGtin?: string | null;
  exactProductMatch?: boolean;
  exactVariantMatch?: boolean | null;
  qualityStatus: 'usable' | 'low_quality' | 'invalid';
  commerceApproved?: boolean;
  conflicts?: string[];
  payload?: unknown;
  verifiedAgainstJson?: string | null;
  verifiedAgainstHash?: string | null;
  declaredSourceType?: string | null;
  brandEvidenceId?: string | null;
  brandEvidenceHash?: string | null;
}): PiAssetRow {
  const db = getDb();
  const id = randomUUID();
  db.run(
    `INSERT OR IGNORE INTO product_intelligence_assets
     (id, run_id, source_id, source_url, source_page_url, source_type,
      source_path, source_artifact_id, extraction_method, retrieved_at,
      original_content_hash, perceptual_hash, variant_reference, rights_status,
      rights_basis, rights_evidence_ref, observed_brand, observed_product_name,
      observed_variant, observed_net_content_json, observed_pack_count,
      observed_gtin, exact_product_match, exact_variant_match, quality_status,
      commerce_approved, conflicts_json, payload_json, created_at,
      verified_against_json, verified_against_hash, declared_source_type,
      candidate_id, brand_evidence_id, brand_evidence_hash, origin,
      onboarding_item_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      null,
      null,
      input.sourceUrl,
      null,
      input.sourceType,
      null,
      null,
      input.extractionMethod,
      input.retrievedAt,
      input.originalContentHash,
      input.perceptualHash ?? null,
      null,
      input.rightsStatus,
      input.rightsBasis ?? null,
      input.rightsEvidenceRef ?? null,
      input.observedBrand ?? null,
      input.observedProductName ?? null,
      input.observedVariant ?? null,
      input.observedNetContent ? JSON.stringify(input.observedNetContent) : null,
      input.observedPackCount ?? null,
      input.observedGtin ?? null,
      input.exactProductMatch ? 1 : 0,
      input.exactVariantMatch === null || input.exactVariantMatch === undefined ? null : input.exactVariantMatch ? 1 : 0,
      input.qualityStatus,
      input.commerceApproved ? 1 : 0,
      JSON.stringify(input.conflicts ?? []),
      input.payload ? JSON.stringify(input.payload) : '{}',
      now(),
      input.verifiedAgainstJson ?? null,
      input.verifiedAgainstHash ?? null,
      input.declaredSourceType ?? null,
      null,
      input.brandEvidenceId ?? null,
      input.brandEvidenceHash ?? null,
      'onboarding_distributor',
      input.onboardingItemId,
    ],
  );
  const row = db.query(
    `${ASSET_SELECT} WHERE origin = 'onboarding_distributor' AND onboarding_item_id = ? AND source_url = ?`,
  ).get(input.onboardingItemId, input.sourceUrl) as PiAssetRow;
  return row;
}

/** Verified assets for an onboarding item (origin onboarding_distributor). */
export function listPiAssetsByOnboardingItem(itemId: string): PiAssetRow[] {
  const db = getDb();
  return db.query(
    `${ASSET_SELECT} WHERE origin = 'onboarding_distributor' AND onboarding_item_id = ? ORDER BY created_at ASC`,
  ).all(itemId) as PiAssetRow[];
}

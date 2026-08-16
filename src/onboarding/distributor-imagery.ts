/**
 * Onboarding distributor imagery verification (epic #46 follow-up, PI-6
 * reuse for the onboarding pipeline).
 *
 * Distributor records already carry RIGHTS-ATTESTED approvals
 * (distributorImageApprovals, `distributor_channel_opt_in` — the operator's
 * explicit licensed-opt-in). This service runs the deterministic PI-6
 * verification pipeline (`verifyImageCandidate`) over those approved URLs:
 *
 * - durable reuse grants are seeded per image domain (tier 'supplier',
 *   terms recording the channel opt-in) so rights resolve 'approved';
 * - when a local VLM is configured, packaging OCR supplies BYTE-BOUND
 *   identity facts (the OCR content hash must equal the fetched bytes) so
 *   `classifyAssetIdentity` can establish an exact GTIN/brand match;
 * - every outcome persists as a durable `product_intelligence_assets` row
 *   (origin 'onboarding_distributor', linked to the onboarding item) —
 *   commerce-approved when identity + quality + rights hold, display-only
 *   otherwise;
 * - idempotent per (item, source_url).
 *
 * The review drawer renders the approved URLs regardless of verification
 * outcome (display-only until the asset is commerce-approved); the draft
 * promoter already gates commerce downloads on the approvals list.
 */
import { PolicyGateway } from '../product-intelligence/policy/policy-gateway';
import { ProductIntelligencePolicySchema } from '../product-intelligence/contracts';
import { verifyImageCandidate, type ResolvedEvidenceFact } from '../product-intelligence/assets/verification';
import type { ProductAssetEvidence } from '../product-intelligence/assets/schema';
import type { ImageVerificationContract } from '../product-intelligence/assets/contract';
import { buildReuseGrantResolver, upsertReusePolicy } from '../db/repositories/pi-reuse-policy-repo';
import { insertOnboardingPiAsset, listPiAssetsByOnboardingItem } from '../db/repositories/product-intelligence-repo';
import { getDb } from '../db/connection';
import { listItemsByBatch } from '../db/repositories/onboarding-item-repo';
import type { OnboardingItem } from '../shared/schemas/onboarding';
import { extractPackagingOcr } from './packaging-ocr';
import { getVlmConfig } from './vlm-client';
import { isLoopbackBaseUrl } from '../classification/model-policy-gateway';
import type { DistributorImageApproval } from '../shared/schemas/onboarding';

/** Frozen onboarding verification policy: public network (CDN fetches),
 *  bounded response size, standard SSRF/protocol protections from the
 *  gateway. */
const ONBOARDING_IMAGERY_POLICY = ProductIntelligencePolicySchema.parse({
  configId: 'onboarding-distributor-imagery-v1',
  networkPolicy: 'allowlisted_remote',
  dataSharingPolicy: 'cloud_models_and_sources',
  domainAllowlist: [],
  allowedTools: [],
  researchTools: [],
  maxResponseBytes: 10 * 1024 * 1024,
});

export interface DistributorImagerySummary {
  items: number;
  images: number;
  verified: number;
  commerceApproved: number;
  displayOnly: number;
  failed: number;
  /** URLs skipped: already verified (durable row) or display-only origin. */
  skipped: number;
  skippedVlmOcr: boolean;
  perItem: Array<{
    itemId: string;
    upc: string;
    images: number;
    commerceApproved: number;
  }>;
}

export interface DistributorImageryDeps {
  /** OCR override for tests (default: real extractPackagingOcr). */
  ocr?: typeof extractPackagingOcr;
  /** Gateway fetch override for tests. */
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Pixel-decode contract override for tests (default: sharp adapter). */
  contract?: ImageVerificationContract;
}

/** Distinct image domains across a batch's RIGHTS-ATTESTED distributor
 *  imagery. Only approvals carrying the operator's explicit channel opt-in
 *  (origin `distributor_channel_opt_in` + `rightsAttested: true`) may seed
 *  reuse grants — any other approval shape stays display-only (PI-6 review
 *  round 2, HIGH-1: "the approval record itself is the authorization" must
 *  be enforced, not assumed). */
export function distributorImageDomains(batchId: string): string[] {
  const db = getDb();
  const rows = db.query(
    `SELECT extraction_data_json FROM onboarding_items
     WHERE batch_id = ? AND source_type = 'distributor_record'`,
  ).all(batchId) as Array<{ extraction_data_json: string | null }>;
  const domains = new Set<string>();
  for (const row of rows) {
    if (!row.extraction_data_json) continue;
    try {
      const data = JSON.parse(row.extraction_data_json) as { distributorImageApprovals?: DistributorImageApproval[] };
      for (const approval of data.distributorImageApprovals ?? []) {
        if (approval.approvalOrigin !== 'distributor_channel_opt_in' || approval.rightsAttested !== true) continue;
        try {
          domains.add(new URL(approval.imageUrl).hostname.toLowerCase());
        } catch {
          // unparseable URL — skip
        }
      }
    } catch {
      // corrupt payload — skip
    }
  }
  return [...domains].sort();
}

/** Seed supplier-tier reuse grants for the batch's image domains. The
 *  operator's explicit channel opt-in (distributorImageApprovals with origin
 *  distributor_channel_opt_in) IS the authorization; the grant records it
 *  durably so `verifyImageCandidate` resolves rights server-side. */
export function authorizeDistributorImageDomains(batchId: string, workspaceId: string): string[] {
  const domains = distributorImageDomains(batchId);
  for (const domain of domains) {
    upsertReusePolicy({
      workspaceId,
      sourceTier: 'supplier',
      domainPattern: domain,
      allowed: true,
      terms: 'Distributor channel opt-in (licensed distributor imagery) — operator-authorized via onboarding batch verification',
    });
  }
  return domains;
}

function approvedImagesOf(item: OnboardingItem): DistributorImageApproval[] {
  const data = item.extractionData as Record<string, unknown> | null;
  const approvals = (data?.distributorImageApprovals ?? []) as DistributorImageApproval[];
  return approvals.filter((a) => typeof a?.imageUrl === 'string' && a.imageUrl.length > 0);
}

/** Resolve the item's durable evidence attempts as verification facts. */
function attemptFacts(item: OnboardingItem, imageUrl: string): ResolvedEvidenceFact[] {
  const db = getDb();
  const attempts = db.query(
    `SELECT id, provider_id, identity_json FROM onboarding_evidence_attempts WHERE item_id = ? AND outcome = 'found'`,
  ).all(item.id) as Array<{ id: string; provider_id: string; identity_json: string | null }>;
  const facts: ResolvedEvidenceFact[] = [];
  for (const attempt of attempts) {
    if (!attempt.identity_json) continue;
    let identity: Record<string, unknown>;
    try {
      identity = JSON.parse(attempt.identity_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    // The attempt's OWN images bind this evidence to the URL being verified.
    const images = Array.isArray(identity.images) ? (identity.images as string[]) : [];
    if (!images.some((u) => u === imageUrl)) continue;
    const addFact = (targetField: string, value: unknown): void => {
      if (value === null || value === undefined || value === '') return;
      facts.push({
        id: attempt.id,
        targetField,
        value,
        extractionMethod: 'distributor_catalog',
        snippet: null,
        sourceUrl: imageUrl,
        sourceDomain: null,
        contentHash: null,
        entityId: attempt.id,
        matchedNamespace: 'row_id',
      });
    };
    addFact('gtin', identity.upc ?? identity.gtin);
    addFact('brand', identity.brand);
    addFact('name', identity.name);
    for (const [key, value] of Object.entries(identity)) {
      if (['gtin', 'upc', 'brand', 'name'].includes(key)) continue;
      addFact(key, value);
    }
  }
  return facts;
}

/**
 * Verify one approved distributor image end-to-end. Returns the evidence
 * record (commerce-approved when identity+quality+rights hold).
 */
export async function verifyDistributorImage(
  item: OnboardingItem,
  imageUrl: string,
  workspacePath: string,
  workspaceId: string,
  deps: DistributorImageryDeps = {},
): Promise<{ record: ProductAssetEvidence; skippedVlmOcr: boolean }> {
  const gateway = new PolicyGateway(deps.fetchFn ? { fetchFn: deps.fetchFn } : {})
  const ocr = deps.ocr ?? extractPackagingOcr;
  const evidenceIds: string[] = [];

  // Byte-bound packaging OCR — ONLY when it is free. The effective VLM route
  // (AI Compute visionOcr, falling back to api_keys ollama_vlm) may point at
  // a CLOUD provider (e.g. openai-cloud / gpt-5.6-luna) — the operator's rule:
  // automatic imagery verification must never burn paid tokens. A non-loopback
  // route skips OCR entirely (verification continues, identity from catalog
  // evidence only → display-only assets). An injected deps.ocr is a test seam
  // and always allowed.
  let skippedVlmOcr = true;
  const ocrFacts: ResolvedEvidenceFact[] = [];
  const ocrIsFree =
    deps.ocr !== undefined ||
    (() => {
      try {
        const vlm = getVlmConfig();
        return vlm?.enabled === true && isLoopbackBaseUrl(vlm.baseUrl);
      } catch {
        return false;
      }
    })();
  if (!ocrIsFree) {
    console.log(
      `[DistributorImagery] Skipping OCR for ${imageUrl} — configured VLM route is not loopback (cloud tokens); verification continues display-only`,
    );
  }
  if (ocrIsFree) {
    try {
      const ocrData = await ocr({ imageUrl, workspacePath, sku: item.upc ?? null });
    if (ocrData && ocrData.contentHash) {
      skippedVlmOcr = false;
      const addOcrFact = (targetField: string, value: unknown): void => {
        if (value === null || value === undefined || value === '') return;
        const id = `ocr_${item.id}_${Buffer.from(imageUrl).toString('hex').slice(0, 12)}_${targetField}`;
        evidenceIds.push(id);
        ocrFacts.push({
          id,
          targetField,
          value,
          extractionMethod: 'image_ocr',
          snippet: null,
          sourceUrl: imageUrl,
          sourceDomain: null,
          contentHash: ocrData.contentHash,
          entityId: item.id,
          matchedNamespace: 'row_id',
        });
      };
      addOcrFact('gtin', ocrData.upc);
      addOcrFact('brand', ocrData.brand);
      addOcrFact('name', ocrData.productName);
    }
    } catch {
      // No OCR → display-only path (identity from catalog evidence only).
    }
  }

  const attemptFactsForUrl = attemptFacts(item, imageUrl);
  for (const fact of attemptFactsForUrl) evidenceIds.push(fact.id);

  const evidenceResolver = (ids: string[]): ResolvedEvidenceFact[] => {
    const all = [...attemptFactsForUrl, ...ocrFacts];
    const byId = new Map(all.map((f) => [f.id, f]));
    return ids.map((id) => byId.get(id)).filter((f): f is ResolvedEvidenceFact => f !== undefined);
  };

  const record = await verifyImageCandidate(
    {
      url: imageUrl,
      sourcePageUrl: null,
      extractionMethod: 'image_ocr',
      runIdentity: {
        gtin: item.upc ?? null,
        name: item.name ?? null,
        variant: null,
        netContent: null,
        packCount: null,
        flavor: null,
        formula: null,
      },
      expectedGtin: item.upc ?? null,
      expectedBrand: item.brandHint ?? null,
      expectedName: item.name ?? null,
      evidenceIds,
      // Round-8 content-addressed linkage: prior verified assets for THIS
      // item+URL (server-derived — the first verification has none, OCR
      // covers the byte binding).
      assetGtinLinkages: [],
    },
    {
      runId: `onboarding:${item.id}`,
      policy: ONBOARDING_IMAGERY_POLICY,
      gateway,
      signal: new AbortController().signal,
      evidenceResolver,
      contract: deps.contract,
      // The distributor IS the supplier tier (rights resolve via the
      // seeded reuse grant below).
      sourceTypeResolver: () => 'supplier',
      reuseGrantResolver: buildReuseGrantResolver(workspaceId),
    },
  );
  return { record, skippedVlmOcr };
}

/**
 * Verify all approved distributor imagery for a batch: authorize domains,
 * run PI-6 verification per image, persist durable assets. Returns a
 * per-item summary. Idempotent — re-runs skip already-verified URLs (the
 * durable (item, url) asset row is the verified-state authority).
 */
export interface DistributorItemVerificationResult {
  itemId: string;
  upc: string;
  images: number;
  verified: number;
  commerceApproved: number;
  displayOnly: number;
  failed: number;
  skipped: number;
  skippedVlmOcr: boolean;
}

/**
 * Verify ONE item's approved distributor imagery (PI-6 pipeline):
 * rights-attested opt-in approvals only, already-verified URLs skipped,
 * durable assets persisted. Pure side effect on the asset table; NEVER
 * throws for expected outcomes (network/OCR failures degrade counts).
 * Used by the batch sweep and by automatic promotion-time verification.
 */
export async function verifyDistributorImageryForItem(
  item: OnboardingItem,
  workspacePath: string,
  workspaceId: string,
  deps: DistributorImageryDeps = {},
): Promise<DistributorItemVerificationResult> {
  const result: DistributorItemVerificationResult = {
    itemId: item.id,
    upc: item.upc ?? '',
    images: 0,
    verified: 0,
    commerceApproved: 0,
    displayOnly: 0,
    failed: 0,
    skipped: 0,
    skippedVlmOcr: false,
  };
  if (item.sourceType !== 'distributor_record') return result;
  result.images = approvedImagesOf(item).length;
  if (result.images === 0) return result;

  // Seed supplier-tier reuse grants for this item's opt-in image domains
  // (idempotent upserts — the batch sweep seeds the same grants). Without
  // the durable grant, `verifyImageCandidate` resolves rights as denied and
  // every image would verify display-only.
  const optInUrls = approvedImagesOf(item)
    .filter((a) => a.approvalOrigin === 'distributor_channel_opt_in' && a.rightsAttested === true)
    .map((a) => a.imageUrl);
  for (const domain of new Set(optInUrls.map((url) => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }).filter((d): d is string => d !== null))) {
    upsertReusePolicy({
      workspaceId,
      sourceTier: 'supplier',
      domainPattern: domain,
      allowed: true,
      terms: 'Distributor channel opt-in (licensed distributor imagery) — operator-authorized via onboarding batch verification',
    });
  }

  const verifiedUrls = new Set(listPiAssetsByOnboardingItem(item.id).map((a) => a.sourceUrl));
  for (const approval of approvedImagesOf(item)) {
    // Display-only approvals (non-opt-in origins) never enter the
    // verification pipeline (review round 2, HIGH-1).
    if (approval.approvalOrigin !== 'distributor_channel_opt_in' || approval.rightsAttested !== true) {
      result.skipped += 1;
      continue;
    }
    // Already verified in a previous run — the durable row is the
    // authority; never re-fetch/re-OCR (review round 2, MEDIUM-4).
    if (verifiedUrls.has(approval.imageUrl)) {
      result.skipped += 1;
      const existing = listPiAssetsByOnboardingItem(item.id).find((a) => a.sourceUrl === approval.imageUrl);
      if (existing?.commerceApproved) result.commerceApproved += 1;
      continue;
    }
    const { record, skippedVlmOcr } = await verifyDistributorImage(item, approval.imageUrl, workspacePath, workspaceId, deps);
    result.skippedVlmOcr = result.skippedVlmOcr || skippedVlmOcr;
    if (record.qualityStatus === 'invalid') {
      result.failed += 1;
      continue;
    }
    result.verified += 1;
    insertOnboardingPiAsset({
      onboardingItemId: item.id,
      sourceUrl: approval.imageUrl,
      sourceType: record.sourceType ?? 'supplier',
      extractionMethod: record.extractionMethod ?? 'image_ocr',
      retrievedAt: record.retrievedAt,
      originalContentHash: record.originalContentHash,
      perceptualHash: record.perceptualHash ?? null,
      rightsStatus: record.rightsStatus,
      rightsBasis: record.rightsBasis ?? null,
      rightsEvidenceRef: record.rightsEvidenceRef ?? null,
      observedBrand: record.observedBrand ?? null,
      observedProductName: record.observedProductName ?? null,
      observedVariant: record.observedVariant ?? null,
      observedNetContent: record.observedNetContent ?? null,
      observedPackCount: record.observedPackCount ?? null,
      observedGtin: record.observedGtin ?? null,
      exactProductMatch: record.exactProductMatch,
      exactVariantMatch: record.exactVariantMatch,
      qualityStatus: record.qualityStatus,
      commerceApproved: record.commerceApproved,
      conflicts: record.conflicts,
      payload: record,
      verifiedAgainstJson: record.verifiedAgainst ? JSON.stringify(record.verifiedAgainst) : null,
      verifiedAgainstHash: record.verifiedAgainstHash ?? null,
      declaredSourceType: record.sourceType ?? 'supplier',
      brandEvidenceId: record.brandEvidenceId ?? null,
      brandEvidenceHash: record.brandEvidenceHash ?? null,
    });
    if (record.commerceApproved) {
      result.commerceApproved += 1;
    } else {
      result.displayOnly += 1;
    }
  }
  return result;
}

/**
 * Verify all approved distributor imagery for a batch: authorize domains,
 * run PI-6 verification per image, persist durable assets. Returns a
 * per-item summary. Idempotent — re-runs skip already-verified URLs (the
 * durable (item, url) asset row is the verified-state authority).
 */
export async function verifyDistributorImageryForBatch(
  batchId: string,
  workspaceId: string,
  workspacePath: string,
  deps: DistributorImageryDeps = {},
): Promise<DistributorImagerySummary> {
  authorizeDistributorImageDomains(batchId, workspaceId);
  const items = listItemsByBatch(batchId).filter(
    (i) => i.sourceType === 'distributor_record' && approvedImagesOf(i).length > 0,
  );
  const summary: DistributorImagerySummary = {
    items: items.length,
    images: 0,
    verified: 0,
    commerceApproved: 0,
    displayOnly: 0,
    failed: 0,
    skipped: 0,
    skippedVlmOcr: false,
    perItem: [],
  };

  for (const item of items) {
    const r = await verifyDistributorImageryForItem(item, workspacePath, workspaceId, deps);
    summary.images += r.images;
    summary.verified += r.verified;
    summary.commerceApproved += r.commerceApproved;
    summary.displayOnly += r.displayOnly;
    summary.failed += r.failed;
    summary.skipped += r.skipped;
    summary.skippedVlmOcr = summary.skippedVlmOcr || r.skippedVlmOcr;
    summary.perItem.push({ itemId: r.itemId, upc: r.upc, images: r.images, commerceApproved: r.commerceApproved });
  }
  return summary;
}

/**
 * Identity and catalog research tools (PI-3).
 *
 * validate_gtin, lookup_existing_product, lookup_existing_onboarding_evidence,
 * lookup_supplier_product, lookup_distributor_product, and
 * lookup_structured_product_database. All read-only; all return evidence ids
 * and explicit no-result outcomes. The agent never touches repositories
 * directly — these adapters are the only path.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/20
 */
import { Type } from 'typebox';
import { getDb } from '../../db/connection';
import { getEvidenceAttemptsForItem } from '../../db/repositories/onboarding-evidence-repo';
import { findProductBySku } from '../../db/repositories/product-index-repo';
import { fetchOpenIcecatByGtin } from '../../crawler/importers/icecat';
import { defaultPolicyGateway } from '../policy';
import type { PiToolAdapter, PiToolContext, PiToolResult } from './contract';
import { errorResult, evidenceId, noResult, okResult, policyDenied, upcCheckDigit } from './contract';
import { boundedString } from './registry';

function normalizeGtin(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

export const validateGtin: PiToolAdapter = {
  name: 'validate_gtin',
  version: '1.0.0',
  description:
    'Validate and normalize a GTIN/UPC: returns the normalized digits, length, and (for 12-digit UPCs) whether the check digit verifies. Use before any other identity tool.',
  parameters: Type.Object({ gtin: boundedString(64, 'GTIN/UPC to validate') }),
  promptGuidelines: ['Normalize GTINs first (digits only) before comparing across sources.'],
  async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
    const raw = String(params.gtin ?? '');
    const normalized = normalizeGtin(raw);
    if (!normalized) {
      return noResult(`"${raw.slice(0, 40)}" is not a valid GTIN (must be 8-14 digits)`);
    }
    const checkDigitOk = normalized.length === 12 ? upcCheckDigit(normalized.slice(0, 11)) === Number(normalized[11]) : null;
    return okResult(
      {
        normalized,
        length: normalized.length,
        checkDigitValid: checkDigitOk,
        notes: checkDigitOk === false ? 'UPC check digit does not verify — possible transcription error' : undefined,
      },
      [{ id: evidenceId('validate_gtin', normalized), kind: 'gtin_evidence', method: 'gtin_normalization' }],
    );
  },
};

const lookupExistingProduct: PiToolAdapter = {
  name: 'lookup_existing_product',
  version: '1.0.0',
  description:
    'Look up an existing product in the approved catalog index by SKU or GTIN. Returns catalog fields (title, price, image, status) or no_result.',
  parameters: Type.Object({ gtin: boundedString(64, 'GTIN/UPC or SKU to look up') }),
  async execute(params: Record<string, unknown>, _ctx: PiToolContext): Promise<PiToolResult> {
    const key = String(params.gtin ?? '');
    const row = findProductBySku(key) ?? findProductBySku(normalizeGtin(key) ?? '');
    if (!row) return noResult(`No catalog product found for "${key.slice(0, 40)}"`);
    return okResult(
      {
        sku: row.sku,
        title: row.title,
        price: row.price,
        primaryImage: row.primaryImage,
        status: row.status,
        filePath: row.filePath,
        productHash: row.productHash,
        lastApprovedCommit: row.lastApprovedCommit,
      },
      [{ id: evidenceId('lookup_existing_product', key), kind: 'catalog_evidence', method: 'catalog_index_lookup' }],
    );
  },
};

const lookupExistingOnboardingEvidence: PiToolAdapter = {
  name: 'lookup_existing_onboarding_evidence',
  version: '1.0.0',
  description:
    'Look up previously collected onboarding evidence for an item (discovery sources, extraction attempts, selected source). Returns a safe projection or no_result.',
  parameters: Type.Object({
    onboardingItemId: boundedString(128, 'Onboarding item id'),
    upc: Type.Optional(boundedString(64, 'UPC to filter by')),
  }),
  async execute(params: Record<string, unknown>, _ctx: PiToolContext): Promise<PiToolResult> {
    const itemId = String(params.onboardingItemId ?? '');
    const attempts = getEvidenceAttemptsForItem(itemId);
    const db = getDb();
    const sources = db
      .query(
        `SELECT id, url, domain, source_kind AS sourceKind, upc, selected
         FROM onboarding_sources
         WHERE item_id = ? ${params.upc ? 'AND upc = ?' : ''}
         ORDER BY created_at DESC LIMIT 25`,
      )
      .all(...(params.upc ? [itemId, String(params.upc)] : [itemId])) as Array<Record<string, unknown>>;
    if (attempts.length === 0 && sources.length === 0) {
      return noResult(`No onboarding evidence for item ${itemId}`);
    }
    return okResult(
      {
        itemId,
        sources: sources.map((s) => ({
          id: s.id,
          url: s.url,
          domain: s.domain,
          sourceKind: s.sourceKind,
          upc: s.upc,
          selected: s.selected,
        })),
        evidenceAttempts: attempts.map((a) => ({
          id: a.id,
          providerId: a.providerId,
          outcome: a.outcome,
          upc: a.lookupUpc,
          evidenceUrl: a.evidenceUrl,
          matchedFields: a.matchedFields,
          confidence: a.confidence,
          createdAt: a.createdAt,
        })),
      },
      [{ id: evidenceId('lookup_existing_onboarding_evidence', itemId), kind: 'catalog_evidence', method: 'onboarding_evidence_lookup' }],
    );
  },
};

function lookupSourceByKind(kind: 'supplier' | 'distributor'): PiToolAdapter {
  return {
    name: `lookup_${kind}_product`,
    version: '1.0.0',
    description:
      `Look up ${kind} catalog data for a GTIN from previously collected onboarding sources of that kind. ` +
      'Returns source URLs, titles, and evidence references or no_result.',
    parameters: Type.Object({ gtin: boundedString(64, 'GTIN/UPC') }),
    async execute(params, _ctx: PiToolContext): Promise<PiToolResult> {
      const gtin = String(params.gtin ?? '');
      const db = getDb();
      const rows = db
        .query(
          `SELECT DISTINCT s.url, s.domain, s.title, s.source_kind AS sourceKind, s.created_at AS createdAt
           FROM onboarding_sources s
           WHERE s.upc = ? AND s.source_kind = ?
           ORDER BY s.created_at DESC LIMIT 20`,
        )
        .all(gtin, kind) as Array<{ url: string; domain: string; title: string | null; sourceKind: string; createdAt: string }>;
      if (rows.length === 0) return noResult(`No ${kind} source found for ${gtin}`);
      return okResult(
        { gtin, kind, sources: rows },
        rows.map((row) => ({
          id: evidenceId(`lookup_${kind}_product`, `${gtin}:${row.url}`),
          kind: 'supplier_evidence' as const,
          url: row.url,
          domain: row.domain,
          method: `${kind}_source_lookup`,
          snippet: row.title ? row.title.slice(0, 200) : undefined,
        })),
      );
    },
  };
}

const lookupStructuredProductDatabase: PiToolAdapter = {
  name: 'lookup_structured_product_database',
  version: '1.0.0',
  description:
    'Look up a GTIN in an open structured product database (Open Icecat). Returns title, brand, category, features, and images or no_result when unavailable.',
  parameters: Type.Object({ gtin: boundedString(64, 'GTIN/UPC') }),
  async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
    const gtin = String(params.gtin ?? '');
    const gateway = ctx.gateway ?? defaultPolicyGateway;
    const netCtx = { runId: ctx.runId, policy: ctx.policy };
    // P0-1 (round 2): the Open Icecat SDK and REST fallback both perform
    // their own networking — pre-check the endpoint through the policy
    // gateway so restrictive policies deny the lookup before any bytes move,
    // and bind the REST fallback to the gateway-bound fetch below.
    const endpoint = `https://live.icecat.biz/api/?shop_name=OpenIcecatUser&gtin=${encodeURIComponent(gtin)}`;
    const decision = await gateway.checkNetworkRequest(netCtx, endpoint, 'fetched_content');
    if (!decision.allowed) {
      return policyDenied(`icecat lookup denied: ${decision.reasonCode}${decision.detail ? ` (${decision.detail})` : ''}`);
    }
    try {
      const product = await fetchOpenIcecatByGtin(
        gtin,
        undefined,
        gateway.buildPiNetworkFetch(netCtx, { dataClassification: 'fetched_content' }),
      );
      if (!product) return noResult(`No structured database record for ${gtin}`);
      return okResult(
        {
          gtin,
          title: product.title,
          brand: product.brand,
          description: product.description,
          images: product.images,
        },
        [{ id: evidenceId('lookup_structured_product_database', gtin), kind: 'gtin_evidence', method: 'open_icecat_lookup' }],
      );
    } catch (error) {
      return errorResult('upstream_error', error instanceof Error ? error.message : String(error));
    }
  },
};

export const identityTools: PiToolAdapter[] = [
  validateGtin,
  lookupExistingProduct,
  lookupExistingOnboardingEvidence,
  lookupSourceByKind('supplier'),
  lookupSourceByKind('distributor'),
  lookupStructuredProductDatabase,
];

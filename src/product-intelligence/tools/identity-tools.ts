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
import { getPiRun } from '../../db/repositories/product-intelligence-repo';

function normalizeGtin(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 14 ? digits : null;
}

/**
 * Round-11 (review P0): the run's IMMUTABLE requested GTIN (from the run
 * input the operator supplied). Null when unavailable — fail closed: a run
 * whose input cannot be read never gets supplier-authoritative results.
 * Mirrors verification-tools' loadExpectedBrand pattern.
 */
function loadRunGtin(runId: string): string | null {
  try {
    const run = getPiRun(runId);
    if (!run?.inputJson) return null;
    const input = JSON.parse(run.inputJson) as { gtin?: unknown };
    const digits = typeof input.gtin === 'string' ? input.gtin.replace(/\D/g, '') : '';
    return digits.length >= 8 && digits.length <= 14 ? digits : null;
  } catch {
    return null;
  }
}

/**
 * Round-11 (review P0): prove an onboarding item belongs to the current
 * workspace (item -> batch -> workspace). Foreign or missing items are
 * INVISIBLE to research tools — possession of an item id is never
 * authorization. Fail closed: an unreadable ownership check denies.
 */
function onboardingItemInWorkspace(itemId: string, workspaceId: string): boolean {
  try {
    const row = getDb()
      .query(
        `SELECT i.id FROM onboarding_items i
         JOIN onboarding_batches b ON i.batch_id = b.id
         WHERE i.id = ? AND b.workspace_id = ?`,
      )
      .get(itemId, workspaceId) as { id: string } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Round-12 (review P0-1): supplier/distributor lookups deliberately do NOT
 * discriminate by a source_kind column. The column does not exist in the
 * migrated schema, and even when a future migration adds it, the kind is an
 * advisory discriminator on ordinary discovery rows — a tool name + kind
 * column must never mint the durable supplier tier. All onboarding-backed
 * supplier/distributor results are LEADS (catalog_evidence) until a durable
 * pi_source_authorities record references an actual CMS supplier record.
 */

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
    'Look up previously collected onboarding evidence for an item (discovery sources, extraction attempts, selected source). ' +
    'WORKSPACE-SCOPED (round-11): the item must belong to the current workspace — foreign items are denied with policy_denied. ' +
    'Returns a safe projection or no_result.',
  parameters: Type.Object({
    onboardingItemId: boundedString(128, 'Onboarding item id'),
    upc: Type.Optional(boundedString(64, 'UPC to filter by')),
  }),
  async execute(params: Record<string, unknown>, ctx: PiToolContext): Promise<PiToolResult> {
    const itemId = String(params.onboardingItemId ?? '');
    // Round-11 (review P0): resolve ownership FIRST. An arbitrary caller-
    // supplied onboarding item id must belong to the current workspace or
    // the read is denied outright.
    if (!onboardingItemInWorkspace(itemId, ctx.workspaceId)) {
      return policyDenied(`onboarding item ${itemId} does not belong to the current workspace`);
    }
    // Fail closed: when the evidence-attempts store is unavailable (the
    // table is not part of every migrated deployment), treat it as 'no
    // attempts recorded' — sources are still returned and the tool never
    // crashes or leaks.
    let attempts: Awaited<ReturnType<typeof getEvidenceAttemptsForItem>> = [];
    try {
      attempts = getEvidenceAttemptsForItem(itemId);
    } catch {
      // attempts stays [] — fail closed.
    }
    const db = getDb();
    const sources = db
      .query(
        `SELECT s.id, s.url, s.domain, s.source_method AS sourceKind, i.upc AS upc,
                s.is_selected AS selected, s.created_at AS createdAt
         FROM onboarding_sources s
         JOIN onboarding_items i ON s.item_id = i.id
         WHERE s.item_id = ? ${params.upc ? 'AND i.upc = ?' : ''}
         ORDER BY s.created_at DESC LIMIT 25`,
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
      `Look up ${kind} catalog data for a GTIN from previously collected onboarding sources ` +
      'WITHIN THE CURRENT WORKSPACE. Workspace-scoped (round-11): sources belonging to other workspaces are invisible. ' +
      'Round-12 (review P0-1): results are ALWAYS LEADS (catalog_evidence) — plain onboarding sources can never be ' +
      `${kind} authority. Supplier/distributor authority requires a first-class trusted relationship (a durable ` +
      'pi_source_authorities record referencing an actual CMS supplier record); evidence kind alone never mints it. ' +
      'Returns source URLs, titles, lead-only evidence references, or no_result.',
    parameters: Type.Object({ gtin: boundedString(64, 'GTIN/UPC') }),
    async execute(params, ctx: PiToolContext): Promise<PiToolResult> {
      const gtin = String(params.gtin ?? '');
      const db = getDb();
      // Round-11 (review P0): EVERY onboarding-backed research read resolves
      // through the current workspace — join source -> item -> batch/
      // workspace. A workspace-A run can never observe workspace-B sources.
      // The GTIN match is made against the ITEM's upc (the only truthful
      // GTIN linkage in the migrated schema).
      // Round-12 (review P0-1): the source_kind column does NOT exist in the
      // migrated schema, and even when a future migration adds it, the kind
      // column alone is NOT first-class supplier provenance — it is an
      // advisory discriminator on ordinary discovery rows (Serper/sitemap/
      // retailer). A tool NAME (lookup_supplier_product) and a kind column
      // must never mint the durable supplier tier, so the kind predicate is
      // DROPPED entirely: every workspace+GTIN-matching row is returned as a
      // LEAD. Trusted supplier authority can only come from a durable
      // pi_source_authorities record referencing an actual CMS supplier
      // record (not yet wired — see run-service sourceTypeOfKind).
      const args: unknown[] = [ctx.workspaceId, gtin];
      const rows = db
        .query(
          `SELECT DISTINCT s.url, s.domain, s.title, i.upc AS upc, s.created_at AS createdAt
           FROM onboarding_sources s
           JOIN onboarding_items i ON s.item_id = i.id
           JOIN onboarding_batches b ON i.batch_id = b.id
           WHERE b.workspace_id = ? AND i.upc = ?
           ORDER BY s.created_at DESC LIMIT 20`,
        )
        .all(...(args as string[])) as Array<{ url: string; domain: string; title: string | null; upc: string | null; createdAt: string }>;
      if (rows.length === 0) return noResult(`No ${kind} source found for ${gtin} in the current workspace`);
      // Round-11 (review P0): GTIN binding — cross-GTIN exploration is a
      // LEAD. Round-12 (review P0-1): even a same-GTIN hit is a LEAD — the
      // absence of a first-class trusted supplier relationship means no row
      // can be supplier-authoritative. Fail closed: when the run input
      // cannot be read, the lead warning states so.
      const runGtin = loadRunGtin(ctx.runId);
      const gtinMatches = runGtin !== null && runGtin === normalizeGtin(gtin);
      return okResult(
        {
          gtin,
          kind,
          sources: rows,
          leadOnly: true,
          crossGtinLead: !gtinMatches,
          warning:
            'supplier authority requires a first-class trusted supplier relationship (a durable pi_source_authorities ' +
            'record referencing an actual CMS supplier record); plain onboarding sources are leads only — this result ' +
            'is catalog_evidence, never supplier authority' +
            (gtinMatches
              ? ''
              : runGtin === null
                ? " and the run's immutable input GTIN is unavailable"
                : ` and the requested GTIN ${gtin} differs from the run's immutable GTIN ${runGtin}`),
        },
        rows.map((row) => ({
          id: evidenceId(`lookup_${kind}_product`, `${gtin}:${row.url}`),
          kind: 'catalog_evidence' as const,
          url: row.url,
          domain: row.domain,
          method: `${kind}_source_lookup_lead`,
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

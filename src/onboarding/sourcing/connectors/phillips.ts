import {
  type DistributorConnector,
  type SourcingLookupRequest,
  type SourcingLookupResult,
  normalizeGtin,
  type DistributorCatalogRecord,
} from '../contracts';
import { boundedFetchJson, SourcingHttpError, toSourceErrorCode } from '../bounded-fetch';

/**
 * Phillips Pet Food & Supplies connector (Endless Aisles REST API).
 *
 * Contract ported from the BayState repo `apps/web/lib/b2b/adapters/phillips.ts`
 * (field shapes + `/products` pagination) with the CMS security model:
 * `x-api-key` is resolved from `secretRef` server-side, requests are bounded
 * (HTTPS + configured origin, deadline, body cap, JSON content-type), and a
 * lookup NEVER treats an HTTP 200 with the wrong UPC/variant as `found`.
 *
 * v1 is a paged lookup: pages through `/products?page=&pageSize=` (bounded by
 * `maxPages`) and returns the first EXACT normalized UPC/GTIN match.
 */

interface PhillipsProductResponse {
  id?: unknown;
  upc?: unknown;
  gtin?: unknown;
  name?: unknown;
  description?: unknown;
  brand?: unknown;
  weight?: unknown;
  images?: unknown;
}

export interface PhillipsConnectorConfig {
  /** Non-secret base URL; default Endless Aisles production. */
  baseUrl?: string;
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
  /** Injectable transport (tests); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.endlessaisles.io/v1';

export class PhillipsConnector implements DistributorConnector {
  readonly connectorType = 'api' as const;
  readonly providerId = 'phillips';
  readonly requiresSecret = true;

  constructor(private readonly config: PhillipsConnectorConfig = {}) {}

  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    const identifier = normalizeGtin(request.upc) ?? normalizeGtin(request.gtin ?? null);
    if (!identifier) {
      return { outcome: 'source_error', code: 'no_identifier', message: 'no normalized identifier to look up' };
    }

    const apiKey = request.secret;
    if (!apiKey) {
      return { outcome: 'source_error', code: 'secret_missing', message: 'phillips api key is not configured' };
    }

    // Validate configuration (fail closed as config_invalid, never throw).
    const baseUrl = (typeof this.config.baseUrl === 'string' && this.config.baseUrl.length > 0)
      ? this.config.baseUrl
      : DEFAULT_BASE_URL;
    if (!/^https:\/\//.test(baseUrl)) {
      return { outcome: 'source_error', code: 'config_invalid', message: 'phillips baseUrl must be HTTPS' };
    }
    const pageSize = this.config.pageSize ?? 100;
    const maxPages = this.config.maxPages ?? 10;
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(maxPages) || maxPages < 1) {
      return { outcome: 'source_error', code: 'config_invalid', message: 'phillips pageSize/maxPages must be positive integers' };
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { outcome: 'source_error', code: 'config_invalid', message: 'phillips timeoutMs must be positive' };
    }

    // Honor the engine-composed deadline (min of request deadline and local
    // timeout) — the connector never re-implements cancellation.
    const localDeadline = new Date(Date.now() + timeoutMs).toISOString();
    const deadlineAt = request.deadlineAt && request.deadlineAt < localDeadline ? request.deadlineAt : localDeadline;

    try {
      for (let page = 1; page <= maxPages; page++) {
        const url = `${baseUrl}/products?page=${page}&pageSize=${pageSize}`;
        const data = await boundedFetchJson(url, baseUrl, {
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        }, { deadlineAt, signal: request.signal, fetchImpl: this.config.fetchImpl });

        // Exact-match-only verification is connector-internal; the ENGINE
        // additionally re-verifies matchedIdentifier === identifier.
        const items = Array.isArray((data as { items?: unknown }).items)
          ? (data as { items: unknown[] }).items
          : Array.isArray((data as { products?: unknown }).products)
            ? (data as { products: unknown[] }).products
            : null;
        if (!items) {
          return { outcome: 'source_error', code: 'bad_json', message: 'phillips response missing items array' };
        }

        const matches: PhillipsProductResponse[] = [];
        for (const raw of items) {
          const item = raw as PhillipsProductResponse;
          const upc = normalizeGtin(item.upc);
          const gtin = normalizeGtin(item.gtin);
          if (upc === identifier || gtin === identifier) {
            matches.push(item);
          }
        }

        if (matches.length > 0) {
          return foundResult(identifier, matches, request.brandHint ?? null);
        }

        // End of catalog (fewer items than page size).
        if (items.length < pageSize) {
          return { outcome: 'not_stocked', reason: 'no exact UPC/GTIN match in catalog' };
        }
      }
      return { outcome: 'not_stocked', reason: `no exact UPC/GTIN match within ${maxPages} pages` };
    } catch (e) {
      if (e instanceof SourcingHttpError) {
        return { outcome: 'source_error', code: e.code, message: e.message };
      }
      return { outcome: 'source_error', code: toSourceErrorCode(e), message: 'phillips lookup failed unexpectedly' };
    }
  }
}

function foundResult(
  identifier: string,
  matches: PhillipsProductResponse[],
  brandHint: string | null,
): SourcingLookupResult {
  // ADR 0014 variant rule: multiple exact-identifier records with CONFLICTING
  // critical identity (weight/name) are AMBIGUOUS — v1 requests carry no
  // structured variant expectation, so none of them is determinably correct.
  // Ambiguity is never a found coherent result: it returns not_stocked with
  // a reviewable reason (the operator continues to Discovery; nothing is
  // invented). Identical variant records collapse into one found result.
  const criticalValue = (m: PhillipsProductResponse): string => {
    const w = typeof m.weight === 'string' ? m.weight : typeof m.weight === 'number' ? String(m.weight) : '';
    const n = typeof m.name === 'string' ? m.name : '';
    return `${w}|${n}`.toLowerCase();
  };
  if (matches.length > 1) {
    const distinct = new Set(matches.map(criticalValue));
    if (distinct.size > 1) {
      return {
        outcome: 'not_stocked',
        reason: `ambiguous variant records: ${matches.length} catalog items share identifier ${identifier} with conflicting attributes (no structured variant expectation in v1)`,
      };
    }
  }

  // All matches agree on critical identity: brand hint breaks the tie for
  // cosmetic selection; otherwise the first — with a benign warning.
  let chosen = matches[0];
  let warnings: string[] = [];
  if (matches.length > 1) {
    const byBrand = brandHint
      ? matches.find((m) => typeof m.brand === 'string' && m.brand.toLowerCase().includes(brandHint.toLowerCase()))
      : undefined;
    if (byBrand) chosen = byBrand;
    warnings = [`${matches.length} catalog items share identifier ${identifier} with identical variant identity; selected one`];
  }

  const name = typeof chosen.name === 'string' ? chosen.name : null;
  const brand = typeof chosen.brand === 'string' ? chosen.brand : null;
  const weight = typeof chosen.weight === 'string' ? chosen.weight : typeof chosen.weight === 'number' ? String(chosen.weight) : null;
  const imageUrls = Array.isArray(chosen.images) ? chosen.images.filter((i): i is string => typeof i === 'string') : [];

  const record: DistributorCatalogRecord = {
    matchedIdentifier: identifier,
    distributorUpc: normalizeGtin(chosen.upc),
    gtin: normalizeGtin(chosen.gtin),
    distributorSku: null,
    name,
    description: typeof chosen.description === 'string' ? chosen.description : null,
    brand,
    manufacturerPartNumber: null,
    weight,
    features: [],
    category: null,
    dimensions: null,
    casePack: null,
    unitOfMeasure: null,
    ingredients: null,
    attributes: {},
    imageUrls,
    sourceUrl: null,
    catalogVersion: null,
    observedAt: new Date().toISOString(),
    expiresAt: null,
  };

  const matchedFields = ['upc'];
  if (name) matchedFields.push('name');
  if (brand) matchedFields.push('brand');
  if (weight) matchedFields.push('weight');

  return { outcome: 'found', record, matchedFields, warnings };
}

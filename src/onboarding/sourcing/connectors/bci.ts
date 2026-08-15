import {
  type DistributorConnector,
  type SourcingLookupRequest,
  type SourcingLookupResult,
  normalizeGtin,
  type DistributorCatalogRecord,
} from '../contracts';
import { boundedFetchJson, SourcingHttpError, toSourceErrorCode } from '../bounded-fetch';
import { OAuthClient, OAuthError } from '../oauth-client';

/**
 * BCI (OrderCloud) connector.
 *
 * Contract ported from the BayState repo `apps/web/lib/b2b/adapters/bci.ts`
 * + `utils/oauth.ts`: client-credentials OAuth2 against `auth.ordercloud.io`,
 * then paged `/me/products` lookups. CMS adaptations:
 * - token lives in MEMORY only (never persisted), resolved from the
 *   connection secret via the engine (`request.secret` = "clientId:clientSecret");
 * - the price-schedule N+1 is NOT part of v1 identity sourcing (excluded per
 *   the recovery plan);
 * - bounded transport (HTTPS + configured origin, deadline, body cap);
 * - an HTTP 200 with a non-matching `xp.UPC` is NEVER `found`.
 */

interface OrderCloudProductResponse {
  ID?: unknown;
  Name?: unknown;
  Description?: unknown;
  xp?: {
    UPC?: unknown;
    Brand?: unknown;
    Weight?: unknown;
    Images?: unknown;
  };
}

export interface BCIConnectorConfig {
  /** Non-secret base URL; default OrderCloud production. */
  baseUrl?: string;
  /** OAuth token server origin used for the origin allowlist check. */
  tokenOrigin?: string;
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
  /** Injectable transport (tests); defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.ordercloud.io/v1';
const DEFAULT_TOKEN_URL = 'https://auth.ordercloud.io/oauth/token';

/** Secret format for BCI: "clientId:clientSecret" (never logged). */
function parseClientCredentials(secret: string): { clientId: string; clientSecret: string } | null {
  const idx = secret.indexOf(':');
  if (idx <= 0 || idx === secret.length - 1) return null;
  return { clientId: secret.slice(0, idx), clientSecret: secret.slice(idx + 1) };
}

export class BCIConnector implements DistributorConnector {
  readonly connectorType = 'api' as const;
  readonly providerId = 'bci';
  readonly requiresSecret = true;

  private oauth: OAuthClient | null = null;

  constructor(private readonly config: BCIConnectorConfig = {}) {}

  private getOAuthClient(tokenUrl: string, credentials: { clientId: string; clientSecret: string }): OAuthClient {
    if (!this.oauth) {
      this.oauth = new OAuthClient({
        tokenUrl,
        configuredOrigin: tokenUrl,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        fetchImpl: this.config.fetchImpl,
      });
    }
    return this.oauth;
  }

  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    const identifier = normalizeGtin(request.upc) ?? normalizeGtin(request.gtin ?? null);
    if (!identifier) {
      return { outcome: 'source_error', code: 'no_identifier', message: 'no normalized identifier to look up' };
    }

    if (!request.secret) {
      return { outcome: 'source_error', code: 'secret_missing', message: 'bci client credentials are not configured' };
    }
    const credentials = parseClientCredentials(request.secret);
    if (!credentials) {
      return { outcome: 'source_error', code: 'secret_malformed', message: 'bci secret must be clientId:clientSecret' };
    }

    const baseUrl = this.config.baseUrl ?? DEFAULT_BASE_URL;
    const tokenUrl = this.config.tokenOrigin
      ? `${this.config.tokenOrigin}/oauth/token`
      : DEFAULT_TOKEN_URL;
    if (!/^https:\/\//.test(baseUrl) || !/^https:\/\//.test(tokenUrl)) {
      return { outcome: 'source_error', code: 'config_invalid', message: 'bci baseUrl/tokenOrigin must be HTTPS' };
    }
    const pageSize = this.config.pageSize ?? 100;
    const maxPages = this.config.maxPages ?? 10;
    const timeoutMs = this.config.timeoutMs ?? 30_000;
    if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(maxPages) || maxPages < 1) {
      return { outcome: 'source_error', code: 'config_invalid', message: 'bci pageSize/maxPages must be positive integers' };
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { outcome: 'source_error', code: 'config_invalid', message: 'bci timeoutMs must be positive' };
    }

    // Honor the engine-composed deadline (min of request deadline and local
    // timeout) — the connector never re-implements cancellation.
    const localDeadline = new Date(Date.now() + timeoutMs).toISOString();
    const deadlineAt = request.deadlineAt && request.deadlineAt < localDeadline ? request.deadlineAt : localDeadline;

    // Reuse the instance-level OAuth client: the token stays cached in
    // MEMORY for the lifetime of this connector (never persisted).
    const oauth = this.getOAuthClient(tokenUrl, credentials);

    let bearer: string;
    try {
      bearer = (await oauth.getBearerToken(request.signal, deadlineAt)) ?? '';
    } catch (e) {
      if (e instanceof OAuthError) {
        return { outcome: 'source_error', code: 'auth_failed', message: e.message };
      }
      return { outcome: 'source_error', code: 'auth_failed', message: 'bci authentication failed' };
    }
    if (!bearer) {
      return { outcome: 'source_error', code: 'auth_failed', message: 'bci authentication failed' };
    }

    try {
      for (let page = 1; page <= maxPages; page++) {
        const url = `${baseUrl}/me/products?page=${page}&pageSize=${pageSize}`;
        const data = await boundedFetchJson(url, baseUrl, {
          headers: { 'Content-Type': 'application/json', Authorization: bearer },
        }, { deadlineAt, signal: request.signal, fetchImpl: this.config.fetchImpl });

        const items = Array.isArray((data as { Items?: unknown }).Items)
          ? (data as { Items: unknown[] }).Items
          : null;
        if (!items) {
          return { outcome: 'source_error', code: 'bad_json', message: 'bci response missing Items array' };
        }

        for (const raw of items) {
          const item = raw as OrderCloudProductResponse;
          const upc = normalizeGtin(item.xp?.UPC);
          if (upc === identifier) {
            return foundResult(identifier, item, request.brandHint ?? null);
          }
        }

        if (items.length < pageSize) {
          return { outcome: 'not_stocked', reason: 'no exact xp.UPC match in catalog' };
        }
      }
      return { outcome: 'not_stocked', reason: `no exact xp.UPC match within ${maxPages} pages` };
    } catch (e) {
      if (e instanceof SourcingHttpError) {
        return { outcome: 'source_error', code: e.code, message: e.message };
      }
      return { outcome: 'source_error', code: toSourceErrorCode(e), message: 'bci lookup failed unexpectedly' };
    }
  }
}

function foundResult(
  identifier: string,
  item: OrderCloudProductResponse,
  brandHint: string | null,
): SourcingLookupResult {
  const name = typeof item.Name === 'string' ? item.Name : null;
  const brand = typeof item.xp?.Brand === 'string' ? item.xp.Brand : null;
  const weight = typeof item.xp?.Weight === 'string' ? item.xp.Weight : typeof item.xp?.Weight === 'number' ? String(item.xp.Weight) : null;
  const imageUrls = Array.isArray(item.xp?.Images) ? item.xp.Images.filter((i): i is string => typeof i === 'string') : [];

  const record: DistributorCatalogRecord = {
    matchedIdentifier: identifier,
    distributorUpc: identifier,
    gtin: identifier,
    distributorSku: typeof item.ID === 'string' ? item.ID : null,
    name,
    description: typeof item.Description === 'string' ? item.Description : null,
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

  const warnings = brandHint && brand && !brand.toLowerCase().includes(brandHint.toLowerCase())
    ? [`returned brand '${brand}' does not match advisory brand hint '${brandHint}'`]
    : [];

  return { outcome: 'found', record, matchedFields, warnings };
}

/**
 * Corpus record validation.
 *
 * Every Bronze observation must carry positive product-page evidence before it
 * is accepted into the offline corpus. Category/interstitial/blocked pages,
 * records without provenance, invalid URLs, and invalid GTINs are rejected
 * with an explicit code — never silently discarded.
 */

import { sha256Hex } from '../shared/stable-id.js';
import { computePayloadHash, validateGtin, ScrapedProductEvidenceSchema, type ScrapedProductEvidence } from './corpus-schema.js';
import { validateUrl, computeEntityId, type UrlValidationIssue } from './url-policy.js';

export type CorpusRejectionCode =
  | 'invalid_json'
  | 'missing_title'
  | 'non_product_page'
  | 'blocked_page'
  | 'invalid_url'
  | 'invalid_gtin'
  | 'missing_provenance'
  | 'duplicate_locator'
  | 'empty_content';

export interface CorpusValidationResult {
  ok: boolean;
  entityId?: string;
  observationId?: string;
  canonicalUrl?: string;
  rejectionCode?: CorpusRejectionCode;
  rejectionReason?: string;
}

export interface CorpusValidationOptions {
  /** Optional allowlist of registrable domains (e.g. known retailers). */
  allowedRegistrableDomains?: ReadonlySet<string>;
  /** Set of entity IDs already seen; collisions are rejected as duplicates. */
  seenEntityIds?: Set<string>;
}

/** Junk titles that indicate a non-product or blocked page. */
const JUNK_TITLE_PATTERNS = [
  /^technical page$/i,
  /^page not found$/i,
  /^404$/i,
  /^access denied$/i,
  /^forbidden$/i,
  /^sign in$/i,
  /^sign up$/i,
  /^account$/i,
  /^shop all\b/i,
  /^home$/i,
  /^search results$/i,
  /^cart$/i,
  /^checkout$/i,
  /^products$/i,
  /^brands$/i,
  /^learn\b/i,
];

/** URL path patterns that indicate category/index/interstitial pages. */
const NON_PRODUCT_PATH_PATTERNS = [
  /\/learn(?:\/|$)/i,
  /\/learn(?:\.html)?$/i,
  /\/brands?$/i,
  /\/shop-all\/?$/i,
  /\/shop\/(?:all|[a-z0-9-]+)\/?$/i,
  /\/home\/?$/i,
  /\/catalog\/(?:[a-z0-9-]+)\/?$/i,
  /\/category\/(?:[a-z0-9-]+)\/?$/i,
  /\/product-category\/(?:[a-z0-9-]+)\/?$/i,
  /\/collections\/(?:[a-z0-9-]+)\/?$/i,
  /\/search\?/i,
  /\/cart\/?$/i,
  /\/account\/?$/i,
  /\/login\/?$/i,
];

const BLOCKED_HOST_HINTS = [/recaptcha/i, /captcha/i, /interstitial/i];

function isProductPageEvidence(record: ScrapedProductEvidence): boolean {
  const title = (record.title || '').trim();
  if (title.length < 3) return false;
  if (JUNK_TITLE_PATTERNS.some((pattern) => pattern.test(title))) return false;

  const url = record.sourceUrl || record.rawUrl || '';
  if (NON_PRODUCT_PATH_PATTERNS.some((pattern) => pattern.test(url))) return false;
  if (BLOCKED_HOST_HINTS.some((hint) => hint.test(url))) return false;

  const breadcrumb = record.rawBreadcrumb || [];
  if (breadcrumb.some((crumb) => /shop all/i.test(crumb))) return false;

  return true;
}

function isBlockedPage(record: ScrapedProductEvidence): boolean {
  const title = (record.title || '').trim();
  return (
    /access denied|forbidden|captcha|recaptcha|blocked/i.test(title) ||
    BLOCKED_HOST_HINTS.some((hint) => hint.test(record.sourceUrl || ''))
  );
}

/**
 * Validates a single raw JSONL line into a corpus observation with
 * collision-resistant, source-scoped IDs.
 */
export function validateCorpusLine(
  rawLine: string,
  options: CorpusValidationOptions = {},
): CorpusValidationResult {
  let record: ScrapedProductEvidence;
  try {
    // Parse through the schema so legacy records receive provenance defaults
    // (acquisitionMode/parserVersion/licenseStatus) before validation.
    record = ScrapedProductEvidenceSchema.parse(JSON.parse(rawLine));
  } catch {
    return { ok: false, rejectionCode: 'invalid_json', rejectionReason: 'Line is not valid JSON.' };
  }

  if (record.title === undefined || record.title === null || String(record.title).trim().length === 0) {
    return { ok: false, rejectionCode: 'missing_title', rejectionReason: 'Record has no title.' };
  }

  const sourceUrl = record.sourceUrl || record.rawUrl;
  if (!sourceUrl) {
    return { ok: false, rejectionCode: 'invalid_url', rejectionReason: 'Record has no source URL.' };
  }

  const urlResult = validateUrl(sourceUrl, options.allowedRegistrableDomains);
  if (!urlResult.ok) {
    const issueText = (urlResult.issues as UrlValidationIssue[]).join(',');
    return {
      ok: false,
      rejectionCode: urlResult.issues.includes('deceptive_suffix') ? 'invalid_url' : 'invalid_url',
      rejectionReason: `URL rejected: ${issueText}`,
    };
  }

  if (isBlockedPage(record)) {
    return { ok: false, rejectionCode: 'blocked_page', rejectionReason: 'Blocked/captcha/interstitial page detected.' };
  }

  if (!isProductPageEvidence(record)) {
    return {
      ok: false,
      rejectionCode: 'non_product_page',
      rejectionReason: 'No positive product-page evidence (category/index/interstitial/junk title).',
    };
  }

  if (record.gtin && !validateGtin(record.gtin)) {
    return { ok: false, rejectionCode: 'invalid_gtin', rejectionReason: `GTIN "${record.gtin}" failed checksum validation.` };
  }
  if (record.upc && !validateGtin(record.upc)) {
    return { ok: false, rejectionCode: 'invalid_gtin', rejectionReason: `UPC "${record.upc}" failed checksum validation.` };
  }

  // Provenance is recorded on every output record via schema defaults
  // (legacy import_file/1.0/unknown). An explicit invalid acquisitionMode
  // fails schema normalization above as invalid_json.

  const payloadHash = record.payloadHash || computePayloadHash(record);
  const entityId = record.entityId || computeEntityId(sourceUrl);
  const observationId = record.observationId || computeObservationId(entityId, payloadHash);

  if (options.seenEntityIds && options.seenEntityIds.has(entityId)) {
    return { ok: false, rejectionCode: 'duplicate_locator', rejectionReason: `Duplicate source locator for entity ${entityId}.` };
  }

  return { ok: true, entityId, observationId, canonicalUrl: urlResult.canonicalUrl };
}

/**
 * Source-scoped SHA-256 observation identity for one record.
 */
export function computeObservationId(entityId: string, payloadHash: string): string {
  return sha256Hex(`observation:${entityId}:${payloadHash}`);
}

export { computeEntityId };

/**
 * Extractor-profile domain blockers (epic #46 follow-up, GPT plan phase 5).
 *
 * Missing-profile extraction failures surface as DOMAIN-level tasks —
 * "build profile for frommfamily.com — unblocks 4 products" — instead of 14
 * indistinguishable item failures. The domain release sweep
 * (`releaseDomainExtractionItems`) handles the retry automatically once a
 * profile becomes usable, so this queue is purely the operator's setup
 * surface.
 */
import { getDb } from '../../db/connection';
import { findProfileByDomain } from '../../db/repositories/extractor-profile-repo';

export interface ExtractorProfileDomainBlocker {
  domain: string;
  blockedItemCount: number;
  batchId: string;
  itemIds: string[];
  sampleItems: Array<{
    itemId: string;
    upc?: string;
    name: string;
    sourceUrl: string | null;
    errorMessage: string;
  }>;
  /** True when an extractor profile already exists for the domain (the
   *  failures may be stale or the profile unusable — surface it either way). */
  profileExists: boolean;
}

/** The worker's stable failure signature (page-extractor). */
const MISSING_PROFILE_RE = /^No extractor profile for\s+(\S+)/i;

/**
 * Normalize the extracted domain token (GPT review, LOW): tolerate
 * URL-shaped tokens ("https://frommfamily.com/products/x"), strip any
 * leading scheme/www, and drop path fragments. Returns null when nothing
 * usable remains.
 */
function normalizeBlockerDomain(raw: string): string | null {
  let token = raw.trim();
  if (!token) return null;
  if (token.includes('://')) {
    try {
      token = new URL(token).hostname;
    } catch {
      // Fall through to the string-based cleanup.
    }
  }
  const cleaned = token
    .toLowerCase()
    .replace(/^www\./, '')
    .split('/')[0]
    .split(':')[0]
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Group a batch's missing-profile extraction failures by source domain. */
export function getExtractorProfileDomainBlockers(batchId: string): ExtractorProfileDomainBlocker[] {
  const db = getDb();
  const rows = db.query(
    `SELECT id, upc, name, source_url, error_message
     FROM onboarding_items
     WHERE batch_id = ? AND stage = 'extraction' AND stage_status = 'failed'
       AND error_message IS NOT NULL
     ORDER BY row_number ASC`,
  ).all(batchId) as Array<{
    id: string;
    upc: string | null;
    name: string | null;
    source_url: string | null;
    error_message: string | null;
  }>;

  const byDomain = new Map<string, ExtractorProfileDomainBlocker>();
  for (const row of rows) {
    const match = MISSING_PROFILE_RE.exec(row.error_message ?? '');
    if (!match) continue; // not a missing-profile failure (HTTP/parse/timeout)
    const domain = normalizeBlockerDomain(match[1]);
    if (!domain) continue;
    let blocker = byDomain.get(domain);
    if (!blocker) {
      blocker = {
        domain,
        blockedItemCount: 0,
        batchId,
        itemIds: [],
        sampleItems: [],
        profileExists: findProfileByDomain(domain) !== null,
      };
      byDomain.set(domain, blocker);
    }
    blocker.blockedItemCount += 1;
    blocker.itemIds.push(row.id);
    if (blocker.sampleItems.length < 3) {
      blocker.sampleItems.push({
        itemId: row.id,
        upc: row.upc ?? undefined,
        name: row.name ?? '',
        sourceUrl: row.source_url,
        errorMessage: row.error_message ?? '',
      });
    }
  }

  // Highest impact first (most blocked products), then domain asc.
  return [...byDomain.values()].sort(
    (a, b) => b.blockedItemCount - a.blockedItemCount || a.domain.localeCompare(b.domain),
  );
}

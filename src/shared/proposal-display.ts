// fallow-ignore-file unused-export

/**
 * Shared Page-proposal display helpers (issue #17 D1 contract).
 *
 * A `category_page` proposal's identity is the stable Page ID; its display
 * name is data (`proposedValue.pageName`). Legacy proposals stored the name in
 * `proposedValue` (string) with the name also in `targetId`. Every consumer —
 * preview, promotion, benchmark, retrieval, and the review UI — must read the
 * display name through these helpers and never place a Page ID into a
 * page-name field.
 */
export interface PageProposalLike {
  proposedValue?: unknown;
  targetId?: string | null;
  revisedValue?: unknown;
  hasRevisedValue?: boolean;
  revisedTargetId?: string | null;
  hasRevisedTargetId?: boolean;
}

/**
 * Page display name from a category_page effective value, with legacy
 * fallbacks. New shape: `{ pageId, pageName, identityVerified }`. Legacy
 * shape: the value itself is the page name; the target was the name too.
 *
 * Returns `null` (never a Page ID) when no display name is present.
 */
export function pageNameFromPageValue(
  value: unknown,
  fallbackTargetId?: string | null,
): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const pageName = (value as Record<string, unknown>).pageName;
    if (typeof pageName === 'string' && pageName.length > 0) return pageName;
  }
  if (typeof value === 'string' && value.length > 0) return value;
  const fallback = fallbackTargetId ?? null;
  return fallback && fallback.length > 0 ? fallback : null;
}

/**
 * Display name for a category_page proposal, honoring the reviewed correction
 * when present (same precedence as `getEffectiveProposalValue`).
 */
export function getPageDisplayName(proposal: PageProposalLike): string | null {
  const effective = proposal.hasRevisedValue ? proposal.revisedValue : proposal.proposedValue;
  const target = proposal.hasRevisedTargetId ? proposal.revisedTargetId ?? null : proposal.targetId ?? null;
  return pageNameFromPageValue(effective, target);
}

/**
 * Stable Page identity for a category_page proposal. Returns the reviewed or
 * proposed `pageId` when present, else `null` (legacy name-only proposals
 * have no verified identity and must never be treated as verified).
 */
export function getPageIdentityId(proposal: PageProposalLike): string | null {
  const effective = proposal.hasRevisedValue ? proposal.revisedValue : proposal.proposedValue;
  if (effective && typeof effective === 'object' && !Array.isArray(effective)) {
    const pageId = (effective as Record<string, unknown>).pageId;
    if (typeof pageId === 'string' && pageId.length > 0) return pageId;
  }
  return null;
}

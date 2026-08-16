/**
 * Conservative brand comparison normalization (epic #46 batch-analysis
 * follow-up, GPT plan phase 3).
 *
 * Rules: trim, collapse internal whitespace, lowercase — for COMPARISON
 * ONLY. No punctuation stripping, no fuzzy matching, no aliasing: distinct
 * brand strings ("Wholesomes" vs "WholesomesFlavor") must STILL conflict so
 * the operator decides. Raw values are never rewritten.
 */
export function normalizeBrandForComparison(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Conservative pack-count comparison normalization (epic #46 batch-analysis
 * follow-up, GPT plan phase 3).
 *
 * Accepts only unsigned integer strings; canonicalizes whitespace and
 * leading zeroes for comparison. Everything else (decimals, ranges, units,
 * text) fails closed — the existing conflict/manual path stands. `0` is
 * returned as-is (it may mean unknown/missing and must never be silently
 * equated with positive counts).
 */
export function normalizePackCountForComparison(value: string): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[0-9]+$/.test(trimmed)) return null;
  return String(parseInt(trimmed, 10));
}

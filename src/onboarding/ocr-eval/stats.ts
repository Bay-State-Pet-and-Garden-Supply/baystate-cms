/**
 * Wilson score interval for a proportion — relocated verbatim from
 * src/product-intelligence/evaluation/metrics.ts during the Agent Lab
 * decommission (ADR-0030, Phase 1 PR 1.2). Sole consumer: ocr-eval metrics.
 */

/** Wilson score interval for a proportion. */
export function wilsonInterval(
  p: number,
  n: number,
  z = 1.96,
): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 0 };
  const clamped = Math.min(1, Math.max(0, p));
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (clamped + z2 / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((clamped * (1 - clamped) + z2 / (4 * n)) / n)) / denom;
  return {
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin),
  };
}

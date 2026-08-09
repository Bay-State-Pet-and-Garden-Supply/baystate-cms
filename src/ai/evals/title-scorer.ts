/**
 * Product-Name Consolidation Task Scorer.
 *
 * Checks preservation of authoritative variant signals (size, weight, count, flavor, brand).
 */

export interface TitleEvalCase {
  id: string;
  rawName: string;
  brandHint?: string;
  expectedName: string;
  protectedTokens: string[];
}

export interface TitleScorerResult {
  totalCases: number;
  exactMatches: number;
  exactMatchAccuracy: number;
  preservedTokensCount: number;
  totalProtectedTokens: number;
  tokenPreservationRate: number;
}

export function scoreTitleConsolidation(
  cases: TitleEvalCase[],
  predictions: Array<{ caseId: string; consolidatedName: string }>,
): TitleScorerResult {
  let exactMatches = 0;
  let preservedTokensCount = 0;
  let totalProtectedTokens = 0;

  const predMap = new Map(predictions.map((p) => [p.caseId, p.consolidatedName]));

  for (const c of cases) {
    const predicted = (predMap.get(c.id) || '').trim();
    const expected = (c.expectedName || '').trim();

    if (predicted.toLowerCase() === expected.toLowerCase() && expected !== '') {
      exactMatches += 1;
    }

    const lowerPredicted = predicted.toLowerCase();
    for (const token of c.protectedTokens) {
      totalProtectedTokens += 1;
      if (lowerPredicted.includes(token.toLowerCase())) {
        preservedTokensCount += 1;
      }
    }
  }

  const totalCases = cases.length || 1;
  const totalTokens = totalProtectedTokens || 1;

  return {
    totalCases: cases.length,
    exactMatches,
    exactMatchAccuracy: Number((exactMatches / totalCases).toFixed(4)),
    preservedTokensCount,
    totalProtectedTokens,
    tokenPreservationRate: Number((preservedTokensCount / totalTokens).toFixed(4)),
  };
}

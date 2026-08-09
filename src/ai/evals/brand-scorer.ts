/**
 * Brand Inference Task Scorer.
 *
 * Scores exact canonical brand match, JSON validity, and false-positive rates.
 */

export interface BrandEvalCase {
  id: string;
  searchTitle: string;
  searchSnippet?: string;
  expectedBrand: string;
}

export interface BrandScorerResult {
  totalCases: number;
  exactMatches: number;
  exactMatchAccuracy: number;
  invalidJsonCount: number;
  invalidJsonRate: number;
  falsePositives: number;
  falsePositiveRate: number;
}

export function scoreBrandInference(
  cases: BrandEvalCase[],
  predictions: Array<{ caseId: string; predictedBrand: string | null; validJson: boolean }>,
): BrandScorerResult {
  let exactMatches = 0;
  let invalidJsonCount = 0;
  let falsePositives = 0;

  const predMap = new Map(predictions.map((p) => [p.caseId, p]));

  for (const c of cases) {
    const pred = predMap.get(c.id);
    if (!pred || !pred.validJson) {
      invalidJsonCount += 1;
      continue;
    }

    const predicted = (pred.predictedBrand || '').trim().toLowerCase();
    const expected = (c.expectedBrand || '').trim().toLowerCase();

    if (predicted === expected && expected !== '') {
      exactMatches += 1;
    } else if (expected === '' && predicted !== '') {
      falsePositives += 1;
    }
  }

  const totalCases = cases.length || 1;

  return {
    totalCases: cases.length,
    exactMatches,
    exactMatchAccuracy: Number((exactMatches / totalCases).toFixed(4)),
    invalidJsonCount,
    invalidJsonRate: Number((invalidJsonCount / totalCases).toFixed(4)),
    falsePositives,
    falsePositiveRate: Number((falsePositives / totalCases).toFixed(4)),
  };
}

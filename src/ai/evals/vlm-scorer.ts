/**
 * Packaging VLM OCR Task Scorer.
 *
 * Scores field-level precision/recall and exact UPC matching.
 */

export interface VlmEvalCase {
  id: string;
  imagePath: string;
  expectedUpc?: string | null;
  expectedFields: Record<string, string>;
}

export interface VlmScorerResult {
  totalCases: number;
  upcExactMatches: number;
  upcMatchRate: number;
  fieldPrecision: number;
  fieldRecall: number;
  fieldF1: number;
}

export function scoreVlmOcr(
  cases: VlmEvalCase[],
  predictions: Array<{
    caseId: string;
    extractedUpc?: string | null;
    extractedFields: Record<string, string>;
  }>,
): VlmScorerResult {
  let upcExactMatches = 0;
  let upcCases = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  const predMap = new Map(predictions.map((p) => [p.caseId, p]));

  for (const c of cases) {
    const pred = predMap.get(c.id);

    if (c.expectedUpc) {
      upcCases += 1;
      if (pred?.extractedUpc && pred.extractedUpc.trim() === c.expectedUpc.trim()) {
        upcExactMatches += 1;
      }
    }

    for (const [field, expectedVal] of Object.entries(c.expectedFields)) {
      const extractedVal = pred?.extractedFields?.[field];
      const normExp = expectedVal.trim().toLowerCase();
      const normAct = (extractedVal || '').trim().toLowerCase();

      if (!normAct && normExp) {
        falseNegatives += 1;
      } else if (normAct && !normExp) {
        falsePositives += 1;
      } else if (normAct === normExp) {
        truePositives += 1;
      } else {
        falsePositives += 1;
        falseNegatives += 1;
      }
    }
  }

  const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0;
  const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const totalUpc = upcCases || 1;

  return {
    totalCases: cases.length,
    upcExactMatches,
    upcMatchRate: Number((upcExactMatches / totalUpc).toFixed(4)),
    fieldPrecision: Number(precision.toFixed(4)),
    fieldRecall: Number(recall.toFixed(4)),
    fieldF1: Number(f1.toFixed(4)),
  };
}

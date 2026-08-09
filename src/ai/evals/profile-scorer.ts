/**
 * Selector Profile Generation & Revision Task Scorer.
 *
 * Scores validated selector proposal success, field extraction accuracy, and stability.
 */

export interface ProfileEvalCase {
  id: string;
  domain: string;
  sampleUrl: string;
  expectedSelectors: Record<string, string>;
}

export interface ProfileScorerResult {
  totalCases: number;
  validatedProfiles: number;
  validatedSuccessRate: number;
  correctFieldSelectors: number;
  totalFields: number;
  fieldAccuracy: number;
}

export function scoreProfileGeneration(
  cases: ProfileEvalCase[],
  predictions: Array<{
    caseId: string;
    validSelectors: boolean;
    extractedSelectors: Record<string, string>;
  }>,
): ProfileScorerResult {
  let validatedProfiles = 0;
  let correctFieldSelectors = 0;
  let totalFields = 0;

  const predMap = new Map(predictions.map((p) => [p.caseId, p]));

  for (const c of cases) {
    const pred = predMap.get(c.id);
    if (!pred) continue;

    if (pred.validSelectors) {
      validatedProfiles += 1;
    }

    for (const [field, expectedSel] of Object.entries(c.expectedSelectors)) {
      totalFields += 1;
      const actualSel = pred.extractedSelectors?.[field];
      if (actualSel && actualSel.trim() === expectedSel.trim()) {
        correctFieldSelectors += 1;
      }
    }
  }

  const totalCases = cases.length || 1;
  const totalF = totalFields || 1;

  return {
    totalCases: cases.length,
    validatedProfiles,
    validatedSuccessRate: Number((validatedProfiles / totalCases).toFixed(4)),
    correctFieldSelectors,
    totalFields,
    fieldAccuracy: Number((correctFieldSelectors / totalF).toFixed(4)),
  };
}

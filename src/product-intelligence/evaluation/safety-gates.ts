/**
 * Safety metrics gates (e03s01 Task 3).
 * wrong-product / wrong-variant / false-pass must not regress vs v1 baseline.
 * Retrieval 200 with wrong size = failed product-extraction (not success).
 * Provider recommendation respects safety and traceability.
 * Pure, <180 lines.
 * story: e03s01
 */
export interface SafetyGateInput {
  wrongProductRate: number | null;
  wrongVariantRate: number | null;
  falsePassRate: number | null;
  traceabilityCoverage: number | null;
}

export interface SafetyGateResult {
  passed: boolean;
  reasons: string[];
}

const MAX_WRONG_VARIANT = 0.05;
const MAX_FALSE_PASS = 0.02;
const MIN_TRACEABILITY = 0.8;

export function evaluateSafetyGates(
  current: SafetyGateInput,
  baseline: SafetyGateInput | null,
): SafetyGateResult {
  const reasons: string[] = [];
  if (current.wrongVariantRate != null && current.wrongVariantRate > MAX_WRONG_VARIANT) {
    reasons.push(`wrongVariantRate ${current.wrongVariantRate.toFixed(3)} exceeds ${MAX_WRONG_VARIANT}`);
  }
  if (current.falsePassRate != null && current.falsePassRate > MAX_FALSE_PASS) {
    reasons.push(`falsePassRate ${current.falsePassRate.toFixed(3)} exceeds ${MAX_FALSE_PASS}`);
  }
  if (current.traceabilityCoverage != null && current.traceabilityCoverage < MIN_TRACEABILITY) {
    reasons.push(`traceability ${current.traceabilityCoverage.toFixed(3)} below ${MIN_TRACEABILITY}`);
  }
  if (baseline) {
    if (
      baseline.wrongProductRate != null &&
      current.wrongProductRate != null &&
      current.wrongProductRate > baseline.wrongProductRate
    ) reasons.push('wrongProductRate regressed vs v1 baseline');
    if (
      baseline.wrongVariantRate != null &&
      current.wrongVariantRate != null &&
      current.wrongVariantRate > baseline.wrongVariantRate
    ) reasons.push('wrongVariantRate regressed vs v1 baseline');
    if (
      baseline.falsePassRate != null &&
      current.falsePassRate != null &&
      current.falsePassRate > baseline.falsePassRate
    ) reasons.push('falsePassRate regressed vs v1 baseline');
  }
  return { passed: reasons.length === 0, reasons };
}

export function traceabilitySatisfied(coverage: number | null): boolean {
  if (coverage == null) return false;
  return coverage >= MIN_TRACEABILITY;
}

export function providerSafetyQualified(
  extractionRate: number | null,
  safety: SafetyGateResult,
  traceabilityOk: boolean,
): boolean {
  if (extractionRate == null) return false;
  if (extractionRate < 0.8) return false;
  if (!safety.passed) return false;
  if (!traceabilityOk) return false;
  return true;
}

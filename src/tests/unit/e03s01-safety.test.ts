/**
 * e03s01 Task3 safety gates and traceability — vitest pure (story: e03s01)
 */
import { describe, it, expect } from 'vitest';
import { evaluateSafetyGates, providerSafetyQualified, traceabilitySatisfied } from '../../product-intelligence/evaluation/safety-gates';

describe('safety gates', () => {
  it('200 with wrong size already failed (retrieval ok but extraction wrong_variant, safety gate catches)', () => {
    const r = evaluateSafetyGates({ wrongProductRate: 0, wrongVariantRate: 0.06, falsePassRate: 0, traceabilityCoverage: 0.9 }, null);
    expect(r.passed).toBe(false);
  });
  it('regression vs baseline fails', () => {
    const cur = { wrongProductRate: 0.02, wrongVariantRate: 0.04, falsePassRate: 0.03, traceabilityCoverage: 0.9 };
    const base = { wrongProductRate: 0.01, wrongVariantRate: 0.03, falsePassRate: 0.02, traceabilityCoverage: 0.9 };
    const r = evaluateSafetyGates(cur, base);
    expect(r.passed).toBe(false);
    expect(r.reasons.join(',')).toMatch(/regressed/);
  });
  it('traceability required for recommendation', () => {
    expect(traceabilitySatisfied(0.79)).toBe(false);
    expect(traceabilitySatisfied(0.85)).toBe(true);
    expect(providerSafetyQualified(0.85, { passed: true, reasons: [] }, true)).toBe(true);
    expect(providerSafetyQualified(0.85, { passed: true, reasons: [] }, false)).toBe(false);
    expect(providerSafetyQualified(0.7, { passed: true, reasons: [] }, true)).toBe(false);
  });
});

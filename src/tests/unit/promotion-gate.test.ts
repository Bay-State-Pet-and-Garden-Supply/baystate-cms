/**
 * PR11 C1 unit tests (issue #30): the PURE promotion gate.
 *
 * The gate is deterministic over its inputs (no DB access) — every branch:
 * legacy pass; blocked refuse (first finding as reason); malformed/missing
 * semantic payload in an ACTIVE cohort child refuse `semantic_validation_unavailable`;
 * parent missing/superseded/not-completed refuses; stale type-dependency
 * (mismatch) refuses; matching dependency passes; no-dependency (universal)
 * passes; a present dependency against a MISSING effective type refuses;
 * reviewed-source member pass/mismatch.
 */
import { describe, it, expect } from 'vitest';
import { validatePromotionGate, resolvePromotionEffectiveTypeId } from '../../classification/promotion-gate';
import type { PromotionGateInput } from '../../classification/promotion-gate';
import type { ClassificationRunRow } from '../../db/repositories/classification-run-repo';
import type { CohortRun } from '../../shared/schemas/cohorts';
import type { ClassificationProposal } from '../../shared/types';
import type { CurationData } from '../../shared/schemas/onboarding';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function run(overrides: Partial<ClassificationRunRow> = {}): ClassificationRunRow {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    onboardingItemId: 'item-1',
    sourceKind: 'onboarding',
    sourceProductHash: null,
    productSku: 'SKU-1',
    configSnapshotId: null,
    configSnapshotHash: null,
    status: 'completed',
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: '2025-01-01T00:01:00.000Z',
    errorMessage: null,
    cohortRunId: null,
    ...overrides,
  };
}

function cohortRun(overrides: Partial<CohortRun> = {}): CohortRun {
  return {
    id: 'parent-1',
    workspaceId: 'ws-1',
    cohortId: 'cohort-1',
    candidateMembershipHash: 'candidate-hash',
    finalMembershipHash: 'final-hash',
    evidenceSnapshotHash: 'evidence-hash',
    evidenceSnapshotId: null,
    configSnapshotId: null,
    configSnapshotHash: null,
    pageImportId: null,
    pageImportHash: null,
    modelPolicyDigest: null,
    executionProductTypeId: 'dog-food-dry',
    productTypeConfidence: 0.9,
    productTypeOutcome: 'coherent',
    status: 'completed',
    claimedBy: null,
    claimedAt: null,
    leaseExpiresAt: null,
    startedAt: '2025-01-01T00:00:00.000Z',
    completedAt: '2025-01-01T00:05:00.000Z',
    errorMessage: null,
    supersededAt: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function proposal(overrides: Partial<ClassificationProposal> = {}): ClassificationProposal {
  return {
    id: 'proposal-1',
    runId: 'run-1',
    productSku: 'SKU-1',
    proposalType: 'field_assignment',
    targetId: 'flavor',
    proposedValue: 'Chicken',
    confidence: 0.9,
    evidenceIds: [],
    status: 'accepted',
    isBulkAcceptable: false,
    isStale: false,
    stalenessReason: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function curationData(overrides: Partial<CurationData> = {}): CurationData {
  return {
    curatedTitle: 'Test Product',
    searchKeywords: null,
    packagingOcrTitle: null,
    curatedWeight: null,
    titleSource: 'web',
    curatedDescription: null,
    curatedDescriptionSourceAttemptIds: [],
    suggestedPages: [],
    suggestedProductType: null,
    curatedAt: '2025-01-01T00:00:00.000Z',
    curationMethod: 'auto',
    classificationRunId: 'run-1',
    classificationConfigSnapshot: null,
    classificationEvidence: [],
    classificationProposals: [],
    classificationDecisions: [],
    classificationHistory: [],
    ...overrides,
  };
}

function blockedSemanticValidation(message: string): CurationData['semanticValidation'] {
  return {
    status: 'blocked',
    findings: [{ code: 'family_brand', memberSku: 'SKU-1', message }],
  };
}

function passedSemanticValidation(): CurationData['semanticValidation'] {
  return { status: 'passed', findings: [] };
}

function gateInput(overrides: Partial<PromotionGateInput> = {}): PromotionGateInput {
  return {
    workspaceId: 'ws-1',
    itemId: 'item-1',
    productSku: 'SKU-1',
    curationData: curationData(),
    activeRun: run(),
    parentRun: null,
    effectiveTypeId: 'dog-food-dry',
    acceptedProposals: [],
    dependencyLookup: () => [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PR11 C1 — validatePromotionGate (pure)', () => {
  it('legacy pass: no curation data or no classification run pointer is byte-identical (no gate)', () => {
    expect(validatePromotionGate(gateInput({ curationData: null }))).toEqual({ ok: true });
    expect(
      validatePromotionGate(gateInput({ curationData: curationData({ classificationRunId: null }) })),
    ).toEqual({ ok: true });
    // A blocked semantic payload on a legacy item (no run pointer) is NOT a
    // gate input at all — legacy promotion is byte-identical.
    expect(
      validatePromotionGate(gateInput({
        curationData: curationData({
          classificationRunId: null,
          semanticValidation: blockedSemanticValidation('legacy finding'),
        }),
      })),
    ).toEqual({ ok: true });
  });

  it('refuses a blocked member with the FIRST finding as the reason', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({
        semanticValidation: blockedSemanticValidation('Brand conflict: blue-buffalo vs woof'),
      }),
    }));
    expect(result).toEqual({
      ok: false,
      code: 'semantic_validation_blocked',
      reason: 'Brand conflict: blue-buffalo vs woof',
    });
  });

  it('refuses a blocked member even when the parent would also be stale (first refusal wins)', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({
        semanticValidation: blockedSemanticValidation('coordinated_page mismatch'),
      }),
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun({ status: 'superseded' }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('semantic_validation_blocked');
  });

  it('blocked with no parseable findings falls back to the deterministic default', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({ semanticValidation: { status: 'blocked', findings: [] } }),
    }));
    expect(result).toEqual({
      ok: false,
      code: 'semantic_validation_blocked',
      reason: 'A hard cohort semantic validation finding blocks this item.',
    });
  });

  it('active cohort child with a MISSING semantic payload fails closed (semantic_validation_unavailable)', () => {
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun(),
      curationData: curationData({ semanticValidation: undefined }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('semantic_validation_unavailable');
  });

  it('active cohort child with a MALFORMED semantic payload fails closed (semantic_validation_unavailable)', () => {
    const malformed = { status: 'banana', findings: [] } as unknown as CurationData['semanticValidation'];
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun(),
      curationData: curationData({ semanticValidation: malformed }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('semantic_validation_unavailable');
  });

  it('a non-cohort run with an absent semantic payload proceeds', () => {
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: null }),
      curationData: curationData({ semanticValidation: undefined }),
    }));
    expect(result).toEqual({ ok: true });
  });

  it('cohort child with a MISSING parent refuses parent_not_found', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({ semanticValidation: passedSemanticValidation() }),
      activeRun: run({ cohortRunId: 'parent-missing' }),
      parentRun: null,
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('parent_not_found');
      expect(result.reason).toContain('parent-missing');
    }
  });

  it('cohort child of a SUPERSEDED parent refuses parent_superseded (reason: parent id)', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({ semanticValidation: passedSemanticValidation() }),
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun({ id: 'parent-1', status: 'superseded' }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('parent_superseded');
      expect(result.reason).toContain('parent-1');
    }
  });

  it('cohort child of a NON-TERMINAL parent refuses parent_not_completed', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({ semanticValidation: passedSemanticValidation() }),
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun({ status: 'running' }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('parent_not_completed');
      expect(result.reason).toContain('running');
    }
  });

  it('cohort child of a completed_with_member_failures parent is terminal (passed parent gate)', () => {
    const result = validatePromotionGate(gateInput({
      curationData: curationData({ semanticValidation: passedSemanticValidation() }),
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun({ status: 'completed_with_member_failures' }),
    }));
    // No parent refusal; with no type dependencies the gate passes.
    expect(result).toEqual({ ok: true });
  });

  it('refuses a STALE proposal: execution dependency target != current effective type', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        { dependencyKind: 'execution_product_type', dependencyTargetId: 'dog-food-wet' },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_proposal');
      expect(result.reason).toContain('proposal-1');
      expect(result.reason).toContain('execution_product_type');
      expect(result.reason).toContain('dog-food-wet');
      expect(result.reason).toContain('dog-food-dry');
    }
  });

  it('passes a MATCHING execution dependency', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        { dependencyKind: 'execution_product_type', dependencyTargetId: 'dog-food-dry' },
      ],
    }));
    expect(result).toEqual({ ok: true });
  });

  it('a universal-attribute proposal (NO dependency rows) is never stale', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal({ id: 'brand-proposal', targetId: 'brand' })],
      dependencyLookup: () => [],
    }));
    expect(result).toEqual({ ok: true });
  });

  it('a present type-dependency against a MISSING effective type is itself stale', () => {
    const result = validatePromotionGate(gateInput({
      effectiveTypeId: null,
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        { dependencyKind: 'execution_product_type', dependencyTargetId: 'dog-food-dry' },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('stale_proposal');
  });

  it('reviewed-source member: MATCHING reviewed_product_type dependency passes', () => {
    const result = validatePromotionGate(gateInput({
      effectiveTypeId: 'cat-food-wet',
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        { dependencyKind: 'reviewed_product_type', dependencyTargetId: 'cat-food-wet' },
      ],
    }));
    expect(result).toEqual({ ok: true });
  });

  it('reviewed-source member: MISMATCHED reviewed_product_type dependency refuses stale_proposal', () => {
    const result = validatePromotionGate(gateInput({
      effectiveTypeId: 'cat-food-wet',
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        { dependencyKind: 'reviewed_product_type', dependencyTargetId: 'dog-food-dry' },
      ],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_proposal');
      expect(result.reason).toContain('reviewed_product_type');
    }
  });

  it('non-type dependency kinds are ignored', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal()],
      dependencyLookup: () => [
        { dependencyKind: 'some_other_kind', dependencyTargetId: 'dog-food-wet' },
      ],
    }));
    expect(result).toEqual({ ok: true });
  });

  it('refuses stale_proposal as soon as ANY accepted proposal is stale', () => {
    const result = validatePromotionGate(gateInput({
      acceptedProposals: [proposal({ id: 'universal-brand' }), proposal({ id: 'stale-flavor' })],
      dependencyLookup: proposalId =>
        proposalId === 'stale-flavor'
          ? [{ dependencyKind: 'execution_product_type', dependencyTargetId: 'dog-food-wet' }]
          : [],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stale_proposal');
      expect(result.reason).toContain('stale-flavor');
    }
  });

  it('defensive: a present run pointer with an unresolved active run fails closed', () => {
    const result = validatePromotionGate(gateInput({ activeRun: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('semantic_validation_unavailable');
  });

  // ── PR11 review R1 (P1-B): independent terminal authority ───────────────

  it('R1: a NON-TERMINAL child run is refused (run_not_completed) even when semantic + parent checks would pass', () => {
    const result = validatePromotionGate(gateInput({
      activeRun: run({ status: 'running', cohortRunId: 'parent-1' }),
      parentRun: cohortRun(),
      curationData: curationData({ semanticValidation: { status: 'passed', findings: [] } }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('run_not_completed');
      expect(result.reason).toContain('running');
    }
  });

  it('R1: a cross-workspace parent is refused (workspace_mismatch) — never this item\'s authority', () => {
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun({ workspaceId: 'ws-OTHER' }),
      curationData: curationData({ semanticValidation: { status: 'passed', findings: [] } }),
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('workspace_mismatch');
      expect(result.reason).toContain('ws-OTHER');
    }
  });

  it('R1: a completed child with a same-workspace terminal parent still passes the authority checks (regression guard)', () => {
    const result = validatePromotionGate(gateInput({
      activeRun: run({ cohortRunId: 'parent-1' }),
      parentRun: cohortRun(),
      curationData: curationData({ semanticValidation: { status: 'passed', findings: [] } }),
    }));
    // No authority refusal — the gate continues to the stale checks.
    expect(result.ok).toBe(true);
  });
});

describe('PR11 C1 — resolvePromotionEffectiveTypeId (reviewed-first, PR11 review R1 P1-A)', () => {
  it('cohort child with NO reviewed type: the Execution Product Type fills the gap (first-pass Curation semantics)', () => {
    expect(resolvePromotionEffectiveTypeId(cohortRun(), [proposal()])).toBe('dog-food-dry');
    expect(resolvePromotionEffectiveTypeId(cohortRun({ executionProductTypeId: null }), [])).toBeNull();
  });

  it('cohort child WITH a reviewed type: REVIEWED wins even when the Execution Type differs (PR5 precedence — the flipped authority test)', () => {
    expect(
      resolvePromotionEffectiveTypeId(cohortRun(), [
        proposal({ proposalType: 'primary_product_type', targetId: 'dog-food-dry' }),
      ]),
    ).toBe('dog-food-dry');
    // The reviewer-revised type is the promotion authority over the frozen
    // execution type — the exact inversion the R1 P1-A blocker described.
    expect(
      resolvePromotionEffectiveTypeId(cohortRun(), [
        proposal({
          proposalType: 'primary_product_type',
          targetId: 'dry-dog-food',
          hasRevisedTargetId: true,
          revisedTargetId: 'wet-dog-food',
        }),
      ]),
    ).toBe('wet-dog-food');
    expect(
      resolvePromotionEffectiveTypeId(cohortRun({ executionProductTypeId: 'dry-dog-food' }), [
        proposal({ proposalType: 'primary_product_type', targetId: 'wet-dog-food' }),
      ]),
    ).toBe('wet-dog-food');
  });

  it('non-cohort member: the live accepted primary_product_type proposal target is the reviewed truth', () => {
    expect(
      resolvePromotionEffectiveTypeId(null, [
        proposal({ proposalType: 'primary_product_type', targetId: 'dog-food-dry' }),
      ]),
    ).toBe('dog-food-dry');
  });

  it('non-cohort member: a reviewer-corrected type target wins over the prediction', () => {
    expect(
      resolvePromotionEffectiveTypeId(null, [
        proposal({
          proposalType: 'primary_product_type',
          targetId: 'dog-food-dry',
          hasRevisedTargetId: true,
          revisedTargetId: 'cat-food-wet',
        }),
      ]),
    ).toBe('cat-food-wet');
  });

  it('non-cohort member with no type proposal resolves to none', () => {
    expect(resolvePromotionEffectiveTypeId(null, [proposal({ proposalType: 'field_assignment' })])).toBeNull();
  });
});

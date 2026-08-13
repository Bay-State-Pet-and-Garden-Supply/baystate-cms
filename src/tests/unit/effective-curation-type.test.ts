/**
 * Effective Curation Product Type resolver — pure unit tests (issue #30 PR5 C1).
 *
 * Covers: reviewed-first resolution, reviewed-override precedence over the
 * cohort execution type, execution fallback, the `none` outcome, the
 * snapshot-only reviewed-type reader, and the stage-facing helper against a
 * synthetic StageContext.
 */
import { describe, expect, it } from 'bun:test';
import {
  resolveEffectiveCurationType,
  getReviewedTypeFromSnapshot,
  getEffectiveCurationProductType,
  getEffectiveCurationTypeForSnapshot,
} from '../../classification/effective-curation-type';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import type { StageContext, StageInput } from '../../classification/types';
import type { ReviewedFact } from '../../classification/reviewed-facts';

const REVIEWED_ID = 'dry-dog-food';
const EXECUTION_ID = 'dry-dog-food';

function makeTypeFact(value: unknown): ReviewedFact {
  return {
    proposalId: 'p1',
    decisionId: 'd1',
    runId: 'r1',
    workspaceId: 'ws',
    productSku: 'sku',
    proposalType: 'primary_product_type',
    targetId: REVIEWED_ID,
    value,
    configSnapshotHash: 'cfg',
    sourceHash: 'src',
    createdAt: '2026-08-01T00:00:00.000Z',
  };
}

function makeNonTypeFact(proposalType: string, targetId: string): ReviewedFact {
  return {
    proposalId: 'p2',
    decisionId: 'd2',
    runId: 'r1',
    workspaceId: 'ws',
    productSku: 'sku',
    proposalType,
    targetId,
    value: 'Dog',
    configSnapshotHash: 'cfg',
    sourceHash: 'src',
    createdAt: '2026-08-01T00:00:00.000Z',
  };
}

function makeSnapshot(facts: ReviewedFact[]): RuntimeClassificationSnapshot {
  return { reviewedFacts: facts } as unknown as RuntimeClassificationSnapshot;
}

function makeContext(cohortExecutionType?: StageContext['cohortExecutionType']): StageContext {
  return {
    workspacePath: '/tmp/ws',
    workspaceId: 'ws',
    configSnapshotRef: { id: 'snap', hash: 'hash', sourceCommit: null, createdAt: '2026-08-01T00:00:00.000Z' },
    runId: 'run',
    cohortExecutionType,
  };
}

const EMPTY_INPUT: StageInput = {
  sku: 'sku',
  evidence: [],
  acceptedProposals: [],
  allProposals: [],
};

describe('resolveEffectiveCurationType', () => {
  it('prefers the reviewed type when both reviewed and execution ids are present', () => {
    expect(resolveEffectiveCurationType(REVIEWED_ID, EXECUTION_ID)).toEqual({
      effectiveTypeId: REVIEWED_ID,
      source: 'reviewed',
    });
  });

  it('lets the reviewed type win even when it differs from the execution type (override precedence)', () => {
    expect(resolveEffectiveCurationType('dog-treats', 'dry-dog-food')).toEqual({
      effectiveTypeId: 'dog-treats',
      source: 'reviewed',
    });
  });

  it('falls back to the execution type when no reviewed type exists', () => {
    expect(resolveEffectiveCurationType(null, EXECUTION_ID)).toEqual({
      effectiveTypeId: EXECUTION_ID,
      source: 'execution',
    });
  });

  it('treats empty-string ids as absent', () => {
    expect(resolveEffectiveCurationType('', EXECUTION_ID)).toEqual({
      effectiveTypeId: EXECUTION_ID,
      source: 'execution',
    });
    expect(resolveEffectiveCurationType(REVIEWED_ID, '')).toEqual({
      effectiveTypeId: REVIEWED_ID,
      source: 'reviewed',
    });
  });

  it('returns none when both ids are absent', () => {
    expect(resolveEffectiveCurationType(null, null)).toEqual({
      effectiveTypeId: null,
      source: 'none',
    });
  });
});

describe('getReviewedTypeFromSnapshot', () => {
  it('returns null for an empty reviewed-facts list', () => {
    expect(getReviewedTypeFromSnapshot(makeSnapshot([]))).toBeNull();
  });

  it('returns null when the snapshot is absent', () => {
    expect(getReviewedTypeFromSnapshot(undefined)).toBeNull();
  });

  it('extracts the id from a { productTypeId } value shape', () => {
    const snapshot = makeSnapshot([makeTypeFact({ productTypeId: REVIEWED_ID })]);
    expect(getReviewedTypeFromSnapshot(snapshot)).toBe(REVIEWED_ID);
  });

  it('extracts the id from a plain string value shape', () => {
    const snapshot = makeSnapshot([makeTypeFact(REVIEWED_ID)]);
    expect(getReviewedTypeFromSnapshot(snapshot)).toBe(REVIEWED_ID);
  });

  it('ignores non-type facts', () => {
    const snapshot = makeSnapshot([
      makeNonTypeFact('field_assignment', 'flavor'),
      makeTypeFact({ productTypeId: REVIEWED_ID }),
    ]);
    expect(getReviewedTypeFromSnapshot(snapshot)).toBe(REVIEWED_ID);
  });

  it('returns the first type fact when several exist', () => {
    const snapshot = makeSnapshot([
      makeTypeFact({ productTypeId: 'dog-treats' }),
      makeTypeFact({ productTypeId: REVIEWED_ID }),
    ]);
    expect(getReviewedTypeFromSnapshot(snapshot)).toBe('dog-treats');
  });
});

describe('getEffectiveCurationProductType', () => {
  it('matches the pure resolver: reviewed fact wins over the execution type', () => {
    const input = { ...EMPTY_INPUT };
    const context = makeContext({ id: EXECUTION_ID, confidence: 0.9, outcome: 'coherent' });
    context.snapshot = makeSnapshot([makeTypeFact({ productTypeId: REVIEWED_ID })]);
    expect(getEffectiveCurationProductType(input, context)).toEqual({
      effectiveTypeId: REVIEWED_ID,
      source: 'reviewed',
    });
  });

  it('matches the pure resolver: execution type used when no reviewed facts exist', () => {
    const context = makeContext({ id: EXECUTION_ID, confidence: 0.9, outcome: 'coherent' });
    context.snapshot = makeSnapshot([]);
    expect(getEffectiveCurationProductType(EMPTY_INPUT, context)).toEqual({
      effectiveTypeId: EXECUTION_ID,
      source: 'execution',
    });
  });

  it('matches the pure resolver: cohortExecutionType absent behaves exactly like legacy reviewed-only', () => {
    const context = makeContext(undefined);
    context.snapshot = makeSnapshot([]);
    expect(getEffectiveCurationProductType(EMPTY_INPUT, context)).toEqual({
      effectiveTypeId: null,
      source: 'none',
    });
  });

  it('honors an in-run accepted proposal through the unchanged reviewed helper', () => {
    const context = makeContext({ id: EXECUTION_ID, confidence: 0.9, outcome: 'coherent' });
    context.snapshot = makeSnapshot([]);
    const input = {
      ...EMPTY_INPUT,
      acceptedProposals: [
        {
          id: 'acc-1',
          runId: 'run',
          productSku: 'sku',
          proposalType: 'primary_product_type' as const,
          targetId: 'dog-treats',
          proposedValue: { productTypeId: 'dog-treats' },
          confidence: 1,
          evidenceIds: [],
          status: 'accepted' as const,
          isBulkAcceptable: false,
          isStale: false,
          stalenessReason: null,
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    };
    expect(getEffectiveCurationProductType(input, context)).toEqual({
      effectiveTypeId: 'dog-treats',
      source: 'reviewed',
    });
  });
});

describe('getEffectiveCurationTypeForSnapshot', () => {
  it('resolves the reviewed type from snapshot facts ahead of the execution id', () => {
    const snapshot = makeSnapshot([makeTypeFact({ productTypeId: REVIEWED_ID })]);
    expect(getEffectiveCurationTypeForSnapshot(snapshot, EXECUTION_ID)).toEqual({
      effectiveTypeId: REVIEWED_ID,
      source: 'reviewed',
    });
  });

  it('falls back to the execution id when the snapshot has no reviewed type', () => {
    expect(getEffectiveCurationTypeForSnapshot(makeSnapshot([]), EXECUTION_ID)).toEqual({
      effectiveTypeId: EXECUTION_ID,
      source: 'execution',
    });
  });

  it('returns none when the snapshot is absent and no execution id exists', () => {
    expect(getEffectiveCurationTypeForSnapshot(undefined, null)).toEqual({
      effectiveTypeId: null,
      source: 'none',
    });
  });
});

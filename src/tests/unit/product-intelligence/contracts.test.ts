/**
 * Contract schema tests for the Product Intelligence execution boundary (PI-1).
 */
import { describe, expect, it } from 'vitest';
import {
  ProductResearchInputSchema,
  ProductResearchContextSchema,
  ProductIntelligencePolicySchema,
  StructuredSubmissionSchema,
  ProductResearchResultSchema,
  ProductIntelligenceExecutionEventSchema,
} from '../../../product-intelligence/contracts';
import { testContext, testPolicy, validSubmission } from './test-helpers';

describe('ProductResearchInputSchema', () => {
  it('accepts a valid input', () => {
    const parsed = ProductResearchInputSchema.safeParse({
      gtin: '085000079585',
      registerName: 'STELLA CHKN BROTH 16OZ',
      brandHint: 'Stella & Chewys',
      departmentHint: null,
      price: '5.99',
      quantity: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects non-digit GTINs', () => {
    const parsed = ProductResearchInputSchema.safeParse({
      gtin: '0850-0007-9585',
      registerName: 'STELLA CHKN BROTH 16OZ',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0].path.join('.')).toContain('gtin');
    }
  });

  it('rejects GTINs with wrong length', () => {
    const parsed = ProductResearchInputSchema.safeParse({
      gtin: '123',
      registerName: 'STELLA CHKN BROTH 16OZ',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty register name', () => {
    const parsed = ProductResearchInputSchema.safeParse({ gtin: '085000079585', registerName: '' });
    expect(parsed.success).toBe(false);
  });
});

describe('ProductIntelligencePolicySchema', () => {
  it('accepts a fail-closed default policy', () => {
    const parsed = ProductIntelligencePolicySchema.safeParse({
      configId: 'abc123',
      allowedTools: ['read'],
      networkPolicy: 'local_only',
      dataSharingPolicy: 'local_only',
      modelRoute: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.maxToolCalls).toBe(100);
      expect(parsed.data.deadlineMs).toBe(300_000);
    }
  });

  it('rejects unknown allowlisted tools', () => {
    const parsed = ProductIntelligencePolicySchema.safeParse({
      configId: 'abc123',
      allowedTools: ['read', 'rm_rf'],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a model route without provider', () => {
    const parsed = ProductIntelligencePolicySchema.safeParse({
      configId: 'abc123',
      modelRoute: { model: 'gpt-4o-mini' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ProductResearchContextSchema', () => {
  it('accepts a valid context without a signal (signal is runtime-only)', () => {
    const parsed = ProductResearchContextSchema.safeParse(testContext());
    expect(parsed.success).toBe(true);
  });

  it('requires runId, workspace, and policy', () => {
    const parsed = ProductResearchContextSchema.safeParse({ executionMode: 'shadow' });
    expect(parsed.success).toBe(false);
  });

  it('defaults execution mode to shadow', () => {
    const parsed = ProductResearchContextSchema.safeParse({
      runId: 'r1',
      workspaceId: 'w1',
      workspacePath: '/tmp/w1',
      policy: testPolicy(),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.executionMode).toBe('shadow');
  });
});

describe('StructuredSubmissionSchema', () => {
  it('accepts a valid evidence bundle', () => {
    expect(StructuredSubmissionSchema.safeParse(validSubmission()).success).toBe(true);
  });

  it('accepts a full abstention', () => {
    const parsed = StructuredSubmissionSchema.safeParse({
      ...validSubmission(),
      abstention: {
        scope: 'full',
        reason: 'No authoritative source resolves this GTIN.',
        actionableNextStep: 'Provide a package photo.',
        targets: [],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an image with an invalid rights status', () => {
    const parsed = StructuredSubmissionSchema.safeParse({
      ...validSubmission(),
      images: [
        {
          url: 'https://example.com/img.jpg',
          sourceId: 'src-1',
          rightsStatus: 'probably-fine',
          identityMatch: 'exact',
          evidenceIds: [],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an image with an invalid identity match value', () => {
    const parsed = StructuredSubmissionSchema.safeParse({
      ...validSubmission(),
      images: [
        {
          url: 'https://example.com/img.jpg',
          sourceId: 'src-1',
          rightsStatus: 'confirmed',
          identityMatch: 'definitely',
          evidenceIds: [],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects out-of-range confidence', () => {
    const parsed = StructuredSubmissionSchema.safeParse({
      ...validSubmission(),
      confidence: 1.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an evidence item with no sourceIds', () => {
    const parsed = StructuredSubmissionSchema.safeParse({
      ...validSubmission(),
      evidenceItems: [{ id: 'ev-1', field: 'title', value: 'x', sourceIds: [] }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects evidence sources with non-URL values', () => {
    const parsed = StructuredSubmissionSchema.safeParse({
      ...validSubmission(),
      evidenceSources: [{ id: 'src-1', url: 'not-a-url', domain: 'x', kind: 'other', accessedAt: '2026-08-04T00:00:00.000Z' }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ProductResearchResultSchema + events', () => {
  it('accepts a submitted result', () => {
    const parsed = ProductResearchResultSchema.safeParse({
      runId: 'r1',
      outcome: 'submitted',
      executor: 'pi',
      executorVersion: '1.0.0',
      piVersion: '0.83.0',
      extensionVersions: [],
      configId: 'cfg',
      durationMs: 12,
      submission: validSubmission(),
      failure: null,
      events: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an execution event', () => {
    const parsed = ProductIntelligenceExecutionEventSchema.safeParse({
      type: 'submission_received',
      runId: 'r1',
      sequence: 3,
      timestamp: '2026-08-04T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an event with an unknown type', () => {
    const parsed = ProductIntelligenceExecutionEventSchema.safeParse({
      type: 'chain_of_thought_dump',
      runId: 'r1',
      sequence: 3,
      timestamp: '2026-08-04T00:00:00.000Z',
    });
    expect(parsed.success).toBe(false);
  });
});

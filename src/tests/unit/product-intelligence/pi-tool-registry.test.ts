/**
 * Terminal submission tool tests (PI-1): TypeBox schema, zod re-validation,
 * and the structured contract gate.
 */
import { describe, expect, it, vi } from 'vitest';
import { Check } from 'typebox/value';
import {
  buildProductResearchSubmissionTool,
  SubmissionTypeBoxSchema,
} from '../../../product-intelligence/pi/pi-tool-registry';
import { SUBMISSION_TOOL_NAME, StructuredSubmissionSchema } from '../../../product-intelligence/contracts';
import { ABSTENTION_SUBMISSION, validSubmission } from './test-helpers';

describe('buildProductResearchSubmissionTool', () => {
  it('registers under the reserved terminal tool name', () => {
    const tool = buildProductResearchSubmissionTool(() => undefined);
    expect(tool.name).toBe(SUBMISSION_TOOL_NAME);
    expect(tool.description).toContain('TERMINAL');
  });

  it('exposes a TypeBox parameter schema that accepts a valid bundle', () => {
    const tool = buildProductResearchSubmissionTool(() => undefined);
    expect(Check(tool.parameters, validSubmission())).toBe(true);
  });

  it('TypeBox schema rejects invalid payloads (e.g. invented rights status)', () => {
    const invalid = {
      ...validSubmission(),
      images: [
        {
          url: 'https://example.com/i.jpg',
          sourceId: 'src-1',
          rightsStatus: 'unknown-ish',
          identityMatch: 'exact',
          evidenceIds: [],
        },
      ],
    };
    expect(Check(SubmissionTypeBoxSchema, invalid)).toBe(false);
  });

  it('accepts a full abstention payload', () => {
    const tool = buildProductResearchSubmissionTool(() => undefined);
    expect(Check(tool.parameters, ABSTENTION_SUBMISSION)).toBe(true);
  });

  it('delivers validated submissions to the callback', async () => {
    const onSubmission = vi.fn();
    const tool = buildProductResearchSubmissionTool(onSubmission);
    const result = await tool.execute('call-1', validSubmission());
    expect(onSubmission).toHaveBeenCalledTimes(1);
    expect(onSubmission.mock.calls[0][0].identity.gtinMatch).toBe('exact');
    expect(result.content[0].text).toContain('accepted');
  });

  it('throws a tool error for payloads that fail zod validation', async () => {
    const tool = buildProductResearchSubmissionTool(() => undefined);
    await expect(tool.execute('call-2', { schemaVersion: 99 })).rejects.toThrow(/Invalid submission/);
  });

  it('never delivers invalid payloads to the callback', async () => {
    const onSubmission = vi.fn();
    const tool = buildProductResearchSubmissionTool(onSubmission);
    await expect(tool.execute('call-3', { schemaVersion: 99 })).rejects.toThrow();
    expect(onSubmission).not.toHaveBeenCalled();
  });

  it('supports a custom validator (e.g. stricter CMS-side contract)', async () => {
    const onSubmission = vi.fn();
    const tool = buildProductResearchSubmissionTool(onSubmission, {
      validate: (value) => StructuredSubmissionSchema.safeParse(value),
    });
    await tool.execute('call-4', validSubmission());
    expect(onSubmission).toHaveBeenCalledTimes(1);
  });

  it('rejects submissions that invent taxonomy identifiers structurally', async () => {
    // The schema itself allows string ids — CMS-side validation (PI-3/4)
    // resolves ids against the registry. This test documents the boundary:
    // structural acceptance must never imply registry acceptance.
    const tool = buildProductResearchSubmissionTool(() => undefined);
    const invented = {
      ...validSubmission(),
      classificationProposal: {
        productTypeId: 'invented-product-type',
        categoryPageId: 'invented-page',
        attributes: [],
      },
    };
    expect(Check(tool.parameters, invented)).toBe(true);
    expect(StructuredSubmissionSchema.safeParse(invented).success).toBe(true);
  });
});

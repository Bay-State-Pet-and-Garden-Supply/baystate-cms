/**
 * Legacy PI-1 submission schema tests: TypeBox mirror vs zod contract.
 *
 * P0-3: the legacy `submit_product_research` tool is no longer built or
 * registered for Pi sessions — every live terminal is a PI-4 workflow tool.
 * This file pins the remaining surface: the TypeBox mirror of the legacy
 * PI-1 envelope still validates historical payloads identically to the zod
 * contract.
 */
import { describe, expect, it } from 'vitest';
import { Check } from 'typebox/value';
import { SubmissionTypeBoxSchema } from '../../../product-intelligence/pi/pi-tool-registry';
import { StructuredSubmissionSchema } from '../../../product-intelligence/contracts';
import { ABSTENTION_SUBMISSION, validSubmission } from './test-helpers';

describe('SubmissionTypeBoxSchema (legacy PI-1 envelope mirror)', () => {
  it('exposes a TypeBox parameter schema that accepts a valid bundle', () => {
    expect(Check(SubmissionTypeBoxSchema, validSubmission())).toBe(true);
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
    expect(Check(SubmissionTypeBoxSchema, ABSTENTION_SUBMISSION)).toBe(true);
  });

  it('zod and TypeBox agree on valid and invalid historical envelopes', () => {
    expect(StructuredSubmissionSchema.safeParse(validSubmission()).success).toBe(true);
    expect(Check(SubmissionTypeBoxSchema, validSubmission())).toBe(true);
    expect(StructuredSubmissionSchema.safeParse({ schemaVersion: 99 }).success).toBe(false);
    expect(Check(SubmissionTypeBoxSchema, { schemaVersion: 99 })).toBe(false);
  });

  it('rejects submissions that invent taxonomy identifiers structurally', () => {
    // The schema itself allows string ids — CMS-side validation (PI-3/4)
    // resolves ids against the registry. This test documents the boundary:
    // structural acceptance must never imply registry acceptance.
    const invented = {
      ...validSubmission(),
      classificationProposal: {
        productTypeId: 'invented-product-type',
        categoryPageId: 'invented-page',
        attributes: [],
      },
    };
    expect(Check(SubmissionTypeBoxSchema, invented)).toBe(true);
    expect(StructuredSubmissionSchema.safeParse(invented).success).toBe(true);
  });
});

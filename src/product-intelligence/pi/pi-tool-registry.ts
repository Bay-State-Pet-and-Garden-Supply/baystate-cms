/**
 * Legacy PI-1 structured-submission schema mirror (TypeBox).
 *
 * P0-3: the legacy `submit_product_research` terminal tool has been REMOVED
 * from live Pi sessions — every session terminal is a PI-4 workflow tool
 * (submit_product_research_bundle / submit_insufficient_evidence /
 * submit_identity_conflict), all of which pass the PI-4 bundle validator.
 *
 * This file now only keeps the TypeBox mirror of `StructuredSubmissionSchema`
 * (the legacy PI-1 envelope) so that:
 *   - schema-equivalence tests keep pinning the zod <-> TypeBox drift,
 *   - historical run payloads can still be validated when parsed.
 *
 * The TypeBox schema is maintained to be behaviorally equivalent to
 * `StructuredSubmissionSchema` (same required fields, same enums, same
 * numeric bounds, same format checks, same optionality). Schema-equivalence
 * tests in `src/tests/unit/product-intelligence/schema-equivalence.test.ts`
 * guard against drift between the two.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/18
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/21
 */
import { Type } from 'typebox';

// ---------------------------------------------------------------------------
// TypeBox schema (mirrors StructuredSubmissionSchema — legacy PI-1 envelope)
// ---------------------------------------------------------------------------

const EvidenceSourceTypeBoxSchema = Type.Object({
  id: Type.String(),
  url: Type.String({ format: 'uri' }),
  title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  domain: Type.String(),
  kind: Type.Union([
    Type.Literal('catalog'),
    Type.Literal('supplier'),
    Type.Literal('registry'),
    Type.Literal('retailer'),
    Type.Literal('manufacturer'),
    Type.Literal('other'),
  ]),
  accessedAt: Type.String({ format: 'date-time' }),
});

const EvidenceItemTypeBoxSchema = Type.Object({
  id: Type.String(),
  field: Type.String(),
  value: Type.String(),
  sourceIds: Type.Array(Type.String(), { minItems: 1 }),
  quote: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const ProductFieldProposalTypeBoxSchema = Type.Object({
  field: Type.String(),
  value: Type.String(),
  evidenceIds: Type.Optional(Type.Array(Type.String())),
});

const AttributeProposalTypeBoxSchema = Type.Object({
  fieldName: Type.String(),
  value: Type.String(),
  evidenceIds: Type.Optional(Type.Array(Type.String())),
});

const ImageProposalTypeBoxSchema = Type.Object({
  url: Type.String({ format: 'uri' }),
  sourceId: Type.String(),
  rightsStatus: Type.Union([
    Type.Literal('unknown'),
    Type.Literal('confirmed'),
    Type.Literal('conflicting'),
  ]),
  identityMatch: Type.Union([
    Type.Literal('unknown'),
    Type.Literal('exact'),
    Type.Literal('variant'),
    Type.Literal('wrong'),
  ]),
  evidenceIds: Type.Optional(Type.Array(Type.String())),
  rightsNote: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const ConflictTypeBoxSchema = Type.Object({
  id: Type.String(),
  severity: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')]),
  category: Type.String(),
  summary: Type.String(),
  evidenceIds: Type.Optional(Type.Array(Type.String())),
  resolutionProposal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const AbstentionTypeBoxSchema = Type.Object({
  scope: Type.Union([Type.Literal('full'), Type.Literal('partial')]),
  reason: Type.String(),
  actionableNextStep: Type.String(),
  targets: Type.Optional(Type.Array(Type.String())),
});

export const SubmissionTypeBoxSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  identity: Type.Object({
    gtinMatch: Type.Union([
      Type.Literal('exact'),
      Type.Literal('variant'),
      Type.Literal('unknown'),
      Type.Literal('conflicting'),
    ]),
    gtinEvidenceIds: Type.Optional(Type.Array(Type.String())),
    registerNameMatch: Type.Union([
      Type.Literal('exact'),
      Type.Literal('variant'),
      Type.Literal('unknown'),
      Type.Literal('conflicting'),
    ]),
    registerNameEvidenceIds: Type.Optional(Type.Array(Type.String())),
    summary: Type.String(),
  }),
  evidenceSources: Type.Optional(Type.Array(EvidenceSourceTypeBoxSchema)),
  evidenceItems: Type.Optional(Type.Array(EvidenceItemTypeBoxSchema)),
  productProposal: Type.Object({
    fields: Type.Optional(Type.Array(ProductFieldProposalTypeBoxSchema)),
  }),
  classificationProposal: Type.Object({
    productTypeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    categoryPageId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    attributes: Type.Optional(Type.Array(AttributeProposalTypeBoxSchema)),
  }),
  images: Type.Optional(Type.Array(ImageProposalTypeBoxSchema)),
  conflicts: Type.Optional(Type.Array(ConflictTypeBoxSchema)),
  abstention: Type.Optional(Type.Union([Type.Null(), AbstentionTypeBoxSchema])),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

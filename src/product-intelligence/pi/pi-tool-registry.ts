/**
 * Pi terminal structured submission tool (PI-1).
 *
 * The only way an agent's research becomes a candidate product result is a
 * call to `submit_product_research` whose payload validates against the
 * structured submission contract. Ordinary assistant prose can never become
 * the authoritative product result.
 *
 * The tool is defined with a TypeBox parameter schema (the Pi SDK's native
 * tool-schema format) and re-validates the payload with the authoritative Zod
 * contract on execute (belt and braces — the TypeBox schema is the runtime
 * gate, the Zod schema is the durable contract).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/18
 */
import { Type, type TSchema } from 'typebox';
import {
  SUBMISSION_TOOL_NAME,
  type StructuredSubmission,
} from '../contracts';
import { StructuredSubmissionSchema } from '../contracts';

// ---------------------------------------------------------------------------
// TypeBox schema (mirrors StructuredSubmissionSchema)
// ---------------------------------------------------------------------------

export const SubmissionTypeBoxSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  identity: Type.Object({
    gtinMatch: Type.Union([
      Type.Literal('exact'),
      Type.Literal('variant'),
      Type.Literal('unknown'),
      Type.Literal('conflicting'),
    ]),
    gtinEvidenceIds: Type.Array(Type.String()),
    registerNameMatch: Type.Union([
      Type.Literal('exact'),
      Type.Literal('variant'),
      Type.Literal('unknown'),
      Type.Literal('conflicting'),
    ]),
    registerNameEvidenceIds: Type.Array(Type.String()),
    summary: Type.String(),
  }),
  evidenceSources: Type.Array(
    Type.Object({
      id: Type.String(),
      url: Type.String(),
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
      accessedAt: Type.String(),
    }),
  ),
  evidenceItems: Type.Array(
    Type.Object({
      id: Type.String(),
      field: Type.String(),
      value: Type.String(),
      sourceIds: Type.Array(Type.String()),
      quote: Type.Optional(Type.String()),
    }),
  ),
  productProposal: Type.Object({
    fields: Type.Array(
      Type.Object({
        field: Type.String(),
        value: Type.String(),
        evidenceIds: Type.Array(Type.String()),
      }),
    ),
  }),
  classificationProposal: Type.Object({
    productTypeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    categoryPageId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    attributes: Type.Array(
      Type.Object({
        fieldName: Type.String(),
        value: Type.String(),
        evidenceIds: Type.Array(Type.String()),
      }),
    ),
  }),
  images: Type.Array(
    Type.Object({
      url: Type.String(),
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
      evidenceIds: Type.Array(Type.String()),
      rightsNote: Type.Optional(Type.String()),
    }),
  ),
  conflicts: Type.Array(
    Type.Object({
      id: Type.String(),
      severity: Type.Union([
        Type.Literal('low'),
        Type.Literal('medium'),
        Type.Literal('high'),
      ]),
      category: Type.String(),
      summary: Type.String(),
      evidenceIds: Type.Array(Type.String()),
      resolutionProposal: Type.Optional(Type.String()),
    }),
  ),
  abstention: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Object({
        scope: Type.Union([Type.Literal('full'), Type.Literal('partial')]),
        reason: Type.String(),
        actionableNextStep: Type.String(),
        targets: Type.Array(Type.String()),
      }),
    ]),
  ),
  confidence: Type.Optional(Type.Number()),
});

export interface SubmissionToolDeps {
  /** Authoritative validation; defaults to the structured submission contract. */
  validate?: (value: unknown) => ReturnType<typeof StructuredSubmissionSchema.safeParse>;
}

/**
 * Build the terminal submission tool definition.
 *
 * `onSubmission` receives the validated submission when the agent calls the
 * tool with a valid payload. Invalid payloads surface as tool errors so the
 * agent can correct and retry; the executor decides what happens next.
 */
export function buildProductResearchSubmissionTool(
  onSubmission: (submission: StructuredSubmission) => void,
  deps: SubmissionToolDeps = {},
): {
  name: string;
  label: string;
  description: string;
  promptGuidelines: string[];
  parameters: TSchema;
  execute: (toolCallId: string, params: unknown) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: Record<string, never>;
  }>;
} {
  const validate = deps.validate ?? ((value: unknown) => StructuredSubmissionSchema.safeParse(value));
  return {
    name: SUBMISSION_TOOL_NAME,
    label: 'Submit Product Research',
    description:
      'TERMINAL TOOL. Call this exactly once when research is complete and every claim is backed by evidence. ' +
      'Submits the structured evidence bundle: identity assessment, evidence sources, evidence items, ' +
      'product field proposals, classification proposals, image proposals with rights/identity provenance, ' +
      'conflicts, and an optional abstention. Never invent taxonomy, Category Page, attribute, Product Type, ' +
      'or ProductField identifiers: leave ids null or omit entries you cannot ground. If you cannot research ' +
      'the product with confidence, submit a full abstention with an actionable next step.',
    promptGuidelines: [
      `The only valid terminal action is ${SUBMISSION_TOOL_NAME}.`,
      'Every factual value must reference at least one evidence source you actually fetched or read.',
      'Image proposals must state rightsStatus and identityMatch; never claim exact match without direct evidence.',
      'Never invent identifiers for taxonomy, Category Page, attributes, Product Types, or ProductFields.',
      'You may abstain (full or partial) — an honest abstention is better than unsupported claims.',
    ],
    parameters: SubmissionTypeBoxSchema,
    async execute(_toolCallId: string, params: unknown) {
      const parsed = validate(params);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ');
        throw new Error(`Invalid submission payload: ${issues}`);
      }
      onSubmission(parsed.data);
      return {
        content: [
          {
            type: 'text',
            text: 'Submission accepted. Your research has been recorded; do not call this tool again.',
          },
        ],
        details: {},
      };
    },
  };
}

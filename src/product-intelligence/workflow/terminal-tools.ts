/**
 * PI-4 terminal submission tools.
 *
 * The workflow session must finish through exactly one of:
 * submit_product_research_bundle, submit_insufficient_evidence, or
 * submit_identity_conflict. Each tool validates its payload (TypeBox gate +
 * zod contract) and delivers it to the run's submission handler.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/21
 */
import { Type, type TSchema } from 'typebox';
import {
  TERMINAL_BUNDLE_TOOL,
  TERMINAL_CONFLICT_TOOL,
  TERMINAL_INSUFFICIENT_TOOL,
  type TerminalSubmission,
} from './bundle';
import {
  IdentityConflictSubmissionSchema,
  InsufficientEvidenceSubmissionSchema,
  ProductResearchBundleSchema,
} from './bundle';

export const BundleTypeBoxSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  gtin: Type.String({ maxLength: 64 }),
  inputName: Type.String({ maxLength: 512 }),
  identity: Type.Object({
    status: Type.Union([
      Type.Literal('exact_match'),
      Type.Literal('probable_match'),
      Type.Literal('parent_product_only'),
      Type.Literal('wrong_variant'),
      Type.Literal('conflicting_identity'),
      Type.Literal('insufficient_evidence'),
    ]),
    brand: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Null()])),
    canonicalName: Type.Optional(Type.Union([Type.String({ maxLength: 512 }), Type.Null()])),
    variant: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Null()])),
    manufacturer: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Null()])),
    netContent: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Object({ value: Type.Number({ exclusiveMinimum: 0 }), unit: Type.String({ maxLength: 16 }) }),
      ]),
    ),
    packCount: Type.Optional(Type.Union([Type.Null(), Type.Integer({ exclusiveMinimum: 0 })])),
    evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  }),
  commerceFacts: Type.Optional(
    Type.Array(
      Type.Object({
        field: Type.String({ maxLength: 128 }),
        value: Type.Unknown(),
        evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        extractionMethods: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        confidenceSignal: Type.Optional(Type.Union([Type.Null(), Type.Number({ minimum: 0, maximum: 1 })])),
      }),
      { maxItems: 128 },
    ),
  ),
  classificationProposals: Type.Optional(
    Type.Array(
      Type.Object({
        targetId: Type.String({ maxLength: 128 }),
        selectedOptionId: Type.String({ maxLength: 256 }),
        evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        disposition: Type.Optional(Type.Union([Type.Literal('proposed'), Type.Literal('needs_review')])),
      }),
      { maxItems: 64 },
    ),
  ),
  imageCandidates: Type.Optional(
    Type.Array(
      Type.Object({
        sourceId: Type.String({ minLength: 1 }),
        sourceArtifactId: Type.String({ minLength: 1 }),
        url: Type.String({ format: 'uri' }),
        role: Type.Union([Type.Literal('primary'), Type.Literal('alternate'), Type.Literal('nutrition'), Type.Literal('ingredients'), Type.Literal('comparison')]),
        exactProductMatch: Type.Boolean(),
        exactVariantMatch: Type.Optional(Type.Union([Type.Null(), Type.Boolean()])),
        variantReference: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Null()])),
        rightsStatus: Type.Union([
          Type.Literal('supplier_authorized'),
          Type.Literal('manufacturer_authorized'),
          Type.Literal('licensed_dataset'),
          Type.Literal('retailer_authorized'),
          Type.Literal('unknown'),
        ]),
        evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        sourcePageUrl: Type.Optional(Type.Union([Type.String({ format: 'uri' }), Type.Null()])),
        sourcePath: Type.Optional(Type.Union([Type.String({ maxLength: 1024 }), Type.Null()])),
        extractionMethod: Type.Optional(
          Type.Union([
            Type.Literal('json_ld'),
            Type.Literal('platform_api'),
            Type.Literal('network_response'),
            Type.Literal('profile_selector'),
            Type.Literal('media_api'),
            Type.Literal('manual'),
            Type.Null(),
          ]),
        ),
        retrievedAt: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
        rightsBasis: Type.Optional(Type.Union([Type.String({ maxLength: 512 }), Type.Null()])),
        rightsEvidenceRef: Type.Optional(Type.Union([Type.String({ maxLength: 512 }), Type.Null()])),
        originalContentHash: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
        perceptualHash: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
        qualityStatus: Type.Optional(
          Type.Union([Type.Literal('usable'), Type.Literal('low_quality'), Type.Literal('invalid')]),
        ),
        commerceApproved: Type.Boolean(),
        observedNetContent: Type.Optional(
          Type.Union([
            Type.Null(),
            Type.Object({ value: Type.Number({ exclusiveMinimum: 0 }), unit: Type.String({ maxLength: 16 }) }),
          ]),
        ),
        observedPackCount: Type.Optional(Type.Union([Type.Null(), Type.Integer({ exclusiveMinimum: 0 })])),
        conflicts: Type.Optional(Type.Array(Type.String({ maxLength: 256 }))),
      }),
      { maxItems: 32 },
    ),
  ),
  conflicts: Type.Optional(
    Type.Array(
      Type.Object({
        field: Type.String({ maxLength: 128 }),
        values: Type.Array(Type.Unknown(), { minItems: 1 }),
        evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        severity: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('blocking')]),
      }),
      { maxItems: 64 },
    ),
  ),
  disposition: Type.Union([
    Type.Literal('research_complete'),
    Type.Literal('needs_review'),
    Type.Literal('insufficient_evidence'),
    Type.Literal('identity_conflict'),
  ]),
});

export const InsufficientEvidenceTypeBoxSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  gtin: Type.String({ maxLength: 64 }),
  inputName: Type.String({ maxLength: 512 }),
  reason: Type.String({ minLength: 1, maxLength: 2048 }),
  actionableNextStep: Type.String({ minLength: 1, maxLength: 2048 }),
  evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  attemptedSteps: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

export const IdentityConflictTypeBoxSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  gtin: Type.String({ maxLength: 64 }),
  inputName: Type.String({ maxLength: 512 }),
  conflicts: Type.Array(
    Type.Object({
      field: Type.String({ maxLength: 128 }),
      values: Type.Array(Type.Unknown(), { minItems: 1 }),
      evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      severity: Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('blocking')]),
    }),
    { minItems: 1, maxItems: 64 },
  ),
  evidenceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  recommendedDisposition: Type.Union([Type.Literal('needs_review'), Type.Literal('identity_conflict')]),
});

export interface WorkflowTerminalTool {
  name: string;
  label: string;
  description: string;
  promptGuidelines: string[];
  parameters: TSchema;
  execute: (toolCallId: string, params: unknown) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: Record<string, never>;
  }>;
}

type SubmissionValidator = (
  value: unknown,
) => { success: boolean; data?: TerminalSubmission; error?: unknown };

/**
 * Build the three PI-4 terminal submission tools. All deliver to the same
 * run-level submission handler; the executor fails the run when a session
 * ends without any of them having succeeded.
 */
export function buildWorkflowTerminalTools(
  onSubmission: (submission: TerminalSubmission) => void,
): WorkflowTerminalTool[] {
  const validators: Record<string, SubmissionValidator> = {
    [TERMINAL_BUNDLE_TOOL]: (value) => ProductResearchBundleSchema.safeParse(value),
    [TERMINAL_INSUFFICIENT_TOOL]: (value) => InsufficientEvidenceSubmissionSchema.safeParse(value),
    [TERMINAL_CONFLICT_TOOL]: (value) => IdentityConflictSubmissionSchema.safeParse(value),
  };

  const specs: Array<{
    name: string;
    description: string;
    guidelines: string[];
    parameters: TSchema;
  }> = [
    {
      name: TERMINAL_BUNDLE_TOOL,
      description:
        'TERMINAL TOOL. Submit the full ProductResearchBundle when research is complete. ' +
        'Every non-null factual value must cite evidence ids from tool outputs; classification proposals must ' +
        'reference existing CMS-controlled ids; image rights status must be stated and never "unknown" for commerce use. ' +
        'Use disposition research_complete only when identity is exact and no blocking conflicts remain; otherwise needs_review.',
      guidelines: [
        'Call exactly one terminal tool at the end of the session.',
        'A parent_product_only / wrong_variant / conflicting_identity identity can never be research_complete.',
        'Every factual value cites supporting evidence ids.',
      ],
      parameters: BundleTypeBoxSchema,
    },
    {
      name: TERMINAL_INSUFFICIENT_TOOL,
      description:
        'TERMINAL TOOL. Abstain when evidence is missing or budgets were exhausted. ' +
        'Provide a reason, an actionable next step, and the steps already attempted.',
      guidelines: [
        'Abstention is a valid, preferred outcome over invented content.',
        'Missing sources yield insufficient_evidence — never fabricate facts.',
      ],
      parameters: InsufficientEvidenceTypeBoxSchema,
    },
    {
      name: TERMINAL_CONFLICT_TOOL,
      description:
        'TERMINAL TOOL. Submit blocking identity or fact conflicts when sources disagree. ' +
        'High-authority conflicts are never silently merged; the run cannot complete research on conflicted identity.',
      guidelines: [
        'Blocking conflicts require this tool or disposition identity_conflict.',
        'Include the evidence ids backing each conflict.',
      ],
      parameters: IdentityConflictTypeBoxSchema,
    },
  ];

  return specs.map((spec) => ({
    name: spec.name,
    label: spec.name.replace(/_/g, ' '),
    description: spec.description,
    promptGuidelines: spec.guidelines,
    parameters: spec.parameters,
    async execute(_toolCallId: string, params: unknown) {
      const parsed = validators[spec.name](params);
      if (!parsed.success || !parsed.data) {
        // Returned, not thrown: the SDK relays the text verbatim to the model
        // so it can fix the payload (smoke finding B/G).
        const zodError = parsed.error as { issues?: Array<{ path: Array<string | number>; message: string }> } | undefined;
        const issues = (zodError?.issues ?? [])
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ');
        return {
          content: [
            {
              type: 'text',
              text: `Invalid submission payload for ${spec.name}: ${issues || 'validation failed'}; check the terminal submission schema — leave unknown ids null.`.slice(0, 400),
            },
          ],
          details: {},
        };
      }
      onSubmission(parsed.data);
      return {
        content: [{ type: 'text', text: 'Submission accepted. Do not call any terminal tool again.' }],
        details: {},
      };
    },
  }));
}

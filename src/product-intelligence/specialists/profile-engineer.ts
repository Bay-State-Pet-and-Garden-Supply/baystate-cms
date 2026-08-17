/**
 * Provider-neutral Profile Engineer specialist (epic #47, issue #51).
 *
 * The engineer is deliberately a proposal/validation capability. It can inspect
 * deterministic page signals and produce a versioned profile candidate, but it
 * never writes extractor_profiles, calls the promoter, or releases onboarding
 * work. Profile Builder and profile governance remain the only activation
 * authority.
 */
import { z } from 'zod';
import type { SpecialistContext, SpecialistCapability, SpecialistResult } from './contracts';
import { SpecialistResultSchema } from './contracts';
import type { PageExtractionContract } from '../tools/contract';
import {
  captureSpecialistCodeCommit,
  finalizeSpecialistArtifact,
  SpecialistArtifactSchemaRegistry,
  type SpecialistArtifactEnvelope,
  serializeSpecialistArtifact,
} from './artifacts';

export const PROFILE_ENGINEER_SPECIALIST_NAME = 'profile_engineer';
export const PROFILE_ENGINEER_SPECIALIST_VERSION = '1.0.0';
export const PROFILE_ENGINEER_INPUT_SCHEMA_VERSION = '1.0.0';
export const PROFILE_ENGINEER_OUTPUT_SCHEMA_VERSION = '1.0.0';
export const PROFILE_ENGINEER_INPUT_ARTIFACT_TYPE = 'profile_engineer_input';
export const PROFILE_ENGINEER_OUTPUT_ARTIFACT_TYPE = 'profile_engineer_result';

const MAX_SAMPLES = 20;
const MAX_FIELDS = 64;
const MAX_ARTIFACT_REFS = 16;

const boundedRecord = <T>(valueSchema: z.ZodType<T>) =>
  z.record(z.string().max(256), valueSchema).superRefine((value, ctx) => {
    if (Object.keys(value).length > MAX_FIELDS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${MAX_FIELDS} fields are allowed` });
    }
  });

const ProfileEngineerFieldSchema = z.object({
  status: z.enum(['pass', 'warning', 'fail']),
  /** Number of representative pages on which this field was observed. */
  coveredSamples: z.number().int().nonnegative(),
  sampleCount: z.number().int().positive(),
  extractedValue: z.string().max(4096).nullable().default(null),
  failureReason: z.string().max(1024).nullable().default(null),
}).strict();
export type ProfileEngineerField = z.infer<typeof ProfileEngineerFieldSchema>;

export const ProfileEngineerSampleSchema = z.object({
  url: z.string().url().max(2048),
  /** Exact retained worker/page artifacts used while proposing or validating. */
  artifactRefs: z.array(z.string().trim().min(1).max(512)).max(MAX_ARTIFACT_REFS).default([]),
  expectedName: z.string().max(512).nullish(),
  expectedGtin: z.string().max(32).nullish(),
  expectedVariant: z.string().max(256).nullish(),
  /** Deterministic signals from the extraction ladder; never model claims. */
  signals: z.object({
    jsonLd: z.boolean().default(false),
    shopify: z.boolean().default(false),
    woocommerce: z.boolean().default(false),
    embeddedState: z.boolean().default(false),
    selectorOnly: z.boolean().default(false),
    changedMarkup: z.boolean().default(false),
    wrongVariant: z.boolean().default(false),
  }).default({
    jsonLd: false,
    shopify: false,
    woocommerce: false,
    embeddedState: false,
    selectorOnly: false,
    changedMarkup: false,
    wrongVariant: false,
  }),
  /** Optional deterministic selector observations supplied by the profile worker. */
  selectorHints: boundedRecord(z.string().max(500).nullable()).default({}),
  /** Optional normalized observations used by the default validation gate. */
  observedFields: boundedRecord(z.string().max(4096).nullable()).default({}),
}).strict();
export type ProfileEngineerSample = z.infer<typeof ProfileEngineerSampleSchema>;

export const ProfileEngineerInputSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  domain: z.string().trim().min(1).max(256),
  /** Existing profile is supplied for compatibility checking, never modified. */
  activeProfile: z.object({
    version: z.number().int().positive().default(1),
    selectors: boundedRecord(z.string().nullable()).default({}),
    runtime: z.enum(['static', 'rendered']).default('rendered'),
  }).nullable().default(null),
  // Two independent pages are the minimum evidence needed to distinguish a
  // working profile from a selector that only happens to match one fixture.
  samples: z.array(ProfileEngineerSampleSchema).min(2).max(MAX_SAMPLES),
  requiredFields: z.array(z.string().trim().min(1).max(128)).max(MAX_FIELDS).default(['titleSelector']),
}).strict();
export type ProfileEngineerInput = z.infer<typeof ProfileEngineerInputSchema>;

export const ProfileEngineerValidationRecordSchema = z.object({
  url: z.string().url().max(2048),
  artifactRefs: z.array(z.string().trim().min(1).max(512)).max(MAX_ARTIFACT_REFS),
  identityStatus: z.enum(['exact', 'probable', 'wrong_variant', 'unknown']),
  fields: z.record(z.string(), ProfileEngineerFieldSchema),
  overall: z.enum(['pass', 'warning', 'fail']),
}).strict();
export type ProfileEngineerValidationRecord = z.infer<typeof ProfileEngineerValidationRecordSchema>;

export const ProfileEngineerProposalSchema = z.object({
  domain: z.string().trim().min(1).max(256),
  proposedVersion: z.number().int().positive(),
  strategy: z.enum(['json_ld', 'shopify', 'woocommerce', 'embedded_state', 'selector_only', 'mixed']),
  selectors: boundedRecord(z.string().nullable()),
  runtime: z.enum(['static', 'rendered']),
  /** Extra deterministic profile settings (variant/image rules, etc.). */
  metadata: z.record(z.string(), z.unknown()).default({}),
  validation: z.array(ProfileEngineerValidationRecordSchema).min(1).max(MAX_SAMPLES),
  validationSummary: z.object({
    sampleCount: z.number().int().positive(),
    passingSamples: z.number().int().nonnegative(),
    failingSamples: z.number().int().nonnegative(),
    byField: z.record(z.string(), z.object({ coveredSamples: z.number().int().nonnegative(), failedSamples: z.number().int().nonnegative(), status: z.enum(['pass', 'warning', 'fail']) }).strict()),
  }).strict(),
  /** Explicitly non-authoritative. This value is required by the contract. */
  authority: z.literal('proposal_only'),
  /** No generated selector is eligible for activation without governance. */
  activation: z.literal('manual_review_required'),
}).strict();
export type ProfileEngineerProposal = z.infer<typeof ProfileEngineerProposalSchema>;

export const PROFILE_ENGINEER_INPUT_ARTIFACT_SCHEMA = {
  name: PROFILE_ENGINEER_INPUT_ARTIFACT_TYPE,
  version: PROFILE_ENGINEER_INPUT_SCHEMA_VERSION,
  schema: ProfileEngineerInputSchema,
  description: 'Domain profile compatibility request with representative page evidence',
} as const;
export const PROFILE_ENGINEER_OUTPUT_ARTIFACT_SCHEMA = {
  name: PROFILE_ENGINEER_OUTPUT_ARTIFACT_TYPE,
  version: PROFILE_ENGINEER_OUTPUT_SCHEMA_VERSION,
  schema: ProfileEngineerProposalSchema,
  description: 'Versioned, validated domain profile proposal; never activation authority',
} as const;

export const PROFILE_ENGINEER_SPECIALIST_CAPABILITY: SpecialistCapability = {
  name: PROFILE_ENGINEER_SPECIALIST_NAME,
  version: PROFILE_ENGINEER_SPECIALIST_VERSION,
  kind: 'extraction',
  summary: 'Proposes and validates domain extraction profiles without activating them.',
  input: { schemaName: PROFILE_ENGINEER_INPUT_ARTIFACT_TYPE, schemaVersion: PROFILE_ENGINEER_INPUT_SCHEMA_VERSION },
  output: { schemaName: PROFILE_ENGINEER_OUTPUT_ARTIFACT_TYPE, schemaVersion: PROFILE_ENGINEER_OUTPUT_SCHEMA_VERSION },
};
export const profileEngineerSpecialistCapability = PROFILE_ENGINEER_SPECIALIST_CAPABILITY;

export function registerProfileEngineerSchemas(registry: SpecialistArtifactSchemaRegistry): SpecialistArtifactSchemaRegistry {
  return registry.register(PROFILE_ENGINEER_INPUT_ARTIFACT_SCHEMA).register(PROFILE_ENGINEER_OUTPUT_ARTIFACT_SCHEMA);
}

export interface ProfileEngineerHealth {
  healthy: boolean;
  reason?: string;
  /** Machine-readable probe outcome retained for routing/audit consumers. */
  failure?: {
    code: 'cancelled' | 'no_representative_samples' | 'insufficient_representative_samples' | 'profile_runner_unavailable' | 'profile_probe_failed' | 'profile_incompatible';
    url?: string;
  };
}

export interface ProfileEngineerWorkflowMutation {
  applied: boolean;
  reason?: string;
  generationId?: string | null;
  revisionId?: string | null;
}

export interface ProfileEngineerWorkflowLock {
  claim(domain: string, runId: string, workspaceId: string): Promise<{ acquired: boolean; workflowId: string; reason?: string }> | { acquired: boolean; workflowId: string; reason?: string };
  complete?(workflowId: string, runId: string, artifactJson?: string): Promise<ProfileEngineerWorkflowMutation> | ProfileEngineerWorkflowMutation;
  fail?(workflowId: string, runId: string, reason: string): Promise<ProfileEngineerWorkflowMutation> | ProfileEngineerWorkflowMutation;
}

export interface ProfileEngineerDependencies {
  /** Checks the active profile using deterministic extraction, not model confidence. */
  checkProfile?: (profile: ProfileEngineerInput['activeProfile'], input: ProfileEngineerInput, context: SpecialistContext) => Promise<ProfileEngineerHealth> | ProfileEngineerHealth;
  /** Existing provider-neutral ladder; no browser/provider is selected here. */
  extraction?: PageExtractionContract;
  /** Optional domain lock; implementations should be restart/concurrency safe. */
  workflow?: ProfileEngineerWorkflowLock;
}

export interface ProfileEngineerOptions {
  codeCommit?: string | null;
  /** The profile generator is not allowed to select a selector from one page only. */
  minimumRepresentativeSamples?: number;
}

export interface ProfileEngineerRun {
  output: ProfileEngineerProposal;
  artifact: SpecialistArtifactEnvelope;
  result: SpecialistResult;
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./u, '').trim();
}

function strategyFor(samples: ProfileEngineerSample[]): ProfileEngineerProposal['strategy'] {
  const signal = (name: keyof ProfileEngineerSample['signals']) => samples.some((sample) => sample.signals[name]);
  const methods = [signal('jsonLd'), signal('shopify'), signal('woocommerce'), signal('embeddedState'), signal('selectorOnly')].filter(Boolean).length;
  if (methods > 1) return 'mixed';
  if (signal('jsonLd')) return 'json_ld';
  if (signal('shopify')) return 'shopify';
  if (signal('woocommerce')) return 'woocommerce';
  if (signal('embeddedState')) return 'embedded_state';
  return 'selector_only';
}

/**
 * Select only selector hints repeated across every representative page. A
 * selector seen on one page is intentionally omitted rather than promoted.
 */
function repeatedSelectors(samples: ProfileEngineerSample[]): Record<string, string | null> {
  const keys = new Set(samples.flatMap((sample) => Object.keys(sample.selectorHints)));
  const selectors: Record<string, string | null> = {};
  for (const key of keys) {
    const values = samples.map((sample) => sample.selectorHints[key]).filter((value): value is string => !!value?.trim());
    if (values.length === samples.length && new Set(values).size === 1) selectors[key] = values[0];
    else selectors[key] = null;
  }
  return selectors;
}

function identityStatus(sample: ProfileEngineerSample): ProfileEngineerValidationRecord['identityStatus'] {
  if (sample.signals.wrongVariant || sample.expectedVariant?.toLowerCase() === 'wrong') return 'wrong_variant';
  if (sample.expectedName && sample.observedFields.product_name) {
    const expected = sample.expectedName.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
    const actual = sample.observedFields.product_name.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
    if (actual === expected || actual.includes(expected) || expected.includes(actual)) return 'exact';
    return 'probable';
  }
  return 'unknown';
}

function validateSample(input: ProfileEngineerInput, sample: ProfileEngineerSample, selectors: Record<string, string | null>): ProfileEngineerValidationRecord {
  const fields: Record<string, ProfileEngineerField> = {};
  const observationForField = (field: string): string | null => {
    const direct = sample.observedFields[field];
    if (direct !== undefined) return direct;
    const semanticField: Record<string, string> = {
      titleSelector: 'product_name',
      descriptionSelector: 'description',
      brandSelector: 'brand',
      imagesSelector: 'images',
    };
    return semanticField[field] ? sample.observedFields[semanticField[field]] ?? null : null;
  };
  for (const field of input.requiredFields) {
    const observed = observationForField(field);
    const selector = selectors[field] ?? sample.selectorHints[field] ?? null;
    const covered = observed !== null && observed.trim().length > 0;
    const failedForMarkup = sample.signals.changedMarkup || (sample.signals.selectorOnly && !selector);
    fields[field] = {
      status: covered && !failedForMarkup ? 'pass' : failedForMarkup ? 'fail' : 'warning',
      coveredSamples: covered && !failedForMarkup ? 1 : 0,
      sampleCount: 1,
      extractedValue: covered ? observed : null,
      failureReason: covered && !failedForMarkup ? null : failedForMarkup ? 'selector did not survive representative markup' : 'field was not observed in the deterministic page evidence',
    };
  }
  if (sample.signals.wrongVariant) {
    for (const field of Object.keys(fields)) {
      fields[field] = { ...fields[field], status: 'fail', coveredSamples: 0, failureReason: 'wrong-variant sample cannot validate a profile' };
    }
  }
  const statuses = Object.values(fields).map((field) => field.status);
  const overall: ProfileEngineerValidationRecord['overall'] = statuses.includes('fail') ? 'fail' : statuses.includes('warning') ? 'warning' : 'pass';
  return { url: sample.url, artifactRefs: sample.artifactRefs, identityStatus: identityStatus(sample), fields, overall };
}

/**
 * Deterministically probes an already registered profile through the existing
 * PageExtractionContract. Callers can use this before routing to the
 * specialist, so healthy profiles never invoke Profile Engineer. A profile is
 * incompatible when any representative page is missing a title or reports a
 * wrong/conflicting identity; model confidence is never consulted.
 */
export async function evaluateExistingProfile(
  profile: ProfileEngineerInput['activeProfile'],
  samples: ProfileEngineerSample[],
  extraction: PageExtractionContract,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ProfileEngineerHealth> {
  if (!profile) return { healthy: false, reason: 'profile_missing' };
  if (samples.length < 2) {
    return {
      healthy: false,
      reason: samples.length === 0 ? 'no_representative_samples' : 'insufficient_representative_samples',
      failure: { code: samples.length === 0 ? 'no_representative_samples' : 'insufficient_representative_samples' },
    };
  }
  // A generic extraction result is never evidence that an active profile is
  // healthy. In particular, do not call extract() when the explicit runner is
  // absent: doing so can fetch a page successfully and obscure that the
  // profile cannot be exercised by this contract.
  if (!extraction.extractWithProfile) {
    return {
      healthy: false,
      reason: 'profile_runner_unavailable',
      failure: { code: 'profile_runner_unavailable' },
    };
  }
  const profileRequest = {
    selectors: profile.selectors,
    runtime: profile.runtime,
  };
  for (const sample of samples) {
    if (signal.aborted) return { healthy: false, reason: 'cancelled', failure: { code: 'cancelled', url: sample.url } };
    try {
      const result = await extraction.extractWithProfile({
        url: sample.url,
        expected: { name: sample.expectedName ?? undefined, gtin: sample.expectedGtin ?? undefined },
        signal,
        timeoutMs,
        profile: profileRequest,
      });
      const profileFields = result.fields.filter((field) => field.method === 'profile_selector');
      const title = profileFields.find((field) => field.field === 'product_name')?.value
        ?? profileFields.find((field) => field.field === 'title')?.value;
      const usedProfile = result.fetchModes.includes('profile_selector') && profileFields.length > 0;
      if (!usedProfile || !title?.trim() || result.identityStatus === 'wrong_variant' || result.identityStatus === 'conflicting_identity') {
        return {
          healthy: false,
          reason: `profile_incompatible:${sample.url}`,
          failure: { code: 'profile_incompatible', url: sample.url },
        };
      }
    } catch {
      return {
        healthy: false,
        reason: `profile_probe_failed:${sample.url}`,
        failure: { code: 'profile_probe_failed', url: sample.url },
      };
    }
  }
  return { healthy: true, reason: 'all_representative_pages_passed' };
}

/**
 * Integration seam for the existing ladder/profile worker. The caller may add
 * the durable `profileEngineerWorkflowLock()` adapter from the DB repository;
 * this pure seam only wires deterministic compatibility probing and therefore
 * remains safe to use from provider-neutral orchestration code.
 */
export function createProfileEngineerExtractionSeam(extraction: PageExtractionContract): Pick<ProfileEngineerDependencies, 'extraction' | 'checkProfile'> {
  return {
    extraction,
    checkProfile: async (profile, input, context) => evaluateExistingProfile(
      profile,
      input.samples,
      extraction,
      context.signal ?? new AbortController().signal,
      context.deadlineAt ? Math.max(1, context.deadlineAt - Date.now()) : context.policy.deadlineMs,
    ),
  };
}

function buildProposal(input: ProfileEngineerInput, minimumSamples: number): ProfileEngineerProposal {
  const selectors = repeatedSelectors(input.samples);
  const validation = input.samples.map((sample) => validateSample(input, sample, selectors));
  const byField: ProfileEngineerProposal['validationSummary']['byField'] = {};
  for (const field of input.requiredFields) {
    const rows = validation.map((row) => row.fields[field]);
    const coveredSamples = rows.filter((row) => row.status === 'pass').length;
    const failedSamples = rows.filter((row) => row.status === 'fail').length;
    byField[field] = {
      coveredSamples,
      failedSamples,
      status: failedSamples > 0 ? 'fail' : coveredSamples < minimumSamples ? 'warning' : 'pass',
    };
  }
  const passingSamples = validation.filter((row) => row.overall === 'pass').length;
  const failingSamples = validation.filter((row) => row.overall === 'fail').length;
  const strategy = strategyFor(input.samples);
  const metadata: Record<string, unknown> = {
    extractionLadder: ['json_ld', 'platform_api', 'embedded_state', 'selector_only'],
    validationArtifacts: validation.flatMap((row) => row.artifactRefs),
  };
  if (strategy === 'shopify') metadata.shopifyJSONPath = true;
  return {
    domain: normalizeDomain(input.domain),
    proposedVersion: (input.activeProfile?.version ?? 0) + 1,
    strategy,
    selectors,
    runtime: input.activeProfile?.runtime ?? 'rendered',
    metadata,
    validation,
    validationSummary: { sampleCount: input.samples.length, passingSamples, failingSamples, byField },
    authority: 'proposal_only',
    activation: 'manual_review_required',
  };
}

export class ProfileEngineerSpecialist {
  readonly capability = PROFILE_ENGINEER_SPECIALIST_CAPABILITY;
  private readonly dependencies: ProfileEngineerDependencies;
  private readonly options: Required<ProfileEngineerOptions>;

  constructor(dependencies: ProfileEngineerDependencies = {}, options: ProfileEngineerOptions = {}) {
    this.dependencies = dependencies;
    this.options = {
      codeCommit: options.codeCommit ?? null,
      minimumRepresentativeSamples: Math.max(2, Math.min(MAX_SAMPLES, options.minimumRepresentativeSamples ?? 2)),
    };
  }

  async execute(rawInput: unknown, context: SpecialistContext): Promise<SpecialistResult> {
    const run = await this.engineer(rawInput, context);
    return 'result' in run ? run.result : run;
  }

  async engineer(rawInput: unknown, context: SpecialistContext): Promise<ProfileEngineerRun | SpecialistResult> {
    const parsed = ProfileEngineerInputSchema.safeParse(rawInput);
    if (!parsed.success) return { specialist: PROFILE_ENGINEER_SPECIALIST_NAME, outcome: 'failed', failure: { code: 'invalid_input', message: parsed.error.message }, durationMs: 0 };
    const startedAt = Date.now();
    const minimumSamples = this.options.minimumRepresentativeSamples;
    if (parsed.data.samples.length < minimumSamples) {
      return {
        specialist: PROFILE_ENGINEER_SPECIALIST_NAME,
        outcome: 'failed',
        failure: { code: 'invalid_input', message: `at least ${minimumSamples} representative pages are required` },
        durationMs: 0,
      };
    }
    const input = { ...parsed.data, domain: normalizeDomain(parsed.data.domain) };

    if (input.activeProfile) {
      const health = this.dependencies.checkProfile
        ? await this.dependencies.checkProfile(input.activeProfile, input, context)
        : this.dependencies.extraction
          ? await evaluateExistingProfile(
            input.activeProfile,
            input.samples,
            this.dependencies.extraction,
            context.signal ?? new AbortController().signal,
            context.deadlineAt ? Math.max(1, context.deadlineAt - Date.now()) : context.policy.deadlineMs,
          )
          : { healthy: false, reason: 'profile_health_probe_not_configured' };
      if (health.healthy) return { specialist: PROFILE_ENGINEER_SPECIALIST_NAME, outcome: 'abstained', abstention: { reason: 'healthy_profile_reused', actionableNextStep: null, targets: [input.domain] }, durationMs: Date.now() - startedAt };
    }

    let lock: { acquired: boolean; workflowId: string; reason?: string } | null = null;
    if (this.dependencies.workflow) {
      lock = await this.dependencies.workflow.claim(input.domain, context.runId, context.workspaceId);
      if (!lock.acquired) return { specialist: PROFILE_ENGINEER_SPECIALIST_NAME, outcome: 'abstained', abstention: { reason: lock.reason ?? 'domain_workflow_already_running', actionableNextStep: 'Reuse the existing domain workflow result or wait for its validation.', targets: [input.domain] }, durationMs: Date.now() - startedAt };
    }

    try {
      const proposal = buildProposal(input, this.options.minimumRepresentativeSamples);
      const durationMs = Date.now() - startedAt;
      const artifact = finalizeSpecialistArtifact({
        artifactType: PROFILE_ENGINEER_OUTPUT_ARTIFACT_TYPE,
        payload: proposal,
        payloadSchema: ProfileEngineerProposalSchema,
        lineage: { runId: context.runId, workflowRef: lock?.workflowId ?? input.domain },
        provenance: {
          specialist: PROFILE_ENGINEER_SPECIALIST_NAME,
          specialistVersion: PROFILE_ENGINEER_SPECIALIST_VERSION,
          policyConfigId: context.policy.configId,
          codeCommit: this.options.codeCommit ?? captureSpecialistCodeCommit(),
          durationMs,
        },
      });
      if (lock && this.dependencies.workflow?.complete) {
        const completion = await this.dependencies.workflow.complete(lock.workflowId, context.runId, serializeSpecialistArtifact(artifact));
        if (!completion.applied) {
          return {
            specialist: PROFILE_ENGINEER_SPECIALIST_NAME,
            outcome: 'abstained',
            abstention: {
              reason: completion.reason ?? 'workflow_lease_lost',
              actionableNextStep: 'Retry the profile proposal under a newly acquired workflow lease.',
              targets: [input.domain],
            },
            durationMs: Date.now() - startedAt,
          };
        }
      }
      const result = SpecialistResultSchema.parse({ specialist: PROFILE_ENGINEER_SPECIALIST_NAME, outcome: 'succeeded', output: artifact, durationMs });
      return { output: proposal, artifact, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (lock && this.dependencies.workflow?.fail) {
        const failure = await this.dependencies.workflow.fail(lock.workflowId, context.runId, message);
        if (!failure.applied) {
          return {
            specialist: PROFILE_ENGINEER_SPECIALIST_NAME,
            outcome: 'abstained',
            abstention: {
              reason: failure.reason ?? 'workflow_lease_lost',
              actionableNextStep: 'Retry the profile proposal under a newly acquired workflow lease.',
              targets: [input.domain],
            },
            durationMs: Date.now() - startedAt,
          };
        }
      }
      return { specialist: PROFILE_ENGINEER_SPECIALIST_NAME, outcome: 'failed', failure: { code: 'capability_error', message: message.slice(0, 4096) }, durationMs: Date.now() - startedAt };
    }
  }
}

export async function runProfileEngineerSpecialist(input: unknown, context: SpecialistContext, dependencies: ProfileEngineerDependencies = {}, options: ProfileEngineerOptions = {}): Promise<ProfileEngineerRun | SpecialistResult> {
  return new ProfileEngineerSpecialist(dependencies, options).engineer(input, context);
}

export const ProfileEngineer = ProfileEngineerSpecialist;
export const ProfileEngineerInput = ProfileEngineerInputSchema;
export const ProfileEngineerOutput = ProfileEngineerProposalSchema;

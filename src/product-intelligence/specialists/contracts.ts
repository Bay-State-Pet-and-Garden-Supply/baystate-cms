/**
 * Specialist capability contract (epic #47, issue #48).
 *
 * A specialist is a focused, bounded capability behind the Product
 * Intelligence orchestrator. Like classification stages (ADR 0004), a
 * specialist keeps one responsibility, declares its typed input and output
 * schemas, and is selected for execution by the orchestrator ONLY — a
 * specialist never routes work, never dispatches other specialists, and the
 * capability registry never selects one.
 *
 * These contracts are provider-neutral and runtime-neutral: they do not
 * reference the Pi SDK, an LLM provider, or a specific model. A specialist
 * may run deterministically, through a local model, or through a hosted
 * agent; the contract only pins what crosses the boundary.
 *
 * The durable handoff invariant: every specialist input and output is
 * schema-validated. Inputs are checked against the capability's declared
 * input contract (validateSpecialistInput / invokeSpecialistWithValidation)
 * before execution; outputs are checked against the declared output contract
 * (validateSpecialistResult) before durable handoff. Ordinary specialist
 * prose is never a durable handoff — the only thing that survives is a typed
 * artifact envelope (artifacts.ts) whose payload validates against the
 * specialist's declared output contract.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/48
 */
import { z } from 'zod';
import {
  artifactContentHash,
  isSchemaVersionCompatible,
  SpecialistArtifactEnvelopeSchema,
  type SpecialistArtifactEnvelope,
  type SpecialistArtifactSchemaRegistry,
} from './artifacts';
import type { ProductIntelligencePolicy } from '../contracts';

// ---------------------------------------------------------------------------
// Capability definition (metadata)
// ---------------------------------------------------------------------------

/** The stable domain a specialist operates in (capability classification). */
export const SpecialistKindSchema = z.enum([
  'research', // general product research over multiple evidence sources
  'identity', // GTIN / product-identity verification
  'extraction', // structured page or media extraction
  'classification', // taxonomy / attribute / Category Page proposals
  'orchestration', // coordination capability (scheduling, sequencing, routing)
]);
export type SpecialistKind = z.infer<typeof SpecialistKindSchema>;

/** Declared input contract: a typed, versioned schema the orchestrator must satisfy. */
export const SpecialistInputContractSchema = z.object({
  /** Stable schema name (resolved through the artifact schema registry). */
  schemaName: z.string().min(1).max(128),
  /** Schema version the specialist requires (semver; major must match the registered schema). */
  schemaVersion: z.string().min(1).max(32).regex(/^\d+\.\d+\.\d+$/, { message: 'schemaVersion must be semver (major.minor.patch)' }),
  description: z.string().max(1024).nullish(),
});
export type SpecialistInputContract = z.infer<typeof SpecialistInputContractSchema>;

/** Declared output contract: the typed artifact a specialist must produce to be durable. */
export const SpecialistOutputContractSchema = z.object({
  /** Stable artifact type name (must equal envelope.artifactType of produced artifacts). */
  schemaName: z.string().min(1).max(128),
  /** Schema version the specialist produces (semver; major must match the registered payload schema). */
  schemaVersion: z.string().min(1).max(32).regex(/^\d+\.\d+\.\d+$/, { message: 'schemaVersion must be semver (major.minor.patch)' }),
  description: z.string().max(1024).nullish(),
});
export type SpecialistOutputContract = z.infer<typeof SpecialistOutputContractSchema>;

/**
 * Runtime/provider-neutral capability definition. The registry exposes these
 * definitions (metadata + configuration); the orchestrator reads them and
 * routes work to the selected specialist.
 */
export const SpecialistCapabilitySchema = z.object({
  /** Stable, unique specialist name (contract-level id; the registry key). */
  name: z.string().min(1).max(128),
  /** Implementation version; bumped on any behavior change. */
  version: z.string().min(1).max(32).regex(/^\d+\.\d+\.\d+$/, { message: 'version must be semver (major.minor.patch)' }),
  kind: SpecialistKindSchema,
  summary: z.string().min(1).max(1024),
  input: SpecialistInputContractSchema,
  output: SpecialistOutputContractSchema,
});
export type SpecialistCapability = z.infer<typeof SpecialistCapabilitySchema>;

// ---------------------------------------------------------------------------
// Runtime context
// ---------------------------------------------------------------------------

/**
 * The runtime context handed to a specialist by the orchestrator. It reuses
 * the existing Product Intelligence per-run policy snapshot (PI-5) so every
 * specialist executes under the same immutable governance as PI runs.
 */
export interface SpecialistContext {
  /** Orchestrating Product Intelligence run id. */
  runId: string;
  workspaceId: string;
  workspacePath: string;
  /** Immutable policy snapshot the specialist executes under. */
  policy: ProductIntelligencePolicy;
  /** Deterministic per-run sequence (specialist invocation order). */
  seq: number;
  /** Runtime-only extension: caller cancellation signal (never serialized). */
  signal?: AbortSignal;
  /** Absolute epoch-ms deadline when the orchestrator enforces one. */
  deadlineAt?: number;
}

// ---------------------------------------------------------------------------
// Bounded result
// ---------------------------------------------------------------------------

export const SpecialistFailureCodeSchema = z.enum([
  'invalid_input',
  'policy_denied',
  'model_unavailable',
  'capability_error',
  'deadline_exceeded',
  'cancelled',
  'unknown',
]);
export type SpecialistFailureCode = z.infer<typeof SpecialistFailureCodeSchema>;

export const SpecialistFailureSchema = z.object({
  code: SpecialistFailureCodeSchema,
  message: z.string().min(1).max(4096),
});
export type SpecialistFailure = z.infer<typeof SpecialistFailureSchema>;

/** Stage-style abstention (see 'Stage Abstention' in CONTEXT.md): an
 *  intentional no-output outcome with an explanation — never a failure. */
export const SpecialistAbstentionSchema = z.object({
  reason: z.string().min(1).max(2048),
  actionableNextStep: z.string().max(2048).nullish(),
  /** Targets abstained on (partial abstention). */
  targets: z.array(z.string().min(1)).default([]),
});
export type SpecialistAbstention = z.infer<typeof SpecialistAbstentionSchema>;

export const SpecialistOutcomeSchema = z.enum(['succeeded', 'failed', 'abstained']);
export type SpecialistOutcome = z.infer<typeof SpecialistOutcomeSchema>;

/**
 * The bounded result contract. `output` — when present — must be a typed
 * artifact envelope (or a non-empty array of them): schema-validated,
 * versioned, lineage + provenance stamped. A failure carries failure details,
 * an abstention carries a reason; neither is a handoff.
 */
export const SpecialistResultSchema = z.object({
  /** Must equal the capability name (checked by validateSpecialistResult). */
  specialist: z.string().min(1).max(128),
  outcome: SpecialistOutcomeSchema,
  output: z.union([SpecialistArtifactEnvelopeSchema, z.array(SpecialistArtifactEnvelopeSchema)]).nullish(),
  abstention: SpecialistAbstentionSchema.nullish(),
  failure: SpecialistFailureSchema.nullish(),
  durationMs: z.number().int().nonnegative().default(0),
});
export type SpecialistResult = z.infer<typeof SpecialistResultSchema>;

// ---------------------------------------------------------------------------
// Result validation (the durable-handoff gate)
// ---------------------------------------------------------------------------

export interface SpecialistValidationResult {
  valid: boolean;
  issues: string[];
}

/** Normalize a single envelope or an array to a sequence. */
function outputsOf(result: SpecialistResult): SpecialistArtifactEnvelope[] {
  if (result.output === undefined || result.output === null) return [];
  return Array.isArray(result.output) ? result.output : [result.output];
}

/**
 * Deterministic gate applied before any specialist result may become durable
 * state: the result must parse, be consistent with the capability contract,
 * and every produced artifact must carry the declared artifact type, a
 * version-compatible schema, a self-consistent content hash, and a payload
 * that validates against the registered typed payload schema. Prose fails
 * here — there is no "prose handoff" path.
 */
export function validateSpecialistResult(input: {
  result: unknown;
  capability: SpecialistCapability;
  artifactSchemas: SpecialistArtifactSchemaRegistry;
}): SpecialistValidationResult {
  const parsed = SpecialistResultSchema.safeParse(input.result);
  if (!parsed.success) {
    return { valid: false, issues: [`result failed the specialist result schema: ` + String(parsed.error.message)] };
  }
  const result = parsed.data;
  const issues: string[] = [];

  if (result.specialist !== input.capability.name) {
    issues.push(`result.specialist '${result.specialist}' does not match capability '${input.capability.name}'`);
  }

  switch (result.outcome) {
    case 'succeeded': {
      if (result.failure) issues.push('succeeded outcome must not carry failure details');
      if (result.abstention) issues.push('succeeded outcome must not carry an abstention');
      if (outputsOf(result).length === 0) {
        issues.push('succeeded outcome requires at least one typed artifact output');
      }
      break;
    }
    case 'failed': {
      if (!result.failure) issues.push('failed outcome requires failure details');
      if (result.abstention) issues.push('failed outcome must not carry an abstention');
      if (outputsOf(result).length > 0) issues.push('failed outcome must not carry an artifact output (no handoff on failure)');
      break;
    }
    case 'abstained': {
      if (!result.abstention) issues.push('abstained outcome requires an abstention reason');
      if (outputsOf(result).length > 0) issues.push('abstained outcome must not carry an artifact output');
      break;
    }
  }

  // Every produced artifact must satisfy the capability's output contract.
  for (const envelope of outputsOf(result)) {
    if (envelope.artifactType !== input.capability.output.schemaName) {
      issues.push(
        `artifact.artifactType '${envelope.artifactType}' does not match the capability output contract '${input.capability.output.schemaName}'`,
      );
      continue;
    }
    // The schema version the envelope claims must be same-major compatible
    // with the version the capability declared — an envelope never silently
    // switches payload-schema generations behind the contract's back.
    if (!isSchemaVersionCompatible(envelope.schemaVersion, input.capability.output.schemaVersion)) {
      issues.push(
        `artifact schema version '${envelope.schemaVersion}' is incompatible with the declared output contract version '${input.capability.output.schemaVersion}'`,
      );
    }
    if (!input.artifactSchemas.isVersionCompatible(envelope.artifactType, input.capability.output.schemaVersion)) {
      issues.push(
        `artifact schema '${envelope.artifactType}' version '${input.capability.output.schemaVersion}' is not registered or major-incompatible`,
      );
      continue;
    }
    // contentHash self-check: recompute the canonical payload+lineage hash
    // with the established canonicalization and reject any mismatch — a
    // stale or forged hash is not a durable handoff.
    let expectedContentHash: string;
    try {
      expectedContentHash = artifactContentHash(envelope);
    } catch (error) {
      issues.push(
        `artifact payload is not canonical-JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (expectedContentHash !== envelope.contentHash) {
      issues.push(
        `artifact contentHash mismatch: envelope declares ${envelope.contentHash.slice(0, 12)}… but ${expectedContentHash.slice(0, 12)}… was recomputed from its payload + lineage via canonical JSON`,
      );
    }
    // Validate the payload against the schema version the envelope claims to
    // conform to — never the "closest" registered schema.
    const payloadCheck = input.artifactSchemas.validatePayload(
      envelope.artifactType,
      envelope.schemaVersion,
      envelope.payload,
    );
    if (!payloadCheck.valid) {
      issues.push(...payloadCheck.issues);
    }
  }

  return { valid: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Input validation + deterministic capability invocation path
// ---------------------------------------------------------------------------

/**
 * Deterministic gate applied BEFORE a specialist executes: the raw input
 * payload must satisfy the capability's declared input contract (registered
 * schema name, major-compatible schema version, schema-valid payload). The
 * orchestrator runs this gate before handing the payload to the specialist,
 * so a malformed or unregistered input never reaches the implementation.
 */
export function validateSpecialistInput(input: {
  capability: SpecialistCapability;
  artifactSchemas: SpecialistArtifactSchemaRegistry;
  /** The raw input payload being handed to the specialist. */
  payload: unknown;
}): SpecialistValidationResult {
  const contract = input.capability.input;
  const issues: string[] = [];

  if (!input.artifactSchemas.has(contract.schemaName)) {
    return { valid: false, issues: [`input schema '${contract.schemaName}' is not registered`] };
  }
  if (!input.artifactSchemas.isVersionCompatible(contract.schemaName, contract.schemaVersion)) {
    return {
      valid: false,
      issues: [
        `input schema '${contract.schemaName}' version '${contract.schemaVersion}' is not registered or major-incompatible`,
      ],
    };
  }
  const payloadCheck = input.artifactSchemas.validatePayload(contract.schemaName, contract.schemaVersion, input.payload);
  if (!payloadCheck.valid) {
    issues.push(...payloadCheck.issues);
  }
  return { valid: issues.length === 0, issues };
}

/** The gateway stage that failed during a validated invocation. */
export const SpecialistValidationStageSchema = z.enum(['input', 'result']);
export type SpecialistValidationStage = z.infer<typeof SpecialistValidationStageSchema>;

/** Successful invocation: the validated result may become durable state. */
export interface SpecialistInvocationSuccess {
  ok: true;
  result: SpecialistResult;
}

/** Failed gate: which contract the input or the produced result violated. */
export interface SpecialistInvocationFailure {
  ok: false;
  stage: SpecialistValidationStage;
  issues: string[];
}

export type SpecialistInvocationOutcome = SpecialistInvocationSuccess | SpecialistInvocationFailure;

/**
 * Deterministic capability invocation/validation path (provider-neutral).
 *
 * The orchestrator calls this instead of invoking a specialist directly:
 * 1. the raw input is validated against the capability's declared input
 *    contract BEFORE `execute` runs (invalid input never reaches the
 *    specialist);
 * 2. the produced result is validated against the declared output contract
 *    (typed envelopes, registered payload schema, schema-version gates, and
 *    the canonical contentHash self-check) BEFORE the caller may treat it as
 *    a durable handoff.
 *
 * `execute` is supplied by the orchestrator — this path never routes or
 * selects a specialist (ADR 0018); it only validates the boundary crossing.
 */
export async function invokeSpecialistWithValidation(input: {
  capability: SpecialistCapability;
  artifactSchemas: SpecialistArtifactSchemaRegistry;
  context: SpecialistContext;
  /** The raw specialist input payload (validated against the input contract first). */
  input: unknown;
  execute: (input: unknown, context: SpecialistContext) => SpecialistResult | Promise<SpecialistResult>;
}): Promise<SpecialistInvocationOutcome> {
  const inputGate = validateSpecialistInput({
    capability: input.capability,
    artifactSchemas: input.artifactSchemas,
    payload: input.input,
  });
  if (!inputGate.valid) {
    return { ok: false, stage: 'input', issues: inputGate.issues };
  }
  const result = await input.execute(input.input, input.context);
  const resultGate = validateSpecialistResult({
    result,
    capability: input.capability,
    artifactSchemas: input.artifactSchemas,
  });
  if (!resultGate.valid) {
    return { ok: false, stage: 'result', issues: resultGate.issues };
  }
  return { ok: true, result };
}

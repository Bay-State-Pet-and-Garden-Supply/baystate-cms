/**
 * Typed workflow artifacts (epic #47, issue #48).
 *
 * A specialist artifact is the ONLY durable handoff between specialists and
 * the orchestrator: a versioned envelope that carries the typed payload,
 * the input/output lineage, and execution provenance. Free-form specialist
 * prose never becomes an artifact — a payload that does not validate against
 * the registered typed schema for its artifact type is rejected before it
 * can be persisted.
 *
 * Artifacts are plain canonical JSON (persistence-compatible): every envelope
 * round-trips through string serialization without losing lineage or
 * provenance, and `contentHash` pins the payload + lineage so a tampered
 * envelope is detectable at read time.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/48
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { canonicalJsonStringify, hashCanonicalJson } from '../../shared/stable-id';

/** Current supported artifact envelope schema version (semver). */
export const SPECIALIST_ARTIFACT_SCHEMA_VERSION = '1.0.0' as const;

/**
 * Capture the build identity without embedding a guessed commit in an
 * artifact. Deployments can provide a deterministic build value; local runs
 * fall back to the checked-out HEAD using the same convention as PI runs.
 */
export function captureSpecialistCodeCommit(): string | null {
  const configured = [
    process.env.BAYSTATE_CMS_CODE_COMMIT,
    process.env.GIT_COMMIT,
    process.env.SOURCE_VERSION,
    process.env.COMMIT_SHA,
  ].find((value) => typeof value === 'string' && value.trim().length > 0)?.trim();
  if (configured) return configured.slice(0, 64);
  try {
    const head = readFileSync(join(process.cwd(), '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref:')) {
      return readFileSync(join(process.cwd(), '.git', head.slice(5).trim()), 'utf8').trim().slice(0, 64) || null;
    }
    return head.slice(0, 64) || null;
  } catch {
    return null;
  }
}

export const SemverStringSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^\d+\.\d+\.\d+$/, { message: 'schema version must be semver (major.minor.patch)' });

export function schemaMajor(version: string): number {
  const match = /^(\d+)\./.exec(version);
  return match ? Number(match[1]) : NaN;
}

/**
 * Schema-version compatibility: same-major versions are readable by a
 * consumer built for `supported` (minor/patch bumps are additive). A
 * different major means the schema may have changed incompatibly and the
 * envelope must be rejected, never silently reinterpreted.
 */
export function isSchemaVersionCompatible(actual: string, supported: string): boolean {
  if (!SemverStringSchema.safeParse(actual).success || !SemverStringSchema.safeParse(supported).success) {
    return false;
  }
  return schemaMajor(actual) === schemaMajor(supported);
}

/** Throw when `actual` cannot be read by a consumer supporting `supported`. */
export function assertSchemaVersionCompatible(actual: string, supported: string): void {
  if (!isSchemaVersionCompatible(actual, supported)) {
    throw new Error(
      `incompatible artifact schema version: '${actual}' is not compatible with supported '${supported}' (major must match)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Lineage + provenance
// ---------------------------------------------------------------------------

/** Input/output lineage: which artifacts this artifact was derived from. */
export const ArtifactLineageSchema = z.object({
  /** Input artifact ids consumed to produce this artifact. */
  inputArtifactIds: z.array(z.string().min(1)).default([]),
  /** Parent artifact ids (same-type revision lineage, e.g. refresh chains). */
  parentArtifactIds: z.array(z.string().min(1)).default([]),
  /** Orchestrating Product Intelligence run id when produced inside one. */
  runId: z.string().min(1).nullish(),
  /** Higher-level workflow/batch reference when known. */
  workflowRef: z.string().min(1).nullish(),
});
export type ArtifactLineage = z.infer<typeof ArtifactLineageSchema>;

/** Execution provenance: who produced the artifact and under what policy. */
export const ArtifactProvenanceSchema = z.object({
  specialist: z.string().min(1).max(128),
  specialistVersion: z.string().min(1).max(32),
  /** Provider-backed executor name when one ran (e.g. 'pi'). */
  executor: z.string().min(1).max(128).nullish(),
  /**
   * The component that selected this specialist for execution. Only the
   * orchestrator routes work — specialists never dispatch other specialists
   * and the registry never selects one.
   */
  invokedBy: z.string().min(1).max(128).default('orchestrator'),
  /** CMS code commit captured at execution time. */
  codeCommit: z.string().trim().min(1).max(64),
  /** Immutable policy snapshot id the specialist executed under (PI-5 governance). */
  policyConfigId: z.string().min(1).max(128).nullish(),
  durationMs: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
});
export type ArtifactProvenance = z.infer<typeof ArtifactProvenanceSchema>;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * The versioned typed-artifact envelope. `payload` carries the specialist's
 * structured output; `lineage` records inputs consumed; `provenance` records
 * who executed, under which policy snapshot, and when; `contentHash` is the
 * SHA-256 of the canonical JSON of { artifactType, schemaVersion, payload,
 * lineage } so any later mutation of those fields is detectable.
 */
export const SpecialistArtifactEnvelopeSchema = z
  .object({
    /** Stable artifact type id (must equal the producer's output contract schemaName). */
    artifactType: z.string().min(1).max(128),
    /** Versioned artifact schema this envelope conforms to (semver). */
    schemaVersion: SemverStringSchema,
    /** The typed payload; validated against the registered payload schema for artifactType. */
    payload: z.unknown(),
    lineage: ArtifactLineageSchema,
    provenance: ArtifactProvenanceSchema,
    /** SHA-256 over { artifactType, schemaVersion, payload, lineage } (canonical JSON). */
    contentHash: z.string().min(1).max(128),
  })
  .superRefine((envelope, ctx) => {
    // Fail closed on incompatible schema versions at parse time.
    if (!isSchemaVersionCompatible(envelope.schemaVersion, SPECIALIST_ARTIFACT_SCHEMA_VERSION)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `artifact schema version '${envelope.schemaVersion}' is incompatible with supported '${SPECIALIST_ARTIFACT_SCHEMA_VERSION}'`,
        path: ['schemaVersion'],
      });
    }
  });
export type SpecialistArtifactEnvelope = z.infer<typeof SpecialistArtifactEnvelopeSchema>;

/** Include an artifact's contentHash target (without the hash itself). */
type HashableArtifact = Omit<SpecialistArtifactEnvelope, 'contentHash'>;

/** Deterministic content hash binding payload + lineage to the envelope. */
export function artifactContentHash(artifact: HashableArtifact): string {
  return hashCanonicalJson({
    artifactType: artifact.artifactType,
    schemaVersion: artifact.schemaVersion,
    payload: artifact.payload,
    lineage: artifact.lineage,
  });
}

// ---------------------------------------------------------------------------
// Build + validate + serialize
// ---------------------------------------------------------------------------

export interface FinalizeArtifactInput {
  /** Stable artifact type id (matches the producing specialist's output contract schemaName). */
  artifactType: string;
  /** The structured payload (prose is never a payload). */
  payload: unknown;
  /** When provided, the payload is validated here before the envelope is stamped. */
  payloadSchema?: z.ZodType<unknown>;
  lineage?: Partial<ArtifactLineage>;
  provenance: {
    specialist: string;
    specialistVersion: string;
    executor?: string | null;
    invokedBy?: string;
    codeCommit?: string | null;
    policyConfigId?: string | null;
    durationMs?: number;
    createdAt?: string;
  };
}

/**
 * Build a validated artifact envelope: validates the payload against the
 * optional payload schema, stamps lineage and provenance (the orchestrator
 * is the default invoker), and binds `contentHash` to the result.
 */
export function finalizeSpecialistArtifact(input: FinalizeArtifactInput): SpecialistArtifactEnvelope {
  if (input.payloadSchema) {
    const parsed = input.payloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      throw new Error(
        `artifact payload failed '${input.artifactType}' schema: ${summarizeZodIssues(parsed.error)}`,
      );
    }
  }
  const lineage: ArtifactLineage = {
    inputArtifactIds: [],
    parentArtifactIds: [],
    runId: null,
    workflowRef: null,
    ...input.lineage,
  };
  const provenance: ArtifactProvenance = {
    specialist: input.provenance.specialist,
    specialistVersion: input.provenance.specialistVersion,
    executor: input.provenance.executor ?? null,
    invokedBy: input.provenance.invokedBy ?? 'orchestrator',
    // Finalized artifacts must identify the immutable code/build that
    // produced them. Prefer explicit execution provenance, then use the
    // configured deployment value or checked-out HEAD. Never persist null.
    codeCommit: input.provenance.codeCommit?.trim() || captureSpecialistCodeCommit() || (() => {
      throw new Error('artifact provenance requires codeCommit or a configured/build checkout identifier');
    })(),
    policyConfigId: input.provenance.policyConfigId ?? null,
    durationMs: input.provenance.durationMs ?? 0,
    createdAt: input.provenance.createdAt ?? new Date().toISOString(),
  };
  const envelope: HashableArtifact = {
    artifactType: input.artifactType,
    schemaVersion: SPECIALIST_ARTIFACT_SCHEMA_VERSION,
    payload: input.payload,
    lineage,
    provenance,
  };
  const contentHash = artifactContentHash(envelope);
  return { ...envelope, contentHash };
}

/**
 * Validate an envelope: schema parse (including the schema-version gate) plus
 * a contentHash self-check. A tampered payload or lineage never validates.
 */
export function validateSpecialistArtifactEnvelope(
  value: unknown,
): { valid: true; envelope: SpecialistArtifactEnvelope } | { valid: false; issues: string[] } {
  const parsed = SpecialistArtifactEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    return { valid: false, issues: summarizeZodIssues(parsed.error) };
  }
  const expected = artifactContentHash(parsed.data);
  if (expected !== parsed.data.contentHash) {
    return {
      valid: false,
      issues: [
        `contentHash mismatch: envelope declares ${parsed.data.contentHash.slice(0, 12)}… but ${expected.slice(0, 12)}… was recomputed from its payload + lineage`,
      ],
    };
  }
  return { valid: true, envelope: parsed.data };
}

/** Canonical JSON serialization — the persistence-compatible wire form. */
export function serializeSpecialistArtifact(envelope: SpecialistArtifactEnvelope): string {
  return canonicalJsonStringify(envelope);
}

/** Read a serialized artifact back; throws when the envelope is invalid/tampered. */
export function parseSpecialistArtifact(text: string): SpecialistArtifactEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('specialist artifact is not valid JSON');
  }
  const validated = validateSpecialistArtifactEnvelope(value);
  if (!validated.valid) {
    throw new Error(`specialist artifact failed validation: ${validated.issues.join('; ')}`);
  }
  return validated.envelope;
}

/** Flatten zod error issues into short "<path>: <message>" strings. */
export function summarizeZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

// ---------------------------------------------------------------------------
// Typed payload schema registry
// ---------------------------------------------------------------------------

/** A registered typed payload schema for one artifact type. */
export interface SpecialistArtifactSchema {
  /** Stable schema name (== capability output/input contract schemaName). */
  name: string;
  /** Version of this schema definition (semver; the capability contract must major-match). */
  version: string;
  /** Zod schema validating payloads of this artifact type. */
  schema: z.ZodType<unknown>;
  /** Optional human description. */
  description?: string;
}

/**
 * Registry of typed artifact payload schemas. Specialists declare their
 * output contracts by name + version; the registry resolves the payload
 * schema and enforces version compatibility before a payload may become a
 * durable artifact.
 */
export class SpecialistArtifactSchemaRegistry {
  private readonly schemas = new Map<string, SpecialistArtifactSchema>();

  register(entry: SpecialistArtifactSchema): this {
    if (!SemverStringSchema.safeParse(entry.version).success) {
      throw new Error(`artifact schema '${entry.name}' version must be semver, got '${entry.version}'`);
    }
    if (this.schemas.has(entry.name)) {
      throw new Error(`Duplicate artifact schema registration: ${entry.name}`);
    }
    this.schemas.set(entry.name, entry);
    return this;
  }

  has(name: string): boolean {
    return this.schemas.has(name);
  }

  get(name: string): SpecialistArtifactSchema | undefined {
    return this.schemas.get(name);
  }

  names(): string[] {
    return [...this.schemas.keys()].sort();
  }

  /** True when the schema exists AND the required version is major-compatible. */
  isVersionCompatible(name: string, requiredVersion: string): boolean {
    const registered = this.schemas.get(name);
    return registered ? isSchemaVersionCompatible(requiredVersion, registered.version) : false;
  }

  /**
   * Validate a payload against a registered, version-compatible schema.
   * Missing schema or incompatible version fails closed — a payload is never
   * validated against the "closest" schema.
   */
  validatePayload(name: string, requiredVersion: string, payload: unknown): { valid: boolean; issues: string[] } {
    const registered = this.schemas.get(name);
    if (!registered) {
      return { valid: false, issues: [`no artifact schema registered for '${name}'`] };
    }
    if (!isSchemaVersionCompatible(requiredVersion, registered.version)) {
      return {
        valid: false,
        issues: [
          `artifact schema '${name}' version '${requiredVersion}' is incompatible with registered '${registered.version}'`,
        ],
      };
    }
    const parsed = registered.schema.safeParse(payload);
    if (!parsed.success) {
      return { valid: false, issues: [`payload failed '${name}' schema: ` + summarizeZodIssues(parsed.error).join('; ')] };
    }
    return { valid: true, issues: [] };
  }
}
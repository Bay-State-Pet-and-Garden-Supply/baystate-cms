/**
 * Specialist capability registry + typed workflow artifacts (epic #47,
 * issue #48).
 *
 * Focused unit tests (no DB, no Pi SDK):
 * - invalid artifacts are rejected (prose is never a durable handoff);
 * - incompatible schema versions fail closed (same-major compatibility);
 * - capability failure / abstention results are distinguished from handoffs;
 * - input/output lineage + execution provenance survive serialization
 *   (persistence-compatible lineage) and tampering is detected;
 * - the registry exposes specialist metadata/configuration and never routes;
 * - per-specialist policies reuse the existing Product Intelligence
 *   governance (PI-5 snapshot verification).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/48
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  SpecialistArtifactSchemaRegistry,
  finalizeSpecialistArtifact,
  isSchemaVersionCompatible,
  parseSpecialistArtifact,
  serializeSpecialistArtifact,
  validateSpecialistArtifactEnvelope,
  SPECIALIST_ARTIFACT_SCHEMA_VERSION,
} from '../../../product-intelligence/specialists/artifacts';
import { SpecialistRegistry } from '../../../product-intelligence/specialists/registry';
import {
  SpecialistCapabilitySchema,
  SpecialistResultSchema,
  validateSpecialistResult,
  type SpecialistCapability,
  type SpecialistResult,
  type SpecialistContext,
} from '../../../product-intelligence/specialists/contracts';
import type { SpecialistConfigurationDescriptor } from '../../../product-intelligence/specialists/registry';
import {
  assertSpecialistPolicyValid,
  parseSpecialistPolicyAssignment,
  verifySpecialistPolicy,
} from '../../../product-intelligence/specialists/policies';
import { computePolicyConfigId, verifyPolicySnapshot } from '../../../product-intelligence/policy';
import { ProductIntelligencePolicySchema } from '../../../product-intelligence/contracts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A typed payload schema for the fixture "identity_verifier" specialist. */
const identityReportSchema = z.object({
  /** Exact GTIN as validated by the specialist. */
  gtin: z.string().regex(/^\d{8,14}$/),
  matchStatus: z.enum(['exact', 'variant', 'unknown']),
  brand: z.string().nullable().default(null),
  /** Evidence references (never free-form prose). */
  evidenceIds: z.array(z.string().min(1)).default([]),
});

/** Typed input schema for the same specialist. */
const identityInputSchema = z.object({
  gtin: z.string().regex(/^\d{8,14}$/),
  registerName: z.string().min(1).max(512),
});

const identityVerifierCapability: SpecialistCapability = {
  name: 'identity_verifier',
  version: '1.0.0',
  kind: 'identity',
  summary: 'Verifies the exact-product identity of a GTIN against evidence sources.',
  input: { schemaName: 'identity_input', schemaVersion: '1.0.0' },
  output: { schemaName: 'identity_report', schemaVersion: '1.0.0' },
};

function buildArtifactSchemas(): SpecialistArtifactSchemaRegistry {
  const registry = new SpecialistArtifactSchemaRegistry();
  registry
    .register({ name: 'identity_report', version: '1.0.0', schema: identityReportSchema })
    .register({ name: 'identity_input', version: '1.0.0', schema: identityInputSchema });
  return registry;
}

function signedPolicy(): ReturnType<typeof computePolicyConfigId> {
  return computePolicyConfigId(ProductIntelligencePolicySchema.parse({ configId: 'pending' }));
}

/** A schema-valid succeeded result for identity_verifier. */
function validSucceededResult(payload: unknown = { gtin: '012345678905', matchStatus: 'exact' }): SpecialistResult {
  const artifact = finalizeSpecialistArtifact({
    artifactType: 'identity_report',
    payload,
    payloadSchema: identityReportSchema,
    lineage: { inputArtifactIds: ['input:gtin-012345678905'], runId: 'run-1' },
    provenance: {
      specialist: 'identity_verifier',
      specialistVersion: '1.0.0',
      policyConfigId: signedPolicy().configId,
      durationMs: 12,
    },
  });
  return { specialist: 'identity_verifier', outcome: 'succeeded', output: artifact, durationMs: 12 };
}

function evaluate(result: unknown, artifactSchemas = buildArtifactSchemas()): { valid: boolean; issues: string[] } {
  return validateSpecialistResult({
    result,
    capability: identityVerifierCapability,
    artifactSchemas,
  });
}

function contextFixture(seq = 0): SpecialistContext {
  return {
    runId: 'run-1',
    workspaceId: 'ws-1',
    workspacePath: '/tmp/ws-1',
    policy: signedPolicy(),
    seq,
  };
}

// ---------------------------------------------------------------------------
// Registry: metadata, configuration, lookup-only routing
// ---------------------------------------------------------------------------

describe('specialist capability registry', () => {
  const enabledKey: SpecialistConfigurationDescriptor = {
    key: 'enabled',
    label: 'Enabled',
    valueSchema: z.boolean(),
    default: true,
  };
  const maxResultsKey: SpecialistConfigurationDescriptor = {
    key: 'maxResults',
    label: 'Max results',
    valueSchema: z.number().int().positive(),
    default: 10,
  };

  it('registers and exposes specialist metadata', () => {
    const registry = new SpecialistRegistry().register(identityVerifierCapability);
    expect(registry.names()).toEqual(['identity_verifier']);
    expect(registry.get('identity_verifier')).toEqual(identityVerifierCapability);
    expect(registry.byKind('identity')).toHaveLength(1);
    expect(registry.byKind('extraction')).toHaveLength(0);
    expect(registry.resolveSpecialist('identity_verifier')?.output.schemaName).toBe('identity_report');
    expect(registry.resolveSpecialist('missing')).toBeUndefined();
  });

  it('rejects duplicate specialist names at registration', () => {
    const registry = new SpecialistRegistry().register(identityVerifierCapability);
    expect(() => registry.register(identityVerifierCapability)).toThrow(/Duplicate specialist registration/);
  });

  it('exposes validated per-specialist configuration', () => {
    const registry = new SpecialistRegistry().register(identityVerifierCapability, {
      configuration: [enabledKey, maxResultsKey],
      configurationValues: { maxResults: 3 },
    });
    expect(registry.hasConfiguration('identity_verifier')).toBe(true);
    expect(registry.getConfiguration('identity_verifier')).toEqual({ enabled: true, maxResults: 3 });
    registry.setConfiguration('identity_verifier', 'enabled', false);
    expect(registry.getConfiguration('identity_verifier')?.enabled).toBe(false);
    expect(() => registry.setConfiguration('identity_verifier', 'enabled', 'yes')).toThrow(/invalid configuration/);
    expect(() => registry.setConfiguration('identity_verifier', 'nope', true)).toThrow(/no configuration key/);
  });

  it('fails closed on invalid initial configuration at registration', () => {
    expect(() =>
      new SpecialistRegistry().register(identityVerifierCapability, {
        configuration: [maxResultsKey],
        configurationValues: { maxResults: -1 },
      }),
    ).toThrow(/invalid configuration/);
  });

  it('the registry is lookup-only: it never returns an executable handle', () => {
    const registry = new SpecialistRegistry().register(identityVerifierCapability);
    // The registry only exposes the metadata definition; there is no
    // `execute`/`dispatch` surface and no factory wiring here — routing is
    // exclusive to the orchestrator (ADR 0018).
    const resolved = registry.get('identity_verifier')!;
    expect(resolved).toMatchObject({ name: 'identity_verifier', kind: 'identity' });
    expect('execute' in resolved).toBe(false);
  });

  it('capability definitions are schema-validated', () => {
    expect(SpecialistCapabilitySchema.parse(identityVerifierCapability).name).toBe('identity_verifier');
    expect(
      SpecialistCapabilitySchema.safeParse({ ...identityVerifierCapability, version: 'not-semver' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Typed artifacts: schema versions, envelopes, hashing
// ---------------------------------------------------------------------------

describe('typed artifacts schema versions', () => {
  it('same-major versions are compatible; different majors are not', () => {
    expect(isSchemaVersionCompatible('1.2.0', '1.0.0')).toBe(true);
    expect(isSchemaVersionCompatible('1.0.0', '1.0.0')).toBe(true);
    expect(isSchemaVersionCompatible('2.0.0', '1.0.0')).toBe(false);
    expect(isSchemaVersionCompatible('1.0.0', '2.0.0')).toBe(false);
    expect(isSchemaVersionCompatible('garbage', '1.0.0')).toBe(false);
  });

  it('rejects envelopes with incompatible schema versions at parse time', () => {
    const artifact = finalizeSpecialistArtifact({
      artifactType: 'identity_report',
      payload: { gtin: '012345678905', matchStatus: 'exact' },
      provenance: { specialist: 'identity_verifier', specialistVersion: '1.0.0' },
    });
    const validated = validateSpecialistArtifactEnvelope({ ...artifact, schemaVersion: '2.0.0' });
    expect(validated.valid).toBe(false);
    if (!validated.valid) {
      expect(validated.issues.some((issue) => issue.includes('incompatible'))).toBe(true);
    }
  });

  it('rejects payloads whose schema is unregistered or version-incompatible', () => {
    const schemas = buildArtifactSchemas();
    expect(schemas.validatePayload('identity_report', '1.0.0', { gtin: '012345678905', matchStatus: 'exact' }).valid).toBe(true);
    expect(schemas.validatePayload('identity_report', '2.0.0', { gtin: '012345678905', matchStatus: 'exact' }).valid).toBe(false);
    expect(schemas.validatePayload('unknown_type', '1.0.0', {}).valid).toBe(false);
  });

  it('rejects payloads that violate the typed schema (prose is never a payload)', () => {
    const schemas = buildArtifactSchemas();
    const prose = schemas.validatePayload('identity_report', '1.0.0', 'this product is definitely the right one');
    expect(prose.valid).toBe(false);
    const malformed = schemas.validatePayload('identity_report', '1.0.0', { gtin: 'not-a-gtin', matchStatus: 'maybe' });
    expect(malformed.valid).toBe(false);
  });
});

describe('specialist artifact envelope integrity', () => {
  it('round-trips through canonical JSON preserving lineage and provenance', () => {
    const input = finalizeSpecialistArtifact({
      artifactType: 'identity_input',
      payload: { gtin: '012345678905', registerName: 'STELLA CHKN BROTH 16OZ' },
      payloadSchema: identityInputSchema,
      lineage: { runId: 'run-1', workflowRef: 'batch-9' },
      provenance: { specialist: 'identity_verifier', specialistVersion: '1.0.0', createdAt: '2026-08-10T00:00:00.000Z' },
    });
    const report = finalizeSpecialistArtifact({
      artifactType: 'identity_report',
      payload: { gtin: '012345678905', matchStatus: 'exact', brand: 'Stella & Chewy\'s' },
      payloadSchema: identityReportSchema,
      lineage: {
        inputArtifactIds: [input.artifactType],
        parentArtifactIds: [],
        runId: 'run-1',
        workflowRef: 'batch-9',
      },
      provenance: {
        specialist: 'identity_verifier',
        specialistVersion: '1.0.0',
        policyConfigId: signedPolicy().configId,
        invokedBy: 'orchestrator',
        durationMs: 12,
        createdAt: '2026-08-10T00:00:01.000Z',
      },
    });

    const text = serializeSpecialistArtifact(report);
    const restored = parseSpecialistArtifact(text);

    expect(restored.lineage.inputArtifactIds).toEqual(report.lineage.inputArtifactIds);
    expect(restored.lineage.runId).toBe('run-1');
    expect(restored.lineage.workflowRef).toBe('batch-9');
    expect(restored.provenance.specialist).toBe('identity_verifier');
    expect(restored.provenance.specialistVersion).toBe('1.0.0');
    expect(restored.provenance.invokedBy).toBe('orchestrator');
    expect(restored.provenance.policyConfigId).toBe(report.provenance.policyConfigId);
    expect(restored.provenance.createdAt).toBe('2026-08-10T00:00:01.000Z');
    expect(restored.provenance.durationMs).toBe(12);
    expect(restored.contentHash).toBe(report.contentHash);
    expect(restored.schemaVersion).toBe(SPECIALIST_ARTIFACT_SCHEMA_VERSION);

    // The lineage-suffixed input artifact reference is a durable id binding:
    // the same derived artifact re-validates after persistence.
    const revalidated = validateSpecialistArtifactEnvelope(restored);
    expect(revalidated.valid).toBe(true);
  });

  it('detects tampering with lineage after finalization', () => {
    const report = finalizeSpecialistArtifact({
      artifactType: 'identity_report',
      payload: { gtin: '012345678905', matchStatus: 'exact' },
      provenance: { specialist: 'identity_verifier', specialistVersion: '1.0.0' },
    });
    const tampered = { ...report, lineage: { ...report.lineage, inputArtifactIds: ['forged:evidence'] } };
    const validated = validateSpecialistArtifactEnvelope(tampered);
    expect(validated.valid).toBe(false);
    if (!validated.valid) {
      expect(validated.issues.some((issue) => issue.includes('contentHash mismatch'))).toBe(true);
    }
  });

  it('rejects non-JSON serialized artifacts at read time', () => {
    expect(() => parseSpecialistArtifact('not json at all')).toThrow(/not valid JSON/);
    expect(() => parseSpecialistArtifact('{"artifactType": 1}')).toThrow(/failed validation/);
  });
});

// ---------------------------------------------------------------------------
// Specialist results: handoff gate, failure, abstention
// ---------------------------------------------------------------------------

describe('specialist result validation', () => {
  it('accepts a succeeded result carrying a typed artifact', () => {
    const check = evaluate(validSucceededResult());
    expect(check).toEqual({ valid: true, issues: [] });
  });

  it('accepts an array of typed artifacts', () => {
    const first = finalizeSpecialistArtifact({
      artifactType: 'identity_report',
      payload: { gtin: '012345678905', matchStatus: 'exact' },
      provenance: { specialist: 'identity_verifier', specialistVersion: '1.0.0' },
    });
    const result = {
      specialist: 'identity_verifier',
      outcome: 'succeeded',
      output: [first],
      durationMs: 5,
    };
    expect(evaluate(result).valid).toBe(true);
  });

  it('rejects prose output — prose is never the durable handoff contract', () => {
    // Free-form text smuggled through the output slot fails the envelope schema.
    const mesh: unknown = { ...validSucceededResult(), output: { artifactType: 'identity_report', payload: 'I think this is the right product', lineage: {}, provenance: {} } };
    const check = evaluate(mesh);
    expect(check.valid).toBe(false);
    expect(check.issues.length).toBeGreaterThan(0);
  });

  it('rejects a succeeded result without an artifact output', () => {
    const check = evaluate({ ...validSucceededResult(), output: undefined });
    expect(check.valid).toBe(false);
    expect(check.issues.some((issue) => issue.includes('at least one typed artifact'))).toBe(true);
  });

  it('rejects an output artifact whose type does not match the capability contract', () => {
    const wrong = finalizeSpecialistArtifact({
      artifactType: 'identity_input', // wrong type — the contract says identity_report
      payload: { gtin: '012345678905', registerName: 'x' },
      provenance: { specialist: 'identity_verifier', specialistVersion: '1.0.0' },
    });
    const check = evaluate({ specialist: 'identity_verifier', outcome: 'succeeded', output: wrong });
    expect(check.valid).toBe(false);
    expect(check.issues.some((issue) => issue.includes('does not match the capability output contract'))).toBe(true);
  });

  it('rejects an output payload that violates the registered artifact schema', () => {
    const bad = finalizeSpecialistArtifact({
      artifactType: 'identity_report',
      payload: { gtin: 'nope', matchStatus: 'exact' },
      provenance: { specialist: 'identity_verifier', specialistVersion: '1.0.0' },
    });
    const check = evaluate({ specialist: 'identity_verifier', outcome: 'succeeded', output: bad });
    expect(check.valid).toBe(false);
    expect(check.issues.some((issue) => issue.includes("failed 'identity_report' schema"))).toBe(true);
  });

  it('rejects an output produced under an incompatible capability schema version', () => {
    const artifact = finalizeSpecialistArtifact({
      artifactType: 'identity_report',
      payload: { gtin: '012345678905', matchStatus: 'exact' },
      provenance: { specialist: 'identity_verifier', specialistVersion: '1.0.0' },
    });
    // Capability declares output schema version 2.0.0; the registry only
    // registers 1.0.0 — a same-name but major-incompatible contract fails
    // closed (the payload is never validated against the "closest" schema).
    const v2Capability: SpecialistCapability = {
      ...identityVerifierCapability,
      output: { schemaName: 'identity_report', schemaVersion: '2.0.0' },
    };
    const v2Check = validateSpecialistResult({
      result: { specialist: 'identity_verifier', outcome: 'succeeded', output: artifact },
      capability: v2Capability,
      artifactSchemas: buildArtifactSchemas(),
    });
    expect(v2Check.valid).toBe(false);
    expect(v2Check.issues.some((issue) => issue.includes('not registered or major-incompatible'))).toBe(true);
  });

  it('accepts a failure result with failure details and no output', () => {
    const result = {
      specialist: 'identity_verifier',
      outcome: 'failed',
      failure: { code: 'model_unavailable', message: 'no model route configured for this specialist' },
      durationMs: 7,
    };
    expect(evaluate(result)).toEqual({ valid: true, issues: [] });
  });

  it('rejects a failure result without failure details', () => {
    const check = evaluate({ specialist: 'identity_verifier', outcome: 'failed' });
    expect(check.valid).toBe(false);
    expect(check.issues.some((issue) => issue.includes('requires failure details'))).toBe(true);
  });

  it('rejects a failure result that smuggles an artifact output', () => {
    const artifact = finalizeSpecialistArtifact({
      artifactType: 'identity_report',
      payload: { gtin: '012345678905', matchStatus: 'exact' },
      provenance: { specialist: 'identity_verifier', specialistVersion: '1.0.0' },
    });
    const check = evaluate({
      specialist: 'identity_verifier',
      outcome: 'failed',
      failure: { code: 'capability_error', message: 'boom' },
      output: artifact,
    });
    expect(check.valid).toBe(false);
    expect(check.issues.some((issue) => issue.includes('no handoff on failure'))).toBe(true);
  });

  it('accepts an abstention (stage-style) with a reason and no output', () => {
    const result = {
      specialist: 'identity_verifier',
      outcome: 'abstained',
      abstention: { reason: 'no official source found for this GTIN', actionableNextStep: 'review the paper pack label', targets: ['identity'] },
      durationMs: 4,
    };
    expect(evaluate(result)).toEqual({ valid: true, issues: [] });
  });

  it('rejects an abstention without a reason', () => {
    const check = evaluate({ specialist: 'identity_verifier', outcome: 'abstained' });
    expect(check.valid).toBe(false);
    expect(check.issues.some((issue) => issue.includes('requires an abstention reason'))).toBe(true);
  });

  it('rejects results attributed to a different specialist', () => {
    const orphan: SpecialistResult = { ...validSucceededResult(), specialist: 'some_other_specialist' };
    const check = evaluate(orphan);
    expect(check.valid).toBe(false);
    expect(check.issues.some((issue) => issue.includes('does not match capability'))).toBe(true);
  });

  it('the result schema itself rejects non-artifact output shapes', () => {
    expect(
      SpecialistResultSchema.safeParse({ specialist: 'identity_verifier', outcome: 'succeeded', output: 'free prose' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lineage persistence: results carry lineage across a serialization boundary
// ---------------------------------------------------------------------------

describe('lineage persistence', () => {
  it('retains input/output lineage when a result is serialized and restored', () => {
    const report = validSucceededResult();
    const text = JSON.stringify(report);
    const restored = JSON.parse(text) as SpecialistResult;

    expect(restored.outcome).toBe('succeeded');
    expect(Array.isArray(restored.output)).toBe(false);
    const envelope = restored.output as unknown as {
      lineage: { inputArtifactIds: string[]; runId: string | null };
      provenance: { invokedBy: string; specialist: string };
      contentHash: string;
    };
    expect(envelope.lineage.inputArtifactIds).toContain('input:gtin-012345678905');
    expect(envelope.lineage.runId).toBe('run-1');
    expect(envelope.provenance.invokedBy).toBe('orchestrator');
    expect(envelope.provenance.specialist).toBe('identity_verifier');
    expect(envelope.contentHash).toMatch(/^[a-f0-9]{64}$/);

    // Re-validating the restored result against the capability succeeds —
    // lineage and provenance survived without loss.
    const check = evaluate(restored);
    expect(check).toEqual({ valid: true, issues: [] });
  });

  it('a specialist context can reference inputs by artifact id without re-derivation', () => {
    const ctx = contextFixture(0);
    const artifact = finalizeSpecialistArtifact({
      artifactType: 'identity_report',
      payload: { gtin: '012345678905', matchStatus: 'exact' },
      lineage: { runId: ctx.runId, inputArtifactIds: [`input:${ctx.seq}`] },
      provenance: {
        specialist: 'identity_verifier',
        specialistVersion: '1.0.0',
        policyConfigId: ctx.policy.configId,
        invokedBy: 'orchestrator',
      },
    });
    expect(artifact.lineage.runId).toBe('run-1');
    expect(artifact.lineage.inputArtifactIds).toEqual(['input:0']);
    expect(artifact.provenance.policyConfigId).toBe(ctx.policy.configId);
  });
});

// ---------------------------------------------------------------------------
// Per-specialist policies reuse Product Intelligence governance (PI-5)
// ---------------------------------------------------------------------------

describe('per-specialist policy reuse', () => {
  it('parses assignments built from the existing ProductIntelligencePolicySchema', () => {
    const policy = signedPolicy();
    const assignment = parseSpecialistPolicyAssignment({ specialist: 'identity_verifier', policy });
    expect(assignment.specialist).toBe('identity_verifier');
    expect(assignment.policy.configId).toMatch(/^[a-f0-9]{64}$/);
    // The assignment policy is governed by the same snapshot verification as PI runs.
    expect(verifyPolicySnapshot(assignment.policy).valid).toBe(true);
    expect(verifySpecialistPolicy(assignment.policy).valid).toBe(true);
    expect(() => assertSpecialistPolicyValid(assignment.policy)).not.toThrow();
  });

  it('rejects malformed policy assignments at parse time', () => {
    // A shape violating the existing ProductIntelligencePolicySchema values.
    expect(() => parseSpecialistPolicyAssignment({ specialist: 'identity_verifier', policy: { configId: 'broken', maxToolCalls: -1 } })).toThrow();
    // Missing the specialist binding entirely.
    expect(() => parseSpecialistPolicyAssignment({ policy: signedPolicy() })).toThrow();
  });

  it('rejects tampered snapshots through the specialist policy gate', () => {
    const policy = signedPolicy();
    const tampered = { ...policy, maxToolCalls: policy.maxToolCalls + 1 };
    expect(verifySpecialistPolicy(tampered).valid).toBe(false);
    expect(() => assertSpecialistPolicyValid(tampered)).toThrow(/not self-consistent/);
  });
});
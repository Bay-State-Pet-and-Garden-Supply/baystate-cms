/**
 * PR5 C2 — the two Curation applicability stages consume the effective
 * curation type (issue #30).
 *
 * Direct stage `execute` with a synthetic StageContext: a frozen runtime
 * snapshot (built via `buildRuntimeSnapshot` over a small v1 config) plus
 * `cohortExecutionType` variants. Covers: execution-driven applicability +
 * metadata source, not-in-profile attributes, reviewed override precedence,
 * legacy/flag-OFF byte-identical behavior, universal attributes, conditions
 * staying reviewed-facts-only (DECISION-I), and the fail-closed guard.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { buildRuntimeSnapshot } from '../../classification/runtime-snapshot';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import { attributeApplicabilityStage } from '../../classification/stages/attribute-applicability';
import { productAttributeProposalsStage } from '../../classification/stages/attribute-proposals';
import type { StageContext, StageInput } from '../../classification/types';
import type { ClassificationConfig, ProductAttributeConfig } from '../../shared/schemas/classification';
import type { ReviewedFact } from '../../classification/reviewed-facts';

let dbDir: string;

beforeAll(() => {
  dbDir = path.join(os.tmpdir(), `baystate-cms-effective-stages-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(dbDir, { recursive: true });
  initDb(path.join(dbDir, 'app.db'));
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* ok */ }
});

const NOW = '2026-08-01T12:00:00.000Z';

function makeAttribute(id: string, name: string, allowedValues: string[]): ProductAttributeConfig {
  return {
    id,
    name,
    description: null,
    valueMode: 'controlled',
    canonicalUnit: null,
    allowedValues,
    valueAliases: id === 'flavor' ? [{ alias: 'chicken', mapsTo: 'Chicken' }] : [],
    visualEvidenceEligibility: 'eligible',
    isClaim: false,
    isCompositionAttribute: false,
    group: 'Food',
  };
}

function makeTarget(id: string, label: string, attributeId: string, catalogField: string): ClassificationConfig['curationTargets'][number] {
  return {
    id,
    kind: 'product_field',
    label,
    enabled: true,
    selectionMode: 'single',
    attributeId,
    catalogField,
    optionSource: 'configured',
    required: false,
    mandatory: false,
    sortOrder: 0,
  };
}

const manifest = {
  manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: NOW, updatedAt: NOW, fileVersions: {} },
  brands: [],
  guidance: [],
  modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only' as const, textDataSharing: 'local_only' as const },
  dataSharing: { imagePolicy: 'local_only' as const, textPolicy: 'local_only' as const, sensitiveDataFiltering: true as const, retentionDays: 90 },
};

const sharedProductTypes: ClassificationConfig['productTypes'] = [
  { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, attributeProfileId: 'dry-dog-food-profile', oldIdAliases: [] },
  { id: 'dog-treats', name: 'Dog Treats', description: null, attributeProfileId: 'dog-treats-profile', oldIdAliases: [] },
  // PR5 P1-1: a Product Type is legitimately allowed attributeProfileId: null
  // (no Attribute Profile configured) — on the effective path this must fail
  // closed to an EMPTY profile, never unlock every field.
  { id: 'plain-dog-food', name: 'Plain Dog Food', description: null, attributeProfileId: null, oldIdAliases: [] },
  // PR5 P1-1: a Product Type whose declared profile is MISSING from the
  // frozen snapshot — the effective path must throw, never fall back.
  { id: 'broken-type', name: 'Broken Type', description: null, attributeProfileId: 'ghost-profile', oldIdAliases: [] },
];

const sharedAttributes: ProductAttributeConfig[] = [
  makeAttribute('flavor', 'Flavor', ['Chicken', 'Beef']),
  makeAttribute('color', 'Color', ['Red', 'Blue']),
  makeAttribute('life-stage', 'Life Stage', ['Adult', 'Puppy']),
];

const sharedProfiles: ClassificationConfig['attributeProfiles'] = [
  {
    id: 'dry-dog-food-profile',
    productTypeId: 'dry-dog-food',
    name: 'Dry Dog Food Profile',
    attributes: [
      { attributeId: 'flavor', required: true, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] },
      // DECISION-I: conditions stay reviewed-facts-only. The discriminator
      // (`species`) is never a reviewed fact in these tests, so this entry
      // must evaluate `unknown` — even under an Execution Product Type.
      { attributeId: 'life-stage', required: false, cardinality: 'single', applicabilityConditions: [{ operator: 'equals', attributeId: 'species', value: 'Dog' }], constraints: {}, confidenceThresholds: {}, valueAliases: [] },
    ],
  },
  {
    id: 'dog-treats-profile',
    productTypeId: 'dog-treats',
    name: 'Dog Treats Profile',
    attributes: [
      { attributeId: 'color', required: true, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] },
    ],
  },
];

const sharedMappings: ClassificationConfig['attributeMappings'] = [
  { id: 'flavor-mapping', attributeId: 'flavor', catalogField: 'ProductField1', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
  { id: 'color-mapping', attributeId: 'color', catalogField: 'ProductField2', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
  { id: 'life-stage-mapping', attributeId: 'life-stage', catalogField: 'ProductField4', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
];

const typeTarget: ClassificationConfig['curationTargets'][number] = {
  id: 'target-type',
  kind: 'product_type',
  label: 'Product Type',
  enabled: true,
  selectionMode: 'single',
  attributeId: null,
  catalogField: null,
  optionSource: 'configured',
  required: false,
  mandatory: false,
  sortOrder: 0,
};

/** No universal attribute — used for the legacy/flag-OFF byte-identical leg. */
const BASE_CONFIG: ClassificationConfig = {
  ...manifest,
  productTypes: sharedProductTypes,
  attributes: sharedAttributes,
  attributeProfiles: sharedProfiles,
  attributeMappings: sharedMappings,
  curationTargets: [
    typeTarget,
    makeTarget('target-flavor', 'Flavor', 'flavor', 'ProductField1'),
    makeTarget('target-color', 'Color', 'color', 'ProductField2'),
    makeTarget('target-life-stage', 'Life Stage', 'life-stage', 'ProductField4'),
  ],
};

/** BASE_CONFIG plus a universal attribute (v2-style `isUniversal` flag). */
const UNIVERSAL_CONFIG: ClassificationConfig = {
  ...manifest,
  productTypes: sharedProductTypes,
  attributes: [
    ...sharedAttributes,
    { ...makeAttribute('scent', 'Scent', ['Chicken', 'Beef']), isUniversal: true } as ProductAttributeConfig & { isUniversal: boolean },
  ],
  attributeProfiles: sharedProfiles,
  attributeMappings: [
    ...sharedMappings,
    { id: 'scent-mapping', attributeId: 'scent', catalogField: 'ProductField3', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
  ],
  curationTargets: [
    typeTarget,
    makeTarget('target-flavor', 'Flavor', 'flavor', 'ProductField1'),
    makeTarget('target-color', 'Color', 'color', 'ProductField2'),
    makeTarget('target-scent', 'Scent', 'scent', 'ProductField3'),
    makeTarget('target-life-stage', 'Life Stage', 'life-stage', 'ProductField4'),
  ],
};

function buildSnapshot(config: ClassificationConfig): RuntimeClassificationSnapshot {
  return buildRuntimeSnapshot({
    workspaceId: 'ws',
    workspacePath: path.join(dbDir, 'ws'),
    productSku: 'SKU-1',
    config,
    configSnapshotRef: { id: 'snap', hash: 'hash', sourceCommit: null, createdAt: NOW },
    sourceProductHash: null,
  });
}

function makeContext(snapshot: RuntimeClassificationSnapshot, cohortExecutionType?: StageContext['cohortExecutionType']): StageContext {
  return {
    workspacePath: path.join(dbDir, 'ws'),
    workspaceId: 'ws',
    configSnapshotRef: snapshot.configSnapshotRef,
    runId: 'run-1',
    snapshot,
    ...(cohortExecutionType !== undefined ? { cohortExecutionType } : {}),
  };
}

const STAGE_INPUT: StageInput = {
  sku: 'SKU-1',
  onboardingItemId: 'item-1',
  evidence: [
    {
      id: 'ev-1',
      runId: 'run-1',
      stageName: 'evidence_extraction',
      productSku: 'SKU-1',
      attributeId: null,
      source: 'spreadsheet',
      reliability: 'medium',
      sourceUrl: null,
      sourceField: 'name',
      snippet: 'Purina Dry Dog Food Chicken Recipe',
      value: 'Purina Dry Dog Food Chicken Recipe',
      metadata: {},
      capturedAt: NOW,
    },
  ],
  acceptedProposals: [],
  allProposals: [],
};

function makeTypeFact(productTypeId: string): ReviewedFact {
  return {
    proposalId: 'p-type',
    decisionId: 'd-type',
    runId: 'run-prior',
    workspaceId: 'ws',
    productSku: 'SKU-1',
    proposalType: 'primary_product_type',
    targetId: productTypeId,
    value: { productTypeId },
    configSnapshotHash: 'cfg',
    sourceHash: 'src',
    createdAt: NOW,
  };
}

/** Spread-copy the frozen snapshot with seeded reviewed facts (direct execute only — no hash re-verification). */
function withReviewedFacts(snapshot: RuntimeClassificationSnapshot, facts: ReviewedFact[]): RuntimeClassificationSnapshot {
  return { ...snapshot, reviewedFacts: facts } as RuntimeClassificationSnapshot;
}

const EXECUTION_TYPE = { id: 'dry-dog-food', confidence: 0.9, outcome: 'coherent' as const };

const NULL_PROFILE_EXECUTION_TYPE = { id: 'plain-dog-food', confidence: 0.9, outcome: 'coherent' as const };

const MISSING_PROFILE_EXECUTION_TYPE = { id: 'broken-type', confidence: 0.9, outcome: 'coherent' as const };

function applicabilityFor(result: Awaited<ReturnType<typeof attributeApplicabilityStage.execute>>, attributeId: string) {
  if (result.status !== 'succeeded') throw new Error(`stage not succeeded: ${result.status}`);
  const metadata = result.output.metadata as Record<string, unknown>;
  const applicability = metadata.applicability as Array<{ attributeId: string; state: string; reason?: string }>;
  return applicability.find(e => e.attributeId === attributeId)!;
}

describe('PR5 effective type — attribute applicability stage', () => {
  it('execution type unlocks profile attributes (source=execution) and excludes not-in-profile attributes', async () => {
    const snapshot = buildSnapshot(UNIVERSAL_CONFIG);
    const result = await attributeApplicabilityStage.execute(STAGE_INPUT, makeContext(snapshot, EXECUTION_TYPE));
    expect(result.status).toBe('succeeded');
    const metadata = (result as { status: 'succeeded'; output: { metadata: Record<string, unknown> } }).output.metadata;

    expect(applicabilityFor(result, 'flavor').state).toBe('applicable');
    expect(applicabilityFor(result, 'color').state).toBe('not_applicable');
    expect(metadata.effectiveTypeId).toBe('dry-dog-food');
    expect(metadata.effectiveTypeSource).toBe('execution');
    expect((result as { status: 'succeeded'; output: { message: string } }).output.message).toContain(
      '(driven by cohort execution Product Type.)',
    );
  });

  it('universal attribute stays applicable with no type and no execution type', async () => {
    const snapshot = buildSnapshot(UNIVERSAL_CONFIG);
    const result = await attributeApplicabilityStage.execute(STAGE_INPUT, makeContext(snapshot));
    expect(applicabilityFor(result, 'scent').state).toBe('applicable');
    const metadata = (result as { status: 'succeeded'; output: { metadata: Record<string, unknown> } }).output.metadata;
    expect(metadata.effectiveTypeSource).toBe('none');
  });

  it('reviewed override beats the execution type and its own profile wins (source=reviewed)', async () => {
    const snapshot = withReviewedFacts(buildSnapshot(UNIVERSAL_CONFIG), [makeTypeFact('dog-treats')]);
    const result = await attributeApplicabilityStage.execute(STAGE_INPUT, makeContext(snapshot, EXECUTION_TYPE));
    expect(result.status).toBe('succeeded');
    const metadata = (result as { status: 'succeeded'; output: { metadata: Record<string, unknown> } }).output.metadata;

    // Execution type = dry-dog-food (flavor profile); reviewed override =
    // dog-treats (color profile). Reviewed profile must win.
    expect(metadata.effectiveTypeId).toBe('dog-treats');
    expect(metadata.effectiveTypeSource).toBe('reviewed');
    expect(applicabilityFor(result, 'flavor').state).toBe('not_applicable');
    expect(applicabilityFor(result, 'color').state).toBe('applicable');
  });

  it('PR5 hardening P1-2: same-ID reviewed override — reviewed dry-dog-food agrees with the execution type, source stays reviewed', async () => {
    const snapshot = withReviewedFacts(buildSnapshot(UNIVERSAL_CONFIG), [makeTypeFact('dry-dog-food')]);
    const result = await attributeApplicabilityStage.execute(STAGE_INPUT, makeContext(snapshot, EXECUTION_TYPE));
    expect(result.status).toBe('succeeded');
    const metadata = (result as { status: 'succeeded'; output: { metadata: Record<string, unknown> } }).output.metadata;

    // Same-ID override (reviewed dry-dog-food == execution dry-dog-food): the
    // reviewed fact still wins the source attribution (reviewed-first,
    // DECISION-H), and the profile is the reviewed type's own.
    expect(metadata.effectiveTypeId).toBe('dry-dog-food');
    expect(metadata.effectiveTypeSource).toBe('reviewed');
    expect(applicabilityFor(result, 'flavor').state).toBe('applicable');
    expect(applicabilityFor(result, 'color').state).toBe('not_applicable');
  });

  it('condition-carrying profile entry stays unknown with an unreviewed discriminator (DECISION-I)', async () => {
    const snapshot = buildSnapshot(UNIVERSAL_CONFIG);
    const result = await attributeApplicabilityStage.execute(STAGE_INPUT, makeContext(snapshot, EXECUTION_TYPE));
    const lifeStage = applicabilityFor(result, 'life-stage');
    expect(lifeStage.state).toBe('unknown');
    expect(lifeStage.reason ?? '').toContain('condition');
  });

  it('effective type with attributeProfileId null fails closed to an EMPTY profile (never all fields)', async () => {
    const snapshot = buildSnapshot(UNIVERSAL_CONFIG);
    const result = await attributeApplicabilityStage.execute(STAGE_INPUT, makeContext(snapshot, NULL_PROFILE_EXECUTION_TYPE));
    expect(result.status).toBe('succeeded');
    const metadata = (result as { status: 'succeeded'; output: { metadata: Record<string, unknown> } }).output.metadata;

    // Non-universal type-gated attributes are ALL not_applicable — a null
    // attributeProfileId never unlocks every enabled field.
    expect(applicabilityFor(result, 'flavor').state).toBe('not_applicable');
    expect(applicabilityFor(result, 'color').state).toBe('not_applicable');
    expect(applicabilityFor(result, 'life-stage').state).toBe('not_applicable');
    // Universal attributes still proceed without a profile.
    expect(applicabilityFor(result, 'scent').state).toBe('applicable');
    expect(metadata.effectiveTypeId).toBe('plain-dog-food');
    expect(metadata.effectiveTypeSource).toBe('execution');
  });

  it('throws when the effective type declares a profile missing from the frozen snapshot (fail closed)', async () => {
    const snapshot = buildSnapshot(UNIVERSAL_CONFIG);
    await expect(
      attributeApplicabilityStage.execute(STAGE_INPUT, makeContext(snapshot, MISSING_PROFILE_EXECUTION_TYPE)),
    ).rejects.toThrow(/declares Attribute Profile "ghost-profile".*missing from the frozen runtime snapshot/);
  });

  it('legacy/flag-OFF keeps byte-identical old behavior for a reviewed type with attributeProfileId null', async () => {
    const snapshot = withReviewedFacts(buildSnapshot(BASE_CONFIG), [makeTypeFact('plain-dog-food')]);
    const result = await attributeApplicabilityStage.execute(STAGE_INPUT, makeContext(snapshot));
    expect(result.status).toBe('succeeded');
    const metadata = (result as { status: 'succeeded'; output: { metadata: Record<string, unknown> } }).output.metadata;

    expect(metadata.effectiveTypeId).toBe('plain-dog-food');
    expect(metadata.effectiveTypeSource).toBe('reviewed');
    // Legacy semantics are preserved exactly: no cohortExecutionType means the
    // pre-existing profile lookup (by profile.productTypeId, null when absent)
    // and its "no profile constraint" fall-through stay as-is.
    expect(applicabilityFor(result, 'flavor').state).toBe('applicable');
    expect(applicabilityFor(result, 'color').state).toBe('applicable');
    expect(applicabilityFor(result, 'life-stage').state).toBe('applicable');
  });

  it('legacy/flag-OFF (no cohortExecutionType) keeps byte-identical unknown gating', async () => {
    const snapshot = buildSnapshot(BASE_CONFIG);
    const result = await attributeApplicabilityStage.execute(STAGE_INPUT, makeContext(snapshot));
    expect(result.status).toBe('succeeded');
    const output = (result as { status: 'succeeded'; output: { message: string; metadata: Record<string, unknown> } }).output;

    expect(applicabilityFor(result, 'flavor').state).toBe('unknown');
    expect(applicabilityFor(result, 'color').state).toBe('unknown');
    expect(applicabilityFor(result, 'life-stage').state).toBe('unknown');
    // Byte-identical: exact legacy message, no execution suffix, source none.
    expect(output.message).toBe(
      '0 attributes applicable, 3 blocked (no reviewed Product Type or undecided condition), 0 not applicable for (no reviewed type).',
    );
    expect(output.metadata.effectiveTypeId).toBeNull();
    expect(output.metadata.effectiveTypeSource).toBe('none');
  });

  it('throws when a cohort execution type is present but the frozen snapshot is missing', async () => {
    const context = {
      workspacePath: path.join(dbDir, 'ws'),
      workspaceId: 'ws',
      configSnapshotRef: { id: 'snap', hash: 'hash', sourceCommit: null, createdAt: NOW },
      runId: 'run-1',
      cohortExecutionType: EXECUTION_TYPE,
    } as StageContext;
    await expect(attributeApplicabilityStage.execute(STAGE_INPUT, context)).rejects.toThrow(
      'effective-type path requires the frozen runtime snapshot; live config is never read with an execution type',
    );
  });
});

describe('PR5 effective type — product attribute proposals stage', () => {
  it('emits the profile attribute proposal under the execution type and withholds not-in-profile attributes', async () => {
    const snapshot = buildSnapshot(UNIVERSAL_CONFIG);
    const result = await productAttributeProposalsStage.execute(STAGE_INPUT, makeContext(snapshot, EXECUTION_TYPE));
    expect(result.status).toBe('succeeded');
    const proposals = (result as { status: 'succeeded'; output: { proposals: Array<{ proposalType: string; targetId: string; status: string; proposedValue: unknown }> } }).output.proposals;

    const flavor = proposals.find(p => p.proposalType === 'field_assignment' && p.targetId === 'flavor');
    expect(flavor).toBeDefined();
    expect(flavor!.status).toBe('pending');
    expect(flavor!.proposedValue).toBe('Chicken');
    // Not in the execution profile and not universal → withheld entirely.
    expect(proposals.some(p => p.targetId === 'color')).toBe(false);
  });

  it('legacy/flag-OFF produces zero proposals with the byte-identical blocked message', async () => {
    const snapshot = buildSnapshot(BASE_CONFIG);
    const result = await productAttributeProposalsStage.execute(STAGE_INPUT, makeContext(snapshot));
    expect(result.status).toBe('succeeded');
    const output = (result as { status: 'succeeded'; output: { proposals: unknown[]; message: string; metadata: Record<string, unknown> } }).output;

    expect(output.proposals.length).toBe(0);
    expect(output.message).toBe(
      'No reviewed Primary Product Type; type-gated attribute proposals are withheld until the type is accepted.',
    );
    expect(output.metadata.effectiveTypeId).toBeNull();
    expect(output.metadata.effectiveTypeSource).toBe('none');
  });

  it('empty-profile effective type emits ZERO non-universal proposals; universal attributes stay eligible', async () => {
    const snapshot = buildSnapshot(UNIVERSAL_CONFIG);
    const result = await productAttributeProposalsStage.execute(STAGE_INPUT, makeContext(snapshot, NULL_PROFILE_EXECUTION_TYPE));
    expect(result.status === 'succeeded' || result.status === 'abstained').toBe(true);
    const proposals = (result as { status: 'succeeded'; output: { proposals: Array<{ targetId: string }> } }).output?.proposals ?? [];

    // Never 'all fields': no non-universal type-gated target may propose.
    const nonUniversalTargets = ['flavor', 'color', 'life-stage'];
    expect(proposals.filter(p => nonUniversalTargets.includes(p.targetId)).length).toBe(0);
    // Universal attributes remain eligible: any proposal may only be scent.
    expect(proposals.every(p => p.targetId === 'scent')).toBe(true);
  });

  it('throws when the effective type declares a profile missing from the frozen snapshot (fail closed)', async () => {
    const snapshot = buildSnapshot(UNIVERSAL_CONFIG);
    await expect(
      productAttributeProposalsStage.execute(STAGE_INPUT, makeContext(snapshot, MISSING_PROFILE_EXECUTION_TYPE)),
    ).rejects.toThrow(/declares Attribute Profile "ghost-profile".*missing from the frozen runtime snapshot/);
  });

  it('throws when a cohort execution type is present but the frozen snapshot is missing', async () => {
    const context = {
      workspacePath: path.join(dbDir, 'ws'),
      workspaceId: 'ws',
      configSnapshotRef: { id: 'snap', hash: 'hash', sourceCommit: null, createdAt: NOW },
      runId: 'run-1',
      cohortExecutionType: EXECUTION_TYPE,
    } as StageContext;
    await expect(productAttributeProposalsStage.execute(STAGE_INPUT, context)).rejects.toThrow(
      'effective-type path requires the frozen runtime snapshot; live config is never read with an execution type',
    );
  });
});

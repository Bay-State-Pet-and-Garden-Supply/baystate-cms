import { describe, expect, it, vi } from 'vitest';
import {
  ProfileEngineerSpecialist,
  evaluateExistingProfile,
  PROFILE_ENGINEER_OUTPUT_ARTIFACT_TYPE,
  registerProfileEngineerSchemas,
} from '../../../product-intelligence/specialists/profile-engineer';
import { SpecialistArtifactSchemaRegistry } from '../../../product-intelligence/specialists/artifacts';
import type { SpecialistContext } from '../../../product-intelligence/specialists/contracts';
import type { PageExtractionContract } from '../../../product-intelligence/tools/contract';

const policy = {
  configId: 'policy-profile-engineer-test', allowedTools: [], researchTools: [], allowedSourceDomains: [],
  maxResponseBytes: 5_000_000, networkPolicy: 'local_only' as const, dataSharingPolicy: 'local_only' as const,
  modelRoute: null, maxToolCalls: 20, deadlineMs: 10_000,
};
const context: SpecialistContext = { runId: 'run-profile-engineer', workspaceId: 'ws-profile-engineer', workspacePath: '/tmp/ws-profile-engineer', policy, seq: 1 };

function sample(url: string, overrides: Record<string, unknown> = {}): any {
  return {
    url,
    artifactRefs: [`artifact:${url}`],
    expectedName: 'ACME Chicken Broth 16 oz',
    observedFields: { titleSelector: 'ACME Chicken Broth 16 oz', product_name: 'ACME Chicken Broth 16 oz' },
    ...overrides,
  };
}

function specialist(deps: ConstructorParameters<typeof ProfileEngineerSpecialist>[0] = {}) {
  return new ProfileEngineerSpecialist(deps, { codeCommit: 'test-profile-engineer' });
}

describe('Profile Engineer specialist (#51)', () => {
  it('probes existing profiles through the PageExtractionContract before routing', async () => {
    const extraction: PageExtractionContract = {
      name: 'fixture-ladder',
      version: '1.0.0',
      extract: async ({ url }: { url: string }) => ({
        requestedUrl: url, finalUrl: url, fetchModes: ['profile_selector'], contentHash: 'a'.repeat(64), artifactRef: `artifact:${url}`,
        fields: [{ field: 'product_name', value: 'ACME Chicken Broth 16 oz', method: 'profile_selector', sourcePath: 'profile:title' }],
        gtins: [], sku: null, brand: 'ACME', productName: 'ACME Chicken Broth 16 oz', variant: null, size: '16 oz', packCount: null,
        images: [], conflicts: [], identityStatus: 'exact_match', identityReasons: [], deterministicOnly: true,
      }),
      extractWithProfile: async ({ url }: { url: string }) => ({
        requestedUrl: url, finalUrl: url, fetchModes: ['profile_selector'], contentHash: 'a'.repeat(64), artifactRef: `artifact:${url}`,
        fields: [{ field: 'product_name', value: 'ACME Chicken Broth 16 oz', method: 'profile_selector', sourcePath: 'profile:title' }],
        gtins: [], sku: null, brand: 'ACME', productName: 'ACME Chicken Broth 16 oz', variant: null, size: '16 oz', packCount: null,
        images: [], conflicts: [], identityStatus: 'exact_match', identityReasons: [], deterministicOnly: true,
      }),
    };
    const health = await evaluateExistingProfile(
      { version: 1, selectors: { titleSelector: 'h1' }, runtime: 'rendered' },
      [sample('https://acme.example/p1'), sample('https://acme.example/p2')],
      extraction,
      new AbortController().signal,
      1000,
    );
    expect(health.healthy).toBe(true);
  });

  it('fails closed when the profile health check has fewer than two samples', async () => {
    const extraction: PageExtractionContract = {
      name: 'fixture-profile-runner',
      version: '1.0.0',
      extract: vi.fn(),
      extractWithProfile: vi.fn(async ({ url }) => ({
        requestedUrl: url, finalUrl: url, fetchModes: ['profile_selector'], contentHash: null, artifactRef: null,
        fields: [{ field: 'product_name', value: 'ACME Chicken Broth 16 oz', method: 'profile_selector' }],
        gtins: [], sku: null, brand: null, productName: 'ACME Chicken Broth 16 oz', variant: null, size: null, packCount: null,
        images: [], conflicts: [], identityStatus: 'exact_match' as const, identityReasons: [], deterministicOnly: true,
      })),
    };
    const health = await evaluateExistingProfile(
      { version: 1, selectors: { titleSelector: 'h1' }, runtime: 'static' },
      [sample('https://acme.example/only')], extraction,
      new AbortController().signal, 1000,
    );
    expect(health).toMatchObject({ healthy: false, reason: 'insufficient_representative_samples', failure: { code: 'insufficient_representative_samples' } });
    expect(extraction.extractWithProfile).not.toHaveBeenCalled();
  });

  it('reuses a healthy active profile without claiming a workflow', async () => {
    const claim = vi.fn();
    const result = await specialist({
      checkProfile: () => ({ healthy: true }),
      workflow: { claim },
    }).engineer({ domain: 'www.acme.example', activeProfile: { version: 3, selectors: { titleSelector: 'h1' }, runtime: 'rendered' }, samples: [sample('https://acme.example/p1'), sample('https://acme.example/p2')] }, context);
    expect('outcome' in result && result.outcome).toBe('abstained');
    expect('abstention' in result && result.abstention?.reason).toBe('healthy_profile_reused');
    expect(claim).not.toHaveBeenCalled();
  });

  it('does not treat fallback extraction as an active-profile success', async () => {
    const extraction: PageExtractionContract = {
      name: 'fallback-only',
      version: '1.0.0',
      extract: async ({ url }) => ({
        requestedUrl: url, finalUrl: url, fetchModes: ['json_ld'], contentHash: 'a'.repeat(64), artifactRef: null,
        fields: [{ field: 'product_name', value: 'ACME Chicken Broth 16 oz', method: 'json_ld', sourcePath: 'jsonld:name' }],
        gtins: [], sku: null, brand: null, productName: 'ACME Chicken Broth 16 oz', variant: null, size: null, packCount: null,
        images: [], conflicts: [], identityStatus: 'exact_match', identityReasons: [], deterministicOnly: true,
      }),
    };
    const health = await evaluateExistingProfile(
      { version: 1, selectors: { titleSelector: '.missing-title' }, runtime: 'static' },
      [sample('https://acme.example/p1'), sample('https://acme.example/p2')], extraction,
      new AbortController().signal, 1000,
    );
    expect(health).toMatchObject({ healthy: false, reason: 'profile_runner_unavailable', failure: { code: 'profile_runner_unavailable' } });
  });

  it('never falls back to a successful generic extraction after profile selectors fail', async () => {
    const genericExtract = vi.fn(async ({ url }: { url: string }) => ({
      requestedUrl: url, finalUrl: url, fetchModes: ['json_ld'], contentHash: 'a'.repeat(64), artifactRef: null,
      fields: [{ field: 'product_name', value: 'ACME Chicken Broth 16 oz', method: 'json_ld', sourcePath: 'jsonld:name' }],
      gtins: [], sku: null, brand: null, productName: 'ACME Chicken Broth 16 oz', variant: null, size: null, packCount: null,
      images: [], conflicts: [], identityStatus: 'exact_match' as const, identityReasons: [], deterministicOnly: true,
    }));
    const profileExtract = vi.fn(async () => { throw new Error('profile selectors failed'); });
    const health = await evaluateExistingProfile(
      { version: 1, selectors: { titleSelector: '.missing-title' }, runtime: 'static' },
      [sample('https://acme.example/p1'), sample('https://acme.example/p2')],
      { name: 'profile-and-fallback', version: '1.0.0', extract: genericExtract, extractWithProfile: profileExtract },
      new AbortController().signal, 1000,
    );
    expect(health).toMatchObject({
      healthy: false,
      reason: 'profile_probe_failed:https://acme.example/p1',
      failure: { code: 'profile_probe_failed', url: 'https://acme.example/p1' },
    });
    expect(profileExtract).toHaveBeenCalledTimes(1);
    expect(genericExtract).not.toHaveBeenCalled();
  });

  it('uses JSON-LD/platform evidence before proposing selectors and preserves exact artifacts', async () => {
    const result = await specialist().engineer({
      domain: 'acme.example',
      samples: [
        sample('https://acme.example/p1', { signals: { jsonLd: true }, observedFields: { titleSelector: 'ACME Chicken Broth 16 oz', product_name: 'ACME Chicken Broth 16 oz' } }),
        sample('https://acme.example/p2', { signals: { jsonLd: true }, observedFields: { titleSelector: 'ACME Chicken Broth 16 oz', product_name: 'ACME Chicken Broth 16 oz' } }),
      ],
    }, context);
    if (!('artifact' in result)) throw new Error('expected proposal artifact');
    expect(result.output.strategy).toBe('json_ld');
    expect(result.output.proposedVersion).toBe(1);
    expect(result.output.validation.every((row) => row.artifactRefs.length === 1)).toBe(true);
    expect(result.output.authority).toBe('proposal_only');
    expect(result.output.activation).toBe('manual_review_required');
    expect(result.artifact.artifactType).toBe(PROFILE_ENGINEER_OUTPUT_ARTIFACT_TYPE);
  });

  it.each([
    ['shopify', { shopify: true }],
    ['woocommerce', { woocommerce: true }],
    ['embedded_state', { embeddedState: true }],
  ] as const)('records the deterministic %s platform strategy', async (strategy, signals) => {
    const result = await specialist().engineer({ domain: 'acme.example', samples: [sample('https://acme.example/p1', { signals }), sample('https://acme.example/p2', { signals })] }, context);
    if (!('artifact' in result)) throw new Error('expected proposal output');
    expect(result.output.strategy).toBe(strategy);
  });

  it('requires selectors to survive representative pages and records changed-markup failures', async () => {
    const result = await specialist().engineer({
      domain: 'selector.example',
      samples: [
        sample('https://selector.example/one', { signals: { selectorOnly: true }, selectorHints: { titleSelector: 'h1.product-title' } }),
        sample('https://selector.example/two', { signals: { selectorOnly: true, changedMarkup: true }, selectorHints: { titleSelector: '.new-title' } }),
      ],
    }, context);
    if (!('artifact' in result)) throw new Error('expected proposal output');
    expect(result.output.strategy).toBe('selector_only');
    expect(result.output.selectors.titleSelector).toBeNull();
    expect(result.output.validation[1].fields.titleSelector.status).toBe('fail');
    expect(result.output.validationSummary.byField.titleSelector.failedSamples).toBe(1);
  });

  it('fails closed on wrong-variant samples while retaining their URL and artifact evidence', async () => {
    const result = await specialist().engineer({
      domain: 'variant.example',
      samples: [
        sample('https://variant.example/wrong', { signals: { selectorOnly: true, wrongVariant: true }, expectedVariant: 'wrong' }),
        sample('https://variant.example/wrong-2', { signals: { selectorOnly: true, wrongVariant: true }, expectedVariant: 'wrong' }),
      ],
    }, context);
    if (!('artifact' in result)) throw new Error('expected proposal output');
    expect(result.output.validation[0]).toMatchObject({ url: 'https://variant.example/wrong', artifactRefs: ['artifact:https://variant.example/wrong'], identityStatus: 'wrong_variant', overall: 'fail' });
    expect(result.output.validation[0].fields.titleSelector.failureReason).toMatch(/wrong-variant/i);
  });

  it('fails closed when fewer than two representative pages are supplied', async () => {
    const result = await specialist().engineer({ domain: 'small.example', samples: [sample('https://small.example/only')] }, context);
    expect(result).toMatchObject({ outcome: 'failed', failure: { code: 'invalid_input' } });
  });

  it('does not report success when the completion lease guard is lost', async () => {
    const result = await specialist({
      workflow: {
        claim: () => ({ acquired: true, workflowId: 'workflow-1' }),
        complete: () => ({ applied: false, reason: 'workflow_lease_lost' }),
      },
    }).engineer({ domain: 'lease.example', samples: [sample('https://lease.example/p1'), sample('https://lease.example/p2')] }, context);
    expect(result).toMatchObject({ outcome: 'abstained', abstention: { reason: 'workflow_lease_lost' } });
  });

  it('emits proposedVersion 3 and runtime rendered when repairOf v2 is supplied', async () => {
    let claimedTargetVersion: number | undefined;
    const result = await specialist({
      workflow: {
        claim: (_domain, _runId, _ws, opts) => {
          claimedTargetVersion = opts?.targetVersion;
          return { acquired: true, workflowId: 'workflow-repair' };
        },
        complete: () => ({ applied: true }),
        fail: () => ({ applied: true }),
      },
    }).engineer({
      domain: 'repair.example',
      repairOf: {
        profileId: 'prof-1',
        version: 2,
        runtime: 'rendered',
      },
      samples: [sample('https://repair.example/p1'), sample('https://repair.example/p2')],
    }, context);

    if (!('artifact' in result)) throw new Error('expected proposal output');
    expect(claimedTargetVersion).toBe(3);
    expect(result.output.proposedVersion).toBe(3);
    expect(result.output.runtime).toBe('rendered');
  });

  it('registers versioned input/output payload schemas', async () => {
    const registry = registerProfileEngineerSchemas(new SpecialistArtifactSchemaRegistry());
    const result = await specialist().engineer({ domain: 'schema.example', samples: [sample('https://schema.example/p1'), sample('https://schema.example/p2')] }, context);
    if (!('artifact' in result)) throw new Error('expected proposal output');
    expect(registry.validatePayload(PROFILE_ENGINEER_OUTPUT_ARTIFACT_TYPE, '1.0.0', result.output).valid).toBe(true);
  });
});

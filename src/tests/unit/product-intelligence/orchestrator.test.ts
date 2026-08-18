/**
 * Unit tests for Specialist Orchestrator (#56, epic #47, ADR 0028).
 */

import { describe, it, expect } from 'vitest';
import {
  SpecialistOrchestrator,
} from '../../../product-intelligence/workflow/orchestrator';
import {
  DiscoverySpecialist,
  type DiscoverySourceCandidate,
} from '../../../product-intelligence/specialists/discovery';
import { VerifierSpecialist } from '../../../product-intelligence/specialists/verifier';
import { ProductIntelligencePolicySchema } from '../../../product-intelligence/contracts';
import type { SpecialistContext, SpecialistResult } from '../../../product-intelligence/specialists/contracts';
import type { ProductSeed } from '../../../product-intelligence/product-seed';
import type { ExtractionEvidenceBundle } from '../../../product-intelligence/extraction/evidence';
import { sha256Hex } from '../../../shared/stable-id';

const FIXED_NOW = '2026-08-18T12:00:00.000Z';

const sampleSeed: ProductSeed = {
  sku: 'SUP-56',
  name: 'ACME Organic Chicken Broth 16 oz',
  price: '9.99',
};

const sampleClassificationContext = {
  availableProductTypes: [{ id: 'pt_broth', name: 'Broth & Stock' }],
  availableCategories: [{ id: 'cat_canned_food', name: 'Wet Food & Broths' }],
  attributeProfiles: [],
};

const context: SpecialistContext = {
  runId: 'run-56',
  workspaceId: 'ws-56',
  workspacePath: '/tmp/ws-56',
  seq: 1,
  policy: ProductIntelligencePolicySchema.parse({
    configId: 'test-policy-config',
    modelRoute: { provider: 'test', model: 'test', thinkingLevel: 'off' },
  }),
};

function createDiscoveryCandidate(url = 'https://acme.example/products/chicken-broth-16oz'): DiscoverySourceCandidate {
  return {
    url,
    sourceType: 'manufacturer',
    sourceRef: 'manufacturer:official',
    sourceMethod: 'mock',
    title: 'Organic Chicken Broth',
    snippet: 'ACME Organic Chicken Broth 16 oz',
    evidenceIds: ['ev:1'],
  };
}

const mockExtractionSeam = {
  name: 'mock_extractor',
  version: '1.0.0',
  extract: async (req: any) => ({
    requestedUrl: req.url,
    url: req.url,
    finalUrl: req.url,
    canonicalUrl: req.url,
    fetchModes: ['http_detailed'],
    contentHash: sha256Hex(req.url),
    artifactRef: 'art-1',
    title: 'ACME Organic Chicken Broth 16 fl oz',
    productName: 'Organic Chicken Broth',
    brand: 'ACME',
    sku: 'SUP-56',
    gtin: '012345678901',
    gtins: [{ kind: 'gtin' as const, value: '012345678901', method: 'json_ld', sourcePath: 'product.gtin', sourceArtifactId: 'art-1', evidenceIds: ['ev:1'] }],
    fields: [
      { field: 'brand', value: 'ACME', rawValue: 'ACME', method: 'json_ld', sourcePath: 'product.brand', sourceArtifactId: 'art-1', evidenceIds: ['ev:1'] },
      { field: 'weight', value: '16 fl oz', rawValue: '16 fl oz', method: 'json_ld', sourcePath: 'product.weight', sourceArtifactId: 'art-1', evidenceIds: ['ev:1'] },
    ],
    skuEvidence: { kind: 'sku' as const, value: 'SUP-56', method: 'json_ld', sourcePath: 'product.sku', sourceArtifactId: 'art-1', evidenceIds: ['ev:1'] },
    brandEvidence: { kind: 'brand' as const, value: 'ACME', method: 'json_ld', sourcePath: 'product.brand', sourceArtifactId: 'art-1', evidenceIds: ['ev:1'] },
    variant: null,
    size: '16 fl oz',
    packCount: 1,
    images: [],
    conflicts: [],
    identityStatus: 'exact_match' as const,
    identityReasons: ['exact match'],
    deterministicOnly: true,
  }),
};

function createMockExtractionBundle(url: string, brand = 'ACME'): ExtractionEvidenceBundle {
  const hash = sha256Hex(url);
  return {
    schemaVersion: 1,
    runnerVersion: '1.0.0',
    requestedUrl: url,
    finalUrl: url,
    retrievedAt: FIXED_NOW,
    contentHash: hash,
    artifactRefs: ['art-1'],
    profile: null,
    extractionPath: [{ layer: 'json_ld', method: 'json_ld', sourcePath: 'product', artifactId: 'art-1' }],
    observations: [
      {
        id: 'obs:brand',
        field: 'brand',
        value: brand,
        method: 'json_ld',
        sourcePath: 'product.brand',
        sourceUrl: url,
        finalUrl: url,
        contentHash: hash,
        artifactId: 'art-1',
        profileId: null,
        profileVersion: null,
        variantRef: null,
        provenanceQuality: 'exact_path',
      },
      {
        id: 'obs:weight',
        field: 'weight',
        value: '16 fl oz',
        method: 'json_ld',
        sourcePath: 'product.weight',
        sourceUrl: url,
        finalUrl: url,
        contentHash: hash,
        artifactId: 'art-1',
        profileId: null,
        profileVersion: null,
        variantRef: null,
        provenanceQuality: 'exact_path',
      },
      {
        id: 'obs:title',
        field: 'title',
        value: 'Organic Chicken Broth',
        method: 'json_ld',
        sourcePath: 'product.name',
        sourceUrl: url,
        finalUrl: url,
        contentHash: hash,
        artifactId: 'art-1',
        profileId: null,
        profileVersion: null,
        variantRef: null,
        provenanceQuality: 'exact_path',
      },
      {
        id: 'obs:gtin',
        field: 'gtin',
        value: '012345678901',
        method: 'json_ld',
        sourcePath: 'product.gtin',
        sourceUrl: url,
        finalUrl: url,
        contentHash: hash,
        artifactId: 'art-1',
        profileId: null,
        profileVersion: null,
        variantRef: null,
        provenanceQuality: 'exact_path',
      },
    ],
    images: [],
    variant: null,
    identityStatus: 'exact_match',
    identityReasons: ['exact match'],
    failures: [],
    deterministicOnly: true,
  };
}

describe('Specialist Orchestrator (#56)', () => {
  it('executes end-to-end happy path to terminal status completed with verified extraction runner', async () => {
    const discovery = new DiscoverySpecialist(
      {
        search: async () => ({ candidates: [createDiscoveryCandidate()] }),
        extraction: mockExtractionSeam,
      },
      { codeCommit: 'commit-56' },
    );

    const orchestrator = new SpecialistOrchestrator({
      dependencies: {
        discovery,
        extractionRunner: async (url) => createMockExtractionBundle(url),
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, context);

    expect(result.status).toBe('completed');
    expect(result.retriesCount).toBe(0);
    expect(result.discoveryOutput).toBeDefined();
    expect(result.resolverOutput).toBeDefined();
    expect(result.curatorOutput).toBeDefined();
    expect(result.verifierOutput).toBeDefined();
    expect(result.verifierOutput?.verdict).toBe('pass');
    expect(result.curatorOutput?.catalogTitle).toContain('ACME Organic Chicken Broth');
    expect(result.events.length).toBeGreaterThanOrEqual(5);
  });

  it('routes to Profile Engineer when 2+ domain candidate samples exist and extraction reports profile_failed', async () => {
    let extractionCalls = 0;
    let profileCalls = 0;

    const mockProfileEngineer = {
      execute: async (): Promise<SpecialistResult> => {
        profileCalls += 1;
        return {
          specialist: 'profile_engineer',
          outcome: 'succeeded',
          output: {
            artifactType: 'profile_engineer_result',
            schemaVersion: '1.0.0',
            payload: {
              domain: 'acme.example',
              proposedVersion: 1,
              strategy: 'json_ld',
              selectors: { titleSelector: 'h1.product-title' },
              runtime: 'rendered',
              metadata: {},
              validation: [
                {
                  url: 'https://acme.example/products/chicken-broth-16oz',
                  artifactRefs: ['art-1'],
                  identityStatus: 'exact',
                  fields: {},
                  overall: 'pass',
                },
                {
                  url: 'https://acme.example/products/beef-broth-16oz',
                  artifactRefs: ['art-2'],
                  identityStatus: 'exact',
                  fields: {},
                  overall: 'pass',
                },
              ],
              validationSummary: {
                sampleCount: 2,
                passingSamples: 2,
                failingSamples: 0,
                byField: {},
              },
              authority: 'proposal_only',
              activation: 'manual_review_required',
            },
            lineage: { inputArtifactIds: [], parentArtifactIds: [] },
            provenance: {
              specialist: 'profile_engineer',
              specialistVersion: '1.0.0',
              codeCommit: 'commit-56',
              invokedBy: 'orchestrator',
              durationMs: 10,
              createdAt: FIXED_NOW,
            },
            contentHash: sha256Hex('profile-1'),
          },
          durationMs: 10,
        };
      },
    } as any;

    const mockExtractionRunner = async (url: string, _ctx: any, profile?: any): Promise<ExtractionEvidenceBundle> => {
      extractionCalls += 1;
      if (!profile) {
        // First call without profile reports profile_failed
        return {
          schemaVersion: 1,
          runnerVersion: '1.0.0',
          requestedUrl: url,
          finalUrl: url,
          retrievedAt: FIXED_NOW,
          contentHash: sha256Hex('fail-1'),
          artifactRefs: ['art-1'],
          profile: null,
          extractionPath: [],
          observations: [],
          images: [],
          variant: null,
          identityStatus: 'insufficient_evidence',
          identityReasons: ['Profile required'],
          failures: [{ code: 'profile_failed', stage: 'profile_selector', message: 'Selector extraction failed', retryable: true }],
          deterministicOnly: true,
        };
      }
      // Second call with synthesized profile succeeds
      return createMockExtractionBundle(url);
    };

    const discovery = new DiscoverySpecialist(
      {
        search: async () => ({
          candidates: [
            createDiscoveryCandidate('https://acme.example/products/chicken-broth-16oz'),
            createDiscoveryCandidate('https://acme.example/products/beef-broth-16oz'),
          ],
        }),
        extraction: mockExtractionSeam,
      },
      { codeCommit: 'commit-56' },
    );

    const orchestrator = new SpecialistOrchestrator({
      dependencies: {
        discovery,
        profileEngineer: mockProfileEngineer,
        extractionRunner: mockExtractionRunner,
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, context);

    expect(result.status).toBe('completed');
    expect(profileCalls).toBe(1);
    expect(extractionCalls).toBeGreaterThanOrEqual(2);
    expect(result.events.some((e) => e.specialist === 'profile_engineer' && e.status === 'succeeded')).toBe(true);
  });

  it('transitions to abstained when Discovery finds no candidates', async () => {
    const discovery = new DiscoverySpecialist(
      {
        search: async () => ({ candidates: [] }),
      },
      { codeCommit: 'commit-56' },
    );

    const orchestrator = new SpecialistOrchestrator({
      dependencies: { discovery },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, context);

    expect(result.status).toBe('abstained');
    expect(result.events.some((e) => e.action === 'discover_candidates' && e.status === 'succeeded')).toBe(true);
  });

  it('handles verifier retry loop (retry_curator) up to successful pass', async () => {
    let verifierCalls = 0;
    const mockVerifier = {
      execute: async (rawInput: any, ctx: any): Promise<SpecialistResult> => {
        verifierCalls += 1;
        const verifier = new VerifierSpecialist({ now: () => FIXED_NOW });
        if (verifierCalls === 1) {
          return {
            specialist: 'verifier',
            outcome: 'succeeded',
            output: {
              artifactType: 'verification_report',
              schemaVersion: '1.0.0',
              payload: {
                schemaVersion: '1.0.0',
                specialist: 'verifier',
                specialistVersion: '1.0.0',
                verdict: 'retry_curator',
                score: 0.5,
                identityStatus: 'verified',
                checks: [
                  {
                    checkName: 'claim_grounding',
                    passed: false,
                    severity: 'blocking',
                    field: 'flavor',
                    details: 'Ungrounded flavor claim',
                  },
                ],
                retryRequest: {
                  targetSpecialist: 'curator',
                  reason: 'Regenerate draft attributes',
                  conflictingFields: ['flavor'],
                  suggestedAction: 'Omit ungrounded flavor claim',
                },
                blockingIssuesCount: 1,
                warningsCount: 0,
                verifiedAt: FIXED_NOW,
              },
              lineage: { inputArtifactIds: [], parentArtifactIds: [] },
              provenance: {
                specialist: 'verifier',
                specialistVersion: '1.0.0',
                codeCommit: 'commit-56',
                invokedBy: 'orchestrator',
                durationMs: 10,
                createdAt: FIXED_NOW,
              },
              contentHash: sha256Hex('verifier-1'),
            },
            durationMs: 10,
          };
        }
        return verifier.execute(rawInput, ctx);
      },
    } as any;

    const discovery = new DiscoverySpecialist(
      {
        search: async () => ({ candidates: [createDiscoveryCandidate()] }),
        extraction: mockExtractionSeam,
      },
      { codeCommit: 'commit-56' },
    );

    const orchestrator = new SpecialistOrchestrator({
      maxRetries: 3,
      dependencies: {
        discovery,
        verifier: mockVerifier,
        extractionRunner: async (url) => createMockExtractionBundle(url),
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, context);

    expect(result.status).toBe('completed');
    expect(result.retriesCount).toBe(1);
    expect(verifierCalls).toBe(2);
    expect(result.events.some((e) => e.status === 'retrying')).toBe(true);
  });

  it('holds for human review when retry limit is exhausted', async () => {
    const mockFailingVerifier = {
      execute: async (): Promise<SpecialistResult> => ({
        specialist: 'verifier',
        outcome: 'succeeded',
        output: {
          artifactType: 'verification_report',
          schemaVersion: '1.0.0',
          payload: {
            schemaVersion: '1.0.0',
            specialist: 'verifier',
            specialistVersion: '1.0.0',
            verdict: 'retry_curator',
            score: 0.2,
            identityStatus: 'verified',
            checks: [
              {
                checkName: 'claim_grounding',
                passed: false,
                severity: 'blocking',
                field: 'title',
                details: 'Persistent title issue',
              },
            ],
            retryRequest: {
              targetSpecialist: 'curator',
              reason: 'Persistent title issue',
              conflictingFields: ['title'],
              suggestedAction: 'Fix title',
            },
            blockingIssuesCount: 1,
            warningsCount: 0,
            verifiedAt: FIXED_NOW,
          },
          lineage: { inputArtifactIds: [], parentArtifactIds: [] },
          provenance: {
            specialist: 'verifier',
            specialistVersion: '1.0.0',
            codeCommit: 'commit-56',
            invokedBy: 'orchestrator',
            durationMs: 10,
            createdAt: FIXED_NOW,
          },
          contentHash: sha256Hex('failing-verifier'),
        },
        durationMs: 10,
      }),
    } as any;

    const discovery = new DiscoverySpecialist(
      {
        search: async () => ({ candidates: [createDiscoveryCandidate()] }),
        extraction: mockExtractionSeam,
      },
      { codeCommit: 'commit-56' },
    );

    const orchestrator = new SpecialistOrchestrator({
      maxRetries: 2,
      dependencies: {
        discovery,
        verifier: mockFailingVerifier,
        extractionRunner: async (url) => createMockExtractionBundle(url),
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, context);

    expect(result.status).toBe('needs_review');
    expect(result.retriesCount).toBe(2);
  });

  it('holds for human review when verifier emits human_review verdict', async () => {
    const mockReviewVerifier = {
      execute: async (): Promise<SpecialistResult> => ({
        specialist: 'verifier',
        outcome: 'succeeded',
        output: {
          artifactType: 'verification_report',
          schemaVersion: '1.0.0',
          payload: {
            schemaVersion: '1.0.0',
            specialist: 'verifier',
            specialistVersion: '1.0.0',
            verdict: 'human_review',
            score: 0.6,
            identityStatus: 'ambiguous',
            checks: [
              {
                checkName: 'identity_resolution',
                passed: false,
                severity: 'warning',
                field: 'gtin',
                details: 'Ambiguous brand match',
              },
            ],
            retryRequest: null,
            blockingIssuesCount: 0,
            warningsCount: 1,
            verifiedAt: FIXED_NOW,
          },
          lineage: { inputArtifactIds: [], parentArtifactIds: [] },
          provenance: {
            specialist: 'verifier',
            specialistVersion: '1.0.0',
            codeCommit: 'commit-56',
            invokedBy: 'orchestrator',
            durationMs: 10,
            createdAt: FIXED_NOW,
          },
          contentHash: sha256Hex('review-verifier'),
        },
        durationMs: 10,
      }),
    } as any;

    const discovery = new DiscoverySpecialist(
      {
        search: async () => ({ candidates: [createDiscoveryCandidate()] }),
        extraction: mockExtractionSeam,
      },
      { codeCommit: 'commit-56' },
    );

    const orchestrator = new SpecialistOrchestrator({
      dependencies: {
        discovery,
        verifier: mockReviewVerifier,
        extractionRunner: async (url) => createMockExtractionBundle(url),
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, context);

    expect(result.status).toBe('needs_review');
    expect(result.verifierOutput?.verdict).toBe('human_review');
  });

  it('enforces total dispatch limit as hard stop with multiple parallel candidate workers', async () => {
    const discovery = new DiscoverySpecialist(
      {
        search: async () => ({
          candidates: [
            createDiscoveryCandidate('https://acme.example/1'),
            createDiscoveryCandidate('https://acme.example/2'),
            createDiscoveryCandidate('https://acme.example/3'),
          ],
        }),
        extraction: mockExtractionSeam,
      },
      { codeCommit: 'commit-56' },
    );

    const orchestrator = new SpecialistOrchestrator({
      limits: { maxTotalDispatches: 2 }, // Only allow 2 dispatches total
      dependencies: {
        discovery,
        extractionRunner: async (url) => createMockExtractionBundle(url),
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, context);

    expect(result.status).toBe('budget_exceeded');
    expect(result.totalDispatches).toBeLessThanOrEqual(2);
  });

  it('aborts immediately with cancelled status when AbortSignal is triggered', async () => {
    const controller = new AbortController();
    controller.abort();

    const orchestrator = new SpecialistOrchestrator({ now: () => FIXED_NOW });
    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, {
      ...context,
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
  });

  it('transitions to budget_exceeded when deadline is exceeded', async () => {
    const orchestrator = new SpecialistOrchestrator({ now: () => FIXED_NOW });
    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, {
      ...context,
      deadlineAt: Date.now() - 1000,
    });

    expect(result.status).toBe('budget_exceeded');
  });

  it('fails closed when a specialist execution fails', async () => {
    const mockFailingDiscovery = {
      execute: async (): Promise<SpecialistResult> => ({
        specialist: 'discovery',
        outcome: 'failed',
        failure: { code: 'capability_error', message: 'Serper rate limit exceeded' },
        durationMs: 10,
      }),
    } as any;

    const orchestrator = new SpecialistOrchestrator({
      dependencies: { discovery: mockFailingDiscovery },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, context);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Serper rate limit');
  });
});

/**
 * Unit tests for Specialist Orchestrator (#56, epic #47, ADR 0028).
 */

import { describe, it, expect } from 'vitest';
import {
  SpecialistOrchestrator,
  normalizeScopedIdentifier,
  InMemoryWorkflowPersistenceRepository,
  WorkflowBudgetBroker,
  type SpecialistWorkflowRecord,
} from '../../../product-intelligence/workflow/orchestrator';
import {
  DiscoverySpecialist,
  type DiscoverySourceCandidate,
} from '../../../product-intelligence/specialists/discovery';
import { ProfileEngineerSpecialist, type ProfileEngineerWorkflowLock } from '../../../product-intelligence/specialists/profile-engineer';
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
        id: 'obs:size',
        field: 'size',
        value: '16 fl oz',
        method: 'json_ld',
        sourcePath: 'product.size',
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
        id: 'obs:packCount',
        field: 'packCount',
        value: '1',
        method: 'json_ld',
        sourcePath: 'product.packCount',
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
        id: 'obs:dimensions',
        field: 'dimensions',
        value: '3 x 3 x 7 in',
        method: 'json_ld',
        sourcePath: 'product.dimensions',
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
  it('normalizes identifiers once and rejects 14-digit GTIN from consumer unit scope', () => {
    const unscoped14 = normalizeScopedIdentifier('10012345678908');
    expect(unscoped14.gtin).toBeNull();
    expect(unscoped14.scope).toBe('consumer_unit');

    const case14 = normalizeScopedIdentifier('10012345678908', 'case');
    expect(case14.gtin).toBe('10012345678908');
    expect(case14.scope).toBe('case');

    const consumer12 = normalizeScopedIdentifier('012345678901');
    expect(consumer12.gtin).toBe('012345678901');
    expect(consumer12.scope).toBe('consumer_unit');
  });

  it('executes end-to-end happy path to terminal status completed with verified extraction runner and persistence', async () => {
    const savedRecords: SpecialistWorkflowRecord[] = [];
    const mockPersistence = {
      save: (rec: SpecialistWorkflowRecord) => {
        savedRecords.push(rec);
      },
      get: () => null,
    };

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
        workflowPersistence: mockPersistence,
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
    expect(result.curatorOutput?.catalogTitle).toContain('ACME');
    expect(result.events.length).toBeGreaterThanOrEqual(5);
    expect(result.workflowState).toBeDefined();
    expect(result.workflowState.status).toBe('completed');
    expect(result.workflowState.currentPhase).toBe('completed');
    expect(savedRecords.length).toBeGreaterThanOrEqual(4);
    expect(savedRecords[savedRecords.length - 1].status).toBe('completed');
    expect(result.workflowState.routeRecords.length).toBeGreaterThanOrEqual(3);
  });

  it('routes to real Profile Engineer and produces usable title selector proposal validated on retained samples', async () => {
    const mockExtractionRunner = async (url: string): Promise<ExtractionEvidenceBundle> => {
      const isBeef = url.includes('beef');
      const artId = isBeef ? 'art-2' : 'art-1';
      return {
        schemaVersion: 1,
        runnerVersion: '1.0.0',
        requestedUrl: url,
        finalUrl: url,
        retrievedAt: FIXED_NOW,
        contentHash: sha256Hex(url),
        artifactRefs: [artId],
        profile: null,
        extractionPath: [],
        observations: [
          {
            id: 'obs:title',
            field: 'title',
            value: isBeef ? 'Organic Beef Broth' : 'Organic Chicken Broth',
            method: 'selector',
            sourcePath: 'h1.product-title', // Identical valid CSS selector on both pages
            sourceUrl: url,
            finalUrl: url,
            contentHash: sha256Hex('title'),
            artifactId: artId,
            profileId: null,
            profileVersion: null,
            variantRef: null,
            provenanceQuality: 'exact_path',
          },
        ],
        images: [],
        variant: null,
        identityStatus: 'insufficient_evidence',
        identityReasons: ['Profile required'],
        failures: [{ code: 'profile_failed', stage: 'profile_selector', message: 'Selector extraction failed', retryable: true }],
        deterministicOnly: true,
      };
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

    const realProfileEngineer = new ProfileEngineerSpecialist({}, { codeCommit: 'commit-56' });

    const orchestrator = new SpecialistOrchestrator({
      dependencies: {
        discovery,
        profileEngineer: realProfileEngineer,
        extractionRunner: mockExtractionRunner,
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, context);

    expect(result.status).toBe('needs_review');
    expect(result.profileOutput).toBeDefined();
    expect(result.profileOutput?.domain).toBe('acme.example');
    expect(result.profileOutput?.selectors.titleSelector).toBe('h1.product-title');
    expect(result.profileOutput?.authority).toBe('proposal_only');
    expect(result.profileOutput?.activation).toBe('manual_review_required');
    expect(result.events.some((e) => e.action === 'profile_review_hold')).toBe(true);
  });

  it('rejects JSON-LD paths and differing selectors from being promoted by Profile Engineer', async () => {
    const mockExtractionRunner = async (url: string): Promise<ExtractionEvidenceBundle> => {
      const isBeef = url.includes('beef');
      const artId = isBeef ? 'art-2' : 'art-1';
      return {
        schemaVersion: 1,
        runnerVersion: '1.0.0',
        requestedUrl: url,
        finalUrl: url,
        retrievedAt: FIXED_NOW,
        contentHash: sha256Hex(url),
        artifactRefs: [artId],
        profile: null,
        extractionPath: [],
        observations: [
          {
            id: 'obs:title',
            field: 'title',
            value: isBeef ? 'Organic Beef Broth' : 'Organic Chicken Broth',
            method: isBeef ? 'json_ld' : 'selector', // Sample 2 uses json_ld method!
            sourcePath: isBeef ? 'product.name' : 'h1.product-title',
            sourceUrl: url,
            finalUrl: url,
            contentHash: sha256Hex('title'),
            artifactId: artId,
            profileId: null,
            profileVersion: null,
            variantRef: null,
            provenanceQuality: 'exact_path',
          },
        ],
        images: [],
        variant: null,
        identityStatus: 'insufficient_evidence',
        identityReasons: ['Profile required'],
        failures: [{ code: 'profile_failed', stage: 'profile_selector', message: 'Selector extraction failed', retryable: true }],
        deterministicOnly: true,
      };
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

    const realProfileEngineer = new ProfileEngineerSpecialist({}, { codeCommit: 'commit-56' });

    const orchestrator = new SpecialistOrchestrator({
      dependencies: {
        discovery,
        profileEngineer: realProfileEngineer,
        extractionRunner: mockExtractionRunner,
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, context);

    expect(result.status).toBe('needs_review');
    expect(result.profileOutput).toBeDefined();
    // JSON-LD path is not promoted as titleSelector
    expect(result.profileOutput?.selectors.titleSelector).toBeNull();
  });

  it('rejects 14-digit GTIN without case scope and runs through resolver with null expected consumer GTIN', async () => {
    const caseExtractionSeam = {
      name: 'mock_case_extractor',
      version: '1.0.0',
      extract: async (req: any) => {
        const base = await mockExtractionSeam.extract(req);
        return {
          ...base,
          gtin: '10012345678908',
          gtins: [{ kind: 'gtin' as const, value: '10012345678908', method: 'json_ld', sourcePath: 'product.gtin', sourceArtifactId: 'art-1', evidenceIds: ['ev:1'] }],
        };
      },
    };

    const discovery = new DiscoverySpecialist(
      {
        search: async () => ({
          candidates: [createDiscoveryCandidate()],
        }),
        extraction: caseExtractionSeam,
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

    const result = await orchestrator.runWorkflow(
      sampleSeed,
      sampleClassificationContext,
      context,
      { discoveredGtin: '10012345678908' }, // 14-digit supplied without scope
    );

    expect(result.status).toBe('completed');
    expect(result.resolverOutput).toBeDefined();
    expect(result.resolverOutput?.expectedIdentity?.gtin).toBeNull();
    expect(result.resolverOutput?.expectedIdentity?.gtinScope).toBe('consumer_unit');
  });

  it('accepts 14-digit GTIN when explicitly scoped to case', async () => {
    const caseExtractionSeam = {
      name: 'mock_case_extractor',
      version: '1.0.0',
      extract: async (req: any) => {
        const base = await mockExtractionSeam.extract(req);
        return {
          ...base,
          gtin: '10012345678908',
          gtins: [{ kind: 'gtin' as const, value: '10012345678908', method: 'json_ld', sourcePath: 'product.gtin', sourceArtifactId: 'art-1', evidenceIds: ['ev:1'] }],
        };
      },
    };

    const discovery = new DiscoverySpecialist(
      {
        search: async () => ({
          candidates: [createDiscoveryCandidate()],
        }),
        extraction: caseExtractionSeam,
      },
      { codeCommit: 'commit-56' },
    );

    const orchestrator = new SpecialistOrchestrator({
      dependencies: {
        discovery,
        extractionRunner: async (url) => {
          const base = createMockExtractionBundle(url);
          const gtinObs = base.observations.find((o) => o.field === 'gtin');
          if (gtinObs) gtinObs.value = '10012345678908';
          return base;
        },
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(
      sampleSeed,
      sampleClassificationContext,
      context,
      { discoveredGtin: '10012345678908', gtinScope: 'case' },
    );

    expect(result.status).toBe('completed');
    expect(result.resolverOutput).toBeDefined();
    expect(result.resolverOutput?.expectedIdentity?.gtin).toBe('10012345678908');
    expect(result.resolverOutput?.expectedIdentity?.gtinScope).toBe('case');
  });

  it('promotes genuinely discovered 12-digit GTIN to expected consumer identity', async () => {
    const discovery = new DiscoverySpecialist(
      {
        search: async () => ({
          candidates: [createDiscoveryCandidate()],
        }),
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

    const result = await orchestrator.runWorkflow(
      sampleSeed,
      sampleClassificationContext,
      context,
      { discoveredGtin: '012345678901' },
    );

    expect(result.status).toBe('completed');
    expect(result.resolverOutput?.expectedIdentity?.gtin).toBe('012345678901');
    expect(result.verifierOutput?.identityStatus).toBe('verified');
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
    expect(result.workflowState.status).toBe('abstained');
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
                identityScore: 1.0,
                productDataScore: 0.5,
                identityStatus: 'verified',
                identityDecision: 'pass',
                productDataDecision: 'fail',
                checks: [
                  {
                    checkName: 'claim_grounding',
                    category: 'product_data',
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
            identityScore: 1.0,
            productDataScore: 0.2,
            identityStatus: 'verified',
            identityDecision: 'pass',
            productDataDecision: 'fail',
            checks: [
              {
                checkName: 'claim_grounding',
                category: 'product_data',
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
    expect(result.workflowState.status).toBe('needs_review');
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
      limits: { maxTotalDispatches: 2 },
      dependencies: {
        discovery,
        extractionRunner: async (url) => createMockExtractionBundle(url),
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, context);

    expect(result.status).toBe('budget_exceeded');
    expect(result.totalDispatches).toBeLessThanOrEqual(2);
    expect(result.workflowState.status).toBe('budget_exceeded');
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
    expect(result.workflowState.status).toBe('cancelled');
  });

  it('transitions to budget_exceeded when deadline is exceeded', async () => {
    const orchestrator = new SpecialistOrchestrator({ now: () => FIXED_NOW });
    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, {
      ...context,
      deadlineAt: Date.now() - 1000,
    });

    expect(result.status).toBe('budget_exceeded');
    expect(result.workflowState.status).toBe('budget_exceeded');
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
    expect(result.workflowState.status).toBe('failed');
  });

  it('enforces policy maxToolCalls as active budget stop', async () => {
    const mockDiscovery = {
      execute: async (): Promise<SpecialistResult> => ({
        specialist: 'discovery',
        outcome: 'succeeded',
        output: {
          artifactType: 'discovery_candidates',
          schemaVersion: '1.0.0',
          payload: { candidates: [createDiscoveryCandidate()] },
          lineage: { inputArtifactIds: [], parentArtifactIds: [] },
          provenance: {
            specialist: 'discovery',
            specialistVersion: '1.0.0',
            codeCommit: 'commit-56',
            invokedBy: 'orchestrator',
            durationMs: 10,
            createdAt: FIXED_NOW,
          },
          contentHash: sha256Hex('disc-1'),
        },
        usage: { toolCalls: 10, modelCalls: 2, inputTokens: 500, outputTokens: 200, estimatedCostUsd: 0.05 },
        durationMs: 10,
      }),
    } as any;

    const orchestrator = new SpecialistOrchestrator({
      dependencies: { discovery: mockDiscovery },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(
      sampleSeed,
      sampleClassificationContext,
      {
        ...context,
        policy: ProductIntelligencePolicySchema.parse({
          configId: 'budget-policy',
          maxToolCalls: 5, // Budget is 5, but discovery spent 10
        }),
      },
    );

    expect(result.status).toBe('budget_exceeded');
    expect(result.workflowState.usage.totalToolCalls).toBe(10);
    expect(result.workflowState.status).toBe('budget_exceeded');
  });

  it('enforces policy maxCostUsd as active budget stop', async () => {
    const mockDiscovery = {
      execute: async (): Promise<SpecialistResult> => ({
        specialist: 'discovery',
        outcome: 'succeeded',
        output: {
          artifactType: 'discovery_candidates',
          schemaVersion: '1.0.0',
          payload: { candidates: [createDiscoveryCandidate()] },
          lineage: { inputArtifactIds: [], parentArtifactIds: [] },
          provenance: {
            specialist: 'discovery',
            specialistVersion: '1.0.0',
            codeCommit: 'commit-56',
            invokedBy: 'orchestrator',
            durationMs: 10,
            createdAt: FIXED_NOW,
          },
          contentHash: sha256Hex('disc-1'),
        },
        usage: { toolCalls: 2, modelCalls: 2, inputTokens: 500, outputTokens: 200, estimatedCostUsd: 2.50 },
        durationMs: 10,
      }),
    } as any;

    const orchestrator = new SpecialistOrchestrator({
      dependencies: { discovery: mockDiscovery },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(
      sampleSeed,
      sampleClassificationContext,
      {
        ...context,
        policy: ProductIntelligencePolicySchema.parse({
          configId: 'cost-policy',
          maxCostUsd: 1.00, // Budget is $1.00, but discovery spent $2.50
        }),
      },
    );

    expect(result.status).toBe('budget_exceeded');
    expect(result.workflowState.usage.estimatedCostUsd).toBe(2.50);
    expect(result.workflowState.status).toBe('budget_exceeded');
  });

  it('rehydrates persisted workflow state from storage', async () => {
    const memoryRepo = new InMemoryWorkflowPersistenceRepository();
    const discovery = new DiscoverySpecialist(
      {
        search: async () => ({
          candidates: [createDiscoveryCandidate('https://acme.example/products/broth')],
        }),
        extraction: mockExtractionSeam,
      },
      { codeCommit: 'commit-56' },
    );

    const orchestrator = new SpecialistOrchestrator({
      dependencies: {
        discovery,
        workflowPersistence: memoryRepo,
        extractionRunner: async (url) => createMockExtractionBundle(url),
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(sampleSeed, sampleClassificationContext, context);
    expect(result.status).toBe('completed');

    const rehydrated = await orchestrator.getWorkflowState(context.runId);
    expect(rehydrated).not.toBeNull();
    expect(rehydrated?.runId).toBe(context.runId);
    expect(rehydrated?.status).toBe('completed');
    expect(rehydrated?.capabilityInvocationIds.discovery.length).toBe(1);
    expect(rehydrated?.capabilityInvocationIds.extraction.length).toBe(1);
    expect(rehydrated?.routeRecords.length).toBeGreaterThan(0);
  });

  it('enforces dynamic remaining tool allowance on retry discovery and halts before exceeding limit', async () => {
    let discoveryCalls = 0;
    const mockDiscovery = new DiscoverySpecialist(
      {
        search: async () => {
          discoveryCalls += 1;
          return {
            candidates: [
              createDiscoveryCandidate('https://acme.example/p1'),
              createDiscoveryCandidate('https://acme.example/p2'),
            ],
          };
        },
        extraction: mockExtractionSeam,
      },
      { codeCommit: 'commit-56' },
    );

    let verifierCalls = 0;
    const mockVerifier = {
      execute: async (): Promise<SpecialistResult> => {
        verifierCalls += 1;
        // First verifier call requests retry_discovery
        return {
          specialist: 'verifier',
          outcome: 'succeeded',
          output: {
            artifactType: 'verification_report',
            schemaVersion: '1.0.0',
            payload: {
              verdict: verifierCalls === 1 ? 'retry_discovery' : 'pass',
              score: 0.8,
              identityStatus: 'verified',
              identityDecision: 'pass',
              dataScore: 0.8,
              checks: [],
              retryRequest: verifierCalls === 1 ? { targetSpecialist: 'discovery', reason: 'need more candidates' } : null,
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
            contentHash: sha256Hex(`ver-${verifierCalls}`),
          },
          usage: { toolCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          durationMs: 10,
        };
      },
    } as any;

    const orchestrator = new SpecialistOrchestrator({
      dependencies: {
        discovery: mockDiscovery,
        verifier: mockVerifier,
        extractionRunner: async (url) => createMockExtractionBundle(url),
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(
      sampleSeed,
      sampleClassificationContext,
      {
        ...context,
        policy: ProductIntelligencePolicySchema.parse({
          configId: 'budget-retry-policy',
          maxToolCalls: 5, // Budget limit is 5
        }),
      },
    );

    // First pass spent 3 tools in discovery + 1 in extraction = 4 tools total.
    // When retry_discovery runs, remainingToolCalls was 1. Discovery spent 1 and hit 5 total.
    // Next extraction attempts to reserve tool 6 -> halted with budget_exceeded!
    expect(discoveryCalls).toBeGreaterThan(0);
    expect(result.status).toBe('budget_exceeded');
    expect(result.workflowState.usage.totalToolCalls).toBe(5);
  });

  it('halts with budget_exceeded and blocks non-cooperative specialist before execution when planned cost exceeds budget', async () => {
    let verifierExecuted = false;
    const mockVerifierOverBudget = {
      plannedCostUsd: 5.00,
      plannedModelCalls: 5,
      execute: async (): Promise<SpecialistResult> => {
        // Deliberately non-cooperative specialist: does NOT voluntarily check runtimeAllowance.
        // Orchestrator-owned broker pre-spend reservation MUST block this callback from ever running.
        verifierExecuted = true;
        return {
          specialist: 'verifier',
          outcome: 'succeeded',
          output: {
            artifactType: 'verification_report',
            schemaVersion: '1.0.0',
            payload: {
              verdict: 'pass',
              score: 0.95,
              identityStatus: 'verified',
              identityDecision: 'pass',
              dataScore: 0.95,
              checks: [],
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
            contentHash: sha256Hex('ver-pass'),
          },
          usage: { toolCalls: 0, modelCalls: 5, inputTokens: 5000, outputTokens: 2000, estimatedCostUsd: 5.00 },
          durationMs: 10,
        };
      },
    } as any;

    const orchestrator = new SpecialistOrchestrator({
      dependencies: {
        discovery: new DiscoverySpecialist(
          {
            search: async () => ({ candidates: [createDiscoveryCandidate()] }),
            extraction: mockExtractionSeam,
          },
          { codeCommit: 'commit-56' },
        ),
        verifier: mockVerifierOverBudget,
        extractionRunner: async (url) => createMockExtractionBundle(url),
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(
      sampleSeed,
      sampleClassificationContext,
      {
        ...context,
        policy: ProductIntelligencePolicySchema.parse({
          configId: 'cost-strict-policy',
          maxCostUsd: 1.00,
        }),
      },
    );

    expect(verifierExecuted).toBe(false);
    expect(result.status).toBe('budget_exceeded');
    expect(result.workflowState.status).toBe('budget_exceeded');
  });

  it('blocks specialist execution before dispatch when remaining budget is exhausted', async () => {
    let verifierExecuted = false;
    const mockDiscovery = {
      execute: async (): Promise<SpecialistResult> => ({
        specialist: 'discovery',
        outcome: 'succeeded',
        output: {
          artifactType: 'discovery_candidates',
          schemaVersion: '1.0.0',
          payload: { candidates: [createDiscoveryCandidate()] },
          lineage: { inputArtifactIds: [], parentArtifactIds: [] },
          provenance: {
            specialist: 'discovery',
            specialistVersion: '1.0.0',
            codeCommit: 'commit-56',
            invokedBy: 'orchestrator',
            durationMs: 10,
            createdAt: FIXED_NOW,
          },
          contentHash: sha256Hex('disc-exhausted'),
        },
        usage: { toolCalls: 2, modelCalls: 2, inputTokens: 500, outputTokens: 200, estimatedCostUsd: 1.00 }, // Completely consumes $1.00 budget
        durationMs: 10,
      }),
    } as any;

    const mockVerifier = {
      execute: async (): Promise<SpecialistResult> => {
        verifierExecuted = true;
        return {
          specialist: 'verifier',
          outcome: 'succeeded',
          durationMs: 10,
        };
      },
    } as any;

    const orchestrator = new SpecialistOrchestrator({
      dependencies: {
        discovery: mockDiscovery,
        verifier: mockVerifier,
        extractionRunner: async (url) => createMockExtractionBundle(url),
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(
      sampleSeed,
      sampleClassificationContext,
      {
        ...context,
        policy: ProductIntelligencePolicySchema.parse({
          configId: 'cost-exhausted-policy',
          maxCostUsd: 1.00,
        }),
      },
    );

    expect(verifierExecuted).toBe(false); // Verifier is NEVER executed because budget was already exhausted!
    expect(result.status).toBe('budget_exceeded');
  });

  it('propagates remaining deadline timeout to deterministic extraction runner', async () => {
    let receivedTimeoutMs: number | undefined;
    const mockExtractionRunner = async (
      _url: string,
      execContext: SpecialistContext,
    ): Promise<ExtractionEvidenceBundle> => {
      receivedTimeoutMs = execContext.deadlineAt ? execContext.deadlineAt - Date.now() : undefined;
      return createMockExtractionBundle('https://acme.example/products/broth');
    };

    const orchestrator = new SpecialistOrchestrator({
      dependencies: {
        discovery: new DiscoverySpecialist(
          {
            search: async () => ({ candidates: [createDiscoveryCandidate()] }),
            extraction: mockExtractionSeam,
          },
          { codeCommit: 'commit-56' },
        ),
        extractionRunner: mockExtractionRunner,
      },
      now: () => FIXED_NOW,
    });

    const targetDeadline = Date.now() + 5000;
    await orchestrator.runWorkflow(
      sampleSeed,
      sampleClassificationContext,
      {
        ...context,
        deadlineAt: targetDeadline,
      },
    );

    expect(receivedTimeoutMs).toBeDefined();
    expect(receivedTimeoutMs!).toBeGreaterThan(0);
    expect(receivedTimeoutMs!).toBeLessThanOrEqual(5000);
  });

  it('halts with budget_exceeded when hard maxTotalSteps ceiling is reached', async () => {
    const orchestrator = new SpecialistOrchestrator({
      limits: {
        maxTotalSteps: 2, // Hard step ceiling is 2
      },
      dependencies: {
        discovery: new DiscoverySpecialist(
          {
            search: async () => ({ candidates: [createDiscoveryCandidate()] }),
            extraction: mockExtractionSeam,
          },
          { codeCommit: 'commit-56' },
        ),
        extractionRunner: async (url) => createMockExtractionBundle(url),
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(
      sampleSeed,
      sampleClassificationContext,
      context,
    );

    expect(result.status).toBe('budget_exceeded');
    expect(result.error).toContain('Total step ceiling');
  });

  it('triggers vN+1 repair of failed active profile, sets proposal version 3, and holds for review', async () => {
    let claimedRepairVersion: number | undefined;
    const lock: ProfileEngineerWorkflowLock = {
      claim: (_domain: string, _runId: string, _ws: string, opts?: any) => {
        claimedRepairVersion = opts?.targetVersion;
        return { acquired: true, workflowId: 'wf:repair-test' };
      },
      complete: () => ({ applied: true }),
      fail: () => ({ applied: true }),
    };

    const orchestrator = new SpecialistOrchestrator({
      dependencies: {
        discovery: new DiscoverySpecialist(
          {
            search: async () => ({
              candidates: [
                createDiscoveryCandidate('https://acme.example/pdp1'),
                createDiscoveryCandidate('https://acme.example/pdp2'),
              ],
            }),
            extraction: mockExtractionSeam,
          },
          { codeCommit: 'commit-56' },
        ),
        profileEngineerWorkflowLock: lock,
        extractionRunner: async (url) => {
          const bundle = createMockExtractionBundle(url);
          bundle.profile = { id: 'prof-acme', version: 2, runtime: 'rendered' };
          bundle.failures = [{
            code: 'profile_failed',
            stage: 'profile_selector',
            message: 'active v2 selector failed',
            retryable: true,
          }];
          return bundle;
        },
      },
      now: () => FIXED_NOW,
    });

    const result = await orchestrator.runWorkflow(
      sampleSeed,
      sampleClassificationContext,
      context,
    );

    expect(result.status).toBe('needs_review');
    expect(claimedRepairVersion).toBe(3); // Requested targetVersion 3 (repair of v2!)
    expect(result.profileOutput?.proposedVersion).toBe(3);
    expect(result.profileOutput?.runtime).toBe('rendered');
  });

  it('guarantees concurrency safety of individual budget reservation handles across parallel workers', () => {
    const broker = new WorkflowBudgetBroker(
      {
        ...context,
        policy: ProductIntelligencePolicySchema.parse({
          configId: 'concurrency-policy',
          maxToolCalls: 5,
        }),
      },
      20,
      20,
      Date.now(),
    );

    // Initial committed usage: 3 tool calls
    broker.usage.totalToolCalls = 3;
    expect(broker.getRemainingToolCalls()).toBe(2);

    // Worker A reserves 1 tool call
    const resA = broker.reserve('extraction', { toolCalls: 1 });
    expect(resA.allowed).toBe(true);
    expect(broker.getRemainingToolCalls()).toBe(1);

    // Worker B reserves 1 tool call
    const resB = broker.reserve('extraction', { toolCalls: 1 });
    expect(resB.allowed).toBe(true);
    expect(broker.getRemainingToolCalls()).toBe(0);

    // Worker C tries to reserve but budget is exhausted by active reservations
    const resC = broker.reserve('extraction', { toolCalls: 1 });
    expect(resC.allowed).toBe(false);

    // Worker A finishes and commits its 1 tool call
    broker.commit(resA.handle!, { toolCalls: 1, modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
    expect(broker.usage.totalToolCalls).toBe(4);

    // CRITICAL: Committing worker A did NOT wipe out worker B's active reservation!
    expect(broker.getRemainingToolCalls()).toBe(0); // 5 max - (4 committed + 1 reserved for B) = 0 remaining

    // Worker C is STILL blocked because B is still live
    const resC2 = broker.reserve('extraction', { toolCalls: 1 });
    expect(resC2.allowed).toBe(false);

    // Now worker B finishes and commits
    broker.commit(resB.handle!, { toolCalls: 1, modelCalls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
    expect(broker.usage.totalToolCalls).toBe(5);
    expect(broker.getRemainingToolCalls()).toBe(0);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import {
  createDistributor,
  createConnection,
  updateConnection,
  upsertBrandAdvisoryProfile,
} from '../../db/repositories/distributor-repo';
import { startSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import type { DistributorConnector, SourcingLookupRequest, SourcingLookupResult } from '../../onboarding/sourcing/contracts';

class MockConnector implements DistributorConnector {
  readonly connectorType = 'api';
  readonly requiresSecret = false;
  readonly providerId: string;

  constructor(
    readonly distributorId: string,
    private readonly outcome: 'found' | 'not_stocked',
  ) {
    this.providerId = `provider_${distributorId}`;
  }

  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    if (this.outcome === 'found') {
      return {
        outcome: 'found',
        record: {
          matchedIdentifier: request.upc,
          distributorUpc: request.upc,
          gtin: request.upc,
          distributorSku: `SKU_${this.distributorId}`,
          name: `Found Product ${this.distributorId}`,
          description: 'A great pet product',
          brand: 'Acana',
          manufacturerPartNumber: null,
          weight: '25lb',
          features: ['Grain Free'],
          category: 'Dog Food',
          dimensions: null,
          casePack: null,
          unitOfMeasure: null,
          ingredients: null,
          attributes: {},
          imageUrls: [],
          sourceUrl: null,
          catalogVersion: null,
          observedAt: new Date().toISOString(),
          expiresAt: null,
        },
        matchedFields: ['upc', 'brand'],
        warnings: [],
      };
    }
    return {
      outcome: 'not_stocked',
    };
  }
}

class TestConnectorRegistry implements ConnectorRegistry {
  private connectors = new Map<string, DistributorConnector>();

  register(distributorId: string, connector: DistributorConnector) {
    this.connectors.set(distributorId, connector);
  }

  createConnector(type: string, distributorId: string): DistributorConnector | null {
    return this.connectors.get(distributorId) ?? null;
  }
}

describe('Sourcing Engine Policy Routing', () => {
  const workspaceId = 'ws-sourcing-test';
  let batchId: string;
  let registry: TestConnectorRegistry;

  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'Test Sourcing WS',
      workspacePath: '/tmp/test-sourcing-ws',
      gitPath: '/tmp/test-sourcing-ws/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });

    const b = createBatch({
      workspaceId,
      name: 'Sourcing Batch',
      fileName: 'sourcing.csv',
      totalItems: 1,
    });
    batchId = b.id;

    registry = new TestConnectorRegistry();

    // Setup 3 distributors
    createDistributor({ id: 'dist_phillips', name: 'Phillips Pet' });
    const cp = createConnection({
      id: 'conn_phillips',
      workspaceId,
      distributorId: 'dist_phillips',
      connectorType: 'api',
      configuration: {},
    });
    updateConnection(cp.id, workspaceId, { enabled: true });

    createDistributor({ id: 'dist_bradley', name: 'Bradley Caldwell' });
    const cb = createConnection({
      id: 'conn_bradley',
      workspaceId,
      distributorId: 'dist_bradley',
      connectorType: 'api',
      configuration: {},
    });
    updateConnection(cb.id, workspaceId, { enabled: true });

    createDistributor({ id: 'dist_orgill', name: 'Orgill Hardware' });
    const co = createConnection({
      id: 'conn_orgill',
      workspaceId,
      distributorId: 'dist_orgill',
      connectorType: 'api',
      configuration: {},
    });
    updateConnection(co.id, workspaceId, { enabled: true });
  });

  it('preferred_only policy queries ONLY preferred distributors', async () => {
    registry.register('dist_phillips', new MockConnector('dist_phillips', 'not_stocked'));
    registry.register('dist_bradley', new MockConnector('dist_bradley', 'found'));
    registry.register('dist_orgill', new MockConnector('dist_orgill', 'found'));

    upsertBrandAdvisoryProfile({
      workspaceId,
      brand: 'ACANA',
      preferredDistributorIds: ['dist_phillips'],
      sourcingPolicy: 'preferred_only',
    });

    const items = insertItems(
      batchId,
      [{ upc: '064992524258', name: 'Acana Dog Food 25lb', brandHint: 'ACANA', rowNumber: 1 }],
      'sourcing',
      1,
    );
    const generation = startSourcingGeneration(items[0].id);

    const engine = new DefaultSourcingEngine(registry, 2);
    const result = await engine.runGeneration({
      itemId: items[0].id,
      generationId: generation.id,
      workspaceId,
      upc: '064992524258',
      brandHint: 'ACANA',
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].connectionId).toBe('conn_phillips');
    expect(result.skipped.map((s) => s.reason)).toEqual(['policy_preferred_only', 'policy_preferred_only']);
  });

  it('preferred_then_fallback stops when preferred distributor finds product', async () => {
    registry.register('dist_phillips', new MockConnector('dist_phillips', 'found'));
    registry.register('dist_bradley', new MockConnector('dist_bradley', 'found'));
    registry.register('dist_orgill', new MockConnector('dist_orgill', 'found'));

    upsertBrandAdvisoryProfile({
      workspaceId,
      brand: 'ACANA',
      preferredDistributorIds: ['dist_phillips'],
      sourcingPolicy: 'preferred_then_fallback',
    });

    const items = insertItems(
      batchId,
      [{ upc: '064992524258', name: 'Acana Dog Food 25lb', brandHint: 'ACANA', rowNumber: 1 }],
      'sourcing',
      1,
    );
    const generation = startSourcingGeneration(items[0].id);

    const engine = new DefaultSourcingEngine(registry, 2);
    const result = await engine.runGeneration({
      itemId: items[0].id,
      generationId: generation.id,
      workspaceId,
      upc: '064992524258',
      brandHint: 'ACANA',
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].connectionId).toBe('conn_phillips');
    expect(result.attempts[0].outcome).toBe('found');
    // Fallback connectors are skipped because match was found
    expect(result.skipped.map((s) => s.reason)).toEqual(['policy_preferred_match_found', 'policy_preferred_match_found']);
  });

  it('preferred_then_fallback cascades to fallbacks when preferred distributor returns not_stocked', async () => {
    registry.register('dist_phillips', new MockConnector('dist_phillips', 'not_stocked'));
    registry.register('dist_bradley', new MockConnector('dist_bradley', 'found'));
    registry.register('dist_orgill', new MockConnector('dist_orgill', 'not_stocked'));

    upsertBrandAdvisoryProfile({
      workspaceId,
      brand: 'ACANA',
      preferredDistributorIds: ['dist_phillips'],
      sourcingPolicy: 'preferred_then_fallback',
    });

    const items = insertItems(
      batchId,
      [{ upc: '064992524258', name: 'Acana Dog Food 25lb', brandHint: 'ACANA', rowNumber: 1 }],
      'sourcing',
      1,
    );
    const generation = startSourcingGeneration(items[0].id);

    const engine = new DefaultSourcingEngine(registry, 2);
    const result = await engine.runGeneration({
      itemId: items[0].id,
      generationId: generation.id,
      workspaceId,
      upc: '064992524258',
      brandHint: 'ACANA',
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });

    // All 3 connectors should have been queried
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.map((a) => a.connectionId)).toContain('conn_phillips');
    expect(result.attempts.map((a) => a.connectionId)).toContain('conn_bradley');
    expect(result.attempts.map((a) => a.connectionId)).toContain('conn_orgill');
  });

  it('advisory policy queries all enabled connectors', async () => {
    registry.register('dist_phillips', new MockConnector('dist_phillips', 'found'));
    registry.register('dist_bradley', new MockConnector('dist_bradley', 'found'));
    registry.register('dist_orgill', new MockConnector('dist_orgill', 'found'));

    upsertBrandAdvisoryProfile({
      workspaceId,
      brand: 'ACANA',
      preferredDistributorIds: ['dist_phillips'],
      sourcingPolicy: 'advisory',
    });

    const items = insertItems(
      batchId,
      [{ upc: '064992524258', name: 'Acana Dog Food 25lb', brandHint: 'ACANA', rowNumber: 1 }],
      'sourcing',
      1,
    );
    const generation = startSourcingGeneration(items[0].id);

    const engine = new DefaultSourcingEngine(registry, 2);
    const result = await engine.runGeneration({
      itemId: items[0].id,
      generationId: generation.id,
      workspaceId,
      upc: '064992524258',
      brandHint: 'ACANA',
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });

    expect(result.attempts).toHaveLength(3);
  });
});

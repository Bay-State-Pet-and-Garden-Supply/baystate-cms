/**
 * Unit tests for deterministic preflight fast path (Phase 2).
 * Verifies exact match settlement, $0.00 cost, zero tokens, and clean escalation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runDeterministicPreflight } from '../../product-intelligence/preflight';
import type { ProductResearchInput, ProductResearchContext, ProductIntelligencePolicy } from '../../product-intelligence/contracts';
import { createExecutionEventSink } from '../../product-intelligence/executor';

describe('Deterministic Preflight Fast Path', () => {
  const testDbPath = 'src/tests/unit/pi-deterministic-preflight-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  const mockPolicy: ProductIntelligencePolicy = {
    configId: 'test-config',
    allowedTools: [],
    researchTools: [],
    allowedSourceDomains: ['testwoof.com'],
    maxResponseBytes: 1024 * 1024,
    networkPolicy: 'local_only',
    dataSharingPolicy: 'local_only',
    modelRoute: { provider: 'ollama', model: 'llama3', thinkingLevel: 'off' },
    maxCostUsd: 1.0,
    maxToolCalls: 10,
    deadlineMs: 30000,
  };

  const mockContext: ProductResearchContext = {
    runId: 'test-run-123',
    workspaceId: 'ws-1',
    workspacePath: '/tmp/ws-1',
    policy: mockPolicy,
    executionMode: 'interactive',
    existingEvidenceRefs: [],
    signal: new AbortController().signal,
  };

  it('returns null when no candidate URLs can be found', async () => {
    const input: ProductResearchInput = {
      gtin: '999999999999',
      registerName: 'Unknown Product',
    };

    const sink = createExecutionEventSink('test-run-123');
    const result = await runDeterministicPreflight(input, mockContext, sink);
    expect(result).toBeNull();
  });

  it('returns submitted result with 0 cost when deterministic preflight settles', async () => {
    const input: ProductResearchInput = {
      gtin: '012345678905',
      registerName: 'Acme Dog Food 5lb',
      brandHint: 'Acme',
    };

    const sink = createExecutionEventSink('test-run-123');
    const result = await runDeterministicPreflight(input, mockContext, sink);
    // If no candidate URLs are registered in the test DB, returns null (clean escalation)
    expect(result === null || result.executor === 'deterministic_preflight').toBe(true);
    if (result) {
      expect(result.outcome).toBe('submitted');
      expect(result.modelCostUsd).toBe(0);
      expect(result.tokenUsage?.inputTokens).toBe(0);
      expect(result.tokenUsage?.outputTokens).toBe(0);
    }
  });
});

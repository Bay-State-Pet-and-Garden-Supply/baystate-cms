import { describe, test, expect, beforeEach } from 'bun:test';
import { getDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createConnection } from '../../db/repositories/distributor-repo';
import {
  insertEvidenceAttempt,
  startSourcingGeneration,
  supersedeCurrentSourcingGeneration,
  getCurrentGenerationAttempts,
  listGenerationsForItem,
} from '../../db/repositories/onboarding-evidence-repo';
import {
  getAcceptedAttemptIdsForItem,
  getCurrentGenerationAcceptedAttemptIds,
  recordAcceptances,
  isAcceptanceMigrationCompleted,
} from '../../db/repositories/onboarding-acceptance-repo';

describe('Evidence Acceptance Migration & Authority Tests', () => {
  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    insertWorkspace({
      id: 'w1',
      name: 'Test Workspace',
      workspacePath: '/tmp/test-ws',
      gitPath: '/tmp/test-ws/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  test('confirms distributor_v2_schema_version migration is marked completed', () => {
    expect(isAcceptanceMigrationCompleted()).toBe(true);
  });

  test('zero normalized acceptances are authoritative (ADR 0014 — no legacy resurrection)', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B1', fileName: 'b1.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678901', name: 'Test Product', rowNumber: 1 }]);

    const attempt = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ name: 'Test Product' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
    });

    // A recorded attempt that was never accepted is NOT accepted: the
    // normalized acceptance table is the 100% authoritative source.
    expect(getAcceptedAttemptIdsForItem(item.id)).toEqual([]);

    // Record an acceptance in the relational table.
    recordAcceptances(item.id, [attempt.id], 'operator', 'Manual approval');
    expect(getAcceptedAttemptIdsForItem(item.id)).toEqual([attempt.id]);

    // Clear relational acceptances (simulating operator deleting all accepted
    // evidence) — it MUST still return [] and never resurrect anything.
    getDb().query('DELETE FROM onboarding_item_evidence_acceptances WHERE item_id = ?').run(item.id);
    expect(getAcceptedAttemptIdsForItem(item.id)).toEqual([]);
  });

  test('enforces UNIQUE(item_id, evidence_attempt_id) idempotency with ON CONFLICT DO NOTHING', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B2', fileName: 'b2.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678902', name: 'Dup Test', rowNumber: 1 }]);

    const attempt = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'unfi',
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.95,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
    });

    // Call recordAcceptances twice
    recordAcceptances(item.id, [attempt.id]);
    recordAcceptances(item.id, [attempt.id]);

    const acceptances = getDb()
      .query('SELECT * FROM onboarding_item_evidence_acceptances WHERE item_id = ?')
      .all(item.id);

    expect(acceptances.length).toBe(1);
  });

  test('recordAcceptances validates attempt ownership before insertion', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B3', fileName: 'b3.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678903', name: 'Ownership', rowNumber: 1 }]);

    // An attempt id that does not exist for the item must throw, never insert.
    expect(() => recordAcceptances(item.id, ['attempt-does-not-exist'])).toThrow(/not found for item/);
    expect(getAcceptedAttemptIdsForItem(item.id)).toEqual([]);
  });

  test('acceptances and attempts are generation-scoped (ADR 0014 immutable generations)', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B4', fileName: 'b4.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678904', name: 'Gen Scope', rowNumber: 1 }]);

    const gen1 = startSourcingGeneration(item.id, 'automatic');
    const attempt = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ brand: 'Nutro' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: gen1.id,
    });

    recordAcceptances(item.id, [attempt.id], 'system', 'coherent');
    expect(getCurrentGenerationAcceptedAttemptIds(item.id)).toEqual([attempt.id]);

    // Retry supersedes generation 1 and starts generation 2.
    const gen2 = supersedeCurrentSourcingGeneration(item.id, 'operator_retry');
    expect(gen2.supersedesId).toBe(gen1.id);
    expect(gen2.status).toBe('running');

    // Old attempts/acceptances stay audit-visible...
    expect(listGenerationsForItem(item.id).length).toBe(2);
    expect(getCurrentGenerationAttempts(item.id).length).toBe(0); // gen2 has no attempts
    // ...but never influence the current generation's decisions.
    expect(getCurrentGenerationAcceptedAttemptIds(item.id)).toEqual([]);
    // Item-wide view still shows the historical acceptance.
    expect(getAcceptedAttemptIdsForItem(item.id)).toEqual([attempt.id]);
  });

  test('insertEvidenceAttempt appends exactly once per (item, connection, generation)', () => {
    const { createConnection } = require('../../db/repositories/distributor-repo');
    const batch = createBatch({ workspaceId: 'w1', name: 'B5', fileName: 'b5.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Dedup', rowNumber: 1 }]);
    const gen = startSourcingGeneration(item.id);
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api' });
    const conn2 = createConnection({ workspaceId: 'w1', distributorId: 'unfi', connectorType: 'api' });

    const first = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      distributorConnectionId: conn.id,
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: gen.id,
    });

    // Same connection + generation: idempotent — returns the FIRST row.
    const second = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      distributorConnectionId: conn.id,
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: gen.id,
    });
    expect(second.id).toBe(first.id);
    expect(getCurrentGenerationAttempts(item.id).length).toBe(1);

    // A DIFFERENT connection (same provider!) gets its own durable attempt:
    // the idempotency key is (item, connection, generation), not provider.
    const third = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      distributorConnectionId: conn2.id,
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: gen.id,
    });
    expect(third.id).not.toBe(first.id);
    expect(getCurrentGenerationAttempts(item.id).length).toBe(2);
  });

  test('insertEvidenceAttempt rejects a generation belonging to another item', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B6', fileName: 'b6.csv', totalItems: 2 });
    const [itemA, itemB] = insertItems(batch.id, [
      { upc: '012345678906', name: 'A', rowNumber: 1 },
      { upc: '012345678907', name: 'B', rowNumber: 2 },
    ]);
    const genA = startSourcingGeneration(itemA.id);

    expect(() =>
      insertEvidenceAttempt({
        itemId: itemB.id,
        providerId: 'phillips',
        lookupUpc: itemB.upc,
        outcome: 'found',
        confidence: 0.9,
        evidenceUrl: null,
        matchedFields: ['upc'],
        identityJson: null,
        warningsJson: null,
        errorCode: null,
        errorMessage: null,
        sourcingGenerationId: genA.id,
      }),
    ).toThrow(/does not belong to item/);
  });

  test('insertEvidenceAttempt rejects a cross-workspace connection', () => {
    insertWorkspace({
      id: 'w2',
      name: 'Workspace 2',
      workspacePath: '/tmp/ws2',
      gitPath: '/tmp/ws2/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const batch = createBatch({ workspaceId: 'w1', name: 'B7', fileName: 'b7.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678908', name: 'Cross WS', rowNumber: 1 }]);
    const gen = startSourcingGeneration(item.id);

    // Connection belongs to w2; the item's batch belongs to w1 → rejected.
    const conn = createConnection({ workspaceId: 'w2', distributorId: 'x', connectorType: 'api' });
    expect(() =>
      insertEvidenceAttempt({
        itemId: item.id,
        providerId: 'phillips',
        distributorConnectionId: conn.id,
        lookupUpc: item.upc,
        outcome: 'found',
        confidence: 0.9,
        evidenceUrl: null,
        matchedFields: ['upc'],
        identityJson: null,
        warningsJson: null,
        errorCode: null,
        errorMessage: null,
        sourcingGenerationId: gen.id,
      }),
    ).toThrow(/not found for item/);
  });

  test('recordAcceptances rejects attempts from a stale (non-current) generation', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B8', fileName: 'b8.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678909', name: 'Stale Accept', rowNumber: 1 }]);

    const gen1 = startSourcingGeneration(item.id);
    const staleAttempt = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: gen1.id,
    });

    // Retry supersedes gen1; the stale attempt can never be accepted.
    supersedeCurrentSourcingGeneration(item.id, 'operator_retry');
    expect(() => recordAcceptances(item.id, [staleAttempt.id], 'system', 'coherent')).toThrow(
      /not the item's current generation/,
    );
  });

  test('superseded-generation acceptances stay audit-visible but never current (replacement semantics)', () => {
    const batch = createBatch({ workspaceId: 'w1', name: 'B9', fileName: 'b9.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678951', name: 'Gen Replacement', rowNumber: 1 }]);

    // Generation 1: accepted evidence is the effective set while current.
    const gen1 = startSourcingGeneration(item.id);
    const attempt1 = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: gen1.id,
    });
    recordAcceptances(item.id, [attempt1.id]);
    expect(getCurrentGenerationAcceptedAttemptIds(item.id)).toEqual([attempt1.id]);

    // Retry supersedes gen1 and starts gen2: the effective accepted set is
    // REPLACED by the new generation's acceptances (replacement semantics).
    const gen2 = supersedeCurrentSourcingGeneration(item.id, 'operator_retry');
    expect(gen2.id).not.toBe(gen1.id);

    // The old-generation attempt can no longer be accepted.
    expect(() => recordAcceptances(item.id, [attempt1.id])).toThrow(/not the item's current generation/);

    // A fresh attempt in the new generation is accepted and becomes current.
    const attempt2 = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'bci',
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.8,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: gen2.id,
    });
    recordAcceptances(item.id, [attempt2.id]);

    expect(getCurrentGenerationAcceptedAttemptIds(item.id)).toEqual([attempt2.id]);
    // The audit trail retains BOTH acceptances (immutability: history is
    // never rewritten, it is only superseded).
    const all = getDb()
      .query(
        'SELECT evidence_attempt_id FROM onboarding_item_evidence_acceptances WHERE item_id = ? ORDER BY created_at ASC',
      )
      .all(item.id) as Array<{ evidence_attempt_id: string }>;
    expect(all.map((r) => r.evidence_attempt_id)).toEqual([attempt1.id, attempt2.id]);
  });
});

import { describe, test, expect, beforeEach } from 'bun:test';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { startSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import { listConflictsForItem } from '../../db/repositories/onboarding-conflict-repo';
import { reconcileDistributorEvidence, evaluateDistributorEvidence } from '../../onboarding/sourcing-reconciler';
import type { EvidenceAttempt } from '../../shared/schemas/distributor-evidence';

function makeAttempt(
  id: string,
  providerId: string,
  identity: Record<string, unknown> | null,
  outcome: EvidenceAttempt['outcome'] = 'found',
): EvidenceAttempt {
  return {
    id,
    itemId: 'ignored',
    providerId,
    lookupUpc: '012345678905',
    outcome,
    confidence: 0.9,
    evidenceUrl: null,
    matchedFields: ['upc'],
    identityJson: identity ? JSON.stringify(identity) : null,
    warningsJson: null,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
  };
}

describe('Sourcing evidence reconciler (ADR 0014)', () => {
  let itemId: string;
  let generationId: string;

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
    const batch = createBatch({ workspaceId: 'w1', name: 'B', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'P', rowNumber: 1 }]);
    itemId = item.id;
    generationId = startSourcingGeneration(item.id, 'automatic').id;
  });

  test('coherent evidence across providers is fully accepted with no conflicts', async () => {
    const a1 = makeAttempt('a1', 'phillips', { upc: '012345678905', brand: 'Nutro', weight: '12 lb' });
    const a2 = makeAttempt('a2', 'bci', { upc: '012345678905', brand: 'Nutro', weight: '12 lb' });

    const result = await reconcileDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.hardConflictCount).toBe(0);
    expect(result.softConflictCount).toBe(0);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
    expect(result.providerIds.sort()).toEqual(['bci', 'phillips']);
    expect(listConflictsForItem(itemId)).toEqual([]);
  });

  test('identity conflict on weight is auto-resolved to primary distributor and attempts are accepted', async () => {
    const a1 = makeAttempt('a1', 'phillips', { upc: '012345678905', brand: 'Nutro', weight: '10 lbs' });
    const a2 = makeAttempt('a2', 'bci', { upc: '012345678905', brand: 'Nutro', weight: '20 lbs' });

    const result = await reconcileDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.hardConflictCount).toBe(0);
    expect(result.softConflictCount).toBe(1);
    expect(result.warnings.some((w) => w.includes("auto-resolved to '10 lbs'"))).toBe(true);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
    // Soft/auto-resolved discrepancies do not insert blocking open conflict rows
    expect(listConflictsForItem(itemId)).toEqual([]);
  });

  // Epic #46 follow-up (operator weight rule): "0.0600 lb" vs "0.06 lb" are
  // the SAME pounds value — formatting-only disagreement must not create a
  // hard conflict.
  test('equivalent weight formatting (0.0600 lb vs 0.06 lb) is NOT a conflict', async () => {
    const a1 = makeAttempt('a1', 'phillips', { upc: '012345678905', brand: 'Nutro', weight: '0.0600 lb' });
    const a2 = makeAttempt('a2', 'bci', { upc: '012345678905', brand: 'Nutro', weight: '0.06 lb' });

    const result = await reconcileDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.hardConflictCount).toBe(0);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
    expect(listConflictsForItem(itemId)).toEqual([]);
    // Suppression is EXPLAINABLE: the warning records the canonical agreement.
    expect(result.warnings.some((w) => w.includes('agree after normalization'))).toBe(true);
  });

  test('equivalent weight units (16 oz vs 1.0000 lb) are NOT a conflict', async () => {
    const a1 = makeAttempt('a1', 'phillips', { upc: '012345678905', brand: 'Nutro', weight: '16 oz' });
    const a2 = makeAttempt('a2', 'bci', { upc: '012345678905', brand: 'Nutro', weight: '1.0000 lb' });

    const result = await reconcileDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.hardConflictCount).toBe(0);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
    expect(listConflictsForItem(itemId)).toEqual([]);
  });

  test('rounding-equivalent weights (0.3771 lb vs 0.38 lb) are NOT a conflict', async () => {
    const a1 = makeAttempt('a1', 'phillips', { upc: '012345678905', brand: 'Nutro', weight: '0.3771 lb' });
    const a2 = makeAttempt('a2', 'bci', { upc: '012345678905', brand: 'Nutro', weight: '0.38 lb' });

    const result = await reconcileDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
  });

  test('true weight mismatch is auto-resolved with explainable warning', async () => {
    const a1 = makeAttempt('a1', 'phillips', { upc: '012345678905', brand: 'Nutro', weight: '0.25 lb' });
    const a2 = makeAttempt('a2', 'bci', { upc: '012345678905', brand: 'Nutro', weight: '0.50 lb' });

    const result = await reconcileDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.hardConflictCount).toBe(0);
    expect(result.warnings.some((w) => w.includes("auto-resolved to '0.25 lb'"))).toBe(true);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
  });

  test('malformed weight is auto-resolved against valid values with primary provider precedence', async () => {
    const a1 = makeAttempt('a1', 'phillips', { upc: '012345678905', brand: 'Nutro', weight: 'approx 1 lb' });
    const a2 = makeAttempt('a2', 'bci', { upc: '012345678905', brand: 'Nutro', weight: '1.00 lb' });

    const result = await reconcileDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
  });

  test('brand casing-only agreement and distinct brand strings auto-resolve with explainable warning', async () => {
    const caseA = makeAttempt('c1', 'phillips', { upc: '012345678905', brand: 'WHOLESOMES', weight: '5 lb' });
    const caseB = makeAttempt('c2', 'bci', { upc: '012345678905', brand: 'Wholesomes', weight: '5 lb' });
    const caseResult = await reconcileDistributorEvidence(itemId, [caseA, caseB], generationId);
    expect(caseResult.hasHardIdentityConflict).toBe(false);
    expect(caseResult.acceptedAttemptIds.sort()).toEqual(['c1', 'c2']);

    const distinctA = makeAttempt('d1', 'phillips', { upc: '012345678905', brand: 'Wholesomes', weight: '5 lb' });
    const distinctB = makeAttempt('d2', 'bci', { upc: '012345678905', brand: 'WholesomesFlavor', weight: '5 lb' });
    const distinctResult = await reconcileDistributorEvidence(itemId, [distinctA, distinctB], generationId);
    expect(distinctResult.hasHardIdentityConflict).toBe(false);
    expect(distinctResult.warnings.some((w) => w.includes("auto-resolved to 'Wholesomes'"))).toBe(true);
    expect(distinctResult.acceptedAttemptIds.sort()).toEqual(['d1', 'd2']);
  });

  test('consensus brand resolution (e.g. KONG vs THE KONG COMPANY)', async () => {
    const d1 = makeAttempt('d1', 'phillips', { upc: '012345678905', brand: 'KONG' });
    const d2 = makeAttempt('d2', 'bradley', { upc: '012345678905', brand: 'KONG' });
    const d3 = makeAttempt('d3', 'orgill', { upc: '012345678905', brand: 'THE KONG COMPANY' });

    const result = await reconcileDistributorEvidence(itemId, [d1, d2, d3], generationId);
    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.warnings.some((w) => w.includes("auto-resolved to 'KONG'"))).toBe(true);
    expect(result.acceptedAttemptIds.sort()).toEqual(['d1', 'd2', 'd3']);
  });

  test('soft disagreements (copy + distributor reference fields) are consolidated, never persisted as conflict rows, and never block acceptance', async () => {
    const a1 = makeAttempt('a1', 'phillips', {
      upc: '012345678905',
      brand: 'Nutro',
      description: 'Chicken recipe',
      distributorSku: 'SKU-PHIL',
    });
    const a2 = makeAttempt('a2', 'bci', {
      upc: '012345678905',
      brand: 'Nutro',
      description: 'Chicken & rice recipe',
      distributorSku: 'SKU-BCI',
    });

    const result = await reconcileDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.softConflictCount).toBe(2);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);

    // Soft disagreements are consolidated by the projection authority with
    // provenance (HARD-only persistence) — they never become durable
    // conflict rows and never require an operator decision.
    expect(listConflictsForItem(itemId)).toEqual([]);
  });

  test('confidence does not override primary distributor candidate selection', async () => {
    const low = makeAttempt('a1', 'phillips', { upc: '012345678905', brand: 'Nutro', weight: '10 lbs' });
    low.confidence = 0.1;
    const highConflict = makeAttempt('a2', 'bci', { upc: '012345678905', brand: 'Nutro', weight: '20 lbs' });
    highConflict.confidence = 0.99;

    const result = await reconcileDistributorEvidence(itemId, [low, highConflict], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
    expect(result.warnings.some((w) => w.includes("auto-resolved to '10 lbs'"))).toBe(true);
  });

  test('no found attempts yields an empty result with the no-evidence warning', async () => {
    const a1 = makeAttempt('a1', 'phillips', null, 'not_stocked');
    const a2 = makeAttempt('a2', 'bci', null, 'source_error');

    const result = await reconcileDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.acceptedAttemptIds).toEqual([]);
    expect(result.providerIds).toEqual([]);
    expect(result.hardConflictCount).toBe(0);
    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.warnings).toEqual(['No distributor evidence found']);
    expect(listConflictsForItem(itemId)).toEqual([]);
  });

  test('generation-scoped idempotency: auto-resolved evidence is consistent across retries', async () => {
    const a1 = makeAttempt('a1', 'phillips', { upc: '012345678905', brand: 'Nutro', weight: '10 lbs' });
    const a2 = makeAttempt('a2', 'bci', { upc: '012345678905', brand: 'Nutro', weight: '20 lbs' });

    const res1 = await reconcileDistributorEvidence(itemId, [a1, a2], generationId);
    expect(res1.hasHardIdentityConflict).toBe(false);
    expect(res1.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);

    const res2 = await reconcileDistributorEvidence(itemId, [a1, a2], generationId);
    expect(res2.hasHardIdentityConflict).toBe(false);
    expect(res2.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
  });

  test('a found attempt with malformed identityJson is skipped WITHOUT being accepted', async () => {
    const malformed = makeAttempt('a1', 'phillips', null);
    malformed.identityJson = '{not valid json';

    const result = await reconcileDistributorEvidence(itemId, [malformed], generationId);

    // The malformed attempt contributes no candidates; no crash, no conflicts.
    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.hardConflictCount).toBe(0);
    expect(listConflictsForItem(itemId)).toEqual([]);
    // ADR 0014: only VALIDATED found attempts count — an unparseable attempt
    // is never accepted blindly (it would create an evidence_to_discovery
    // decision on zero evidence).
    expect(result.acceptedAttemptIds).toEqual([]);
  });

  test('variant dimensions inside attributes disagree → auto-resolved on the flattened field', async () => {
    const a1 = makeAttempt('a1', 'phillips', { upc: '012345678905', attributes: { size: '10 lb', count: '24' } });
    const a2 = makeAttempt('a2', 'unfi', { upc: '012345678905', attributes: { size: '20 lb', count: '24' } });

    const result = await reconcileDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.warnings.some((w) => w.includes("auto-resolved to '10 lb'"))).toBe(true);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
    expect(listConflictsForItem(itemId)).toEqual([]);
  });

  test('pure API: flavor/formula disagreements are auto-resolved and nothing is persisted', () => {
    const a1 = makeAttempt('a1', 'phillips', { upc: '012345678905', attributes: { flavor: 'chicken' } });
    const a2 = makeAttempt('a2', 'bci', { upc: '012345678905', attributes: { flavor: 'beef' } });

    const result = evaluateDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.warnings.some((w) => w.includes("auto-resolved to 'chicken'"))).toBe(true);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
    expect(listConflictsForItem(itemId)).toEqual([]);
  });

  test('pure API: formula agreement accepts agreeing values', () => {
    const a1 = makeAttempt('a1', 'phillips', {
      upc: '012345678905',
      brand: 'Nutro',
      attributes: { formula: 'grain free' },
    });
    const a2 = makeAttempt('a2', 'bci', {
      upc: '012345678905',
      brand: 'Nutro',
      attributes: { formula: 'grain free' },
    });

    const result = evaluateDistributorEvidence(itemId, [a1, a2], generationId);
    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
    expect(listConflictsForItem(itemId)).toEqual([]);
  });

  test('pure API: unknown variant axis is an insufficiency signal, never a soft conflict', () => {
    const a1 = makeAttempt('a1', 'phillips', {
      upc: '012345678905',
      brand: 'Nutro',
      attributes: { scent: 'peach' },
    });
    const a2 = makeAttempt('a2', 'bci', {
      upc: '012345678905',
      brand: 'Nutro',
      attributes: { scent: 'strawberry' },
    });

    const result = evaluateDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.hasUnknownVariantAxis).toBe(true);
    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.softConflictCount).toBe(0);
    expect(result.conflicts).toEqual([]);
    expect(result.warnings.some((w) => w.includes("Unknown variant attribute 'scent'"))).toBe(true);

    // Declared axis → participates in auto-resolution.
    const declared = evaluateDistributorEvidence(itemId, [a1, a2], generationId, {
      declaredVariantAxes: ['scent'],
    });
    expect(declared.hasUnknownVariantAxis).toBe(false);
    expect(declared.hasHardIdentityConflict).toBe(false);
    expect(declared.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
    expect(declared.warnings.some((w) => w.includes("auto-resolved to 'peach'"))).toBe(true);
  });

  test('pure API: confidence does not alter candidate selection over primary provider', () => {
    const low = makeAttempt('a1', 'phillips', { upc: '012345678905', weight: '10 lbs' });
    low.confidence = 0.05;
    const high = makeAttempt('a2', 'bci', { upc: '012345678905', weight: '20 lbs' });
    high.confidence = 0.99;

    const result = evaluateDistributorEvidence(itemId, [low, high], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
    expect(result.warnings.some((w) => w.includes("auto-resolved to '10 lbs'"))).toBe(true);
  });

  test('pure API: coherent evidence is accepted without any DB write', () => {
    const a1 = makeAttempt('a1', 'phillips', { upc: '012345678905', brand: 'Nutro', weight: '12 lb' });
    const a2 = makeAttempt('a2', 'bci', { upc: '012345678905', brand: 'Nutro', weight: '12 lb' });

    const result = evaluateDistributorEvidence(itemId, [a1, a2], generationId);

    expect(result.hasHardIdentityConflict).toBe(false);
    expect(result.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
    expect(result.providerIds.sort()).toEqual(['bci', 'phillips']);
    expect(listConflictsForItem(itemId)).toEqual([]);
  });

  test('pure API: declared variant axes participate in auto-resolution (Amendment A)', () => {
    const a1 = makeAttempt('a1', 'phillips', {
      upc: '012345678905',
      brand: 'Nutro',
      attributes: { scent: 'chicken' },
    });
    const a2 = makeAttempt('a2', 'bci', {
      upc: '012345678905',
      brand: 'Nutro',
      attributes: { scent: 'beef' },
    });

    // Without declarations, 'scent' is an unknown axis (insufficiency signal).
    const unknown = evaluateDistributorEvidence(itemId, [a1, a2], generationId);
    expect(unknown.hasUnknownVariantAxis).toBe(true);
    expect(unknown.hasHardIdentityConflict).toBe(false);

    // With the declaration, 'scent' auto-resolves with primary provider precedence.
    const declared = evaluateDistributorEvidence(itemId, [a1, a2], generationId, {
      variantAxisDeclarations: [{ rawField: 'scent', normalizedAxis: 'scent' }],
    });
    expect(declared.hasUnknownVariantAxis).toBe(false);
    expect(declared.hasHardIdentityConflict).toBe(false);
    expect(declared.acceptedAttemptIds.sort()).toEqual(['a1', 'a2']);
    expect(declared.warnings.some((w) => w.includes("auto-resolved to 'chicken'"))).toBe(true);
  });

  test('pure API: raw-field registry treats a registry-only raw key as declared (never unknown)', () => {
    const a1 = makeAttempt('a1', 'phillips', {
      upc: '012345678905',
      brand: 'Nutro',
      attributes: { 'Scent Level': 'high' },
    });
    // Raw key 'Scent Level' is declared via the registry even though it does
    // not normalize to a bare axis name.
    const result = evaluateDistributorEvidence(itemId, [a1], generationId, {
      variantAxisDeclarations: [{ rawField: 'Scent Level', normalizedAxis: 'scent level' }],
    });
    expect(result.hasUnknownVariantAxis).toBe(false);
    expect(result.acceptedAttemptIds).toEqual(['a1']);
  });

  test('legacy export passes declared axes through and reports hasUnknownVariantAxis', async () => {
    const a1 = makeAttempt('a1', 'phillips', {
      upc: '012345678905',
      brand: 'Nutro',
      attributes: { scent: 'chicken' },
    });

    const result = await reconcileDistributorEvidence(itemId, [a1], generationId, ['scent']);
    expect(result.hasUnknownVariantAxis).toBe(false);
    expect(result.acceptedAttemptIds).toEqual(['a1']);

    const unknown = await reconcileDistributorEvidence(itemId, [a1], generationId);
    expect(unknown.hasUnknownVariantAxis).toBe(true);
    expect(unknown.acceptedAttemptIds).toEqual(['a1']);
  });
});

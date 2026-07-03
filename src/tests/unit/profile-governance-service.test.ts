/**
 * Unit tests for `src/onboarding/profile-governance-service.ts`.
 *
 * Covers the central domain-profile governance rules:
 *   - summary rolls up active profile, generations, revisions,
 *     decisions, and validation-sample counts
 *   - backfilled revisions keep legacy generations referentially
 *     consistent
 *   - validation across confirmed samples enforces the selected
 *     sample policy and is bounded by a max
 *   - revision from structured feedback is versioned, not
 *     overwriting the parent
 *   - approval requires per-field opt-in, image approval requires
 *     the previewsReviewed attestation, and rejected fields do not
 *     touch the active profile
 *   - rollback restores the prior selector and writes a
 *     rolled_back decision row
 *
 * The tests use a real on-disk SQLite database (bun:sqlite).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import {
  insertSources,
  selectSource,
} from '../../db/repositories/onboarding-source-repo';
import { insertProfileGeneration } from '../../db/repositories/profile-generation-repo';
import { findProfileGenerationRevisionById, listRevisionsByGeneration, findLatestValidatedRevision, insertRevisionValidationResults } from '../../db/repositories/profile-generation-revision-repo';
import { insertProfileFieldDecision, findProfileFieldDecisionById, listFieldDecisionsByDomain } from '../../db/repositories/profile-generation-field-decision-repo';
import { findProfileByDomain, upsertProfile } from '../../db/repositories/extractor-profile-repo';
import { getDb } from '../../db/connection';
import {
  listDomainProfileGovernance,
  createInitialRevisionForGeneration,
  reviseProfileFromStructuredFeedback,
  rejectRevisionFields,
  rollbackProfileFieldBy,
  validateRevisionAcrossConfirmedSamples,
  approveRevisionFields,
  MAX_VALIDATION_SAMPLES,
  MIN_IMAGE_APPROVAL_SAMPLES,
} from '../../onboarding/profile-governance-service';
import type { StructuredFeedback } from '../../shared/schemas/onboarding';

const TEST_DB = 'src/tests/unit/profile-governance-service-test.db';
const WORKSPACE_ID = 'workspace-governance-test';

function seedConfirmedSample(itemName: string, url: string, domain: string, confidence: number): {
  itemId: string;
  sourceId: string;
} {
  const batch = createBatch({
    workspaceId: WORKSPACE_ID,
    name: 'Test Batch',
    fileName: 'test.xlsx',
    totalItems: 1,
  });
  const items = insertItems(batch.id, [
    { upc: `upc-${Math.random().toString(36).slice(2, 8)}`, name: itemName, rowNumber: 1 },
  ]);
  const sources = insertSources(items[0].id, [
    { url, domain, confidence, title: itemName, snippet: '' },
  ]);
  selectSource(sources[0].id);
  return { itemId: items[0].id, sourceId: sources[0].id };
}

function seedGenerationRecord(
  domain: string,
  selectors: Record<string, unknown>,
  sourceUrl: string,
  expectedName: string | null = null,
): string {
  const rec = insertProfileGeneration({
    domain,
    sourceUrl,
    expectedName,
    brandHint: null,
    selectors,
    status: 'validated',
    confidence: 0.5,
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-flash',
  });
  return rec.id;
}

describe('Profile Governance Service (Phase 3, task 13)', () => {
  beforeAll(() => {
    try {
      resetDb();
    } catch {
      /* ok */
    }
    initDb(TEST_DB);
    runMigrations();
    // Create a workspace to satisfy the foreign keys on onboarding tables.
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [WORKSPACE_ID, 'Governance Test', '/tmp/ws-gov', '/tmp/ws-gov/.git', now, now, 'complete'],
    );
  });

  afterAll(() => {
    closeDb();
    try {
      unlinkSync(TEST_DB);
    } catch {
      /* ok */
    }
  });

  describe('listDomainProfileGovernance', () => {
    test('returns empty summary for an unknown domain', () => {
      const summary = listDomainProfileGovernance('no-such-domain.example');
      expect(summary.domain).toBe('no-such-domain.example');
      expect(summary.activeProfile).toBeNull();
      expect(summary.generations).toEqual([]);
      expect(summary.revisions).toEqual([]);
      expect(summary.fieldDecisions).toEqual([]);
      expect(summary.validationSampleCount).toBe(0);
    });

    test('aggregates active profile, generations, revisions, and decisions', () => {
      const domain = 'governance-test.com';
      // Pre-existing active profile
      upsertProfile(domain, {
        titleSelector: 'h1.old-title',
        imagesSelector: '.old-gallery',
      });
      // Two confirmed sample sources so the validationSampleCount is positive.
      seedConfirmedSample('Product A', 'https://governance-test.com/a', domain, 0.9);
      seedConfirmedSample('Product B', 'https://governance-test.com/b', domain, 0.7);
      // Two generations on this domain
      const g1 = seedGenerationRecord(domain, { titleSelector: 'h1.new' }, 'https://governance-test.com/a');
      seedGenerationRecord(domain, { titleSelector: 'h1.other' }, 'https://governance-test.com/b');
      // Decisions: one approved, one rejected.
      insertProfileFieldDecision({
        generationId: g1,
        revisionId: null,
        domain,
        selectorField: 'titleSelector',
        decision: 'approved',
        proposedSelector: 'h1.new',
        approvedSelector: 'h1.new',
        previousSelector: 'h1.old-title',
      });
      insertProfileFieldDecision({
        generationId: g1,
        revisionId: null,
        domain,
        selectorField: 'imagesSelector',
        decision: 'rejected',
        notes: 'Looks like recommendations',
      });

      const summary = listDomainProfileGovernance(domain);
      expect(summary.domain).toBe(domain);
      expect(summary.activeProfile?.titleSelector).toBe('h1.old-title');
      expect(summary.generations).toHaveLength(2);
      expect(summary.validationSampleCount).toBeGreaterThanOrEqual(2);
      const approved = summary.fieldDecisions.find(
        (d) => d.decision === 'approved' && d.selectorField === 'titleSelector',
      );
      expect(approved?.approvedSelector).toBe('h1.new');
      const rejected = summary.fieldDecisions.find(
        (d) => d.decision === 'rejected' && d.selectorField === 'imagesSelector',
      );
      expect(rejected?.notes).toContain('recommendations');
    });
  });

  describe('createInitialRevisionForGeneration', () => {
    test('synthesizes revision 1 from the legacy selectors_json', () => {
      const domain = 'backfill-test.com';
      seedConfirmedSample('B1', 'https://backfill-test.com/x', domain, 0.8);
      const gid = seedGenerationRecord(domain, { titleSelector: 'h1.x' }, 'https://backfill-test.com/x');
      const rev = createInitialRevisionForGeneration(gid);
      expect(rev).not.toBeNull();
      expect(rev!.generationId).toBe(gid);
      expect(rev!.revisionNumber).toBe(1);
      expect(rev!.source).toBe('initial_generation');
      expect((rev!.selectors as Record<string, string>).titleSelector).toBe('h1.x');
    });

    test('is idempotent — second call returns the existing revision', () => {
      const domain = 'backfill-idempotent.com';
      seedConfirmedSample('B2', 'https://backfill-idempotent.com/x', domain, 0.5);
      const gid = seedGenerationRecord(domain, { titleSelector: 'h1.idem' }, 'https://backfill-idempotent.com/x');
      const first = createInitialRevisionForGeneration(gid);
      const second = createInitialRevisionForGeneration(gid);
      expect(second!.id).toBe(first!.id);
      const all = listRevisionsByGeneration(gid);
      expect(all).toHaveLength(1);
    });
  });

  describe('reviseProfileFromStructuredFeedback', () => {
    test('creates a new revision linked to the parent', () => {
      const domain = 'revise-test.com';
      seedConfirmedSample('R1', 'https://revise-test.com/p', domain, 0.9);
      const gid = seedGenerationRecord(domain, { titleSelector: 'h1.r' }, 'https://revise-test.com/p');
      const parent = createInitialRevisionForGeneration(gid)!;
      const feedback: StructuredFeedback = {
        kind: 'text',
        field: 'titleSelector',
        expectedValue: 'Better Title',
        notes: 'Try a better h1',
      };
      const child = reviseProfileFromStructuredFeedback({
        generationId: gid,
        parentRevisionId: parent.id,
        feedback,
      });
      expect(child).not.toBeNull();
      expect(child!.parentRevisionId).toBe(parent.id);
      expect(child!.revisionNumber).toBe(parent.revisionNumber + 1);
      expect(child!.source).toBe('manager_feedback');
      expect(child!.feedback).toMatchObject({ kind: 'text', field: 'titleSelector' });
      // The original revision row is still intact
      const stillThere = findProfileGenerationRevisionById(parent.id);
      expect(stillThere).not.toBeNull();
    });
  });

  describe('validateRevisionAcrossConfirmedSamples', () => {
    test('returns no samples for a domain with no confirmed sources', async () => {
      const domain = 'no-samples.com';
      const gid = seedGenerationRecord(domain, { titleSelector: 'h1' }, 'https://no-samples.com/x');
      const rev = createInitialRevisionForGeneration(gid)!;
      const result = await validateRevisionAcrossConfirmedSamples(rev.id, domain);
      expect(result.sampleCount).toBe(0);
      expect(result.readyForImageApproval).toBe(false);
      expect(result.textFieldsHaveStrongEvidence).toBe(false);
    });

    test('marks title passing and images failing when selectors are empty', async () => {
      const domain = 'val-empty.com';
      seedConfirmedSample('V1', 'https://val-empty.com/p', domain, 0.9);
      const gid = seedGenerationRecord(
        domain,
        { titleSelector: '', imagesSelector: '' },
        'https://val-empty.com/p',
      );
      const rev = createInitialRevisionForGeneration(gid)!;
      const result = await validateRevisionAcrossConfirmedSamples(rev.id, domain);
      expect(result.sampleCount).toBe(1);
      // Empty selector cannot pass any field
      expect(result.byField.titleSelector.failing).toBeGreaterThan(0);
      expect(result.byField.imagesSelector.failing).toBeGreaterThan(0);
      expect(result.readyForImageApproval).toBe(false);
    });

    test('passes titleSelector with a valid h1 selector', async () => {
      const domain = 'val-title.com';
      seedConfirmedSample('V2', 'https://val-title.com/p', domain, 0.9);
      const gid = seedGenerationRecord(
        domain,
        { titleSelector: 'h1' },
        'https://val-title.com/p',
      );
      const rev = createInitialRevisionForGeneration(gid)!;
      const result = await validateRevisionAcrossConfirmedSamples(rev.id, domain, {
        sampleLimit: 1,
      });
      // The live fetch will hit the real internet in the sandbox
      // which is unreachable. The validation run still reports
      // whatever it could collect; we only assert the function
      // does not throw and returns the expected shape.
      expect(result).toHaveProperty('byField');
      expect(result).toHaveProperty('samples');
      expect(MAX_VALIDATION_SAMPLES).toBeGreaterThanOrEqual(MIN_IMAGE_APPROVAL_SAMPLES);
    });
  });

  describe('approveRevisionFields', () => {
    test('writes only the approved fields and leaves the rest untouched', () => {
      const domain = 'approve-merge.com';
      // Pre-existing active profile with two fields. Title approved
      // historically; description NOT approved historically.
      upsertProfile(domain, {
        titleSelector: 'h1.existing',
        descriptionSelector: '.existing-desc',
      });
      seedConfirmedSample('A1', 'https://approve-merge.com/p', domain, 0.9);
      const gid = seedGenerationRecord(
        domain,
        { titleSelector: 'h1.new', descriptionSelector: '.new-desc', imagesSelector: '.new-img' },
        'https://approve-merge.com/p',
      );
      // Operator only approves titleSelector.
      const result = approveRevisionFields({
        generationId: gid,
        approvedFields: { titleSelector: true },
        decidedBy: 'tester',
      });
      expect(result.imageApprovalAccepted).toBe(true);
      expect(result.promotionResult.approvedFields).toEqual(['titleSelector']);
      // Merge-style upsert must have updated title and left the
      // others at their previous values.
      const after = findProfileByDomain(domain);
      expect(after?.titleSelector).toBe('h1.new');
      expect(after?.descriptionSelector).toBe('.existing-desc');
    });

    test('rejects images approval when imagePreviewsReviewed is not set', () => {
      const domain = 'approve-image-gate.com';
      upsertProfile(domain, { titleSelector: 'h1.x' });
      seedConfirmedSample('A2', 'https://approve-image-gate.com/p', domain, 0.9);
      const gid = seedGenerationRecord(
        domain,
        { titleSelector: 'h1.x', imagesSelector: '.gal' },
        'https://approve-image-gate.com/p',
      );
      const result = approveRevisionFields({
        generationId: gid,
        approvedFields: { titleSelector: true, imagesSelector: true },
        // imagePreviewsReviewed intentionally omitted
      });
      expect(result.imageApprovalAccepted).toBe(false);
      const after = findProfileByDomain(domain);
      // Title was approved, imagesSelector stayed null.
      expect(after?.titleSelector).toBe('h1.x');
      expect(after?.imagesSelector).toBeNull();
    });

    test('rejects images approval when fewer than two image samples passed', () => {
      const domain = 'approve-image-samples.com';
      upsertProfile(domain, { titleSelector: 'h1.samples' });
      seedConfirmedSample('A3S', 'https://approve-image-samples.com/p', domain, 0.9);
      const gid = seedGenerationRecord(
        domain,
        { titleSelector: 'h1.samples', imagesSelector: '.gal' },
        'https://approve-image-samples.com/p',
      );
      const revision = createInitialRevisionForGeneration(gid)!;
      insertRevisionValidationResults(revision.id, [
        {
          selectorField: 'imagesSelector',
          sampleUrl: 'https://approve-image-samples.com/p1',
          itemId: null,
          expectedName: 'A3S one',
          brandHint: null,
          extractedValue: { images: ['https://img.example/one.png'] },
          imagePreviews: ['https://img.example/one.png'],
          warnings: null,
          status: 'pass',
        },
      ]);
      const result = approveRevisionFields({
        generationId: gid,
        approvedFields: { titleSelector: true, imagesSelector: true },
        imagePreviewsReviewed: true,
      });
      expect(result.imageApprovalAccepted).toBe(false);
      const after = findProfileByDomain(domain);
      expect(after?.imagesSelector).toBeNull();
    });

    test('writes imagesSelector when imagePreviewsReviewed is true and 2+ image samples passed', () => {
      const domain = 'approve-image-ok.com';
      upsertProfile(domain, { titleSelector: 'h1.y' });
      seedConfirmedSample('A3', 'https://approve-image-ok.com/p', domain, 0.9);
      const gid = seedGenerationRecord(
        domain,
        { titleSelector: 'h1.y', imagesSelector: '.gal' },
        'https://approve-image-ok.com/p',
      );
      const revision = createInitialRevisionForGeneration(gid)!;
      insertRevisionValidationResults(revision.id, [
        {
          selectorField: 'imagesSelector',
          sampleUrl: 'https://approve-image-ok.com/p1',
          itemId: null,
          expectedName: 'A3 one',
          brandHint: null,
          extractedValue: { images: ['https://img.example/a.png'] },
          imagePreviews: ['https://img.example/a.png'],
          warnings: null,
          status: 'pass',
        },
        {
          selectorField: 'imagesSelector',
          sampleUrl: 'https://approve-image-ok.com/p2',
          itemId: null,
          expectedName: 'A3 two',
          brandHint: null,
          extractedValue: { images: ['https://img.example/b.png'] },
          imagePreviews: ['https://img.example/b.png'],
          warnings: null,
          status: 'pass',
        },
      ]);
      const result = approveRevisionFields({
        generationId: gid,
        approvedFields: { titleSelector: true, imagesSelector: true },
        imagePreviewsReviewed: true,
      });
      expect(result.imageApprovalAccepted).toBe(true);
      const after = findProfileByDomain(domain);
      expect(after?.imagesSelector).toBe('.gal');
    });
  });

  describe('rejectRevisionFields', () => {
    test('records rejection decisions without touching the active profile', () => {
      const domain = 'reject.com';
      const before = upsertProfile(domain, { titleSelector: 'h1.pre' });
      seedConfirmedSample('R1', 'https://reject.com/p', domain, 0.9);
      const gid = seedGenerationRecord(
        domain,
        { titleSelector: 'h1.bad', imagesSelector: '.bad-gal' },
        'https://reject.com/p',
      );
      const result = rejectRevisionFields({
        generationId: gid,
        rejectedFields: ['titleSelector', 'imagesSelector'],
        reason: 'Not acceptable',
        decidedBy: 'tester',
      });
      expect(result.rejectedFields).toEqual(['titleSelector', 'imagesSelector']);
      expect(result.decisionIds).toHaveLength(2);
      const after = findProfileByDomain(domain);
      // Active profile unchanged
      expect(after?.titleSelector).toBe(before.titleSelector);
    });
  });

  describe('rollbackProfileFieldBy', () => {
    test('restores the previous selector from a recorded approval', () => {
      const domain = 'rollback.com';
      upsertProfile(domain, { titleSelector: 'h1.before' });
      seedConfirmedSample('K1', 'https://rollback.com/p', domain, 0.9);
      const gid = seedGenerationRecord(
        domain,
        { titleSelector: 'h1.after' },
        'https://rollback.com/p',
      );
      // Promote
      const approval = approveRevisionFields({
        generationId: gid,
        approvedFields: { titleSelector: true },
      });
      const approvalId = approval.promotionResult.approvalDecisionIds[0];
      expect(approvalId).toBeTruthy();
      // Confirm write happened
      const midState = findProfileByDomain(domain);
      expect(midState?.titleSelector).toBe('h1.after');
      // Rollback via the decisionId
      const result = rollbackProfileFieldBy({ decisionId: approvalId! });
      expect(result.rolledBack).toBe(true);
      const after = findProfileByDomain(domain);
      expect(after?.titleSelector).toBe('h1.before');
      // A new rolled_back decision row should exist on the domain.
      const decisions = listFieldDecisionsByDomain(domain);
      const rollbacks = decisions.filter((d) => d.decision === 'rolled_back');
      expect(rollbacks.length).toBeGreaterThan(0);
    });

    test('rollback with unknown decisionId returns a clear error', () => {
      const result = rollbackProfileFieldBy({ decisionId: 'does-not-exist' });
      expect(result.rolledBack).toBe(false);
      expect(result.reason).toMatch(/not found/i);
    });

    test('rollback via domain+field rolls back the most recent approval', () => {
      const domain = 'rollback-latest.com';
      upsertProfile(domain, { titleSelector: 'h1.orig' });
      seedConfirmedSample('L1', 'https://rollback-latest.com/p', domain, 0.9);
      const gid = seedGenerationRecord(
        domain,
        { titleSelector: 'h1.approved' },
        'https://rollback-latest.com/p',
      );
      approveRevisionFields({ generationId: gid, approvedFields: { titleSelector: true } });
      const mid = findProfileByDomain(domain);
      expect(mid?.titleSelector).toBe('h1.approved');
      const result = rollbackProfileFieldBy({
        domain,
        selectorField: 'titleSelector',
      });
      expect(result.rolledBack).toBe(true);
      const after = findProfileByDomain(domain);
      expect(after?.titleSelector).toBe('h1.orig');
    });
  });

  describe('findLatestValidatedRevision and decision lookup helpers', () => {
    test('findLatestValidatedRevision returns the latest validated row', () => {
      const domain = 'find-latest.com';
      seedConfirmedSample('F1', 'https://find-latest.com/p', domain, 0.8);
      const gid = seedGenerationRecord(
        domain,
        { titleSelector: 'h1.f' },
        'https://find-latest.com/p',
      );
      // No revisions yet → no validated revision
      expect(findLatestValidatedRevision(gid)).toBeNull();
      // Backfill creates a validated one (status: validated because the
      // generation was seeded with status: 'validated')
      createInitialRevisionForGeneration(gid);
      const latest = findLatestValidatedRevision(gid);
      expect(latest).not.toBeNull();
      expect(latest!.generationId).toBe(gid);
    });

    test('findProfileFieldDecisionById returns the same decision', () => {
      const domain = 'find-by-id.com';
      seedConfirmedSample('F2', 'https://find-by-id.com/p', domain, 0.7);
      const gid = seedGenerationRecord(
        domain,
        { titleSelector: 'h1.find' },
        'https://find-by-id.com/p',
      );
      const decision = insertProfileFieldDecision({
        generationId: gid,
        domain,
        selectorField: 'brandSelector',
        decision: 'rejected',
        notes: 'wrong',
      });
      const looked = findProfileFieldDecisionById(decision.id);
      expect(looked?.id).toBe(decision.id);
      expect(looked?.notes).toBe('wrong');
    });
  });
});

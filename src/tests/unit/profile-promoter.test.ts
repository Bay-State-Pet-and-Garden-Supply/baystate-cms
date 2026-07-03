/**
 * Unit tests for `src/onboarding/profile-promoter.ts`.
 *
 * These tests run under `bun test` (and are excluded from vitest via
 * `vitest.config.ts`) because the promoter is DB-dependent and vitest
 * cannot load `bun:sqlite`. The LLM client is NOT touched in this test
 * file because the promotion path never makes an LLM call — it only
 * reads existing generation rows.
 *
 * The promoter enforces a hard product invariant: AI-generated
 * profiles NEVER auto-promote. Every promotion requires a human-
 * supplied per-field approval object. These tests verify that
 * invariant and the per-field semantics.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import {
  insertProfileGeneration,
  findProfileGenerationById,
  listValidatedGenerationsByDomain,
} from '../../db/repositories/profile-generation-repo';
import {
  findProfileByDomain,
  upsertProfile,
} from '../../db/repositories/extractor-profile-repo';
import {
  listFieldDecisionsByGeneration,
  findLatestApprovedFieldDecision,
  findProfileFieldDecisionById,
} from '../../db/repositories/profile-generation-field-decision-repo';
import {
  promoteGeneratedProfile,
  rollbackProfileField,
  rollbackLatestApprovedField,
  SELECTOR_KEYS,
  type SelectorKey,
  type ApprovedSelectorFields,
} from '../../onboarding/profile-promoter';

describe('Profile Promoter (Task 17) — approval-required invariant', () => {
  const testDbPath = 'src/tests/unit/profile-promoter-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  // ─── invariant: no auto-promote symbol exists ──────────────────────

  test('promoter module does not export any auto-promote helper', async () => {
    const mod = await import('../../onboarding/profile-promoter');
    // The legacy auto-promote env-driven path has been removed.
    expect((mod as Record<string, unknown>).isAutoPromoteEnabled).toBeUndefined();
    expect((mod as Record<string, unknown>).MIN_AUTO_PROMOTE_CONFIDENCE).toBeUndefined();
    expect(typeof mod.promoteGeneratedProfile).toBe('function');
    expect(Array.isArray(mod.SELECTOR_KEYS)).toBe(true);
  });

  // ─── failure paths ────────────────────────────────────────────────

  describe('promoteGeneratedProfile: failure paths', () => {
    test('returns not-promoted for a missing generation id', () => {
      const result = promoteGeneratedProfile(
        '00000000-0000-0000-0000-000000000000',
        { titleSelector: true },
      );
      expect(result.promoted).toBe(false);
      expect(result.reason).toMatch(/not found/i);
      expect(result.domain).toBe('');
      // No generation row means no field decisions could be recorded
      // (the domain is unknown), so the response reports empty
      // approval IDs. The caller's intent is reflected in
      // approvedFields (just the one explicit `true` flag) and
      // rejectedFields (everything else).
      expect(result.approvedFields).toEqual([]);
      expect(new Set(result.rejectedFields)).toEqual(
        new Set(SELECTOR_KEYS),
      );
      expect(result.approvalDecisionIds).toEqual([]);
      expect(result.rejectionDecisionIds).toEqual([]);
    });

    test('rejects when no fields are approved (empty object) but leaves row promotable for retry', () => {
      const rec = insertProfileGeneration({
        domain: 'no-approval.com',
        sourceUrl: 'https://no-approval.com/p/1',
        selectors: {
          titleSelector: 'h1.product-title',
          priceSelector: '.product-price',
        },
        status: 'validated',
        confidence: 0.9,
      });
      const result = promoteGeneratedProfile(rec.id, {});
      expect(result.promoted).toBe(false);
      expect(result.reason).toMatch(/no selector fields were approved/i);
      expect(result.approvedFields).toEqual([]);
      // All five fields are reported as rejected.
      expect(new Set(result.rejectedFields)).toEqual(new Set(SELECTOR_KEYS));

      // The audit row's status is preserved as 'validated' so a
      // subsequent call with a real approval can still promote.
      const after = findProfileGenerationById(rec.id);
      expect(after?.status).toBe('validated');
      // errorMessage is NOT poisoned with the rejection reason
      // because this is an approval-flow rejection, not a structural
      // one.
      expect(after?.errorMessage).toBeNull();
      // No profile was created.
      expect(findProfileByDomain('no-approval.com')).toBeNull();
    });

    test('rejects when all approved flags are false', () => {
      const rec = insertProfileGeneration({
        domain: 'all-false.com',
        sourceUrl: 'https://all-false.com/p/1',
        selectors: { titleSelector: 'h1' },
        status: 'validated',
        confidence: 0.9,
      });
      const approval: ApprovedSelectorFields = {
        titleSelector: false,
        descriptionSelector: false,
        imagesSelector: false,
      };
      const result = promoteGeneratedProfile(rec.id, approval);
      expect(result.promoted).toBe(false);
      expect(result.reason).toMatch(/no selector fields were approved/i);
    });

    test('rejects a generation row that has no title selector', () => {
      const rec = insertProfileGeneration({
        domain: 'no-title.com',
        sourceUrl: 'https://no-title.com/p/1',
        selectors: {
          titleSelector: null,
          priceSelector: '.price',
        },
        status: 'validated',
        confidence: 0.9,
      });
      const result = promoteGeneratedProfile(rec.id, {
        titleSelector: true,
      });
      expect(result.promoted).toBe(false);
      expect(result.reason).toMatch(/no titleSelector/i);
      const after = findProfileGenerationById(rec.id);
      expect(after?.status).toBe('rejected');
      expect(findProfileByDomain('no-title.com')).toBeNull();
    });

    test('rejects a generation row whose status is "proposed"', () => {
      const rec = insertProfileGeneration({
        domain: 'proposed-only.com',
        sourceUrl: 'https://proposed-only.com/p/1',
        selectors: { titleSelector: 'h1' },
        status: 'proposed',
        confidence: 0.9,
      });
      const result = promoteGeneratedProfile(rec.id, { titleSelector: true });
      expect(result.promoted).toBe(false);
      expect(result.reason).toMatch(/never validated/i);
      const after = findProfileGenerationById(rec.id);
      expect(after?.status).toBe('rejected');
    });

    test('rejects a generation row whose status is "rejected"', () => {
      const rec = insertProfileGeneration({
        domain: 'rejected-prev.com',
        sourceUrl: 'https://rejected-prev.com/p/1',
        selectors: { titleSelector: 'h1' },
        status: 'rejected',
        confidence: 0.9,
      });
      const result = promoteGeneratedProfile(rec.id, { titleSelector: true });
      expect(result.promoted).toBe(false);
      expect(result.reason).toMatch(/status is rejected/i);
    });

    test('rejects a generation row whose status is "failed"', () => {
      const rec = insertProfileGeneration({
        domain: 'failed-prev.com',
        sourceUrl: 'https://failed-prev.com/p/1',
        selectors: { titleSelector: 'h1' },
        status: 'failed',
        confidence: 0,
        errorMessage: 'no LLM config',
      });
      const result = promoteGeneratedProfile(rec.id, { titleSelector: true });
      expect(result.promoted).toBe(false);
      expect(result.reason).toMatch(/status is failed/i);
    });
  });

  // ─── per-field approval: the core invariant ────────────────────────

  describe('per-field approval semantics', () => {
    const fullSelectors = {
      titleSelector: 'h1.product-title',
      priceSelector: '.product-price',
      descriptionSelector: '.product-description',
      brandSelector: '.product-brand',
      imagesSelector: '.product-gallery img',
    };

    test('only writes selectors that are explicitly approved; unapproved fields stay null', () => {
      const rec = insertProfileGeneration({
        domain: 'title-only-approval.com',
        sourceUrl: 'https://title-only-approval.com/p/1',
        selectors: fullSelectors,
        status: 'validated',
        confidence: 0.95,
      });

      const result = promoteGeneratedProfile(rec.id, { titleSelector: true });
      expect(result.promoted).toBe(true);
      expect(result.approvedFields).toEqual(['titleSelector']);
      // The other two fields are reported as rejected (not written).
      expect(new Set(result.rejectedFields)).toEqual(
        new Set(['descriptionSelector', 'imagesSelector']),
      );

      const profile = findProfileByDomain('title-only-approval.com');
      expect(profile).not.toBeNull();
      expect(profile?.titleSelector).toBe('h1.product-title');
      // The four unapproved selectors stay null (this is a brand-new row).
      expect(profile?.priceSelector).toBeNull();
      expect(profile?.descriptionSelector).toBeNull();
      expect(profile?.brandSelector).toBeNull();
      expect(profile?.imagesSelector).toBeNull();

      const after = findProfileGenerationById(rec.id);
      expect(after?.status).toBe('promoted');
      expect(after?.promotedAt).not.toBeNull();
    });

    test('approving title + description writes both; unapproved price/brand/images stay null', () => {
      const rec = insertProfileGeneration({
        domain: 'title-and-desc.com',
        sourceUrl: 'https://title-and-desc.com/p/1',
        selectors: fullSelectors,
        status: 'validated',
        confidence: 0.95,
      });

      const result = promoteGeneratedProfile(rec.id, {
        titleSelector: true,
        descriptionSelector: true,
      });
      expect(result.promoted).toBe(true);
      expect(new Set(result.approvedFields)).toEqual(
        new Set(['titleSelector', 'descriptionSelector']),
      );
      expect(new Set(result.rejectedFields)).toEqual(
        new Set(['imagesSelector']),
      );

      const profile = findProfileByDomain('title-and-desc.com');
      expect(profile?.titleSelector).toBe('h1.product-title');
      expect(profile?.descriptionSelector).toBe('.product-description');
      expect(profile?.priceSelector).toBeNull();
      expect(profile?.brandSelector).toBeNull();
      expect(profile?.imagesSelector).toBeNull();
    });

    test('imagesSelector is never written without an explicit true opt-in', () => {
      const rec = insertProfileGeneration({
        domain: 'images-require-optin.com',
        sourceUrl: 'https://images-require-optin.com/p/1',
        selectors: fullSelectors,
        status: 'validated',
        confidence: 0.99,
      });

      // High confidence, but only title is approved. Even with the
      // highest possible confidence, images must not be written.
      const result = promoteGeneratedProfile(rec.id, { titleSelector: true });
      expect(result.promoted).toBe(true);
      const profile = findProfileByDomain('images-require-optin.com');
      expect(profile?.titleSelector).toBe('h1.product-title');
      expect(profile?.imagesSelector).toBeNull();
    });

    test('imagesSelector is written only when explicitly approved', () => {
      const rec = insertProfileGeneration({
        domain: 'images-explicitly-approved.com',
        sourceUrl: 'https://images-explicitly-approved.com/p/1',
        selectors: fullSelectors,
        status: 'validated',
        confidence: 0.95,
      });

      const result = promoteGeneratedProfile(rec.id, {
        titleSelector: true,
        imagesSelector: true,
      });
      expect(result.promoted).toBe(true);
      expect(new Set(result.approvedFields)).toEqual(
        new Set(['titleSelector', 'imagesSelector']),
      );

      const profile = findProfileByDomain('images-explicitly-approved.com');
      expect(profile?.titleSelector).toBe('h1.product-title');
      expect(profile?.imagesSelector).toBe('.product-gallery img');
      // The other three are still null.
      expect(profile?.priceSelector).toBeNull();
      expect(profile?.descriptionSelector).toBeNull();
      expect(profile?.brandSelector).toBeNull();
    });

    test('preserves existing selectors via merge-style upsert (unapproved fields untouched)', () => {
      const domain = 'merge-with-approval.com';
      // Seed an existing profile with all selectors populated.
      upsertProfile(domain, {
        titleSelector: 'h1.old-title',
        priceSelector: '.old-price',
        descriptionSelector: '.old-desc',
        brandSelector: '.old-brand',
        imagesSelector: '.old-imgs',
      });

      const rec = insertProfileGeneration({
        domain,
        sourceUrl: 'https://merge-with-approval.com/p/1',
        selectors: fullSelectors,
        status: 'validated',
        confidence: 0.95,
      });

      // Operator approves only title. Everything else must stay put.
      const result = promoteGeneratedProfile(rec.id, { titleSelector: true });
      expect(result.promoted).toBe(true);

      const profile = findProfileByDomain(domain);
      expect(profile).not.toBeNull();
      expect(profile?.titleSelector).toBe('h1.product-title');
      // The four selectors that were not approved remain at their
      // previously-saved values. Nothing is cleared.
      expect(profile?.priceSelector).toBe('.old-price');
      expect(profile?.descriptionSelector).toBe('.old-desc');
      expect(profile?.brandSelector).toBe('.old-brand');
      expect(profile?.imagesSelector).toBe('.old-imgs');
    });

    test('approving description on a merge-row updates only the description', () => {
      const domain = 'merge-desc-only.com';
      upsertProfile(domain, {
        titleSelector: 'h1.old-title',
        priceSelector: '.old-price',
        descriptionSelector: '.old-desc',
        brandSelector: '.old-brand',
        imagesSelector: '.old-imgs',
      });

      const rec = insertProfileGeneration({
        domain,
        sourceUrl: 'https://merge-desc-only.com/p/1',
        selectors: fullSelectors,
        status: 'validated',
        confidence: 0.95,
      });

      // Approve only description. The merge behavior replaces the
      // description and leaves the other selectors at their existing
      // values. Title approval is NOT required to update description
      // (we only require approval for the fields the operator wants
      // to touch).
      const result = promoteGeneratedProfile(rec.id, {
        descriptionSelector: true,
      });
      expect(result.promoted).toBe(true);
      expect(result.approvedFields).toEqual(['descriptionSelector']);
      expect(new Set(result.rejectedFields)).toEqual(
        new Set(['titleSelector', 'imagesSelector']),
      );
      const profile = findProfileByDomain(domain);
      expect(profile?.titleSelector).toBe('h1.old-title');
      expect(profile?.descriptionSelector).toBe('.product-description');
      expect(profile?.priceSelector).toBe('.old-price');
      expect(profile?.brandSelector).toBe('.old-brand');
      expect(profile?.imagesSelector).toBe('.old-imgs');
    });

    test('a separate approval call can write title after an earlier one was rejected', () => {
      const rec = insertProfileGeneration({
        domain: 'second-call-approval.com',
        sourceUrl: 'https://second-call-approval.com/p/1',
        selectors: fullSelectors,
        status: 'validated',
        confidence: 0.9,
      });

      // First call: nothing approved.
      const first = promoteGeneratedProfile(rec.id, {});
      expect(first.promoted).toBe(false);
      expect(first.reason).toMatch(/no selector fields were approved/i);

      // Second call: title approved. Should succeed and write the row.
      const second = promoteGeneratedProfile(rec.id, { titleSelector: true });
      expect(second.promoted).toBe(true);

      const profile = findProfileByDomain('second-call-approval.com');
      expect(profile?.titleSelector).toBe('h1.product-title');
      expect(profile?.imagesSelector).toBeNull();
    });
  });

  // ─── audit trail ──────────────────────────────────────────────────

  describe('audit trail', () => {
    test('successful promotion appends approved decisions to the field_decisions table', () => {
      const rec = insertProfileGeneration({
        domain: 'audit-success.com',
        sourceUrl: 'https://audit-success.com/p/1',
        selectors: {
          titleSelector: 'h1',
          descriptionSelector: '.d',
        },
        status: 'validated',
        confidence: 0.9,
      });

      const result = promoteGeneratedProfile(rec.id, {
        titleSelector: true,
        descriptionSelector: true,
      });

      const after = findProfileGenerationById(rec.id);
      expect(after?.status).toBe('promoted');
      expect(after?.promotedAt).not.toBeNull();
      // Two approved decision rows: title and description.
      const decisions = listFieldDecisionsByGeneration(rec.id);
      const approvals = decisions.filter((d) => d.decision === 'approved');
      expect(approvals.length).toBe(2);
      const approvedFields = new Set(approvals.map((d) => d.selectorField));
      expect(approvedFields).toEqual(new Set(['titleSelector', 'descriptionSelector']));
      // One rejected decision row: the one field that the
      // operator did not approve.
      const rejections = decisions.filter((d) => d.decision === 'rejected');
      expect(rejections.length).toBe(1);
      // Each approval captures the previous active selector (null here)
      // and the proposed + approved selector.
      const titleDecision = approvals.find((d) => d.selectorField === 'titleSelector');
      expect(titleDecision?.proposedSelector).toBe('h1');
      expect(titleDecision?.approvedSelector).toBe('h1');
      expect(titleDecision?.previousSelector).toBeNull();
      // The result reports the new decision IDs so a UI can use them
      // for rollback or further review.
      expect(result.approvalDecisionIds.length).toBe(2);
      expect(result.rejectionDecisionIds.length).toBe(1);
    });

    test('approval-flow rejections record rejected decisions but keep row promotable', () => {
      const rec = insertProfileGeneration({
        domain: 'audit-rejected.com',
        sourceUrl: 'https://audit-rejected.com/p/1',
        selectors: { titleSelector: 'h1' },
        status: 'validated',
        confidence: 0.9,
      });

      // Empty approval → approval-flow rejection. The row is still
      // valid, only the operator's decision is missing.
      promoteGeneratedProfile(rec.id, {});

      const after = findProfileGenerationById(rec.id);
      // Status is preserved as 'validated' so the row can be retried.
      expect(after?.status).toBe('validated');
      expect(after?.errorMessage).toBeNull();
      // Three rejected decision rows (one per SELECTOR_KEYS entry).
      const decisions = listFieldDecisionsByGeneration(rec.id);
      expect(decisions.length).toBe(3);
      expect(decisions.every((d) => d.decision === 'rejected')).toBe(true);
      expect(decisions.every((d) => d.notes === 'No approval provided for this field')).toBe(true);
    });

    test('structural rejections (no titleSelector) DO flip the row to rejected', () => {
      const rec = insertProfileGeneration({
        domain: 'no-title-audit.com',
        sourceUrl: 'https://no-title-audit.com/p/1',
        selectors: {
          titleSelector: null,
          priceSelector: '.price',
        },
        status: 'validated',
        confidence: 0.9,
      });

      promoteGeneratedProfile(rec.id, { titleSelector: true });

      const after = findProfileGenerationById(rec.id);
      // Structural rejection: the generation itself is invalid.
      expect(after?.status).toBe('rejected');
      expect(after?.errorMessage).toMatch(/no titleSelector/i);
      // The rejected decision rows are still recorded for the audit
      // trail so a UI can show the operator what was attempted.
      const decisions = listFieldDecisionsByGeneration(rec.id);
      const rejections = decisions.filter((d) => d.decision === 'rejected');
      expect(rejections.length).toBeGreaterThan(0);
      expect(
        rejections.every((d) =>
          typeof d.notes === 'string' && d.notes.includes('titleSelector'),
        ),
      ).toBe(true);
    });

    test('does not duplicate-promote a row that is already promoted', () => {
      const rec = insertProfileGeneration({
        domain: 'already-promoted.com',
        sourceUrl: 'https://already-promoted.com/p/1',
        selectors: { titleSelector: 'h1.title' },
        status: 'validated',
        confidence: 0.9,
      });
      const first = promoteGeneratedProfile(rec.id, { titleSelector: true });
      expect(first.promoted).toBe(true);
      const second = promoteGeneratedProfile(rec.id, { titleSelector: true });
      expect(second.promoted).toBe(true);
      // The profile is still the same.
      const profile = findProfileByDomain('already-promoted.com');
      expect(profile?.titleSelector).toBe('h1.title');
    });
  });

  // ─── listValidatedGenerationsByDomain integration sanity check ─────

  test('listValidatedGenerationsByDomain returns rows used by the promoter', () => {
    const domain = 'list-validation.com';
    insertProfileGeneration({
      domain,
      sourceUrl: 'https://list-validation.com/a',
      selectors: { titleSelector: 'h1.a' },
      status: 'validated',
      confidence: 0.8,
    });
    insertProfileGeneration({
      domain,
      sourceUrl: 'https://list-validation.com/b',
      selectors: { titleSelector: 'h1.b' },
      status: 'rejected',
      confidence: 0.2,
    });
    insertProfileGeneration({
      domain,
      sourceUrl: 'https://list-validation.com/c',
      selectors: { titleSelector: 'h1.c' },
      status: 'validated',
      confidence: 0.85,
    });
    const list = listValidatedGenerationsByDomain(domain);
    expect(list.length).toBe(2);
    expect(list.every((r) => r.status === 'validated')).toBe(true);
  });

  // ─── SELECTOR_KEYS surface area ───────────────────────────────────

  test('SELECTOR_KEYS contains exactly the three active fields', () => {
    expect(new Set(SELECTOR_KEYS)).toEqual(
      new Set<SelectorKey>([
        'titleSelector',
        'descriptionSelector',
        'imagesSelector',
      ]),
    );
  });

  // ─── rollback ───────────────────────────────────────────────────────

  describe('rollback', () => {
    test('rollback restores the previous active selector and writes a rolled_back decision', () => {
      const domain = 'rollback-restore.com';
      // Seed an existing active profile with all five fields set.
      upsertProfile(domain, {
        titleSelector: 'h1.old-title',
        priceSelector: '.old-price',
        descriptionSelector: '.old-desc',
        brandSelector: '.old-brand',
        imagesSelector: '.old-imgs',
      });

      const rec = insertProfileGeneration({
        domain,
        sourceUrl: 'https://rollback-restore.com/p/1',
        selectors: {
          titleSelector: 'h1.new-title',
          descriptionSelector: '.new-desc',
        },
        status: 'validated',
        confidence: 0.95,
      });

      const promoteResult = promoteGeneratedProfile(rec.id, {
        titleSelector: true,
        descriptionSelector: true,
      });
      expect(promoteResult.promoted).toBe(true);
      // The active profile now has the new selectors merged over the
      // old ones (unapproved fields are preserved at their old values).
      const afterPromote = findProfileByDomain(domain);
      expect(afterPromote?.titleSelector).toBe('h1.new-title');
      expect(afterPromote?.descriptionSelector).toBe('.new-desc');
      expect(afterPromote?.priceSelector).toBe('.old-price');

      // Rollback the title decision.
      const titleDecisionId = promoteResult.approvalDecisionIds.find((id) => {
        const d = findProfileFieldDecisionById(id);
        return d?.selectorField === 'titleSelector';
      });
      expect(titleDecisionId).toBeDefined();
      const rollback = rollbackProfileField(titleDecisionId!);
      expect(rollback.rolledBack).toBe(true);
      expect(rollback.restoredSelector).toBe('h1.old-title');
      expect(rollback.domain).toBe(domain);
      expect(rollback.selectorField).toBe('titleSelector');

      // The active profile has the old title restored.
      const afterRollback = findProfileByDomain(domain);
      expect(afterRollback?.titleSelector).toBe('h1.old-title');
      // Other fields are untouched.
      expect(afterRollback?.descriptionSelector).toBe('.new-desc');
      expect(afterRollback?.priceSelector).toBe('.old-price');

      // A rolled_back decision row was appended.
      const decisions = listFieldDecisionsByGeneration(rec.id);
      const rolledBack = decisions.filter((d) => d.decision === 'rolled_back');
      expect(rolledBack.length).toBe(1);
      expect(rolledBack[0].selectorField).toBe('titleSelector');
      expect(rolledBack[0].previousSelector).toBe('h1.new-title');
      expect(rolledBack[0].notes).toContain(titleDecisionId!);
    });

    test('rollback clears a selector when the field had no prior active value', () => {
      const domain = 'rollback-no-prev.com';
      const rec = insertProfileGeneration({
        domain,
        sourceUrl: 'https://rollback-no-prev.com/p/1',
        selectors: { titleSelector: 'h1.first' },
        status: 'validated',
        confidence: 0.9,
      });
      const result = promoteGeneratedProfile(rec.id, { titleSelector: true });
      expect(result.promoted).toBe(true);
      expect(findProfileByDomain(domain)?.titleSelector).toBe('h1.first');

      const decisionId = result.approvalDecisionIds[0];
      const rollback = rollbackProfileField(decisionId);
      expect(rollback.rolledBack).toBe(true);
      expect(rollback.restoredSelector).toBeNull();
      expect(findProfileByDomain(domain)?.titleSelector).toBeNull();
    });

    test('rollback is rejected for non-approval decisions', () => {
      const domain = 'rollback-non-approval.com';
      const rec = insertProfileGeneration({
        domain,
        sourceUrl: 'https://rollback-non-approval.com/p/1',
        selectors: { titleSelector: 'h1' },
        status: 'validated',
        confidence: 0.9,
      });
      // Empty approval → 5 rejected decision rows, none of which are
      // approvable.
      const result = promoteGeneratedProfile(rec.id, {});
      expect(result.promoted).toBe(false);
      const rejectionId = result.rejectionDecisionIds[0];
      const rollback = rollbackProfileField(rejectionId);
      expect(rollback.rolledBack).toBe(false);
      expect(rollback.reason).toMatch(/not an approval/i);
    });

    test('rollback of an unknown decision id is rejected', () => {
      const rollback = rollbackProfileField('00000000-0000-0000-0000-000000000000');
      expect(rollback.rolledBack).toBe(false);
      expect(rollback.reason).toMatch(/not found/i);
    });

    test('rollbackLatestApprovedField finds and rolls back the most recent approved decision', () => {
      const domain = 'rollback-latest.com';
      upsertProfile(domain, { titleSelector: 'h1.original' });
      const rec = insertProfileGeneration({
        domain,
        sourceUrl: 'https://rollback-latest.com/p/1',
        selectors: { titleSelector: 'h1.first-revision' },
        status: 'validated',
        confidence: 0.9,
      });
      const first = promoteGeneratedProfile(rec.id, { titleSelector: true });
      expect(first.promoted).toBe(true);

      // Rollback the most recent approved decision by domain+field.
      const rollback = rollbackLatestApprovedField(domain, 'titleSelector');
      expect(rollback.rolledBack).toBe(true);
      expect(rollback.restoredSelector).toBe('h1.original');
      expect(findProfileByDomain(domain)?.titleSelector).toBe('h1.original');

      // A subsequent call finds no approved decision to roll back.
      const second = rollbackLatestApprovedField(domain, 'titleSelector');
      expect(second.rolledBack).toBe(false);
      expect(second.reason).toMatch(/no approved decision/i);
    });

    test('rollback preserves unrelated fields via merge-style upsert', () => {
      const domain = 'rollback-merge.com';
      upsertProfile(domain, {
        titleSelector: 'h1.original',
        descriptionSelector: '.original-desc',
        priceSelector: '.original-price',
      });
      const rec = insertProfileGeneration({
        domain,
        sourceUrl: 'https://rollback-merge.com/p/1',
        selectors: {
          titleSelector: 'h1.new',
          descriptionSelector: '.new-desc',
        },
        status: 'validated',
        confidence: 0.9,
      });
      const result = promoteGeneratedProfile(rec.id, {
        titleSelector: true,
        descriptionSelector: true,
      });
      expect(result.promoted).toBe(true);

      // Rollback just the title.
      const titleDecisionId = result.approvalDecisionIds.find((id) => {
        const d = findProfileFieldDecisionById(id);
        return d?.selectorField === 'titleSelector';
      });
      rollbackProfileField(titleDecisionId!);

      const after = findProfileByDomain(domain);
      expect(after?.titleSelector).toBe('h1.original');
      // Description was approved and is NOT rolled back.
      expect(after?.descriptionSelector).toBe('.new-desc');
      // Price was never touched.
      expect(after?.priceSelector).toBe('.original-price');
    });
  });
});

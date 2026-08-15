/**
 * Unit tests for governed domain profile proposal trigger (Phase 3).
 * Tests deduplication against approved profiles, open proposals, and 24h cooldown.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { upsertProfile } from '../../db/repositories/extractor-profile-repo';
import { insertProfileGeneration } from '../../db/repositories/profile-generation-repo';
import { requestDomainProfileProposal } from '../../onboarding/profile-governance-service';

describe('Governed Domain Profile Proposal Trigger (Phase 3)', () => {
  const testDbPath = 'src/tests/unit/pi-governed-proposal-trigger-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('skips proposal creation when an approved profile already exists', () => {
    upsertProfile('has-profile.com', {
      titleSelector: 'h1',
    });

    const res = requestDomainProfileProposal('has-profile.com', {
      sourceUrl: 'https://has-profile.com/prod/1',
      expectedName: 'Some Product',
    });
    expect(res.created).toBe(false);
    expect(res.reason).toBe('profile_already_exists');
  });

  it('creates a new proposal when no profile or active proposal exists', () => {
    const res = requestDomainProfileProposal('new-brand.com', {
      sourceUrl: 'https://new-brand.com/prod/1',
      expectedName: 'New Brand Product',
      brandHint: 'New Brand',
    });
    expect(res.created).toBe(true);
    expect(res.generationId).toBeDefined();
  });

  it('deduplicates against open proposals for the same domain', () => {
    // First request creates
    const res1 = requestDomainProfileProposal('same-domain.com', {
      sourceUrl: 'https://same-domain.com/p/1',
    });
    expect(res1.created).toBe(true);

    // Second request skips due to open proposal
    const res2 = requestDomainProfileProposal('same-domain.com', {
      sourceUrl: 'https://same-domain.com/p/2',
    });
    expect(res2.created).toBe(false);
    expect(res2.reason).toBe('open_proposal_exists');
  });

  it('enforces 24h cooldown if a previous proposal attempt was recent', () => {
    // Seed a rejected/failed proposal created 1 hour ago
    insertProfileGeneration({
      domain: 'cooldown.com',
      sourceUrl: 'https://cooldown.com/p/1',
      selectors: {},
      status: 'failed',
      errorMessage: 'Failed to extract',
    });

    const res = requestDomainProfileProposal('cooldown.com', {
      sourceUrl: 'https://cooldown.com/p/1',
    });
    expect(res.created).toBe(false);
    expect(res.reason).toBe('cooldown_active');
  });
});

/**
 * Extractor-profile domain blockers (epic #46 follow-up, GPT plan phase 5).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { upsertProfile } from '../../db/repositories/extractor-profile-repo';
import { getExtractorProfileDomainBlockers } from '../../onboarding/extraction/profile-blockers';

describe('extractor-profile domain blockers (phase 5)', () => {
  let tempDir: string;
  let workspaceId: string;
  let batchId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-blockers-test-'));
    initDb(path.join(tempDir, 'test.db'));
    runMigrations();
    workspaceId = 'ws-blockers';
    insertWorkspace({
      id: workspaceId,
      name: 'W',
      workspacePath: tempDir,
      gitPath: tempDir + '/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    batchId = createBatch({ workspaceId, name: 'B', fileName: 'b.csv', totalItems: 8 }).id;
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function failExtraction(upc: string, name: string, errorMessage: string): string {
    const [item] = insertItems(batchId, [{ upc, name, rowNumber: 1, stage: 'extraction' }], 'extraction', 1);
    const domainMatch = /No extractor profile for (\S+)/.exec(errorMessage);
    getDb().query(
      "UPDATE onboarding_items SET stage_status = 'failed', error_message = ?, source_url = ? WHERE id = ?",
    ).run(errorMessage, domainMatch ? `https://${domainMatch[1]}/product/p` : null, item.id);
    return item.id;
  }

  test('groups missing-profile failures by domain, sorted by blocked count', () => {
    const fromm1 = failExtraction('1001', 'Fromm A', 'No extractor profile for frommfamily.com — profile required');
    const fromm2 = failExtraction('1002', 'Fromm B', 'No extractor profile for frommfamily.com — profile required');
    const fromm3 = failExtraction('1003', 'Fromm C', 'No extractor profile for frommfamily.com — profile required');
    failExtraction('1004', 'Primal A', 'No extractor profile for primalpetfoods.com — profile required');

    const blockers = getExtractorProfileDomainBlockers(batchId);
    expect(blockers.length).toBe(2);
    expect(blockers[0].domain).toBe('frommfamily.com');
    expect(blockers[0].blockedItemCount).toBe(3);
    expect(blockers[0].itemIds.sort()).toEqual([fromm1, fromm2, fromm3].sort());
    expect(blockers[0].sampleItems.length).toBe(3);
    expect(blockers[0].sampleItems[0].name).toBe('Fromm A');
    expect(blockers[1].domain).toBe('primalpetfoods.com');
    expect(blockers[1].blockedItemCount).toBe(1);
  });

  test('excludes failures NOT caused by a missing profile', () => {
    failExtraction('2001', 'HTTP Item', 'Extraction failed: HTTP 500 from upstream');
    failExtraction('2002', 'Parse Item', 'Extraction failed: no product data found');
    expect(getExtractorProfileDomainBlockers(batchId)).toEqual([]);
  });

  test('marks profileExists when an extractor profile is on file', () => {
    failExtraction('3001', 'Covered A', 'No extractor profile for covered.com — profile required');
    expect(getExtractorProfileDomainBlockers(batchId)[0].profileExists).toBe(false);

    upsertProfile('covered.com', { titleSelector: 'h1' });
    const withProfile = getExtractorProfileDomainBlockers(batchId);
    expect(withProfile[0].profileExists).toBe(true);
  });

  test('domains are case/whitespace normalized and listed even with a profile present', () => {
    failExtraction('4001', 'Mixed A', 'No extractor profile for  FrommFamily.COM  — profile required');
    const blockers = getExtractorProfileDomainBlockers(batchId);
    expect(blockers.length).toBe(1);
    expect(blockers[0].domain).toBe('frommfamily.com');
  });
});

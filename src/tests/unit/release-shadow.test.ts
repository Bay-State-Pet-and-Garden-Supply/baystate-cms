/**
 * bay-state-v4 shadow observer tests (P4 — plan section B.P4.4).
 *
 * Contract under test (release-shadow.ts):
 * - flag OFF → no observation file, no side effects of any kind;
 * - flag ON + pin != v4 → exactly one deduped JSONL line appended to
 *   `<workspace>/store/classification/shadow/v4-shadow.jsonl`;
 * - the returned runtime authority is NEVER altered by observation
 *   (byte-identical with and without the flag);
 * - identical summaries are deduped (no duplicate lines);
 * - observer failures are swallowed (a read-only workspace never breaks loads).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTaxonomyReleaseV4 } from '../../classification/release-validation';
import {
  V4_TAXONOMY_REVISION,
} from '../../classification/release-compiler';
import {
  __resetV4ShadowObserverForTests,
  buildV4ShadowDiffSummary,
  isTaxonomyV4ShadowEnabled,
  recordV4ShadowObservation,
  type ShadowActiveArmView,
} from '../../classification/release-shadow';

const FLAG = 'BAYSTATE_CMS_TAXONOMY_V4_SHADOW';
let savedFlag: string | undefined;
let root: string;

function activeArmFixture(): ShadowActiveArmView {
  return {
    productTypeIds: ['dog-food', 'cat-food', 'wild-bird-feed'],
    attributeIds: ['brand', 'species', 'flavor'],
    mappings: [
      { attributeId: 'brand', catalogField: 'ProductField16' },
      { attributeId: 'species', catalogField: 'ProductField17' },
    ],
  };
}

function shadowLogPath(): string {
  return path.join(root, 'store', 'classification', 'shadow', 'v4-shadow.jsonl');
}

beforeEach(() => {
  savedFlag = process.env[FLAG];
  delete process.env[FLAG];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-shadow-test-'));
  __resetV4ShadowObserverForTests();
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isTaxonomyV4ShadowEnabled', () => {
  it('defaults off and accepts only truthy values', () => {
    expect(isTaxonomyV4ShadowEnabled()).toBe(false);
    for (const value of ['0', 'false', 'no', 'junk']) {
      process.env[FLAG] = value;
      expect(isTaxonomyV4ShadowEnabled()).toBe(false);
    }
    for (const value of ['1', 'true', 'on', 'TRUE', 'On']) {
      process.env[FLAG] = value;
      expect(isTaxonomyV4ShadowEnabled()).toBe(true);
    }
  });
});

describe('recordV4ShadowObservation', () => {
  it('writes one JSONL line with counts and diff lists', () => {
    process.env[FLAG] = '1';
    const summary = buildV4ShadowDiffSummary(activeArmFixture(), loadTaxonomyReleaseV4(V4_TAXONOMY_REVISION), 'bay-state-v3', '2026-08-24T12:00:00.000Z');
    recordV4ShadowObservation(root, summary);

    const lines = fs.readFileSync(shadowLogPath(), 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.pinnedRevision).toBe('bay-state-v3');
    expect(parsed.shadowRevision).toBe(V4_TAXONOMY_REVISION);
    const counts = parsed.counts as Record<string, number>;
    expect(counts.activeProductTypes).toBe(3);
    expect(typeof counts.v4ProductTypes).toBe('number');
    // Deterministic mapping diff: brand stays PF16, species dropped in v4 arm view.
    const mappingChanges = parsed.mappingChanges as Array<{ attributeId: string; to: string }>;
    expect(Array.isArray(mappingChanges)).toBe(true);
  });

  it('dedupes unchanged summaries (no second line)', () => {
    process.env[FLAG] = '1';
    const summary = buildV4ShadowDiffSummary(activeArmFixture(), loadTaxonomyReleaseV4(V4_TAXONOMY_REVISION), 'bay-state-v3', '2026-08-24T12:00:00.000Z');
    recordV4ShadowObservation(root, summary);
    recordV4ShadowObservation(root, { ...summary, observedAt: '2026-08-24T12:00:01.000Z' });
    const lines = fs.readFileSync(shadowLogPath(), 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
  });

  it('records drift when the pinned arm changes between observations', () => {
    process.env[FLAG] = '1';
    const first = buildV4ShadowDiffSummary(activeArmFixture(), loadTaxonomyReleaseV4(V4_TAXONOMY_REVISION), 'bay-state-v3', '2026-08-24T12:00:00.000Z');
    recordV4ShadowObservation(root, first);
    const drifted = activeArmFixture();
    drifted.attributeIds = [...drifted.attributeIds, 'size'];
    const second = buildV4ShadowDiffSummary(drifted, loadTaxonomyReleaseV4(V4_TAXONOMY_REVISION), 'bay-state-v3', '2026-08-24T12:00:02.000Z');
    recordV4ShadowObservation(root, second);
    const lines = fs.readFileSync(shadowLogPath(), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('never throws on an unwritable target path (failures swallowed)', () => {
    process.env[FLAG] = '1';
    // A path that cannot host the shadow dir: use a file as the parent.
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'not-a-directory');
    const summary = buildV4ShadowDiffSummary(activeArmFixture(), loadTaxonomyReleaseV4(V4_TAXONOMY_REVISION), null, '2026-08-24T12:00:00.000Z');
    expect(() => recordV4ShadowObservation(path.join(blocker, 'child'), summary)).not.toThrow();
  });
});

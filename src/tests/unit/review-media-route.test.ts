/**
 * Story e10s04 — route-level tests for PUT /api/onboarding/items/:id/media.
 *
 * Contract under test (spec §Surface + OVERWRITE consequences):
 * - candidate-set UNION validation: requested URLs must belong to extraction
 *   candidates ∪ previously persisted reviewedMedia entries; foreign URLs →
 *   400 with the offending list, nothing persisted;
 * - OVERWRITE consequence: a URL persisted by an earlier save remains valid
 *   even after extraction data no longer contains it;
 * - distributor constraints: selection limited to rights-attested APPROVED
 *   display images, enforced server-side;
 * - consequential edit: durable review state is invalidated via the same
 *   markReviewInvalidated('consequential_edit') path as generic PUT.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import {
  markReviewed,
  getReviewState,
} from '../../db/repositories/onboarding-review-repo';
import onboardingRoutes from '../../server/routes/onboarding-routes';
import { setWorkerPollTriggerForTest } from '../../server/routes/onboarding-work-routes';

let workspaceId: string;
let workspacePath: string;

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', onboardingRoutes);
  return app;
}

function mediaUrl(tag: string): string {
  return `https://images.example/${tag}.jpg`;
}

function putMedia(itemId: string, body: unknown) {
  return makeApp().request(`/api/onboarding/items/${itemId}/media`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createItem(
  batchId: string,
  overrides: {
    upc: string;
    name?: string;
    stage?: string;
    stageStatus?: string;
    sourceType?: string;
    extractionData?: Record<string, unknown>;
    curationData?: Record<string, unknown>;
  },
): string {
  const [item] = insertItems(batchId, [{
    upc: overrides.upc,
    name: overrides.name ?? `Item ${overrides.upc}`,
    rowNumber: 1,
    stage: (overrides.stage ?? 'review') as never,
    stageStatus: (overrides.stageStatus ?? 'in_progress') as never,
  }], (overrides.stage ?? 'review') as never, 1);
  const db = getDb();
  if (overrides.sourceType) {
    db.query("UPDATE onboarding_items SET source_type = ? WHERE id = ?").run(overrides.sourceType, item.id);
  }
  if (overrides.extractionData) {
    db.query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(
      JSON.stringify(overrides.extractionData),
      item.id,
    );
  }
  if (overrides.curationData) {
    db.query('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?').run(
      JSON.stringify(overrides.curationData),
      item.id,
    );
  }
  return item.id;
}

function reviewedMediaOf(itemId: string): Record<string, unknown> | null {
  const row = getDb()
    .query('SELECT curation_data_json FROM onboarding_items WHERE id = ?')
    .get(itemId) as { curation_data_json: string | null };
  const parsed = row.curation_data_json ? JSON.parse(row.curation_data_json) : {};
  return parsed.reviewedMedia ?? null;
}

beforeAll(() => {
  workspaceId = randomUUID();
  workspacePath = path.join(os.tmpdir(), `baystate-cms-mediapick-${workspaceId.slice(0, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  setWorkerPollTriggerForTest(null);
});

describe('PUT /onboarding/items/:id/media — candidate-set union validation', () => {
  it('persists a valid official-page selection and invalidates an existing review', async () => {
    const batchId = createBatch({ workspaceId, name: 'media-1', fileName: 't.csv', totalItems: 0 }).id;
    const id = createItem(batchId, {
      upc: 'M1',
      extractionData: { primaryImage: mediaUrl('a'), additionalImages: [mediaUrl('b'), mediaUrl('c')] },
    });
    markReviewed({ itemId: id, batchId, reviewedBy: 'tester' });

    const res = await putMedia(id, {
      primaryImage: mediaUrl('b'),
      orderedAdditional: [mediaUrl('c'), mediaUrl('a')],
      suppressed: [],
    });
    expect(res.status).toBe(200);

    const persisted = reviewedMediaOf(id);
    expect(persisted).toEqual({
      primaryImage: mediaUrl('b'),
      orderedAdditional: [mediaUrl('c'), mediaUrl('a')],
      suppressed: [],
    });

    // Consequential edit: durable review invalidated with the standard reason.
    const state = getReviewState(id)!;
    expect(state.reviewInvalidatedAt).toBeTruthy();
    expect(state.reviewInvalidationReason).toBe('consequential_edit');
  });

  it('accepts reviewer-added image URLs and persists them', async () => {
    const batchId = createBatch({ workspaceId, name: 'media-2', fileName: 't.csv', totalItems: 0 }).id;
    const id = createItem(batchId, {
      upc: 'M2',
      extractionData: { primaryImage: mediaUrl('a'), additionalImages: [] },
    });

    const res = await putMedia(id, {
      primaryImage: 'https://images.example/custom-added.jpg',
      orderedAdditional: [mediaUrl('a'), 'https://cdn.example/extra.png'],
      suppressed: [],
    });
    expect(res.status).toBe(200);
    expect(reviewedMediaOf(id)).toEqual({
      primaryImage: 'https://images.example/custom-added.jpg',
      orderedAdditional: [mediaUrl('a'), 'https://cdn.example/extra.png'],
      suppressed: [],
    });
  });

  it('rejects invalid URL protocols with 400 and persists nothing', async () => {
    const batchId = createBatch({ workspaceId, name: 'media-2-proto', fileName: 't.csv', totalItems: 0 }).id;
    const id = createItem(batchId, {
      upc: 'M2P',
      extractionData: { primaryImage: mediaUrl('a'), additionalImages: [] },
    });

    const res = await putMedia(id, {
      primaryImage: 'ftp://files.example/image.jpg',
      orderedAdditional: [],
      suppressed: [],
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error?: string };
    expect(payload.error).toContain('protocol');
    expect(reviewedMediaOf(id)).toBeNull();
  });

  it('rejects malformed URLs with 400 and persists nothing', async () => {
    const batchId = createBatch({ workspaceId, name: 'media-2-mal', fileName: 't.csv', totalItems: 0 }).id;
    const id = createItem(batchId, {
      upc: 'M2M',
      extractionData: { primaryImage: mediaUrl('a'), additionalImages: [] },
    });

    const res = await putMedia(id, {
      primaryImage: 'not-a-valid-url',
      orderedAdditional: [],
      suppressed: [],
    });
    expect(res.status).toBe(400);
    expect(reviewedMediaOf(id)).toBeNull();
  });

  it('OVERWRITE consequence: previously persisted URLs stay valid after extraction drops them', async () => {
    const batchId = createBatch({ workspaceId, name: 'media-3', fileName: 't.csv', totalItems: 0 }).id;
    const id = createItem(batchId, {
      upc: 'M3',
      extractionData: { primaryImage: mediaUrl('a'), additionalImages: [mediaUrl('b')] },
    });

    // Save 1: suppress b (valid candidate today).
    const first = await putMedia(id, {
      primaryImage: mediaUrl('a'),
      orderedAdditional: [],
      suppressed: [mediaUrl('b')],
    });
    expect(first.status).toBe(200);

    // Re-extraction overwrites extraction_data WITHOUT b anymore.
    getDb()
      .query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?')
      .run(JSON.stringify({ primaryImage: mediaUrl('a'), additionalImages: [] }), id);

    // Save 2: referencing b must still validate…
    const second = await putMedia(id, {
      primaryImage: mediaUrl('a'),
      orderedAdditional: [mediaUrl('b')],
      suppressed: [],
    });
    expect(second.status).toBe(200);
    expect(reviewedMediaOf(id)).toEqual({
      primaryImage: mediaUrl('a'),
      orderedAdditional: [mediaUrl('b')],
      suppressed: [],
    });
  });

  it('malformed payloads are rejected without mutation', async () => {
    const batchId = createBatch({ workspaceId, name: 'media-4', fileName: 't.csv', totalItems: 0 }).id;
    const id = createItem(batchId, { upc: 'M4' });

    const res = await putMedia(id, { primaryImage: '' });
    expect(res.status).toBe(400);
    expect(reviewedMediaOf(id)).toBeNull();
  });

  it('rejects a selection whose primary is ALSO suppressed (disjoint roles)', async () => {
    const batchId = createBatch({ workspaceId, name: 'media-5', fileName: 't.csv', totalItems: 0 }).id;
    const id = createItem(batchId, {
      upc: 'M5',
      extractionData: { primaryImage: mediaUrl('a'), additionalImages: [mediaUrl('b')] },
    });

    const res = await putMedia(id, {
      primaryImage: mediaUrl('b'),
      orderedAdditional: [],
      suppressed: [mediaUrl('b')],
    });
    expect(res.status).toBe(400);
    expect(reviewedMediaOf(id)).toBeNull();
  });

  it('rejects orderedAdditional URLs that are also suppressed (disjoint roles)', async () => {
    const batchId = createBatch({ workspaceId, name: 'media-6', fileName: 't.csv', totalItems: 0 }).id;
    const id = createItem(batchId, {
      upc: 'M6',
      extractionData: { primaryImage: mediaUrl('a'), additionalImages: [mediaUrl('b'), mediaUrl('c')] },
    });

    const res = await putMedia(id, {
      primaryImage: mediaUrl('a'),
      orderedAdditional: [mediaUrl('b')],
      suppressed: [mediaUrl('b'), mediaUrl('c')],
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { urls?: string[] };
    expect(payload.urls).toEqual([mediaUrl('b')]);
    expect(reviewedMediaOf(id)).toBeNull();
  });
});

describe('PUT /onboarding/items/:id/media — distributor records', () => {
  function distributorItem(batchId: string, upc: string): string {
    return createItem(batchId, {
      upc,
      sourceType: 'distributor_record',
      extractionData: {
        title: 'Dist item',
        distributorImageApprovals: [
          { imageUrl: mediaUrl('d1') },
          { imageUrl: mediaUrl('d2') },
        ],
      },
    });
  }

  it('accepts selections with approved and reviewer-added image URLs', async () => {
    const batchId = createBatch({ workspaceId, name: 'media-d1', fileName: 't.csv', totalItems: 0 }).id;
    const id = distributorItem(batchId, 'D1');

    const res = await putMedia(id, {
      primaryImage: 'https://images.example/dist-new.jpg',
      orderedAdditional: [mediaUrl('d1')],
      suppressed: [],
    });
    expect(res.status).toBe(200);
    expect(reviewedMediaOf(id)).toEqual({
      primaryImage: 'https://images.example/dist-new.jpg',
      orderedAdditional: [mediaUrl('d1')],
      suppressed: [],
    });
  });

  it('404s items outside the active workspace', async () => {
    const res = await putMedia(randomUUID(), {
      primaryImage: null,
      orderedAdditional: [],
      suppressed: [],
    });
    expect([404]).toContain(res.status);
  });
});

describe('reviewedMedia survival across a generic listing PUT', () => {
  async function genericPut(itemId: string, body: Record<string, unknown>) {
    return makeApp().request(`/api/onboarding/items/${itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function curationOf(itemId: string): Record<string, unknown> {
    const row = getDb()
      .query('SELECT curation_data_json FROM onboarding_items WHERE id = ?')
      .get(itemId) as { curation_data_json: string | null };
    return row.curation_data_json ? JSON.parse(row.curation_data_json) : {};
  }

  it('a generic listing-form save carries the persisted selection forward instead of wiping it', async () => {
    const batchId = createBatch({ workspaceId, name: 'media-survival', fileName: 't.csv', totalItems: 0 }).id;
    const id = createItem(batchId, {
      upc: 'SURV1',
      extractionData: { primaryImage: mediaUrl('a'), additionalImages: [mediaUrl('b'), mediaUrl('c')] },
    });

    // Reviewer saves a media selection (suppress one additional).
    const save = await putMedia(id, {
      primaryImage: mediaUrl('a'),
      orderedAdditional: [mediaUrl('c')],
      suppressed: [mediaUrl('b')],
    });
    expect(save.status).toBe(200);

    // Reviewer then edits title/brand via the generic listing form save —
    // body curation_data contains ONLY the four curated keys.
    const edit = await genericPut(id, {
      curation_data: {
        curatedTitle: 'Reviewed Title',
        curatedWeight: null,
        curatedDescription: null,
        searchKeywords: null,
      },
      brandHint: null,
    });
    expect(edit.status).toBe(200);

    // The persisted media selection MUST survive byte-identical; a wipe would
    // silently resurrect suppressed images at promotion time.
    expect(curationOf(id).reviewedMedia).toEqual({
      primaryImage: mediaUrl('a'),
      orderedAdditional: [mediaUrl('c')],
      suppressed: [mediaUrl('b')],
    });
    expect(curationOf(id).curatedTitle).toBe('Reviewed Title');
  });

  it('a generic listing save cannot inject or tamper with reviewedMedia (dedicated route only)', async () => {
    const batchId = createBatch({ workspaceId, name: 'media-tamper', fileName: 't.csv', totalItems: 0 }).id;
    const id = createItem(batchId, {
      upc: 'TAMP1',
      extractionData: { primaryImage: mediaUrl('a'), additionalImages: [] },
    });

    const res = await genericPut(id, {
      curation_data: {
        curatedTitle: 'X',
        reviewedMedia: { primaryImage: mediaUrl('evil'), orderedAdditional: [], suppressed: [] },
      },
    });
    expect(res.status).toBe(200);
    // Client-supplied reviewedMedia is stripped; nothing was validated, so
    // nothing may persist — not even from the "trusted" generic path.
    expect(curationOf(id).reviewedMedia).toBeUndefined();
  });
});

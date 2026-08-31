import { describe, it, expect } from 'vitest';
import { Database } from 'bun:sqlite';
import { createVariantResolutionRepo } from '../../db/repositories/onboarding-variant-resolution-repo';

describe('variant resolution repo', () => {
  it('supersede leaves one current', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT)');
    db.exec(`CREATE TABLE onboarding_items (id TEXT PRIMARY KEY, batch_id TEXT, upc TEXT, name TEXT, row_number INTEGER, created_at TEXT, updated_at TEXT)`);
    db.exec(`CREATE TABLE onboarding_variant_resolutions (id TEXT PRIMARY KEY, onboarding_item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE, source_url TEXT NOT NULL, canonical_parent_key TEXT NOT NULL, platform TEXT NOT NULL, parser_version INTEGER NOT NULL, identity_matrix_hash TEXT NOT NULL, source_content_hash TEXT, status TEXT NOT NULL, reason_codes_json TEXT NOT NULL, candidates_json TEXT NOT NULL, automatic_variant_key TEXT, selected_variant_key TEXT, decision_origin TEXT, decided_at TEXT, superseded_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.exec(`INSERT INTO onboarding_items (id, batch_id, upc, name, row_number, created_at, updated_at) VALUES ('item-1','b1','123','Test',1, datetime('now'), datetime('now'))`);
    const repo = createVariantResolutionRepo(db as any);
    const now = new Date().toISOString();
    repo.create({ id: 'r1', onboarding_item_id: 'item-1', source_url: 'https://example.com/products/test', canonical_parent_key: 'https://example.com/products/test', platform: 'shopify', parser_version: 1, identity_matrix_hash: 'abc', source_content_hash: null, status: 'resolved', reason_codes_json: '[]', candidates_json: '[]', automatic_variant_key: 'k1', selected_variant_key: null, decision_origin: 'automatic', decided_at: now, superseded_at: null, created_at: now, updated_at: now });
    repo.supersedeCurrent('item-1', now);
    repo.create({ id: 'r2', onboarding_item_id: 'item-1', source_url: 'https://example.com/products/test?variant=2', canonical_parent_key: 'https://example.com/products/test', platform: 'shopify', parser_version: 1, identity_matrix_hash: 'def', source_content_hash: null, status: 'selected', reason_codes_json: '[]', candidates_json: '[]', automatic_variant_key: null, selected_variant_key: 'k2', decision_origin: 'operator', decided_at: now, superseded_at: null, created_at: now, updated_at: now });
    const current = repo.getCurrentForItem('item-1');
    expect(current?.id).toBe('r2');
    const all = repo.listForItem('item-1');
    expect(all).toHaveLength(2);
  });
});

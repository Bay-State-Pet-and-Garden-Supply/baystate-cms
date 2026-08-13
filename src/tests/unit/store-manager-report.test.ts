import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import { insertProposal } from '../../db/repositories/catalog-health-proposal-repo';
import { createChangeSet, updateChangeSetStatus } from '../../db/repositories/change-set-repo';
import {
  collectStoreManagerEvidence,
  buildDeterministicReport,
  validateNarrativeOutput,
  buildEvidenceKeyAllowlist,
  generateStoreManagerReport,
} from '../../server/services/store-manager-report';
import {
  StoreManagerReportRequestSchema,
  MAX_ISSUE_SAMPLES,
  MAX_REPORT_FIELDS,
} from '../../shared/schemas/store-manager-report';
import storeManagerRoutes from '../../server/routes/store-manager-routes';

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', storeManagerRoutes);
  return app;
}

const now = () => new Date().toISOString();

function seedWorkspace(workspaceId: string, workspacePath: string): void {
  insertWorkspace({
    id: workspaceId,
    name: 'Report Test Store',
    workspacePath,
    gitPath: path.join(workspacePath, '.git'),
    createdAt: now(),
    updatedAt: now(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
}

function seedProduct(row: {
  sku: string;
  title: string;
  status?: string;
  customFields?: Record<string, string>;
}): void {
  insertProductIndex({
    id: randomUUID(),
    sku: row.sku,
    filePath: `products/${row.sku}.json`,
    title: row.title,
    status: row.status ?? 'active',
    price: '10.00',
    inventoryQuantity: 5,
    primaryImage: null,
    productHash: randomUUID().replace(/-/g, ''),
    lastApprovedCommit: null,
    lastPulledRemoteHash: null,
    lastSyncedRemoteHash: null,
    lastSyncedAt: null,
    syncStatus: 'none',
    hasAdvancedBlocks: 0,
    hasWarnings: 0,
    createdAt: now(),
    updatedAt: now(),
    customFields: row.customFields,
  });
}

function insertValidationIssue(scopeId: string, severity: string, code: string, message: string): void {
  const db = getDb();
  db.run(
    `INSERT INTO validation_results (id, scope_type, scope_id, severity, code, message, field_path, created_at)
     VALUES (?, 'catalog', ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), scopeId, severity, code, message, null, now()],
  );
}

function seedRegistry(workspaceId: string, field: string, label: string): void {
  upsertRegistryEntry({
    id: randomUUID(),
    workspaceId,
    xmlField: field,
    label,
    kind: 'custom',
    dataType: 'text',
    editable: true,
    required: false,
    uiGroup: 'detail',
    sampleValuesJson: null,
    createdAt: now(),
    updatedAt: now(),
  });
}

// ---------------------------------------------------------------------------
// Main fixture: issues, proposals, change sets, field audits
// ---------------------------------------------------------------------------

describe('Store Manager evidence-grounded report (epic #42, #38)', () => {
  const testDir = path.join(os.tmpdir(), `baystate-cms-sm-report-${randomUUID().slice(0, 8)}`);
  const testDbPath = path.join(testDir, 'app.db');
  const workspacePath = path.join(testDir, 'workspace');
  const workspaceId = randomUUID();
  const approvedChangeSetId = randomUUID();

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    initDb(testDbPath);
    runMigrations();
    seedWorkspace(workspaceId, workspacePath);
    seedRegistry(workspaceId, 'category', 'Category');

    // Products: SKU-1 'Dog', SKU-2 'dog' (casing duplicate), SKU-3 'Feline'
    // (unique), SKU-4 without the field (empty count).
    seedProduct({ sku: 'SKU-1', title: 'Dog Food', customFields: { category: 'Dog' } });
    seedProduct({ sku: 'SKU-2', title: 'Dog Toy', customFields: { category: 'dog' } });
    seedProduct({ sku: 'SKU-3', title: 'Cat Bed', customFields: { category: 'Feline' } });
    seedProduct({ sku: 'SKU-4', title: 'Leash' });

    insertValidationIssue('SKU-1', 'blocker', 'MISSING_NAME', 'Product name is missing');
    insertValidationIssue('SKU-2', 'warning', 'INVALID_PRICE', 'Price is not a valid number');
    insertValidationIssue('SKU-3', 'blocker', 'MISSING_NAME', 'Product name is missing');

    insertProposal({
      workspaceId,
      field: 'category',
      oldValue: 'Feline',
      newValue: 'Cat',
      affectedSkus: ['SKU-3'],
      reason: 'semantic grouping',
      confidence: 0.9,
      source: 'ai',
      status: 'proposed',
    });
    insertProposal({
      workspaceId,
      field: 'category',
      oldValue: 'dog',
      newValue: 'Dog',
      affectedSkus: ['SKU-2'],
      reason: 'casing normalization',
      confidence: 0.95,
      source: 'deterministic',
      status: 'dismissed',
    });

    const draftCs = createChangeSet({ workspaceId, title: 'Draft CS', baseCommit: 'a'.repeat(40) });
    void draftCs;
    const approvedCs = createChangeSet({ workspaceId, title: 'Approved CS', baseCommit: 'b'.repeat(40) });
    updateChangeSetStatus(approvedCs.id, 'approved', 'c'.repeat(40));
    void approvedChangeSetId;
    const pushedCs = createChangeSet({ workspaceId, title: 'Pushed CS', baseCommit: 'd'.repeat(40) });
    updateChangeSetStatus(pushedCs.id, 'pushed', 'e'.repeat(40));
  });

  afterAll(() => {
    closeDb();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('collects an evidence bundle that matches the fixture', () => {
    const evidence = collectStoreManagerEvidence(workspaceId, []);
    expect(evidence.workspaceId).toBe(workspaceId);
    expect(evidence.generatedAt.length).toBeGreaterThan(0);

    const ch = evidence.catalogHealth;
    expect(ch.totalProducts).toBe(4);
    expect(ch.unhealthyProducts).toBe(3);
    expect(ch.totalErrors).toBe(2);
    expect(ch.totalWarnings).toBe(1);
    expect(ch.issueCountsBySeverity).toEqual({ blocker: 2, warning: 1 });
    expect(ch.issueCountsByCode).toEqual({ MISSING_NAME: 2, INVALID_PRICE: 1 });
    expect(ch.issueSamples).toHaveLength(3);
    expect(ch.issueSamplesTruncated).toBe(false);
    expect(ch.issueSamples[0].sku).toBe('SKU-1');

    expect(evidence.proposals.proposedCount).toBe(1);
    expect(evidence.proposals.byField).toEqual({ category: 1 });

    expect(evidence.changeSets.total).toBe(3);
    expect(evidence.changeSets.byState).toEqual({ draft: 1, approved: 1, pushed: 1 });
  });

  it('audits only requested registered fields and drops unknown fields', () => {
    const none = collectStoreManagerEvidence(workspaceId, []);
    expect(none.fieldAudits).toHaveLength(0);

    const one = collectStoreManagerEvidence(workspaceId, ['category']);
    expect(one.fieldAudits).toHaveLength(1);
    expect(one.fieldAudits[0].field).toBe('category');
    expect(one.fieldAudits[0].casingDuplicateCount).toBe(1);
    expect(one.fieldAudits[0].emptyCount).toBe(1);
    expect(one.fieldAudits[0].suspiciousCount).toBe(0);

    const withBogus = collectStoreManagerEvidence(workspaceId, ['category', 'no-such-field']);
    expect(withBogus.fieldAudits).toHaveLength(1);
  });

  it('caps the requested field list at the schema limit', () => {
    const fields = Array.from({ length: MAX_REPORT_FIELDS + 3 }, (_, i) => `f${i}`);
    const parsed = StoreManagerReportRequestSchema.safeParse({ fields });
    expect(parsed.success).toBe(false);
  });

  it('builds a deterministic report where every catalog line cites its evidence key', () => {
    const evidence = collectStoreManagerEvidence(workspaceId, ['category']);
    const first = buildDeterministicReport(evidence);
    const second = buildDeterministicReport(evidence);
    expect(first.markdown).toBe(second.markdown); // deterministic, no injected timestamp in body
    expect(first.summary).toContain('2 error(s) and 1 warning(s)');

    const md = first.markdown;
    expect(md).toContain('evidence.catalogHealth.totalProducts');
    expect(md).toContain('evidence.catalogHealth.issueCountsBySeverity.blocker');
    expect(md).toContain('evidence.catalogHealth.issueCountsByCode.MISSING_NAME');
    expect(md).toContain('evidence.catalogHealth.issueSamples[0]');
    expect(md).toContain('evidence.fieldAudits.category.casingDuplicateCount');
    expect(md).toContain('evidence.proposals.proposedCount');
    expect(md).toContain('evidence.changeSets.byState.approved');
    expect(md).toContain('SKU-1');
    expect(md).toContain('MISSING_NAME');
  });

  it('omits unsupported severities/codes and fabricated categories', () => {
    const evidence = collectStoreManagerEvidence(workspaceId, []);
    const md = buildDeterministicReport(evidence).markdown;
    expect(md).not.toContain('fatal');
    expect(md).not.toContain('FABRICATED_CODE');
    expect(md).not.toContain('info:');
  });

  it('uses exact Change Set state vocabulary and keeps approved distinct from synced', () => {
    const md = buildDeterministicReport(collectStoreManagerEvidence(workspaceId, [])).markdown;
    expect(md).toContain('draft: 1');
    expect(md).toContain('approved: 1');
    expect(md).toContain('pushed: 1');
    expect(md).toContain('NOT automatically imported, published, or synced');
    expect(md).toContain('"approved" and "synced" remain distinct states');
  });

  it('validates narrative output against the evidence-key allowlist', () => {
    const evidence = collectStoreManagerEvidence(workspaceId, ['category']);
    const allowlist = buildEvidenceKeyAllowlist(evidence);
    expect(allowlist.has('evidence.catalogHealth.totalProducts')).toBe(true);
    expect(allowlist.has('evidence.catalogHealth.issueCountsByCode.MISSING_NAME')).toBe(true);
    expect(allowlist.has('evidence.fieldAudits.category.emptyCount')).toBe(true);
    expect(allowlist.has('evidence.changeSets.byState.approved')).toBe(true);
    expect(allowlist.has('evidence.catalogHealth.issueCountsBySeverity.fatal')).toBe(false);

    const valid = JSON.stringify({
      summary: 'Two blocker issues need attention.',
      bullets: [
        { evidenceKey: 'evidence.catalogHealth.issueCountsBySeverity.blocker', statement: 'Two blocker-level issues were observed.' },
      ],
    });
    const ok = validateNarrativeOutput(valid, allowlist);
    expect(ok).not.toBeNull();
    expect(ok!.bullets).toHaveLength(1);

    // Unknown evidence key must be rejected.
    const unknownKey = JSON.stringify({
      summary: 'Bad summary.',
      bullets: [{ evidenceKey: 'evidence.catalogHealth.issueCountsBySeverity.fatal', statement: 'There is a fatal issue.' }],
    });
    expect(validateNarrativeOutput(unknownKey, allowlist)).toBeNull();

    // Non-JSON / fence-wrapped garbage must be rejected.
    expect(validateNarrativeOutput('not json at all', allowlist)).toBeNull();
    expect(validateNarrativeOutput('```json\n{"summary": "x", "bullets": []}\n```', allowlist)).not.toBeNull();

    // Oversized bullet must be rejected.
    const oversized = JSON.stringify({
      summary: 's',
      bullets: [{ evidenceKey: 'evidence.catalogHealth.totalProducts', statement: 'x'.repeat(300) }],
    });
    expect(validateNarrativeOutput(oversized, allowlist)).toBeNull();
  });

  it('returns the deterministic report when narrative is unavailable (no configured model)', async () => {
    const report = await generateStoreManagerReport(
      workspaceId,
      workspacePath,
      { narrative: true },
      { narrative: async () => null },
    );
    expect(report.reportMarkdown).toContain('Store Manager Cleanup Report');
    expect(report.reportMarkdown).not.toContain('narrative over evidence bundle');
    expect(report.evidence.catalogHealth.totalErrors).toBe(2);
  });

  it('uses a valid narrative when one is produced, still scoped to evidence', async () => {
    const report = await generateStoreManagerReport(
      workspaceId,
      workspacePath,
      { narrative: true },
      {
        narrative: async (bundle) => {
          const allowlist = buildEvidenceKeyAllowlist(bundle);
          return validateNarrativeOutput(
            JSON.stringify({
              summary: 'Summary from narrative.',
              bullets: [
                { evidenceKey: 'evidence.catalogHealth.issueCountsBySeverity.blocker', statement: 'Blockers present.' },
              ],
            }),
            allowlist,
          );
        },
      },
    );
    expect(report.reportMarkdown).toContain('narrative over evidence bundle');
    expect(report.summary).toBe('Summary from narrative.');
  });

  it('returns deterministic report when the narrative generator throws', async () => {
    const report = await generateStoreManagerReport(
      workspaceId,
      workspacePath,
      { narrative: true },
      {
        narrative: async () => { throw new Error('model unavailable'); },
      },
    );
    expect(report.reportMarkdown).toContain('Store Manager Cleanup Report');
  });

  // ---- Route behavior ----

  it('rejects GET /store-manager/report with 405', async () => {
    const res = await makeApp().request('/api/store-manager/report');
    expect(res.status).toBe(405);
  });

  it('POST /store-manager/report returns evidence + deterministic markdown', async () => {
    const res = await makeApp().request('/api/store-manager/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: ['category'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.evidence).toBeDefined();
    expect(body.evidence.catalogHealth.totalErrors).toBe(2);
    expect(typeof body.reportMarkdown).toBe('string');
    expect(body.reportMarkdown).toContain('evidence.catalogHealth.totalProducts');
    expect(typeof body.summary).toBe('string');
  });

  it('POST /store-manager/report validates the request body', async () => {
    const res = await makeApp().request('/api/store-manager/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: 'not-an-array' }),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Clean catalog: empty/clean fixtures must not invent issues
// ---------------------------------------------------------------------------

describe('Store Manager report — clean catalog', () => {
  const testDir = path.join(os.tmpdir(), `baystate-cms-sm-clean-${randomUUID().slice(0, 8)}`);
  const testDbPath = path.join(testDir, 'app.db');
  const workspacePath = path.join(testDir, 'workspace');
  const workspaceId = randomUUID();

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    initDb(testDbPath);
    runMigrations();
    seedWorkspace(workspaceId, workspacePath);
    seedProduct({ sku: 'CLN-1', title: 'Clean Product A' });
    seedProduct({ sku: 'CLN-2', title: 'Clean Product B' });
  });

  afterAll(() => {
    closeDb();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('yields an explicit no-observed-issues report with no fabricated categories', () => {
    const evidence = collectStoreManagerEvidence(workspaceId, []);
    expect(evidence.catalogHealth.totalErrors).toBe(0);
    expect(evidence.catalogHealth.totalWarnings).toBe(0);
    expect(Object.keys(evidence.catalogHealth.issueCountsByCode)).toHaveLength(0);
    expect(evidence.proposals.proposedCount).toBe(0);

    const md = buildDeterministicReport(evidence).markdown;
    expect(md).toContain('No observed catalog issues');
    expect(md).not.toContain('## Issues by severity');
    expect(md).not.toContain('Sample issues');
    expect(md).not.toContain('MISSING_NAME');
  });
});

// ---------------------------------------------------------------------------
// Sample truncation: > MAX_ISSUE_SAMPLES issues must be bounded + flagged
// ---------------------------------------------------------------------------

describe('Store Manager report — bounded issue samples', () => {
  const testDir = path.join(os.tmpdir(), `baystate-cms-sm-trunc-${randomUUID().slice(0, 8)}`);
  const testDbPath = path.join(testDir, 'app.db');
  const workspacePath = path.join(testDir, 'workspace');
  const workspaceId = randomUUID();

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    initDb(testDbPath);
    runMigrations();
    seedWorkspace(workspaceId, workspacePath);
    for (let i = 0; i < MAX_ISSUE_SAMPLES + 7; i++) {
      seedProduct({ sku: `TR-${i}`, title: `Product ${i}` });
      insertValidationIssue(`TR-${i}`, 'warning', 'WARN_CODE', `Issue ${i}`);
    }
  });

  afterAll(() => {
    closeDb();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('caps issue samples at the bound and flags truncation', () => {
    const evidence = collectStoreManagerEvidence(workspaceId, []);
    expect(evidence.catalogHealth.issueSamples).toHaveLength(MAX_ISSUE_SAMPLES);
    expect(evidence.catalogHealth.issueSamplesTruncated).toBe(true);
    expect(evidence.catalogHealth.issueCountsBySeverity.warning).toBe(MAX_ISSUE_SAMPLES + 7);

    const md = buildDeterministicReport(evidence).markdown;
    expect(md).toContain('truncated to sample cap');
    expect(md).toContain('WARN_CODE');
  });
});

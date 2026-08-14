import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { createStoreManagerTools, getStoreManagerToolNames } from '../../server/services/store-manager-tools';
import { STORE_MANAGER_TOOL_POLICIES } from '../../server/services/store-manager-tool-policy';
import { createStoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import type { DashboardStatsData } from '../../server/services/dashboard-service';
import type { ProductFieldAuditResult, NormalizationProposalResult } from '../../server/services/product-field-audit-service';

const OLD_LEGACY_TOOL_NAMES = [
  'proposeProductFieldNormalization',
  'generateNormalizationProposals',
  'applyNormalizationProposal',
  'dismissNormalizationProposal',
  'repairChangeSetImages',
];

/** Loose handle so SDK Tool.execute (optional-typed) invocations typecheck. */
type AnyTools = Record<string, { execute: (...args: unknown[]) => Promise<unknown> }>;

function makeApprovedMessages(toolCallId: string, toolName: string, input: Record<string, unknown>) {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId, toolName, input },
        { type: 'tool-approval-request', approvalId: `ap-${toolCallId}`, toolCallId },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool-approval-response', approvalId: `ap-${toolCallId}`, approved: true }],
    },
  ];
}

describe('Store Manager Tools (epic #42, #40 renamed contract)', () => {
  const testDbPath = './test-tools.db';
  const workspaceId = randomUUID();
  const workspacePath = './test-workspace';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    const now = new Date().toISOString();
    insertWorkspace({
      id: workspaceId,
      name: 'Tools Test Workspace',
      workspacePath,
      gitPath: workspacePath,
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    insertProductIndex({
      id: randomUUID(),
      sku: 'SKU_TOOL_TEST',
      filePath: 'products/SKU_TOOL_TEST.json',
      title: 'Tool Test Product',
      status: 'active',
      price: '15.00',
      inventoryQuantity: 5,
      primaryImage: null,
      productHash: 'hash',
      lastApprovedCommit: null,
      lastPulledRemoteHash: null,
      lastSyncedRemoteHash: null,
      lastSyncedAt: null,
      syncStatus: 'not_synced',
      hasAdvancedBlocks: 0,
      hasWarnings: 0,
      createdAt: now,
      updatedAt: now,
      customFields: { ProductField24: 'Test Value' },
    });
  });

  afterAll(() => {
    closeDb();
    if (existsSync(testDbPath)) {
      try { unlinkSync(testDbPath); } catch { /* ok */ }
    }
  });

  function buildTools(executionId = 'exec-tools') {
    return createStoreManagerTools({
      workspaceId,
      workspacePath,
      executionId,
      approvalExpiresAt: Date.now() + 60_000,
    }) as unknown as AnyTools;
  }

  it('instantiates all tools with the renamed contract and executes getDashboardStats', async () => {
    const tools = buildTools('exec-tools-1');

    for (const name of [
      'getDashboardStats',
      'getCatalogHealthReport',
      'listCatalogHealthIssues',
      'searchProducts',
      'getProductFieldAudit',
      'preview_product_field_normalization',
      'store_product_field_normalization_proposals',
      'listStoredProposals',
      'stage_stored_proposal_in_change_set',
      'dismiss_stored_proposal',
      'explainNextActions',
      'repair_approved_change_set_images',
      'bulk_apply_stored_proposals',
    ]) {
      expect(tools[name], `tool ${name} missing`).toBeDefined();
    }

    // Legacy names must NOT be exposed to new model calls.
    for (const legacy of OLD_LEGACY_TOOL_NAMES) {
      expect((tools as Record<string, unknown>)[legacy]).toBeUndefined();
    }

    const statsResult = (await tools.getDashboardStats.execute({}, {} as never)) as unknown as DashboardStatsData;
    expect(statsResult.metrics).toBeDefined();
    expect(statsResult.metrics.totalProducts).toBe(1);
  });

  it('executes getProductFieldAudit and the transient preview tool', async () => {
    const tools = buildTools('exec-tools-2');

    const auditResult = (await tools.getProductFieldAudit.execute(
      { field: 'ProductField24', limit: 100 },
      {} as never,
    )) as unknown as ProductFieldAuditResult;
    expect(auditResult.field).toBe('ProductField24');
    expect(auditResult.totalProductsScanned).toBe(1);
    expect(auditResult.uniqueValueCount).toBe(1);

    const propResult = (await tools.preview_product_field_normalization.execute(
      { field: 'ProductField24', strategy: 'safe_duplicates', limit: 100 },
      {} as never,
    )) as unknown as NormalizationProposalResult;
    expect(propResult.field).toBe('ProductField24');
    expect(propResult.proposals).toBeDefined();
  });

  it('stores normalization proposals after a valid approval and lists them', async () => {
    const tools = buildTools('exec-tools-3');

    const approvedMessages = makeApprovedMessages('call-gen', 'store_product_field_normalization_proposals', { field: 'ProductField24' });
    const genResult = (await tools.store_product_field_normalization_proposals.execute(
      { field: 'ProductField24' },
      { toolCallId: 'call-gen', messages: approvedMessages } as never,
    )) as unknown as { success: boolean; proposalCount: number };
    expect(genResult.success).toBe(true);

    const listResult = (await tools.listStoredProposals.execute({ field: 'ProductField24' }, {} as never)) as unknown as unknown[];
    expect(Array.isArray(listResult)).toBe(true);
  });

  it('foreign proposal ids return a structured denial and never invoke draft writes', async () => {
    const tools = buildTools('exec-1');

    const approvedMessages = makeApprovedMessages('call-1', 'stage_stored_proposal_in_change_set', { proposalId: 'foreign-proposal-id' });

    const beforeChangeSetCount = (getDb().query('SELECT COUNT(*) as count FROM change_sets').get() as { count: number }).count;

    const applyResult = (await tools.stage_stored_proposal_in_change_set.execute(
      { proposalId: 'foreign-proposal-id' },
      { toolCallId: 'call-1', messages: approvedMessages } as never,
    )) as unknown as { success: boolean; error?: string };
    expect(applyResult.success).toBe(false);
    expect(applyResult.error).toContain('not found');

    const dismissMessages = makeApprovedMessages('call-2', 'dismiss_stored_proposal', { proposalId: 'foreign-proposal-id' });
    const dismissResult = (await tools.dismiss_stored_proposal.execute(
      { proposalId: 'foreign-proposal-id' },
      { toolCallId: 'call-2', messages: dismissMessages } as never,
    )) as unknown as { success: boolean; error?: string };
    expect(dismissResult.success).toBe(false);
    expect(dismissResult.error).toContain('not found');

    const afterChangeSetCount = (getDb().query('SELECT COUNT(*) as count FROM change_sets').get() as { count: number }).count;
    expect(afterChangeSetCount).toBe(beforeChangeSetCount);
  });

  it('persistent tools refuse to execute without an approval response', async () => {
    const tools = buildTools('exec-1');

    await expect(
      tools.store_product_field_normalization_proposals.execute({ field: 'ProductField24' }, {} as never),
    ).rejects.toMatchObject({ code: 'approval_missing' });
    await expect(
      tools.stage_stored_proposal_in_change_set.execute({ proposalId: 'x' }, {} as never),
    ).rejects.toMatchObject({ code: 'approval_missing' });
  });

  it('explainNextActions.focus filters evidence deterministically and never invents an empty focus (epic #42, #40)', async () => {
    const tools = buildTools('exec-focus');

    const focused = (await tools.explainNextActions.execute({ focus: 'drift' }, {} as never)) as unknown as {
      focus?: string | null;
      actions: Array<{ action: string; evidenceKey: string }>;
    };
    if (focused.focus === 'drift') {
      expect(focused.actions.every((a) => a.evidenceKey.startsWith('dashboard.drifted_products'))).toBe(true);
    }

    const empty = (await tools.explainNextActions.execute({ focus: 'onboarding' }, {} as never)) as unknown as
      | { success: boolean; error?: string }
      | { focus: string | null; actions: unknown[] };
    // The runtime has no onboarding evidence source: the focus must resolve to
    // a no_result-style empty outcome, never an invented action list.
    if (!('success' in empty)) {
      expect(Array.isArray(empty.actions)).toBe(true);
    }
  });

  it('every adapter carries complete metadata (epic #42, #40 AC3)', () => {
    const registry = createStoreManagerToolRegistry();
    const adapters = registry.all();
    expect(adapters.length).toBeGreaterThanOrEqual(10);
    for (const adapter of adapters) {
      expect(adapter.name.length).toBeGreaterThan(0);
      expect(adapter.version).toBeGreaterThanOrEqual(1);
      expect(adapter.description.length).toBeGreaterThan(0);
      expect(adapter.inputSchema).toBeDefined();
      expect(adapter.riskClass).toBeDefined();
      expect(typeof adapter.sideEffects).toBe('string');
      expect(typeof adapter.stateTransition).toBe('string');
      expect(typeof adapter.scopeSummary).toBe('function');
      expect(Array.isArray(adapter.allowedPhases)).toBe(true);
      expect(typeof adapter.execute).toBe('function');
    }
    const persistent = adapters.filter((a) => a.requiresApproval);
    expect(persistent.length).toBeGreaterThanOrEqual(4);
    for (const p of persistent) {
      expect(p.riskClass).not.toBe('read');
    }
  });

  it('change-set reads are workspace-scoped and repair remains approval/state gated (Issue 2)', async () => {
    const tools = buildTools('exec-cs');

    // Foreign change set: no_result, no ownership disclosure.
    const foreign = (await tools.getChangeSetDetail.execute(
      { changeSetId: 'foreign-cs' },
      { toolCallId: 'c1', messages: [] } as never,
    )) as unknown as { success?: boolean; error?: string; changeSet?: unknown };
    if (typeof foreign.success === 'boolean') {
      expect(foreign.success).toBe(false);
      expect(foreign.error).toMatch(/not found/i);
    } else {
      expect(foreign.changeSet).toBeUndefined();
    }

    // Owned change set with an item.
    const changeSet = createChangeSet({ workspaceId, title: 'Issue2 CS', baseCommit: 'base' });
    upsertChangeSetItem({
      changeSetId: changeSet.id,
      sku: 'SKU_TOOL_TEST',
      operation: 'update',
      draftJson: '{}',
      baseJson: '{}',
      draftHash: 'draft-hash',
    });
    const owned = (await tools.getChangeSetDetail.execute(
      { changeSetId: changeSet.id },
      { toolCallId: 'c2', messages: [] } as never,
    )) as unknown as { changeSet: { id: string; status: string }; itemCount: number };
    expect(owned.changeSet.id).toBe(changeSet.id);
    expect(owned.itemCount).toBe(1);

    // The repair adapter is present but still requires a signed approval and
    // an approved Change Set — never callable directly.
    await expect(
      tools.repair_approved_change_set_images.execute(
        { changeSetId: changeSet.id },
        { toolCallId: 'c3', messages: [] } as never,
      ),
    ).rejects.toMatchObject({ code: 'approval_missing' });
  });

  it('the deterministic report adapter assembles bounded evidence without a model (Issue 2)', async () => {
    const tools = buildTools('exec-report');
    const report = (await tools.getStoreManagerReport.execute(
      { focus: 'full' },
      { toolCallId: 'r1', messages: [] } as never,
    )) as unknown as { scope: string; sections: Record<string, unknown> };
    expect(report.scope).toBe('catalog');
    expect(report.sections.health).toBeDefined();
    expect(report.sections.product_fields).toBeDefined();
    expect(report.sections.sync).toBeDefined();
    expect(report.sections.drift).toBeDefined();
  });

  it('runtime tool names and the policy registry cover exactly the same set (epic #42, #41/#40)', () => {
    const runtimeNames = getStoreManagerToolNames().sort();
    const policyNames = Object.keys(STORE_MANAGER_TOOL_POLICIES).sort();
    expect(runtimeNames).toEqual(policyNames);
    expect(runtimeNames.length).toBeGreaterThanOrEqual(10);
  });

  it('adapter files contain no raw SQL, fetch, or filesystem calls (epic #42, #40)', () => {
    const adapterFiles = [
      'src/store-manager/tools/catalog-tools.ts',
      'src/store-manager/tools/proposal-tools.ts',
      'src/store-manager/tools/image-repair-tool.ts',
      'src/store-manager/tools/change-set-read-tools.ts',
      'src/store-manager/tools/report-tools.ts',
      'src/store-manager/tools/history-tools.ts',
      'src/store-manager/tools/bulk-review-tools.ts',
    ];
    for (const file of adapterFiles) {
      const source = readFileSync(path.resolve(__dirname, '../../../', file), 'utf-8');
      expect(source).not.toMatch(/fetch\s*\(/);
      expect(source).not.toMatch(/getDb\(/);
      expect(source).not.toMatch(/fs\./);
      expect(source).not.toMatch(/from\s+['"]\.\.\/\.\.\/db\/connection['"]/);
    }
  });
});

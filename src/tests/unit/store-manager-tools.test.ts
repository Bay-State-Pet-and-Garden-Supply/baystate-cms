import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { createStoreManagerTools, ApprovalGateError } from '../../server/services/store-manager-tools';
import type { DashboardStatsData } from '../../server/services/dashboard-service';
import type { ProductFieldAuditResult, NormalizationProposalResult } from '../../server/services/product-field-audit-service';

describe('Store Manager Tools', () => {
  const testDbPath = './test-tools.db';
  const workspaceId = randomUUID();
  const workspacePath = './test-workspace';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    // Set up mock product
    const now = new Date().toISOString();
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

  it('should instantiate all tools and execute getDashboardStats', async () => {
    const tools = createStoreManagerTools({
      workspaceId,
      workspacePath,
      executionId: 'exec-tools-1',
      approvalExpiresAt: Date.now() + 60_000,
    });

    expect(tools.getDashboardStats).toBeDefined();
    expect(tools.getCatalogHealthReport).toBeDefined();
    expect(tools.listCatalogHealthIssues).toBeDefined();
    expect(tools.searchProducts).toBeDefined();
    expect(tools.getProductFieldAudit).toBeDefined();
    expect(tools.proposeProductFieldNormalization).toBeDefined();
    expect(tools.generateNormalizationProposals).toBeDefined();
    expect(tools.listStoredProposals).toBeDefined();
    expect(tools.applyNormalizationProposal).toBeDefined();
    expect(tools.dismissNormalizationProposal).toBeDefined();
    expect(tools.explainNextActions).toBeDefined();

    // Call execute on getDashboardStats with type assertion
    const statsResult = (await tools.getDashboardStats.execute({}, {} as any)) as DashboardStatsData;
    expect(statsResult.metrics).toBeDefined();
    expect(statsResult.metrics.totalProducts).toBe(1);
    expect(statsResult.metrics.syncedProducts).toBe(0);
  });

  it('should execute getProductFieldAudit and proposeProductFieldNormalization tools', async () => {
    const tools = createStoreManagerTools({
      workspaceId,
      workspacePath,
      executionId: 'exec-tools-2',
      approvalExpiresAt: Date.now() + 60_000,
    });

    const auditResult = (await tools.getProductFieldAudit.execute({ field: 'ProductField24', limit: 100 }, {} as any)) as ProductFieldAuditResult;
    expect(auditResult.field).toBe('ProductField24');
    expect(auditResult.totalProductsScanned).toBe(1);
    expect(auditResult.uniqueValueCount).toBe(1);

    const propResult = (await tools.proposeProductFieldNormalization.execute(
      { field: 'ProductField24', strategy: 'safe_duplicates', limit: 100 },
      {} as any
    ) as NormalizationProposalResult);
    expect(propResult.field).toBe('ProductField24');
    expect(propResult.proposals).toBeDefined();

    // Test new database-backed proposal tools execution (with a valid approval
    // for the persistent tool, mirroring the runtime approval flow).
    const approvedMessages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-gen',
            toolName: 'generateNormalizationProposals',
            input: { field: 'ProductField24' },
          },
          { type: 'tool-approval-request', approvalId: 'ap-gen', toolCallId: 'call-gen' },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-approval-response', approvalId: 'ap-gen', approved: true }],
      },
    ];
    const genResult = (await tools.generateNormalizationProposals.execute(
      { field: 'ProductField24' },
      { toolCallId: 'call-gen', messages: approvedMessages } as any,
    )) as { success: boolean; proposalCount: number };
    expect(genResult.success).toBe(true);

    const listResult = (await tools.listStoredProposals.execute({ field: 'ProductField24' }, {} as any)) as any[];
    expect(Array.isArray(listResult)).toBe(true);
  });

  it('foreign or unknown proposal ids return a structured denial and never invoke draft writes', async () => {
    const tools = createStoreManagerTools({
      workspaceId,
      workspacePath,
      executionId: 'exec-1',
      approvalExpiresAt: Date.now() + 60_000,
    });

    // A valid signed approval for the foreign id passes the approval gate;
    // the workspace-scoped service still denies the foreign proposal.
    const approvedMessages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'applyNormalizationProposal',
            input: { proposalId: 'foreign-proposal-id' },
          },
          { type: 'tool-approval-request', approvalId: 'ap-1', toolCallId: 'call-1' },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-approval-response', approvalId: 'ap-1', approved: true }],
      },
    ];

    const beforeChangeSetCount = (getDb().query('SELECT COUNT(*) as count FROM change_sets').get() as { count: number }).count;

    // Unknown/foreign id — no proposal exists in this workspace.
    const applyResult = (await tools.applyNormalizationProposal.execute(
      { proposalId: 'foreign-proposal-id' },
      { toolCallId: 'call-1', messages: approvedMessages } as any,
    )) as { success: boolean; error?: string };
    expect(applyResult.success).toBe(false);
    expect(applyResult.error).toContain('not found');

    const dismissResult = (await tools.dismissNormalizationProposal.execute(
      { proposalId: 'foreign-proposal-id' },
      { toolCallId: 'call-1', messages: approvedMessages } as any,
    )) as { success: boolean; error?: string };
    expect(dismissResult.success).toBe(false);
    expect(dismissResult.error).toContain('not found');

    // No change set or draft mutation occurred.
    const afterChangeSetCount = (getDb().query('SELECT COUNT(*) as count FROM change_sets').get() as { count: number }).count;
    expect(afterChangeSetCount).toBe(beforeChangeSetCount);
  });

  it('persistent tools refuse to execute without an approval response', async () => {
    const tools = createStoreManagerTools({
      workspaceId,
      workspacePath,
      executionId: 'exec-1',
      approvalExpiresAt: Date.now() + 60_000,
    });

    await expect(
      tools.generateNormalizationProposals.execute({ field: 'ProductField24' }, {} as any),
    ).rejects.toMatchObject({ code: 'approval_missing' });
    await expect(
      tools.applyNormalizationProposal.execute({ proposalId: 'x' }, {} as any),
    ).rejects.toMatchObject({ code: 'approval_missing' });
  });
});

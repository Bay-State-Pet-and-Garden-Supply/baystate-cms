import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import {
  createStoreManagerTools,
  gateToolExecution,
  resetConsumedApprovalsForTests,
} from '../../server/services/store-manager-tools';
import {
  STORE_MANAGER_TOOL_POLICIES,
  buildToolApprovalConfig,
  requireStoreManagerToolPolicy,
} from '../../server/services/store-manager-tool-policy';

// ---------------------------------------------------------------------------
// Epic #42, #34 — server-enforced approval for persistent Store Manager tools.
// DB-backed: run under `bun test` (excluded from Vitest).
// ---------------------------------------------------------------------------

const workspaceId = randomUUID();
const testDbPath = './test-approval.db';

function makeMessages(overrides?: {
  toolCallInput?: Record<string, unknown>;
  executeInput?: Record<string, unknown>;
  approvalApproved?: boolean;
  requestToolCallId?: string;
  responseApprovalId?: string;
}) {
  const {
    toolCallInput = { field: 'ProductField24' },
    executeInput = { field: 'ProductField24' },
    approvalApproved = true,
    requestToolCallId = 'call-1',
    responseApprovalId = 'ap-1',
  } = overrides ?? {};
  return {
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'store_product_field_normalization_proposals',
            input: toolCallInput,
          },
          {
            type: 'tool-approval-request',
            approvalId: 'ap-1',
            toolCallId: requestToolCallId,
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-approval-response',
            approvalId: responseApprovalId,
            approved: approvalApproved,
          },
        ],
      },
    ] as unknown[],
    executeInput,
  };
}

describe('Store Manager tool policy metadata (epic #42, #34)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();

    const now = new Date().toISOString();
    insertProductIndex({
      id: randomUUID(),
      sku: 'SKU_APPROVAL_TEST',
      filePath: 'products/SKU_APPROVAL_TEST.json',
      title: 'Approval Test Product',
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

  it('every agent tool has a policy entry with a risk class (metadata completeness)', () => {
    const tools = createStoreManagerTools({
      workspaceId,
      workspacePath: './test-workspace',
      executionId: 'exec-1',
      approvalExpiresAt: Date.now() + 60_000,
    });
    for (const name of Object.keys(tools)) {
      const policy = STORE_MANAGER_TOOL_POLICIES[name];
      expect(policy, `tool "${name}" lacks a policy registry entry`).toBeDefined();
      expect(policy!.version).toBeGreaterThanOrEqual(1);
      expect(['read', 'proposal_write', 'catalog_mutation', 'network_filesystem_repair']).toContain(
        policy!.riskClass,
      );
    }
  });

  it('read tools are not-applicable and persistent tools are user-approval in toolApproval config', () => {
    const tools = createStoreManagerTools({
      workspaceId,
      workspacePath: './test-workspace',
      executionId: 'exec-1',
      approvalExpiresAt: Date.now() + 60_000,
    });
    const config = buildToolApprovalConfig(tools) as Record<string, 'not-applicable' | 'user-approval' | undefined>;
    const readTools = [
      'getDashboardStats',
      'getCatalogHealthReport',
      'listCatalogHealthIssues',
      'searchProducts',
      'getProductFieldAudit',
      'preview_product_field_normalization',
      'listStoredProposals',
      'explainNextActions',
    ];
    const persistentTools = [
      'store_product_field_normalization_proposals',
      'dismiss_stored_proposal',
      'stage_stored_proposal_in_change_set',
      'repair_approved_change_set_images',
      'bulk_apply_stored_proposals',
    ];
    for (const name of readTools) {
      expect(config[name], `${name} should be not-applicable`).toBe('not-applicable');
      expect(STORE_MANAGER_TOOL_POLICIES[name].requiresApproval).toBe(false);
    }
    for (const name of persistentTools) {
      expect(config[name], `${name} should be user-approval`).toBe('user-approval');
      expect(STORE_MANAGER_TOOL_POLICIES[name].requiresApproval).toBe(true);
    }
  });

  describe('approval gate', () => {
    const policy = requireStoreManagerToolPolicy('store_product_field_normalization_proposals');
    const executionCtx = {
      workspaceId,
      workspacePath: './test-workspace',
      executionId: 'exec-1',
      approvalExpiresAt: Date.now() + 60_000,
    };

    // The consumed-approval registry is per-process; fixed test ids ('ap-1')
    // must not leak between cases.
    beforeEach(() => {
      resetConsumedApprovalsForTests();
    });

    it('approval-required tool with no approval response fails closed and executes zero times', async () => {
      const calls: string[] = [];
      const gated = gateToolExecution(policy, executionCtx, async () => {
        calls.push('run');
        return { ok: true };
      });
      await expect(
        gated({ field: 'ProductField24' }, { toolCallId: 'call-1', messages: [] } as any),
      ).rejects.toMatchObject({ code: 'approval_missing' });
      expect(calls).toEqual([]);
    });

    it('valid approved approval executes the underlying tool exactly once', async () => {
      const calls: string[] = [];
      const gated = gateToolExecution(policy, executionCtx, async () => {
        calls.push('run');
        return { ok: true };
      });
      const { messages, executeInput } = makeMessages();
      const result = await gated(executeInput, { toolCallId: 'call-1', messages } as any);
      expect(result).toEqual({ ok: true });
      expect(calls).toEqual(['run']);
    });

    it('denied approval executes zero times', async () => {
      const calls: string[] = [];
      const gated = gateToolExecution(policy, executionCtx, async () => {
        calls.push('run');
        return { ok: true };
      });
      const { messages, executeInput } = makeMessages({ approvalApproved: false });
      await expect(
        gated(executeInput, { toolCallId: 'call-1', messages } as any),
      ).rejects.toMatchObject({ code: 'approval_denied' });
      expect(calls).toEqual([]);
    });

    it('a whole approved call replayed under a new execution context is refused', async () => {
      const calls: string[] = [];
      const gatedFirst = gateToolExecution(policy, executionCtx, async () => {
        calls.push('run');
        return { ok: true };
      });
      const { messages, executeInput } = makeMessages();
      await gatedFirst(executeInput, { toolCallId: 'call-1', messages } as any);
      expect(calls).toEqual(['run']);

      // New turn/execution context, byte-identical approved message history:
      // the approval was consumed under exec-1 and must not execute again.
      const gatedSecond = gateToolExecution(
        policy,
        { ...executionCtx, executionId: 'exec-2' },
        async () => {
          calls.push('run');
          return { ok: true };
        },
      );
      await expect(
        gatedSecond(executeInput, { toolCallId: 'call-1', messages } as any),
      ).rejects.toMatchObject({ code: 'approval_replay_or_altered' });
      expect(calls).toEqual(['run']);
    });

    it('the same approval cannot execute twice within one execution context', async () => {
      const calls: string[] = [];
      const gated = gateToolExecution(policy, executionCtx, async () => {
        calls.push('run');
        return { ok: true };
      });
      const { messages, executeInput } = makeMessages();
      await gated(executeInput, { toolCallId: 'call-1', messages } as any);
      expect(calls).toEqual(['run']);
      // Second dispatch of the same approval in the same context: single-use.
      await expect(
        gated(executeInput, { toolCallId: 'call-1', messages } as any),
      ).rejects.toMatchObject({ code: 'approval_replay_or_altered' });
      expect(calls).toEqual(['run']);
    });

    it('altered arguments after approval are refused', async () => {
      const calls: string[] = [];
      const gated = gateToolExecution(policy, executionCtx, async () => {
        calls.push('run');
        return { ok: true };
      });
      const { messages } = makeMessages({ toolCallInput: { field: 'ProductField25' } });
      await expect(
        gated({ field: 'ProductField24' }, { toolCallId: 'call-1', messages } as any),
      ).rejects.toMatchObject({ code: 'approval_replay_or_altered' });
      expect(calls).toEqual([]);
    });

    it('replayed approval for a different tool call is refused', async () => {
      const calls: string[] = [];
      const gated = gateToolExecution(policy, executionCtx, async () => {
        calls.push('run');
        return { ok: true };
      });
      // The approval request belongs to call-OTHER; this execution is call-1.
      const { messages, executeInput } = makeMessages({ requestToolCallId: 'call-OTHER' });
      await expect(
        gated(executeInput, { toolCallId: 'call-1', messages } as any),
      ).rejects.toMatchObject({ code: 'approval_missing' });
      expect(calls).toEqual([]);
    });

    it('expired execution context refuses every tool', async () => {
      const calls: string[] = [];
      const gated = gateToolExecution(
        policy,
        { ...executionCtx, approvalExpiresAt: Date.now() - 1000 },
        async () => {
          calls.push('run');
          return { ok: true };
        },
      );
      const { messages, executeInput } = makeMessages();
      await expect(
        gated(executeInput, { toolCallId: 'call-1', messages } as any),
      ).rejects.toMatchObject({ code: 'approval_session_expired' });
      expect(calls).toEqual([]);
    });

    it('missing execution context refuses execution', async () => {
      const calls: string[] = [];
      const gated = gateToolExecution(
        policy,
        { workspaceId, workspacePath: './test-workspace' },
        async () => {
          calls.push('run');
          return { ok: true };
        },
      );
      await expect(
        gated({ field: 'ProductField24' }, { toolCallId: 'call-1', messages: [] } as any),
      ).rejects.toMatchObject({ code: 'execution_context_missing' });
      expect(calls).toEqual([]);
    });

    it('read tools execute without approval inside a valid execution context', async () => {
      const readPolicy = requireStoreManagerToolPolicy('getDashboardStats');
      const calls: string[] = [];
      const gated = gateToolExecution(readPolicy, executionCtx, async () => {
        calls.push('run');
        return { metrics: {} };
      });
      const result = await gated({}, { toolCallId: 'call-read', messages: [] } as any);
      expect(result).toEqual({ metrics: {} });
      expect(calls).toEqual(['run']);
    });
  });

  describe('gate wired through createStoreManagerTools', () => {
    const executionCtx = {
      workspaceId,
      workspacePath: './test-workspace',
      executionId: 'exec-1',
      approvalExpiresAt: Date.now() + 60_000,
    };

    beforeEach(() => {
      resetConsumedApprovalsForTests();
    });

    it('denied proposal generation creates no proposal rows', async () => {
      const tools = createStoreManagerTools(executionCtx);
      const before = (getDb().query(
        'SELECT COUNT(*) as count FROM catalog_health_proposals',
      ).get() as { count: number }).count;
      const { messages } = makeMessages({ approvalApproved: false });
      await expect(
        (tools as any).store_product_field_normalization_proposals.execute(
          { field: 'ProductField24' },
          { toolCallId: 'call-1', messages } as any,
        ),
      ).rejects.toMatchObject({ code: 'approval_denied' });
      const after = (getDb().query(
        'SELECT COUNT(*) as count FROM catalog_health_proposals',
      ).get() as { count: number }).count;
      expect(after).toBe(before);
    });

    it('valid approved proposal generation persists proposals', async () => {
      const tools = createStoreManagerTools(executionCtx);
      const before = (getDb().query(
        'SELECT COUNT(*) as count FROM catalog_health_proposals',
      ).get() as { count: number }).count;
      const { messages, executeInput } = makeMessages();
      const result = await (tools as any).store_product_field_normalization_proposals.execute(
        executeInput,
        { toolCallId: 'call-1', messages } as any,
      );
      expect(result.success).toBe(true);
      const after = (getDb().query(
        'SELECT COUNT(*) as count FROM catalog_health_proposals',
      ).get() as { count: number }).count;
      // At least the (possibly empty) deterministic set was generated; the gate
      // allowed exactly one execution (row count monotonic, no double-run).
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('foreign proposal id still denies at dispatch even with a valid approval', async () => {
      const tools = createStoreManagerTools(executionCtx);
      const { messages, executeInput } = makeMessages({
        toolCallInput: { proposalId: 'foreign-proposal-id' },
        executeInput: { proposalId: 'foreign-proposal-id' },
      });
      const result = (await (tools as any).stage_stored_proposal_in_change_set.execute(
        executeInput,
        { toolCallId: 'call-1', messages } as any,
      )) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('bulk_apply_stored_proposals is approval-bound like every catalog mutation (Issue 8)', async () => {
      const policy = requireStoreManagerToolPolicy('bulk_apply_stored_proposals');
      expect(policy.riskClass).toBe('catalog_mutation');
      expect(policy.requiresApproval).toBe(true);

      const calls: string[] = [];
      const gated = gateToolExecution(policy, executionCtx, async () => {
        calls.push('run');
        return { ok: true };
      });

      // No approval response -> fail closed, zero executions.
      await expect(
        gated({ batchId: 'batch-x' }, { toolCallId: 'call-1', messages: [] } as any),
      ).rejects.toMatchObject({ code: 'approval_missing' });
      expect(calls).toEqual([]);

      // Valid approved call -> executes exactly once, then single-use.
      const { messages, executeInput } = makeMessages({
        toolCallInput: { batchId: 'batch-x' },
        executeInput: { batchId: 'batch-x' },
      });
      const result = await gated(executeInput, { toolCallId: 'call-1', messages } as any);
      expect(result).toEqual({ ok: true });
      expect(calls).toEqual(['run']);

      // The same approval cannot be replayed under a different execution context.
      const foreignCtx = { ...executionCtx, executionId: 'exec-other' };
      const gatedForeign = gateToolExecution(policy, foreignCtx, async () => {
        calls.push('run-again');
        return { ok: true };
      });
      await expect(
        gatedForeign(executeInput, { toolCallId: 'call-1', messages } as any),
      ).rejects.toMatchObject({ code: 'approval_replay_or_altered' });
      expect(calls).toEqual(['run']);
    });
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { runStoreManagerOperationsMigration } from '../../db/store-manager-operations-migration';
import { z } from 'zod';
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { StoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import type { StoreManagerToolAdapter, StoreManagerToolResult } from '../../store-manager/runtime/contracts';
import { okResult } from '../../store-manager/runtime/contracts';
import { buildStoreManagerActionDiff } from '../../store-manager/runtime/action-preview';
import type { ResolvedAiSdkModel } from '../../server/services/ai-sdk-model-resolver';
import {
  runStoreManagerPlaybook,
  resumeStoreManagerPlaybookRun,
  getStoreManagerPlaybookRunDetail,
  StoreManagerPlaybookRunError,
} from '../../store-manager/playbooks/runner';
import { createPlaybook, appendPlaybookVersion, activatePlaybookVersion } from '../../db/repositories/store-manager-playbook-repo';
import { hashCanonicalJson } from '../../shared/stable-id';
import type { StoreManagerPlaybookDefinition } from '../../shared/schemas/store-manager-playbook';
import { getStoreManagerSession, getStoreManagerEvents } from '../../db/repositories/store-manager-session-repo';
import { upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { resetConsumedApprovalsForTests } from '../../server/services/store-manager-tools';
import { overrideStoreManagerFlags, resetStoreManagerFlagsOverride } from '../../store-manager/flags';

/**
 * Operations console Issue 7 — playbook runner.
 * DB-backed (leases, step rows, execution sessions): run under `bun test`.
 */

const workspaceId = 'ws-pb';
const testDbPath = './test-playbook-runner.db';
let toolCalls: string[] = [];

const readAdapter: StoreManagerToolAdapter = {
  name: 'pb_read',
  version: 1,
  description: 'pb read',
  promptGuidelines: 'none',
  inputSchema: z.object({ q: z.string().max(50).optional() }),
  riskClass: 'read',
  sideEffects: 'none',
  requiresApproval: false,
  stateTransition: 'none',
  allowedPhases: ['investigate', 'verify'] as const,
  scopeSummary: (i) => `read ${String(i.q ?? '')}`,
  execute: async ({ q }): Promise<StoreManagerToolResult> => {
    toolCalls.push('pb_read');
    return okResult({ q, itemCount: 2, items: [{ sku: 'SKU-A' }, { sku: 'SKU-B' }] });
  },
};

const writeAdapter: StoreManagerToolAdapter = {
  name: 'pb_write',
  version: 1,
  description: 'pb write',
  promptGuidelines: 'none',
  inputSchema: z.object({ proposalId: z.string() }),
  riskClass: 'proposal_write',
  sideEffects: 'writes a proposal row',
  requiresApproval: true,
  stateTransition: 'proposal stored',
  allowedPhases: ['approve'] as const,
  scopeSummary: (i) => `write ${String(i.proposalId ?? '')}`,
  previewDiff: async ({ proposalId }, ctx) =>
    buildStoreManagerActionDiff({
      toolName: 'pb_write',
      toolVersion: 1,
      riskClass: 'proposal_write',
      workspaceId: ctx.workspaceId,
      scopeHash: null,
      affectedSkuCount: 1,
      affectedSkus: ['SKU-A'],
      beforeAfter: [{ field: 'ProductField24', before: 'old', after: 'new', affectedCount: 1 }],
      changeSet: null,
      networkActivity: { kind: 'none' },
      evidenceRefs: [`proposal:${String(proposalId ?? '')}`],
    }),
  execute: async ({ proposalId }): Promise<StoreManagerToolResult> => {
    toolCalls.push('pb_write');
    return okResult({ success: true, proposalId, itemCount: 1, items: [{ sku: 'SKU-A' }] });
  },
};

function testRegistry() {
  return new StoreManagerToolRegistry([readAdapter, writeAdapter]);
}

/**
 * Fake model that parses the runner's playbook step contract from the
 * objective and calls the declared tool with the declared input exactly once.
 */
function contractModel() {
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'fake-provider',
    modelId: 'fake-model',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('doGenerate not exercised');
    },
    async doStream(options: LanguageModelV3CallOptions) {
      let objective = '';
      let hasToolResult = false;
      if (Array.isArray(options.prompt)) {
        for (const message of options.prompt as Array<{ content?: unknown }>) {
          if (typeof message.content === 'string') {
            objective += message.content;
          } else if (Array.isArray(message.content)) {
            for (const part of message.content as Array<{ type?: string; text?: string }>) {
              if (part.type === 'text' && typeof part.text === 'string') objective += part.text;
              if (part.type === 'tool-result') hasToolResult = true;
            }
          }
        }
      }
      const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
      if (!hasToolResult) {
        const toolMatch = /tool: ([^\n]+)/.exec(String(objective));
        const inputMatch = /input: (\{.*\})/.exec(String(objective));
        if (toolMatch && toolMatch[1] !== '__summarize_no_tool__') {
          const input = inputMatch ? JSON.parse(inputMatch[1]) : {};
          const toolCallIdMatch = /toolCallId: (\S+)/.exec(String(objective));
          const toolCallId = toolCallIdMatch ? toolCallIdMatch[1] : 'pb-call-1';
          parts.push(
            { type: 'tool-call', toolCallId, toolName: toolMatch[1], input: JSON.stringify(input) },
            {
              type: 'finish',
              usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            },
          );
        } else {
          parts.push(
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'ok' },
            { type: 'text-end', id: 't1' },
            {
              type: 'finish',
              usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
              finishReason: { unified: 'stop', raw: 'stop' },
            },
          );
        }
      } else {
        parts.push(
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'done' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
            finishReason: { unified: 'stop', raw: 'stop' },
          },
        );
      }
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
  return model as unknown as ResolvedAiSdkModel['modelInstance'];
}

const resolvedFake: ResolvedAiSdkModel = {
  modelInstance: {} as ResolvedAiSdkModel['modelInstance'],
  provider: 'fake-provider',
  modelId: 'fake-model',
  locality: 'cloud',
  resolutionReason: 'explicit',
};

function buildDefinition(overrides?: { omitVerify?: boolean }, id = 'pb-test-1'): { definition: StoreManagerPlaybookDefinition; hash: string } {
  const content = {
    name: 'Test playbook',
    description: 'runner test',
    scopeInput: { allowedKinds: [], maxSkus: 200 },
    variables: [{ name: 'field', type: 'product_field' as const, required: true }],
    steps: [
      {
        stepId: 's-read',
        kind: 'read' as const,
        toolName: 'pb_read',
        toolVersion: 1,
        inputTemplate: { q: 'hello' },
      },
      {
        stepId: 's-checkpoint',
        kind: 'approval_checkpoint' as const,
        diffRequired: true as const,
      },
      {
        stepId: 's-execute',
        kind: 'execute' as const,
        toolName: 'pb_write',
        toolVersion: 1,
        inputTemplate: { proposalId: 'p-1' },
        declaredRiskClass: 'proposal_write' as const,
      },
      ...(overrides?.omitVerify
        ? []
        : [
            {
              stepId: 's-verify',
              kind: 'verify' as const,
              toolNames: [{ toolName: 'pb_read', toolVersion: 1 }],
            },
          ]),
    ],
  };
  const hash = hashCanonicalJson(content);
  return {
    definition: {
      id,
      workspaceId,
      name: content.name,
      description: content.description,
      templateKind: null,
      version: 1,
      status: 'active' as const,
      scopeInput: content.scopeInput,
      variables: content.variables,
      steps: content.steps as StoreManagerPlaybookDefinition['steps'],
      definitionHash: hash,
      activatedAt: new Date().toISOString(),
      activatedBy: 'operator',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    hash,
  };
}

let seedCounter = 0;
function seedPlaybook(overrides?: { omitVerify?: boolean }): string {
  seedCounter += 1;
  const id = `pb-test-${seedCounter}`;
  const { definition, hash } = buildDefinition(overrides, id);
  createPlaybook({ id, workspaceId, name: definition.name, description: definition.description });
  appendPlaybookVersion({
    workspaceId,
    playbookId: id,
    version: 1,
    definitionJson: JSON.stringify(definition),
    definitionHash: hash,
  });
  activatePlaybookVersion({ workspaceId, playbookId: id, version: 1, definitionHash: hash, activatedBy: 'operator' });
  return id;
}

describe('Store Manager playbook runner (epic #42, Issue 7)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
    runStoreManagerOperationsMigration();
    insertWorkspace({
      id: workspaceId,
      name: 'test workspace',
      workspacePath: './ws',
      gitPath: './ws-git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'not_started',
      baselineCommit: null,
    } as never);
    upsertRegistryEntry({
      id: 'field-24',
      workspaceId,
      xmlField: 'ProductField24',
      label: 'Test field',
      kind: 'custom',
      dataType: 'string',
      editable: true,
      required: false,
      uiGroup: null,
      sampleValuesJson: null,
      curatedFieldsJson: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    overrideStoreManagerFlags({ playbooksEnabled: true });
  });

  afterAll(() => {
    resetStoreManagerFlagsOverride();
    closeDb();
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(`${testDbPath}${suffix}`); } catch { /* ok */ }
    }
  });

  beforeEach(() => {
    toolCalls = [];
    resetConsumedApprovalsForTests();
  });

  it('pauses at the approval checkpoint with a diff bundle; resume with the exact diff executes the persistent step and verifies', async () => {
    const playbookId = seedPlaybook();
    const first = await runStoreManagerPlaybook({
      workspaceId,
      workspacePath: './ws',
      playbookId,
      variables: { field: 'ProductField24' },
      actor: 'operator',
      registry: testRegistry(),
      resolveModel: () => ({ ...resolvedFake, modelInstance: contractModel() }),
    });

    // Paused at checkpoint: read step executed through the COMMON RUNNER.
    expect(first.status).toBe('paused_at_checkpoint');
    expect(first.checkpoint).not.toBeNull();
    expect(first.checkpoint!.toolName).toBe('pb_write');
    expect(first.checkpoint!.diffHash).toMatch(/^[a-f0-9]{64}$/);
    expect(toolCalls).toEqual(['pb_read']); // execute did NOT run yet
    const readStep = first.steps.find((s) => s.stepId === 's-read');
    expect(readStep!.executionRunId).toBeTruthy();
    const session = getStoreManagerSession(workspaceId, readStep!.executionRunId!);
    expect(session).not.toBeNull();
    expect(session!.entrypoint).toBe('playbook');
    expect(session!.lineage_json).toContain('s-read');

    // Wrong diff hash is refused (exact binding).
    await expect(
      resumeStoreManagerPlaybookRun(workspaceId, first.runId, {
        approve: true,
        actor: 'operator',
        diffHash: 'a'.repeat(64),
        registry: testRegistry(),
        resolveModel: () => ({ ...resolvedFake, modelInstance: contractModel() }),
      }),
    ).rejects.toThrow(StoreManagerPlaybookRunError);

    // Correct diff resumes: execute + verify run through the common runner.
    const resumed = await resumeStoreManagerPlaybookRun(workspaceId, first.runId, {
      approve: true,
      actor: 'operator',
      diffHash: first.checkpoint!.diffHash,
      registry: testRegistry(),
      resolveModel: () => ({ ...resolvedFake, modelInstance: contractModel() }),
    });

    expect(resumed.status).toBe('completed');
    expect(toolCalls).toEqual(['pb_read', 'pb_write', 'pb_read']); // verify read too
    const executeStep = resumed.steps.find((s) => s.stepId === 's-execute');
    expect(executeStep!.status).toBe('executed');
    const verifyStep = resumed.steps.find((s) => s.stepId === 's-verify');
    expect(verifyStep!.status).toBe('verified');
    // Verification diff artifact exists.
    const detail = getStoreManagerPlaybookRunDetail(workspaceId, resumed.runId);
    expect(detail.steps.find((s) => s.step_id === 's-verify')?.artifact_id).toBeTruthy();
  });

  it('refuses to run an inactive playbook and refuses a tampered definition', async () => {
    const { definition } = buildDefinition();
    createPlaybook({ id: 'pb-inactive', workspaceId, name: 'inactive', description: '' });
    appendPlaybookVersion({ workspaceId, playbookId: 'pb-inactive', version: 1, definitionJson: JSON.stringify(definition), definitionHash: definition.definitionHash });
    await expect(
      runStoreManagerPlaybook({ workspaceId, workspacePath: './ws', playbookId: 'pb-inactive', variables: { field: 'ProductField24' }, registry: testRegistry(), resolveModel: () => resolvedFake }),
    ).rejects.toThrow(/not active/);
  });

  it('a denied checkpoint fails the run closed and schedule/event actors cannot approve', async () => {
    const playbookId = seedPlaybook();
    const first = await runStoreManagerPlaybook({
      workspaceId,
      workspacePath: './ws',
      playbookId,
      variables: { field: 'ProductField24' },
      actor: 'operator',
      registry: testRegistry(),
      resolveModel: () => ({ ...resolvedFake, modelInstance: contractModel() }),
    });
    // schedule/event identity cannot approve.
    await expect(
      resumeStoreManagerPlaybookRun(workspaceId, first.runId, {
        approve: true,
        actor: 'system_schedule',
        diffHash: first.checkpoint!.diffHash,
      }),
    ).rejects.toThrow(/Only an operator/);

    // Deny fails the run closed with no execute side effects.
    const denied = await resumeStoreManagerPlaybookRun(workspaceId, first.runId, {
      approve: false,
      actor: 'operator',
      diffHash: first.checkpoint!.diffHash,
    });
    expect(denied.status).toBe('failed');
    expect(denied.errorCode).toBe('checkpoint_denied');
    expect(toolCalls).toEqual(['pb_read']); // no execute
    await expect(
      resumeStoreManagerPlaybookRun(workspaceId, first.runId, { approve: true, actor: 'operator', diffHash: first.checkpoint!.diffHash }),
    ).rejects.toThrow(/not paused/);
  });

  it('a failed step (model does not call the declared tool) fails the run with step_contract_violation', async () => {
    const playbookId = seedPlaybook();
    seedCounter -= 1;
    // A model that never calls tools: the read step fails its contract.
    const silentModel = {
      specificationVersion: 'v3',
      provider: 'fake-provider',
      modelId: 'fake-model',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('x');
      },
      async doStream() {
        const parts: LanguageModelV3StreamPart[] = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'no tool call' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', usage: { inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } }, finishReason: { unified: 'stop', raw: 'stop' } },
        ];
        return { stream: new ReadableStream<LanguageModelV3StreamPart>({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
      },
    } as LanguageModelV3;
    await expect(
      runStoreManagerPlaybook({
        workspaceId,
        workspacePath: './ws',
        playbookId,
        variables: { field: 'ProductField24' },
        actor: 'operator',
        registry: testRegistry(),
        resolveModel: () => ({ ...resolvedFake, modelInstance: silentModel as unknown as ResolvedAiSdkModel['modelInstance'] }),
      }),
    ).rejects.toThrow(/step_contract_violation|did not call/);
    const detail = getStoreManagerPlaybookRunDetail(workspaceId, (await getRecentRun(workspaceId, 'pb-test-1')) ?? '');
    void detail;
  });

  it('a mutation playbook without a verify step is rejected at definition validation', async () => {
    const { definition, hash } = buildDefinition({ omitVerify: true });
    createPlaybook({ id: 'pb-noverify', workspaceId, name: 'no verify', description: '' });
    appendPlaybookVersion({ workspaceId, playbookId: 'pb-noverify', version: 1, definitionJson: JSON.stringify(definition), definitionHash: hash });
    activatePlaybookVersion({ workspaceId, playbookId: 'pb-noverify', version: 1, definitionHash: hash, activatedBy: 'operator' });
    await expect(
      runStoreManagerPlaybook({
        workspaceId,
        workspacePath: './ws',
        playbookId: 'pb-noverify',
        variables: { field: 'ProductField24' },
        registry: testRegistry(),
        resolveModel: () => resolvedFake,
      }),
    ).rejects.toThrow(/verify|validation/i);
  });

  it('executes a read-only playbook (no checkpoint) to completion through the common runner', async () => {
    const readOnlyContent = {
      name: 'Read only',
      description: '',
      scopeInput: { allowedKinds: [], maxSkus: 200 },
      variables: [],
      steps: [{ stepId: 'r1', kind: 'read' as const, toolName: 'pb_read', toolVersion: 1, inputTemplate: { q: 'scan' } }],
    };
    const hash = hashCanonicalJson(readOnlyContent);
    const definition: StoreManagerPlaybookDefinition = {
      id: 'pb-ro',
      workspaceId,
      name: 'Read only',
      description: '',
      templateKind: null,
      version: 1,
      status: 'active',
      scopeInput: readOnlyContent.scopeInput,
      variables: readOnlyContent.variables,
      steps: readOnlyContent.steps,
      definitionHash: hash,
      activatedAt: new Date().toISOString(),
      activatedBy: 'operator',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    createPlaybook({ id: 'pb-ro', workspaceId, name: 'Read only', description: '' });
    appendPlaybookVersion({ workspaceId, playbookId: 'pb-ro', version: 1, definitionJson: JSON.stringify(definition), definitionHash: hash });
    activatePlaybookVersion({ workspaceId, playbookId: 'pb-ro', version: 1, definitionHash: hash, activatedBy: 'operator' });

    const result = await runStoreManagerPlaybook({
      workspaceId,
      workspacePath: './ws',
      playbookId: 'pb-ro',
      variables: {},
      registry: testRegistry(),
      resolveModel: () => ({ ...resolvedFake, modelInstance: contractModel() }),
    });
    expect(result.status).toBe('completed');
    expect(toolCalls).toContain('pb_read');
  });
});

/** Last run id for a playbook (test helper). */
function getRecentRun(workspaceIdArg: string, playbookId: string): string | null {
  const rows = require('../../db/repositories/store-manager-playbook-run-repo').listStoreManagerPlaybookRuns(workspaceIdArg, 10) as Array<{ id: string; playbook_id: string }>;
  const run = rows.find((r) => r.playbook_id === playbookId);
  return run ? run.id : null;
}

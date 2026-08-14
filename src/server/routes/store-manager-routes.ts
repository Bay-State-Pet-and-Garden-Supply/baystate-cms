import { Hono, type Context } from 'hono';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { getCurrentWorkspace } from '../services/workspace-service';
import { generateProductFieldAuditReport } from '../services/catalog-insight-service';
import {
  generateDeterministicProposals,
  listProposals,
  getProposalById,
  applyProposal,
  dismissProposal,
  ProposalNotFoundError,
} from '../services/product-field-refactor-service';
import {
  generateAiProposals,
  ProposalFieldScopeError,
  AiProposalValidationError,
  type GenerateAiProposalsResult,
} from '../services/store-manager-assistant-service';
import { generateStoreManagerReport } from '../services/store-manager-report';
import { StoreManagerReportRequestSchema } from '../../shared/schemas/store-manager-report';
import { listUsableStoreManagerModels, ModelUnavailableError } from '../services/ai-sdk-model-resolver';
import { createUIMessageStreamResponse } from 'ai';
import {
  saveChatMessage,
  getChatHistory,
  getChatThreads,
  clearChatHistory,
  pruneOldChatHistory,
} from '../services/store-manager-chat-history-service';
import {
  insertStoreManagerUnavailableCall,
  sanitizeChatMessagesForPersistence,
} from '../services/store-manager-telemetry';
import { runStoreManagerTurn, runStoreManagerExecution, StoreManagerTurnError } from '../../store-manager/runtime/executor';
import { createStoreManagerExecutionRequest } from '../../store-manager/runtime/execution-request';
import {
  compileStoreManagerCommand,
  StoreManagerCommandCompileError,
} from '../../store-manager/commands/compiler';import { describeStoreManagerCommands } from '../../store-manager/commands/registry';
import {
  StoreManagerCommandCompileRequestSchema,
  StoreManagerCommandExecuteRequestSchema,
  StoreManagerCommandResultSchema,
  type StoreManagerCommandToolOutcome,
} from '../../shared/schemas/store-manager-command';
import {
  StoreManagerScopePinRequestSchema,
  type StoreManagerResolvedScope,
} from '../../shared/schemas/store-manager-scope';
import {
  resolveStoreManagerScopeRequest,
  StoreManagerScopeError,
} from '../services/store-manager-scope-service';
import {
  saveStoreManagerPreference,
  getActivePreferenceRevisionRow,
  listStoreManagerPreferenceRevisions,
} from '../services/store-manager-preference-service';
import {
  StoreManagerPreferenceSaveRequestSchema,
  StoreManagerPreferenceValidationError,
} from '../../shared/schemas/store-manager-preferences';
import { listRegistry } from '../../db/repositories/field-registry-repo';
import { StoreManagerChatRequestSchema } from '../../shared/schemas/store-manager';
import {
  runStoreManagerPlaybook,
  resumeStoreManagerPlaybookRun,
  getStoreManagerPlaybookRunDetail,
  StoreManagerPlaybookRunError,
} from '../../store-manager/playbooks/runner';
import { createStoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import { computeAdapterPreviewDiff } from '../../store-manager/runtime/action-preview';
import {
  listRunHistory,
  getRunHistoryDetail,
  toHistoryRun,
  recordReviewDecision,
} from '../../db/repositories/store-manager-history-repo';
import { replayStoreManagerRun, StoreManagerReplayError } from '../services/store-manager-replay-service';
import { compareStoreManagerRuns, StoreManagerComparisonError } from '../services/store-manager-comparison-service';
import { executeHistoryQuery, StoreManagerHistoryQueryError } from '../services/store-manager-history-query-service';
import { describeHistoryQueries } from '../../store-manager/history/query-registry';
import {
  StoreManagerReplayRequestSchema,
  StoreManagerCompareRequestSchema,
  StoreManagerHistoryQueryRequestSchema,
  StoreManagerRunHistoryListSchema,
  StoreManagerRunHistoryDetailSchema,
} from '../../shared/schemas/store-manager-history';
import { StoreManagerActionDiffSchema } from '../../shared/schemas/store-manager-diff';
import {
  createTriggerFromTemplate,
  listTriggersForWorkspace,
  getTriggerForWorkspace,
  updateTriggerForWorkspace,
  setTriggerEnabledForWorkspace,
  runTriggerNowReadOnly,
} from '../services/store-manager-trigger-service';
import { listOccurrencesByTrigger } from '../../db/repositories/store-manager-trigger-repo';
import { listTriggerTemplates } from '../../store-manager/events/trigger-registry';
import {
  StoreManagerTriggerCreateRequestSchema,
  StoreManagerTriggerUpdateRequestSchema,
  StoreManagerTriggerRunNowRequestSchema,
  StoreManagerTriggerOccurrenceListQuerySchema,
} from '../../shared/schemas/store-manager-trigger';
import {
  previewBulkReviewBatch,
  revalidateBulkReviewBatch,
  denyBulkReviewBatch,
  BulkReviewError,
  BulkReviewDisabledError,
} from '../services/store-manager-bulk-review-service';
import {
  listBulkReviewBatches,
  findBulkReviewBatch,
  listBulkReviewBatchItems,
} from '../../db/repositories/store-manager-bulk-review-repo';
import {
  StoreManagerBulkReviewPreviewRequestSchema,
  StoreManagerBulkReviewDenyRequestSchema,
} from '../../shared/schemas/store-manager-bulk-review';
import { getStoreManagerFlags } from '../../store-manager/flags';
import {
  createPlaybookFromTemplate,
  listPlaybooks,
  getPlaybook,
  getPlaybookVersions,
  getPlaybookVersion,
  savePlaybookDraft,
  activatePlaybook,
  StoreManagerPlaybookError,
} from '../services/store-manager-playbook-service';
import {
  StoreManagerPlaybookCreateRequestSchema,
  StoreManagerPlaybookSaveDraftRequestSchema,
  StoreManagerPlaybookActivateRequestSchema,
} from '../../shared/schemas/store-manager-playbook';
import { describeStoreManagerPlaybookTemplates } from '../../store-manager/playbooks/templates';
import { StoreManagerPlaybookValidationError } from '../../store-manager/playbooks/contracts';
import type { UIMessage } from 'ai';
import {
  reconcileInbox,
  openInboxItem,
  acknowledgeInboxItemForWorkspace,
  resolveInboxItemForWorkspace,
  listInboxItemsForWorkspace,
} from '../services/store-manager-inbox-service';
import {
  evaluateNotificationRules,
  listNotificationsForWorkspace,
  countUnreadNotificationsForWorkspace,
} from '../services/store-manager-notification-service';
import {
  StoreManagerInboxLifecycleSchema,
  type StoreManagerInboxLifecycle,
} from '../../shared/schemas/store-manager-inbox';
import storeManagerEventsRoutes from './store-manager-events-routes';

const route = new Hono();

/**
 * HMAC secret for tool-approval signatures (epic #42, #34).
 *
 * A process-random secret is generated once at startup unless the operator
 * pins one via BAYSTATE_CMS_STORE_MANAGER_APPROVAL_SECRET. The AI SDK signs
 * each approval request with this secret and verifies the signature when the
 * client resubmits the approval response, so a client-forged or replayed
 * approval fails closed. A restart rotates the secret, which invalidates any
 * pending approvals (the operator simply re-sends the message). The secret is
 * never logged, sent to the client, or persisted.
 */
const toolApprovalSecret =
  process.env.BAYSTATE_CMS_STORE_MANAGER_APPROVAL_SECRET ?? randomBytes(32).toString('hex');


/**
 * GET /api/store-manager/models
 * Server-owned descriptor list of usable Store Manager models. The picker
 * must render exactly this list; credentials/base URLs are never returned.
 */
route.get('/store-manager/models', (c) => {
  try {
    return c.json(listUsableStoreManagerModels());
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/store-manager/chat
 * Streams AI Store Manager Assistant chat responses with tool executions.
 * The route validates/authenticates, then delegates ALL orchestration
 * (model resolution, message validation, prompt, tools, approval wiring,
 * telemetry, events, terminalization) to the bounded runtime executor.
 */
route.post('/store-manager/chat', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid chat request.', details: parsed.error.flatten() },
      400,
    );
  }
  const { messages, selectedSkus, selectedModel, threadId, pinnedScope } = parsed.data;

  try {
    // Pinned conversational scope (Issue 2): resolve + workspace-check before
    // the run; a foreign/invalid scope fails closed (never silently widened).
    const resolvedScope = pinnedScope
      ? resolveStoreManagerScopeRequest(workspace.id, pinnedScope)
      : null;
    const result = await runStoreManagerTurn({
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      threadId: threadId ?? null,
      messages,
      selectedSkus,
      selectedModel,
      abortSignal: c.req.raw.signal,
      toolApprovalSecret,
      pinnedScope: resolvedScope?.pinnedScope ?? undefined,
    });
    return createUIMessageStreamResponse({
      stream: result.uiMessageStream,
    });
  } catch (err) {
    if (err instanceof StoreManagerScopeError) {
      return c.json({ error: err.message, errorCode: err.code }, 400);
    }
    if (err instanceof ModelUnavailableError) {
      // Explicit unavailability fails before streaming and names the
      // corrective setting without exposing secrets. No transport attempt:
      // record a single terminal `unavailable` telemetry row, never a
      // fallback row.
      insertStoreManagerUnavailableCall(
        workspace.id,
        typeof selectedModel === 'string' ? selectedModel : undefined,
      );
      return c.json({ error: err.message, errorCode: 'model_unavailable' }, 400);
    }
    if (err instanceof StoreManagerTurnError) {
      return c.json({ error: err.message, errorCode: err.code }, 400);
    }
    console.error('[StoreManagerChat] Error during streaming:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/store-manager/insights
 * Retrieve read-only ProductField audit report.
 */
route.get('/store-manager/insights', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const field = c.req.query('field') || 'ProductField24';
  try {
    const report = generateProductFieldAuditReport(workspace.id, field);
    return c.json(report);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/store-manager/proposals
 * List proposals with optional field and status filters.
 */
route.get('/store-manager/proposals', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const field = c.req.query('field');
  const status = c.req.query('status');

  try {
    const proposals = listProposals(workspace.id, { field, status });
    return c.json({ proposals });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/store-manager/proposals/generate
 * Generate new proposals (deterministic or AI-assisted) for a field.
 */
route.post('/store-manager/proposals/generate', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const field = body.field || 'ProductField24';
    const useAi = !!body.useAi;

    let proposals: GenerateAiProposalsResult | null = null;
    if (useAi) {
      try {
        proposals = await generateAiProposals(workspace.id, field);
      } catch (err) {
        if (err instanceof ProposalFieldScopeError) {
          return c.json({ error: err.message, errorCode: err.code }, 400);
        }
        if (err instanceof AiProposalValidationError) {
          return c.json(
            { error: err.message, errorCode: err.errorCode, diagnostics: err.diagnostics },
            422,
          );
        }
        throw err;
      }
      return c.json({ success: true, proposals: proposals.proposals, diagnostics: proposals.diagnostics });
    }
    const deterministic = generateDeterministicProposals(workspace.id, field);
    return c.json({ success: true, proposals: deterministic });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/store-manager/proposals/:id
 * Retrieve a specific proposal details.
 */
route.get('/store-manager/proposals/:id', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const id = c.req.param('id');
  try {
    const proposal = getProposalById(workspace.id, id);
    if (!proposal) {
      return c.json({ error: 'Proposal not found.' }, 404);
    }
    return c.json(proposal);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/store-manager/proposals/:id/apply
 * Apply the selected proposal, staging the updates in the active change set.
 */
route.post('/store-manager/proposals/:id/apply', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const id = c.req.param('id');
  try {
    const result = applyProposal(workspace.id, workspace.workspacePath, id);
    return c.json({ success: true, changeSetId: result.changeSetId });
  } catch (err) {
    if (err instanceof ProposalNotFoundError) {
      return c.json({ error: 'Proposal not found.' }, 404);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/store-manager/proposals/:id/dismiss
 * Dismiss the selected proposal.
 */
route.post('/store-manager/proposals/:id/dismiss', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const id = c.req.param('id');
  try {
    dismissProposal(workspace.id, id);
    // Durable review decision (Issue 7) for the bounded history queries
    // (proposals-rejected-more-than-once) and per-item audit.
    const proposal = getProposalById(workspace.id, id);
    recordReviewDecision({
      workspaceId: workspace.id,
      proposalId: id,
      field: proposal?.field ?? 'unknown',
      decision: 'dismissed',
      actor: 'operator',
    });
    return c.json({ success: true });
  } catch (err) {
    if (err instanceof ProposalNotFoundError) {
      return c.json({ error: 'Proposal not found.' }, 404);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/store-manager/report
 * Retrieve AI Assistant notes and cleanup report.
 */
/**
 * GET /api/store-manager/chat/threads
 * Retrieve all active chat threads in the last 7 days.
 */
route.get('/store-manager/chat/threads', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ threads: [] });
  }

  try {
    // Automatically prune old chat history
    pruneOldChatHistory();
    const threads = getChatThreads(workspace.id);
    return c.json({ threads });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/store-manager/chat/:threadId
 * Retrieve stored messages for a specific chat thread.
 */
route.get('/store-manager/chat/:threadId', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ messages: [] });
  }

  const threadId = c.req.param('threadId');
  try {
    const history = getChatHistory(workspace.id, threadId);
    return c.json({ messages: history });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/store-manager/chat/:threadId/save
 * Save the entire chat messages list to a specific thread.
 */
route.post('/store-manager/chat/:threadId/save', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const threadId = c.req.param('threadId');
  try {
    const { messages, threadTitle } = await c.req.json().catch(() => ({ messages: [], threadTitle: '' }));

    // Server-side telemetry reconstruction: the client is never trusted with
    // usage totals/provider/model. Assistant-message metadata is re-hydrated
    // from the workspace-owned ai_model_calls row by call id; forged, stale,
    // or foreign call ids are stripped.
    const sanitized = sanitizeChatMessagesForPersistence(workspace.id, messages);

    clearChatHistory(workspace.id, threadId);
    for (const msg of sanitized) {
      saveChatMessage(
        workspace.id,
        threadId,
        threadTitle,
        String(msg.id),
        msg.role as 'user' | 'assistant',
        msg as unknown as UIMessage,
      );
    }
    return c.json({ success: true, saved: sanitized.length });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * DELETE /api/store-manager/chat/:threadId
 * Clear all messages in a specific thread.
 */
route.delete('/store-manager/chat/:threadId', (c) => {
  const workspace = getCurrentWorkspace();
  const threadId = c.req.param('threadId');
  if (workspace && threadId) {
    clearChatHistory(workspace.id, threadId);
  }
  return c.json({ success: true });
});

route.get('/store-manager/report', (c) => {
  // Report generation triggers evidence collection and possibly a billable
  // model narrative; it is an action, not a read (epic #42, #38).
  return c.json(
    { error: 'Method Not Allowed: report generation is a POST action.' },
    405,
  );
});

route.post('/store-manager/report', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerReportRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid report request.', details: parsed.error.flatten() }, 400);
  }

  try {
    const report = await generateStoreManagerReport(
      workspace.id,
      workspace.workspacePath,
      parsed.data,
    );
    return c.json(report);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Operations console — Issue 2: slash commands, /plan, pinned scope, and
// explicit preferences. Every command compiles server-side and executes
// through runStoreManagerExecution — never a direct service call.
// ---------------------------------------------------------------------------

/** Server-owned registry resolver (tool/version drift fails before runner). */
const commandRegistry = createStoreManagerToolRegistry();
const resolveToolVersion = (name: string): number | undefined => commandRegistry.get(name)?.version;

/** Compile + resolve scope + tool/scope compatibility (shared by endpoints). */
function compileAndResolve(
  workspaceId: string,
  raw: string,
  pinnedScope: unknown,
): { compiled: ReturnType<typeof compileStoreManagerCommand>; resolvedScope: StoreManagerResolvedScope | null } {
  const compiled = compileStoreManagerCommand(raw, {
    pinnedScope: pinnedScope as never ?? null,
    resolveToolVersion,
  });
  const effectiveScope = compiled.scopeHint;
  const resolvedScope = effectiveScope ? resolveStoreManagerScopeRequest(workspaceId, effectiveScope) : null;
  // Tool/scope compatibility: a hinted tool that cannot honor the resolved
  // scope fails at compile time (scope_unsupported) before any execution.
  if (resolvedScope) {
    for (const hint of compiled.expectedToolHints) {
      const adapter = commandRegistry.get(hint.name);
      if (adapter && adapter.supportedScopes !== undefined && !adapter.supportedScopes.includes(resolvedScope.pinnedScope.kind)) {
        throw new StoreManagerCommandCompileError(
          'scope_unsupported',
          `Tool "${hint.name}" cannot run under the pinned ${resolvedScope.pinnedScope.kind} scope.`,
        );
      }
    }
  }
  return { compiled, resolvedScope };
}

function commandErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof StoreManagerCommandCompileError) {
    return c.json({ ok: false, errorCode: err.code, error: err.message }, 400);
  }
  if (err instanceof StoreManagerScopeError) {
    return c.json({ ok: false, errorCode: err.code, error: err.message }, 400);
  }
  console.error('[StoreManagerCommands] Compile/execute error:', err);
  return c.json({ ok: false, errorCode: 'command_failed', error: err instanceof Error ? err.message : String(err) }, 400);
}

/**
 * GET /api/store-manager/commands
 * Server-owned palette descriptors (the client never keeps a command catalog).
 */
route.get('/store-manager/commands', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  // Enrich value-arg suggestions with registered ProductFields (bounded).
  const fields = listRegistry(workspace.id)
    .map((f) => f.xmlField)
    .slice(0, 50);
  const descriptors = describeStoreManagerCommands().map((desc) => ({
    ...desc,
    argSpecs: desc.argSpecs.map((arg) =>
      arg.label === 'ProductField' ? { ...arg, suggestions: fields } : arg,
    ),
  }));
  return c.json({ commands: descriptors });
});

/**
 * POST /api/store-manager/commands/compile
 * Compile + validate a raw command line. Zero execution: no model, no tool,
 * no repository collector, no network, no mutation.
 */
route.post('/store-manager/commands/compile', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerCommandCompileRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid command compile request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const { compiled, resolvedScope } = compileAndResolve(
      workspace.id,
      parsed.data.raw,
      parsed.data.pinnedScope ?? null,
    );
    return c.json({ ok: true, compiled, resolvedScope });
  } catch (err) {
    return commandErrorResponse(c, err);
  }
});

/**
 * POST /api/store-manager/commands/execute
 * Execute a compiled command through runStoreManagerExecution (drained) or,
 * with mode 'plan', return the zero-execution preview descriptor. Commands
 * cannot bypass policy/approval: persistent adapters are denied at dispatch
 * (approval_required) and /plan executes nothing at all.
 */
route.post('/store-manager/commands/execute', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerCommandExecuteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid command execute request.', details: parsed.error.flatten() }, 400);
  }

  try {
    const { compiled, resolvedScope } = compileAndResolve(
      workspace.id,
      parsed.data.raw,
      parsed.data.pinnedScope ?? null,
    );
    const lineage = { commandName: compiled.commandName, commandVersion: compiled.commandVersion };

    if (parsed.data.mode === 'plan') {
      const request = createStoreManagerExecutionRequest({
        workspaceId: workspace.id,
        workspacePath: workspace.workspacePath,
        threadId: null,
        entrypoint: 'plan_preview',
        executionMode: 'preview',
        objective: compiled.objective,
        pinnedScope: resolvedScope?.pinnedScope,
        lineage,
        selectedModel: parsed.data.selectedModel,
      });
      const result = await runStoreManagerExecution(request);
      if (result.kind !== 'preview') {
        return c.json({ ok: false, errorCode: 'plan_failed', error: 'Plan preview did not produce a descriptor.' }, 500);
      }
      return c.json({ ok: true, runId: result.runId, turnId: result.turnId, plan: result.preview });
    }

    const request = createStoreManagerExecutionRequest({
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      threadId: null,
      entrypoint: 'command',
      executionMode: 'interactive',
      objective: compiled.objective,
      pinnedScope: resolvedScope?.pinnedScope,
      lineage,
      selectedModel: parsed.data.selectedModel,
    });
    const result = await runStoreManagerExecution(request);
    if (result.kind !== 'completed') {
      return c.json({ ok: false, errorCode: 'command_failed', error: 'Command execution did not complete.' }, 500);
    }
    const commandResult = {
      ok: true as const,
      runId: result.runId,
      turnId: result.turnId,
      terminalStatus: result.terminalStatus,
      outcomeReason: null as string | null,
      modelCallId: result.modelCallId,
      text: result.output?.text ?? '',
      toolResults: (result.output?.toolResults ?? []).map((t) => ({
        toolCallId: t.toolCallId,
        toolName: t.toolName,
        status: t.status,
        output: t.output,
        errorText: t.errorText,
      })) as StoreManagerCommandToolOutcome[],
    };
    const validated = StoreManagerCommandResultSchema.safeParse(commandResult);
    if (!validated.success) {
      return c.json({ ok: false, errorCode: 'command_result_invalid', error: 'Command result failed validation.' }, 500);
    }
    return c.json(validated.data);
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return c.json({ ok: false, errorCode: 'model_unavailable', error: err.message }, 400);
    }
    return commandErrorResponse(c, err);
  }
});

/**
 * POST /api/store-manager/scope
 * Validate + resolve a pinned scope (client-held pin). Passing null clears
 * the pin. Never persists; scope is explicit per request.
 */
route.post('/store-manager/scope', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerScopePinRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid scope pin request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const resolved = resolveStoreManagerScopeRequest(workspace.id, parsed.data.scope);
    return c.json({ ok: true, resolvedScope: resolved });
  } catch (err) {
    if (err instanceof StoreManagerScopeError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, 400);
    }
    return c.json({ ok: false, errorCode: 'scope_failed', error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * GET /api/store-manager/preferences
 * Active preference revision + recent immutable revisions (Settings UI).
 */
route.get('/store-manager/preferences', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const active = getActivePreferenceRevisionRow(workspace.id);
  const revisions = listStoreManagerPreferenceRevisions(workspace.id, 50);
  return c.json({ active, revisions });
});

/**
 * POST /api/store-manager/preferences
 * Save a new immutable preference revision (Settings-only; the model has no
 * preference tool and chat is never parsed into preferences).
 */
route.post('/store-manager/preferences', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerPreferenceSaveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid preference save request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const saved = saveStoreManagerPreference(workspace.id, parsed.data.content, 'operator');
    return c.json({ ok: true, revision: saved.revision, unknownSkus: saved.unknownSkus });
  } catch (err) {
    if (err instanceof StoreManagerPreferenceValidationError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, 400);
    }
    return c.json({ ok: false, errorCode: 'preference_failed', error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Operations console — Issue 3: Manager Inbox + notifications.
// The Inbox is one workspace-scoped triage queue. Counts are re-derived from
// authoritative sources on every reconcile; opening an item re-validates
// against current state. The model has NO tool to create, acknowledge,
// resolve, or hide Inbox items — only operators through these routes.
// ---------------------------------------------------------------------------

/**
 * POST /api/store-manager/inbox/reconcile
 * Re-derive the deterministic inbox candidates and reconcile lifecycle rows,
 * then evaluate threshold notification rules. Idempotent; never mutates
 * onboarding or catalog state.
 */
route.post('/store-manager/inbox/reconcile', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  try {
    const reconciled = reconcileInbox(workspace.id);
    const evaluation = evaluateNotificationRules(workspace.id);
    return c.json({
      ok: true,
      ...reconciled,
      emittedNotifications: evaluation.emitted,
      latestNotificationSequence: evaluation.latestSequence,
    });
  } catch (err) {
    console.error('[StoreManagerInbox] Reconcile error:', err);
    return c.json({ ok: false, errorCode: 'reconcile_failed', error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/store-manager/inbox
 * List inbox items (optionally filtered by lifecycle), bounded. Counts are
 * display values; current authority is re-read on open (:id).
 */
route.get('/store-manager/inbox', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const lifecycleRaw = c.req.query('lifecycle');
  const lifecycle: StoreManagerInboxLifecycle | null = lifecycleRaw
    ? StoreManagerInboxLifecycleSchema.safeParse(lifecycleRaw).success
      ? (lifecycleRaw as StoreManagerInboxLifecycle)
      : null
    : null;
  const limitRaw = c.req.query('limit');
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(Math.max(Number(limitRaw), 1), 200) : 100;
  try {
    const items = listInboxItemsForWorkspace(workspace.id, { lifecycle, limit });
    const openCount = listInboxItemsForWorkspace(workspace.id, { lifecycle: 'open', limit: 200 }).length;
    return c.json({ items, openCount });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/store-manager/inbox/:id
 * Open an inbox item AND re-validate it against the current authoritative
 * source. A stale row stays auditable but `isCurrent: false` — it must never
 * be treated as current authority or used to approve work.
 */
route.get('/store-manager/inbox/:id', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid inbox item id.' }, 400);
  try {
    const result = openInboxItem(workspace.id, id);
    if (!result) return c.json({ error: 'Inbox item not found.' }, 404);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** POST /api/store-manager/inbox/:id/acknowledge — operator ack (no catalog effect). */
route.post('/store-manager/inbox/:id/acknowledge', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid inbox item id.' }, 400);
  const updated = acknowledgeInboxItemForWorkspace(workspace.id, id);
  if (!updated) return c.json({ error: 'Inbox item not found or not actionable.' }, 404);
  return c.json({ ok: true, item: updated });
});

/** POST /api/store-manager/inbox/:id/resolve — operator resolve (no catalog effect). */
route.post('/store-manager/inbox/:id/resolve', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid inbox item id.' }, 400);
  const updated = resolveInboxItemForWorkspace(workspace.id, id);
  if (!updated) return c.json({ error: 'Inbox item not found or not actionable.' }, 404);
  return c.json({ ok: true, item: updated });
});

/**
 * GET /api/store-manager/notifications — bounded notification list + unread.
 */
route.get('/store-manager/notifications', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const afterRaw = c.req.query('afterSequence');
  const afterSequence = afterRaw && /^\d+$/.test(afterRaw) ? Number(afterRaw) : 0;
  try {
    return c.json({
      notifications: listNotificationsForWorkspace(workspace.id, { afterSequence, limit: 100 }),
      unread: countUnreadNotificationsForWorkspace(workspace.id),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Issue 3 events routes (notifications + SSE) mounted under /store-manager so
// the full paths stay /api/store-manager/notifications[...].
route.route('/store-manager', storeManagerEventsRoutes);

// ---------------------------------------------------------------------------
// Operations console — Issue 4: leased scheduled read-only runs.
// Schedules enter runStoreManagerExecution with entrypoint 'schedule' and the
// unattended read-only policy; the runtime denies persistent adapters at
// dispatch. Automation stays inert while schedulesEnabled is false or the
// kill switch is on; reads/history remain available under the kill switch.
// ---------------------------------------------------------------------------

import {
  createScheduleFromTemplate,
  listSchedulesForWorkspace,
  getScheduleForWorkspace,
  updateScheduleForWorkspace,
  setScheduleEnabledForWorkspace,
  runNowReadOnly,
} from '../services/store-manager-schedule-service';
import { listOccurrencesBySchedule } from '../../db/repositories/store-manager-schedule-repo';
import { listScheduleTemplates } from '../../store-manager/schedules/templates';
import {
  StoreManagerScheduleCreateRequestSchema,
  StoreManagerScheduleUpdateRequestSchema,
  StoreManagerScheduleRunNowRequestSchema,
  StoreManagerOccurrenceListQuerySchema,
} from '../../shared/schemas/store-manager-schedule';

/**
 * GET /api/store-manager/schedules — workspace-scoped schedule list. Read
 * access stays available under the kill switch (history/inbox reads only).
 */
route.get('/store-manager/schedules', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const schedules = listSchedulesForWorkspace(workspace.id);
  return c.json({ schedules });
});

/**
 * POST /api/store-manager/schedules — create a schedule from a locked
 * template. Schedules are created disabled (automation inert until enabled).
 */
route.post('/store-manager/schedules', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerScheduleCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid schedule create request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = createScheduleFromTemplate(workspace.id, parsed.data);
    return c.json({ ok: true, schedule: result.schedule, nextRunAt: result.nextRunAt });
  } catch (err) {
    return c.json({ ok: false, errorCode: 'schedule_create_failed', error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * GET /api/store-manager/schedules/templates — server-owned template list.
 */
route.get('/store-manager/schedules/templates', (c) => {
  return c.json({ templates: listScheduleTemplates() });
});

/**
 * GET /api/store-manager/schedules/:id — schedule detail.
 */
route.get('/store-manager/schedules/:id', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid schedule id.' }, 400);
  const schedule = getScheduleForWorkspace(workspace.id, id);
  if (!schedule) return c.json({ error: 'Schedule not found.' }, 404);
  return c.json({ schedule });
});

/**
 * POST /api/store-manager/schedules/:id — update editable fields (new
 * immutable definition version; no cron/code).
 */
route.post('/store-manager/schedules/:id', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid schedule id.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerScheduleUpdateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid schedule update request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const schedule = updateScheduleForWorkspace(workspace.id, id, parsed.data);
    return c.json({ ok: true, schedule });
  } catch (err) {
    return c.json({ ok: false, errorCode: 'schedule_update_failed', error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * POST /api/store-manager/schedules/:id/enable — explicitly enable (gated by
 * schedulesEnabled flag; automation inert otherwise).
 */
route.post('/store-manager/schedules/:id/enable', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.schedulesEnabled) {
    return c.json({ ok: false, errorCode: 'not_configured', error: 'Scheduled runs are disabled (flag or kill switch).' }, 409);
  }
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid schedule id.' }, 400);
  const schedule = setScheduleEnabledForWorkspace(workspace.id, id, true, 'operator');
  if (!schedule) return c.json({ error: 'Schedule not found.' }, 404);
  return c.json({ ok: true, schedule });
});

/**
 * POST /api/store-manager/schedules/:id/disable — explicitly disable.
 */
route.post('/store-manager/schedules/:id/disable', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid schedule id.' }, 400);
  const schedule = setScheduleEnabledForWorkspace(workspace.id, id, false, 'operator');
  if (!schedule) return c.json({ error: 'Schedule not found.' }, 404);
  return c.json({ ok: true, schedule });
});

/**
 * POST /api/store-manager/schedules/:id/run-now — synchronous READ-ONLY run
 * through the common unattended runtime. Not an approval shortcut; gated by
 * the schedulesEnabled flag and kill switch.
 */
route.post('/store-manager/schedules/:id/run-now', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.schedulesEnabled) {
    return c.json({ ok: false, errorCode: 'not_configured', error: 'Scheduled runs are disabled (flag or kill switch).' }, 409);
  }
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid schedule id.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerScheduleRunNowRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid run-now request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = await runNowReadOnly(workspace.id, id, {
      workspacePath: workspace.workspacePath,
      selectedModel: parsed.data.selectedModel,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return c.json({ ok: false, errorCode: 'model_unavailable', error: err.message }, 400);
    }
    return c.json({ ok: false, errorCode: 'run_now_failed', error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * GET /api/store-manager/schedules/:id/occurrences — bounded occurrence
 * history (read access stays available under kill switch).
 */
route.get('/store-manager/schedules/:id/occurrences', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid schedule id.' }, 400);
  const query = StoreManagerOccurrenceListQuerySchema.safeParse({
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    status: c.req.query('status') ?? undefined,
  });
  const limit = query.success ? query.data.limit ?? 50 : 50;
  const status = query.success ? query.data.status : undefined;
  const occurrences = listOccurrencesBySchedule(workspace.id, id, { limit, status });
  return c.json({ occurrences });
});

// ---------------------------------------------------------------------------
// Operations console — Issue 5: durable event-triggered read-only runs.
// Triggers observe committed durable state and every occurrence enters
// runStoreManagerExecution with entrypoint 'event' and the unattended
// read-only policy. Automation stays inert while eventTriggersEnabled is
// false or the kill switch is on; reads/history remain available under the
// kill switch.
// ---------------------------------------------------------------------------

/**
 * GET /api/store-manager/triggers — workspace-scoped trigger list. Read
 * access stays available under the kill switch (history/inbox reads only).
 */
route.get('/store-manager/triggers', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const triggers = listTriggersForWorkspace(workspace.id);
  return c.json({ triggers });
});

/**
 * POST /api/store-manager/triggers — create a trigger from one of the four
 * locked templates. Triggers are created disabled (automation inert until
 * enabled). Gated by the eventTriggersEnabled flag and kill switch.
 */
route.post('/store-manager/triggers', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.eventTriggersEnabled) {
    return c.json({ ok: false, errorCode: 'not_configured', error: 'Event triggers are disabled (flag or kill switch).' }, 409);
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerTriggerCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid trigger create request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = createTriggerFromTemplate(workspace.id, parsed.data);
    return c.json({ ok: true, trigger: result.trigger });
  } catch (err) {
    return c.json({ ok: false, errorCode: 'trigger_create_failed', error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * GET /api/store-manager/triggers/templates — server-owned template list.
 */
route.get('/store-manager/triggers/templates', (c) => {
  return c.json({ templates: listTriggerTemplates() });
});

/**
 * GET /api/store-manager/triggers/:id — trigger detail.
 */
route.get('/store-manager/triggers/:id', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid trigger id.' }, 400);
  const trigger = getTriggerForWorkspace(workspace.id, id);
  if (!trigger) return c.json({ error: 'Trigger not found.' }, 404);
  return c.json({ trigger });
});

/**
 * POST /api/store-manager/triggers/:id — update editable fields (new
 * immutable definition version; kind is immutable).
 */
route.post('/store-manager/triggers/:id', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid trigger id.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerTriggerUpdateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid trigger update request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const trigger = updateTriggerForWorkspace(workspace.id, id, parsed.data);
    return c.json({ ok: true, trigger });
  } catch (err) {
    return c.json({ ok: false, errorCode: 'trigger_update_failed', error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * POST /api/store-manager/triggers/:id/enable — explicitly enable (gated by
 * the eventTriggersEnabled flag; automation inert otherwise).
 */
route.post('/store-manager/triggers/:id/enable', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.eventTriggersEnabled) {
    return c.json({ ok: false, errorCode: 'not_configured', error: 'Event triggers are disabled (flag or kill switch).' }, 409);
  }
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid trigger id.' }, 400);
  const trigger = setTriggerEnabledForWorkspace(workspace.id, id, true, 'operator');
  if (!trigger) return c.json({ error: 'Trigger not found.' }, 404);
  return c.json({ ok: true, trigger });
});

/**
 * POST /api/store-manager/triggers/:id/disable — explicitly disable.
 */
route.post('/store-manager/triggers/:id/disable', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid trigger id.' }, 400);
  const trigger = setTriggerEnabledForWorkspace(workspace.id, id, false, 'operator');
  if (!trigger) return c.json({ error: 'Trigger not found.' }, 404);
  return c.json({ ok: true, trigger });
});

/**
 * POST /api/store-manager/triggers/:id/run-now — synchronous READ-ONLY run
 * through the common unattended runtime. Not an approval shortcut; gated by
 * the eventTriggersEnabled flag and kill switch.
 */
route.post('/store-manager/triggers/:id/run-now', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.eventTriggersEnabled) {
    return c.json({ ok: false, errorCode: 'not_configured', error: 'Event triggers are disabled (flag or kill switch).' }, 409);
  }
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid trigger id.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerTriggerRunNowRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid run-now request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = await runTriggerNowReadOnly(workspace.id, id, {
      workspacePath: workspace.workspacePath,
      selectedModel: parsed.data.selectedModel,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ModelUnavailableError) {
      return c.json({ ok: false, errorCode: 'model_unavailable', error: err.message }, 400);
    }
    return c.json({ ok: false, errorCode: 'run_now_failed', error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * GET /api/store-manager/triggers/:id/occurrences — bounded occurrence
 * history (read access stays available under kill switch).
 */
route.get('/store-manager/triggers/:id/occurrences', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid trigger id.' }, 400);
  const query = StoreManagerTriggerOccurrenceListQuerySchema.safeParse({
    limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    status: c.req.query('status') ?? undefined,
  });
  const limit = query.success ? query.data.limit ?? 50 : 50;
  const status = query.success ? query.data.status : undefined;
  const occurrences = listOccurrencesByTrigger(workspace.id, id, { limit, status });
  return c.json({ occurrences });
});

/**
 * GET /api/store-manager/playbooks — list workspace playbooks (reads stay
 * available under kill switch; playbooks are inert until activated).
 */
route.get('/store-manager/playbooks', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const playbooks = listPlaybooks(workspace.id);
  return c.json({ playbooks });
});

/**
 * GET /api/store-manager/playbooks/templates — server-owned template list.
 */
route.get('/store-manager/playbooks/templates', (c) => {
  return c.json({ templates: describeStoreManagerPlaybookTemplates() });
});

/**
 * POST /api/store-manager/playbooks — copy a locked starter template into a
 * workspace draft (version 1). Playbook DEFINITIONS are inert data: copying
 * does nothing until the draft is explicitly activated. Gated by the
 * playbooksEnabled flag and kill switch.
 */
route.post('/store-manager/playbooks', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.playbooksEnabled) {
    return c.json({ ok: false, errorCode: 'not_configured', error: 'Playbooks are disabled (flag or kill switch).' }, 409);
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerPlaybookCreateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid playbook create request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const playbook = createPlaybookFromTemplate(workspace.id, parsed.data);
    return c.json({ ok: true, playbook });
  } catch (err) {
    return c.json({ ok: false, errorCode: 'playbook_create_failed', error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * GET /api/store-manager/playbooks/:id — playbook detail + version history
 * (read access stays available under kill switch).
 */
route.get('/store-manager/playbooks/:id', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 100) return c.json({ error: 'Invalid playbook id.' }, 400);
  const playbook = getPlaybook(workspace.id, id);
  if (!playbook) return c.json({ error: 'Playbook not found.' }, 404);
  const versions = getPlaybookVersions(workspace.id, id);
  return c.json({ playbook, versions });
});

/**
 * GET /api/store-manager/playbooks/:id/versions/:version — one immutable version.
 */
route.get('/store-manager/playbooks/:id/versions/:version', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  const version = Number(c.req.param('version'));
  if (id.length > 100 || !Number.isInteger(version) || version < 1) {
    return c.json({ error: 'Invalid playbook id or version.' }, 400);
  }
  const versionRow = getPlaybookVersion(workspace.id, id, version);
  if (!versionRow) return c.json({ error: 'Playbook version not found.' }, 404);
  return c.json({ version: versionRow });
});

/**
 * POST /api/store-manager/playbooks/:id/versions — save a new immutable draft
 * version (copy-on-edit). The service re-validates against the current registry
 * and recomputes the content hash; invalid definitions are rejected before any
 * persistence.
 */
route.post('/store-manager/playbooks/:id/versions', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.playbooksEnabled) {
    return c.json({ ok: false, errorCode: 'not_configured', error: 'Playbooks are disabled (flag or kill switch).' }, 409);
  }
  const id = c.req.param('id');
  if (id.length > 100) return c.json({ error: 'Invalid playbook id.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerPlaybookSaveDraftRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid playbook draft.', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = savePlaybookDraft(workspace.id, id, parsed.data);
    return c.json({ ok: true, version: result.version, staticRisk: result.staticRisk });
  } catch (err) {
    if (err instanceof StoreManagerPlaybookValidationError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, 400);
    }
    if (err instanceof StoreManagerPlaybookError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, err.code === 'not_found' ? 404 : 400);
    }
    return c.json({ ok: false, errorCode: 'playbook_save_failed', error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

/**
 * POST /api/store-manager/playbooks/:id/activate — explicit reviewed
 * activation of a specific immutable version. Records actor/time/hash and is
 * the ONLY way a playbook leaves the inert draft state. Gated by flags.
 */
route.post('/store-manager/playbooks/:id/activate', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.playbooksEnabled) {
    return c.json({ ok: false, errorCode: 'not_configured', error: 'Playbooks are disabled (flag or kill switch).' }, 409);
  }
  const id = c.req.param('id');
  if (id.length > 100) return c.json({ error: 'Invalid playbook id.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerPlaybookActivateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid playbook activation request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const playbook = activatePlaybook(workspace.id, id, parsed.data.version, 'operator');
    return c.json({ ok: true, playbook });
  } catch (err) {
    if (err instanceof StoreManagerPlaybookValidationError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, 400);
    }
    if (err instanceof StoreManagerPlaybookError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, err.code === 'not_found' ? 404 : 400);
    }
    return c.json({ ok: false, errorCode: 'playbook_activate_failed', error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// ---------------------------------------------------------------------------
// Operations console — Issue 7: diff-first action previews, playbook runner,
// run history/replay/comparison, and bounded history queries.
// All execution still enters runStoreManagerExecution; history reads are
// workspace-scoped and redacted; replay creates a NEW current-state run.
// ---------------------------------------------------------------------------

/** Minimal zod request schemas (boundary-validated inline). */
const PlaybookRunRequestSchema = z
  .object({
    version: z.number().int().positive().max(10_000).optional(),
    variables: z.record(z.string().min(1).max(64), z.unknown()).optional(),
  })
  .strict();

const PlaybookResumeRequestSchema = z
  .object({
    approve: z.boolean(),
    diffHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const ActionPreviewRequestSchema = z
  .object({
    toolName: z.string().min(1).max(200),
    input: z.record(z.string().min(1).max(50), z.unknown()).optional(),
  })
  .strict();

/**
 * POST /api/store-manager/action-preview
 * Deterministic pre-approval diff for a persistent tool + input (read-only
 * compute; no side effects). The operator reviews this before approving; the
 * runner/registry revalidates the same diff at dispatch (stale_preview on
 * drift).
 */
route.post('/store-manager/action-preview', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = ActionPreviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid preview request.', details: parsed.error.flatten() }, 400);
  }
  const registry = createStoreManagerToolRegistry();
  const adapter = registry.get(parsed.data.toolName);
  if (!adapter || adapter.riskClass === 'read' || !adapter.previewDiff) {
    return c.json({ ok: false, errorCode: 'not_previewable', error: 'This tool has no deterministic preview (read tools are not previewed).' }, 404);
  }
  try {
    const diff = await computeAdapterPreviewDiff(adapter, parsed.data.input ?? {}, {
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      sessionId: 'preview',
      executionId: 'preview',
      deadlineAt: Date.now() + 60_000,
      entrypoint: 'command',
      pinnedScope: null,
      emit: () => undefined,
    });
    if (!diff) {
      return c.json({ ok: false, errorCode: 'preview_failed', error: 'The deterministic preview could not be built.' }, 422);
    }
    return c.json({ ok: true, diff });
  } catch (err) {
    return c.json({ ok: false, errorCode: 'preview_failed', error: err instanceof Error ? err.message.slice(0, 300) : 'Preview failed.' }, 400);
  }
});

/**
 * POST /api/store-manager/playbooks/:id/run
 * Start a playbook run (operator). Runs synchronously until the first
 * approval checkpoint (pause) or completion. Gated by flags + kill switch
 * (the runner also fails closed).
 */
route.post('/store-manager/playbooks/:id/run', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.playbooksEnabled) {
    return c.json({ ok: false, errorCode: 'not_configured', error: 'Playbooks are disabled (flag or kill switch).' }, 409);
  }
  const id = c.req.param('id');
  if (id.length > 100) return c.json({ error: 'Invalid playbook id.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = PlaybookRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid playbook run request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = await runStoreManagerPlaybook({
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      playbookId: id,
      version: parsed.data.version,
      variables: parsed.data.variables ?? {},
      actor: 'operator',
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof StoreManagerPlaybookRunError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, err.code === 'playbook_not_found' || err.code === 'version_not_found' ? 404 : 400);
    }
    return c.json({ ok: false, errorCode: 'playbook_run_failed', error: err instanceof Error ? err.message.slice(0, 300) : 'Playbook run failed.' }, 400);
  }
});

/**
 * POST /api/store-manager/playbook-runs/:runId/resume
 * Approve (exact diff hash) or deny the paused checkpoint. Only the operator
 * actor can approve; the approval binds the exact diff and is single-use.
 */
route.post('/store-manager/playbook-runs/:runId/resume', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.playbooksEnabled) {
    return c.json({ ok: false, errorCode: 'not_configured', error: 'Playbooks are disabled (flag or kill switch).' }, 409);
  }
  const runId = c.req.param('runId');
  if (runId.length > 64) return c.json({ error: 'Invalid playbook run id.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = PlaybookResumeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid resume request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = await resumeStoreManagerPlaybookRun(workspace.id, runId, {
      approve: parsed.data.approve,
      actor: 'operator',
      diffHash: parsed.data.diffHash,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof StoreManagerPlaybookRunError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, err.code === 'run_not_found' ? 404 : 400);
    }
    return c.json({ ok: false, errorCode: 'resume_failed', error: err instanceof Error ? err.message.slice(0, 300) : 'Resume failed.' }, 400);
  }
});

/** GET /api/store-manager/playbook-runs/:runId — workspace-scoped run detail. */
route.get('/store-manager/playbook-runs/:runId', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const runId = c.req.param('runId');
  if (runId.length > 64) return c.json({ error: 'Invalid playbook run id.' }, 400);
  const detail = getStoreManagerPlaybookRunDetail(workspace.id, runId);
  if (!detail.run) return c.json({ error: 'Playbook run not found.' }, 404);
  return c.json(detail);
});

/**
 * GET /api/store-manager/runs — workspace-scoped run history (cursor list).
 * Reads stay available under the kill switch (history remains inspectable).
 */
route.get('/store-manager/runs', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const afterRaw = c.req.query('after');
  let after: { createdAt: string; id: string } | null = null;
  if (afterRaw) {
    try {
      after = JSON.parse(afterRaw) as { createdAt: string; id: string };
      if (!after || typeof after.createdAt !== 'string' || typeof after.id !== 'string') after = null;
    } catch {
      after = null;
    }
  }
  const limitRaw = c.req.query('limit');
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(Math.max(Number(limitRaw), 1), 200) : 50;
  const entrypoint = c.req.query('entrypoint') || null;
  try {
    const result = listRunHistory(workspace.id, { after, limit, entrypoint });
    const runs = result.runs.map((row) => toHistoryRun(row, row.artifact_count));
    const validated = StoreManagerRunHistoryListSchema.safeParse({ runs, nextCursor: result.nextCursor });
    return c.json(validated.success ? validated.data : { runs: [], nextCursor: null });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/** GET /api/store-manager/runs/:runId — run detail (events + artifacts + telemetry join). */
route.get('/store-manager/runs/:runId', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const runId = c.req.param('runId');
  if (runId.length > 64) return c.json({ error: 'Invalid run id.' }, 400);
  const detail = getRunHistoryDetail(workspace.id, runId);
  if (!detail) return c.json({ error: 'Run not found.' }, 404);
  const validated = StoreManagerRunHistoryDetailSchema.safeParse(detail);
  return c.json(validated.success ? validated.data : { error: 'Run detail failed validation.' });
});

/**
 * POST /api/store-manager/runs/:runId/replay
 * Replay = a NEW current-state run with honest lineage. No approval reuse,
 * no fallback for an explicitly selected model, fail-closed on invalid
 * source policy snapshot / foreign run / incompatible scope.
 */
route.post('/store-manager/runs/:runId/replay', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const flags = getStoreManagerFlags();
  if (flags.killSwitch) {
    return c.json({ ok: false, errorCode: 'not_configured', error: 'New Store Manager runs are disabled by the kill switch.' }, 409);
  }
  const runId = c.req.param('runId');
  if (runId.length > 64) return c.json({ error: 'Invalid run id.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerReplayRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid replay request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = await replayStoreManagerRun({
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      sourceRunId: runId,
      selectedModel: parsed.data.selectedModel,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof StoreManagerReplayError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, err.code === 'run_not_found' ? 404 : 400);
    }
    if (err instanceof ModelUnavailableError) {
      return c.json({ ok: false, errorCode: 'model_unavailable', error: err.message }, 400);
    }
    return c.json({ ok: false, errorCode: 'replay_failed', error: err instanceof Error ? err.message.slice(0, 300) : 'Replay failed.' }, 400);
  }
});

/** POST /api/store-manager/runs/compare — deterministic compatible-artifact comparison. */
route.post('/store-manager/runs/compare', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerCompareRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid compare request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = compareStoreManagerRuns(workspace.id, parsed.data.runIdA, parsed.data.runIdB);
    return c.json(result);
  } catch (err) {
    if (err instanceof StoreManagerComparisonError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, 404);
    }
    return c.json({ ok: false, errorCode: 'compare_failed', error: err instanceof Error ? err.message.slice(0, 300) : 'Compare failed.' }, 400);
  }
});

/** GET /api/store-manager/history/queries — supported query descriptors (server-owned). */
route.get('/store-manager/history/queries', (c) => {
  return c.json({ queries: describeHistoryQueries() });
});

/** POST /api/store-manager/history/query — bounded query execution. */
route.post('/store-manager/history/query', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerHistoryQueryRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid history query request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = executeHistoryQuery(workspace.id, parsed.data.queryId, parsed.data.params);
    return c.json(result);
  } catch (err) {
    if (err instanceof StoreManagerHistoryQueryError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, 400);
    }
    return c.json({ ok: false, errorCode: 'query_failed', error: err instanceof Error ? err.message.slice(0, 300) : 'Query failed.' }, 400);
  }
});

// ---------------------------------------------------------------------------
// Operations console — Issue 8: homogeneous bulk review.
// Grouping is a read/preview operation; the persisted batch preview is
// immutable; the stage path is the registry/policy approval-gated tool
// (bulk_apply_stored_proposals), never a direct route mutation. Deny is an
// operator action with zero catalog effect. Gated by bulkReviewEnabled +
// kill switch (read access to batch history stays available during kill
// switch, matching the operations-console posture).
// ---------------------------------------------------------------------------

/** POST /api/store-manager/bulk-review/preview — derive + persist one immutable batch preview. */
route.post('/store-manager/bulk-review/preview', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerBulkReviewPreviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid bulk-review preview request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = previewBulkReviewBatch(workspace.id, parsed.data, 'operator');
    return c.json(result);
  } catch (err) {
    if (err instanceof BulkReviewDisabledError) {
      return c.json({ ok: false, errorCode: 'not_configured', error: err.message }, 409);
    }
    if (err instanceof BulkReviewError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, err.code === 'empty_group' ? 422 : 400);
    }
    return c.json({ ok: false, errorCode: 'bulk_preview_failed', error: err instanceof Error ? err.message.slice(0, 300) : 'Preview failed.' }, 400);
  }
});

/** GET /api/store-manager/bulk-review/batches — bounded batch history (reads stay available). */
route.get('/store-manager/bulk-review/batches', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const limitRaw = Number(c.req.query('limit') ?? '50');
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  return c.json({ batches: listBulkReviewBatches(workspace.id, limit) });
});

/** GET /api/store-manager/bulk-review/batches/:id — batch detail + live staleness revalidation. */
route.get('/store-manager/bulk-review/batches/:id', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid batch id.' }, 400);
  const batch = findBulkReviewBatch(workspace.id, id);
  if (!batch) return c.json({ error: 'Bulk review batch not found.' }, 404);
  const revalidation = revalidateBulkReviewBatch(workspace.id, id);
  return c.json({
    ok: true,
    batch,
    items: listBulkReviewBatchItems(workspace.id, id),
    stale: !revalidation.fresh,
    staleReason: revalidation.reason,
    currentProposalCount: revalidation.currentProposalCount,
  });
});

/** POST /api/store-manager/bulk-review/batches/:id/deny — per-item denied decisions; zero catalog effect. */
route.post('/store-manager/bulk-review/batches/:id/deny', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const id = c.req.param('id');
  if (id.length > 64) return c.json({ error: 'Invalid batch id.' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const parsed = StoreManagerBulkReviewDenyRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, errorCode: 'invalid_request', error: 'Invalid deny request.', details: parsed.error.flatten() }, 400);
  }
  try {
    const result = denyBulkReviewBatch(workspace.id, id, 'operator', undefined, parsed.data.reason);
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof BulkReviewDisabledError) {
      return c.json({ ok: false, errorCode: 'not_configured', error: err.message }, 409);
    }
    if (err instanceof BulkReviewError) {
      return c.json({ ok: false, errorCode: err.code, error: err.message }, err.code === 'not_found' ? 404 : 400);
    }
    return c.json({ ok: false, errorCode: 'bulk_deny_failed', error: err instanceof Error ? err.message.slice(0, 300) : 'Deny failed.' }, 400);
  }
});

export default route;

import { Hono, type Context } from 'hono';
import { randomBytes } from 'node:crypto';
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
import { createStoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import {
  compileStoreManagerCommand,
  StoreManagerCommandCompileError,
} from '../../store-manager/commands/compiler';
import { describeStoreManagerCommands } from '../../store-manager/commands/registry';
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
import type { UIMessage } from 'ai';

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

export default route;

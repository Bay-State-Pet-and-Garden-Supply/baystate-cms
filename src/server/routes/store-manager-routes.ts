import { Hono } from 'hono';
import { randomUUID, randomBytes } from 'node:crypto';
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
import { resolveAiSdkModel, listUsableStoreManagerModels, ModelUnavailableError, type ResolvedAiSdkModel } from '../services/ai-sdk-model-resolver';
import { createStoreManagerTools } from '../services/store-manager-tools';
import { buildToolApprovalConfig } from '../services/store-manager-tool-policy';
import { buildStoreManagerSystemPrompt } from '../services/store-manager-prompt-builder';
import { buildAttachedProductContext, injectAttachedContext, selectedSkusSchema } from '../services/store-manager-context';
import { streamText, convertToModelMessages, toUIMessageStream, createUIMessageStreamResponse, isStepCount, type UIMessage } from 'ai';
import {
  saveChatMessage,
  getChatHistory,
  getChatThreads,
  clearChatHistory,
  pruneOldChatHistory,
} from '../services/store-manager-chat-history-service';
import {
  beginStoreManagerCall,
  terminalizeStoreManagerCall,
  buildStoreManagerMessageMetadata,
  insertStoreManagerUnavailableCall,
  sanitizeChatMessagesForPersistence,
} from '../services/store-manager-telemetry';

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
 * How long a per-chat execution context stays valid. Generous enough to cover
 * long multi-step turns; the HMAC signature remains the primary approval gate.
 */
const APPROVAL_WINDOW_MS = 30 * 60 * 1000;


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
 */
route.post('/store-manager/chat', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const { messages, selectedSkus, selectedModel, threadId } = await c.req.json().catch(() => ({ 
    messages: null, 
    selectedSkus: null, 
    selectedModel: null,
    threadId: null
  }));
  if (!messages || !Array.isArray(messages)) {
    return c.json({ error: 'Invalid request: messages array is required.' }, 400);
  }

  let resolvedModel: ResolvedAiSdkModel | null = null;
  let modelCallId: string | null = null;
  try {
    try {
      resolvedModel = resolveAiSdkModel(selectedModel);
    } catch (err) {
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
      throw err;
    }
    // Non-null local captured after resolution so stream callbacks can close
    // over it without re-checking nullability.
    const resolved = resolvedModel;
    const model = resolved.modelInstance;
    // Durable telemetry row before the first transport attempt; terminalized
    // exactly once on success/failure/cancel paths below.
    modelCallId = beginStoreManagerCall(workspace.id, resolved);
    const callId = modelCallId;
    // Per-chat execution context: approvals are bound to this turn and expire.
    const executionId = randomUUID();
    const approvalExpiresAt = Date.now() + APPROVAL_WINDOW_MS;
    const tools = createStoreManagerTools({
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
      executionId,
      approvalExpiresAt,
    });

    // Attached product context is injected below `system` as a bounded,
    // server-owned low-trust data message. The system prompt is never
    // concatenated with request/product content.
    let chatMessages: any[] = messages;
    if (selectedSkus && Array.isArray(selectedSkus) && selectedSkus.length > 0) {
      const parsed = selectedSkusSchema.safeParse({ selectedSkus });
      if (!parsed.success) {
        return c.json({ error: 'Invalid attached product selection: at most 10 unique SKUs of bounded length are allowed.' }, 400);
      }
      const context = buildAttachedProductContext(
        workspace.id,
        workspace.workspacePath,
        parsed.data.selectedSkus,
      );
      chatMessages = injectAttachedContext(messages, context.serialized);
    }

    const modelMessages = await convertToModelMessages(chatMessages);

    const result = streamText({
      model,
      system: buildStoreManagerSystemPrompt(),
      messages: modelMessages,
      tools,
      // #34: read tools run autonomously; every persistent class pauses for a
      // signed operator approval. The tool wrappers re-check risk/approval
      // immediately before execution.
      toolApproval: buildToolApprovalConfig(tools),
      experimental_toolApprovalSecret: toolApprovalSecret,
      // Client disconnect must abort the generation so the `started` row is
      // terminalized as `cancelled` instead of lingering.
      abortSignal: c.req.raw.signal,
      stopWhen: isStepCount(10),
      // #37: onEnd/onFinish usage in AI SDK 7 is the combined usage of all
      // steps (verified by store-manager-chat-runtime.test.ts), so the
      // durable row holds aggregate totals, never final-step-only usage.
      onEnd: ({ usage }) => {
        if (modelCallId) {
          terminalizeStoreManagerCall(modelCallId, resolved, 'success', {
            promptTokens: usage?.inputTokens ?? null,
            completionTokens: usage?.outputTokens ?? null,
          });
        }
      },
      onError: (error) => {
        if (modelCallId) {
          terminalizeStoreManagerCall(modelCallId, resolved, 'failed', {
            errorCode: error instanceof Error ? error.name : 'STREAM_ERROR',
          });
        }
      },
      onAbort: () => {
        if (modelCallId) {
          terminalizeStoreManagerCall(modelCallId, resolved, 'cancelled');
        }
      },
    });

    const uiMessageStream = toUIMessageStream({
      stream: result.stream,
      tools,
      // Attach server-owned telemetry metadata to the response message: the
      // durable call id plus the exact resolved provider/model/locality and
      // aggregate usage/cost. The chat-save path re-hydrates from the row.
      messageMetadata: ({ part }) => {
        if (part.type === 'start') {
          return {
            modelCallId: callId,
            provider: resolved.provider,
            model: resolved.modelId,
            locality: resolved.locality,
            resolutionReason: resolved.resolutionReason,
          };
        }
        if (part.type === 'finish') {
          return buildStoreManagerMessageMetadata(resolved, callId, {
            inputTokens: part.totalUsage?.inputTokens,
            outputTokens: part.totalUsage?.outputTokens,
          });
        }
        return undefined;
      },
    });

    return createUIMessageStreamResponse({
      stream: uiMessageStream,
    });
  } catch (err) {
    // Synchronous failures between the `started` insert and stream creation
    // (e.g. message conversion) must not leave an unresolved `started` row.
    if (modelCallId && resolvedModel) {
      terminalizeStoreManagerCall(modelCallId, resolvedModel, 'failed', {
        errorCode: err instanceof Error ? err.name : 'STREAM_ERROR',
      });
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

export default route;

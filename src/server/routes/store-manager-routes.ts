import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { generateProductFieldAuditReport } from '../services/catalog-insight-service';
import {
  generateDeterministicProposals,
  listProposals,
  getProposalById,
  applyProposal,
  dismissProposal,
} from '../services/product-field-refactor-service';
import {
  generateAiProposals,
  generateStoreManagerReport,
} from '../services/store-manager-assistant-service';
import { resolveAiSdkModel, listUsableStoreManagerModels, ModelUnavailableError, type ResolvedAiSdkModel } from '../services/ai-sdk-model-resolver';
import { createStoreManagerTools } from '../services/store-manager-tools';
import { STORE_MANAGER_AGENT_SYSTEM_PROMPT } from '../services/store-manager-agent-prompt';
import { buildAttachedProductContext, injectAttachedContext, selectedSkusSchema } from '../services/store-manager-context';
import { streamText, convertToModelMessages, toUIMessageStream, createUIMessageStreamResponse, isStepCount } from 'ai';
import {
  saveChatMessage,
  getChatHistory,
  getChatThreads,
  clearChatHistory,
  pruneOldChatHistory,
} from '../services/store-manager-chat-history-service';

import { computeApiCost } from '../../ai/model-pricing';

const route = new Hono();

// Global map to track the latest usage tokens for active streaming chats
const lastStreamUsage = new Map<string, { promptTokens: number; completionTokens: number; provider: string; model: string; locality: 'local' | 'cloud' }>();


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

  try {
    let resolvedModel: ResolvedAiSdkModel;
    try {
      resolvedModel = resolveAiSdkModel(selectedModel);
    } catch (err) {
      if (err instanceof ModelUnavailableError) {
        // Explicit unavailability fails before streaming and names the
        // corrective setting without exposing secrets. No transport attempt.
        return c.json({ error: err.message, errorCode: 'model_unavailable' }, 400);
      }
      throw err;
    }
    const model = resolvedModel.modelInstance;
    const tools = createStoreManagerTools({
      workspaceId: workspace.id,
      workspacePath: workspace.workspacePath,
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
      system: STORE_MANAGER_AGENT_SYSTEM_PROMPT,
      messages: modelMessages,
      tools,
      stopWhen: isStepCount(10),
      onFinish: ({ usage }) => {
        if (usage && threadId) {
          lastStreamUsage.set(threadId, {
            promptTokens: usage.inputTokens || 0,
            completionTokens: usage.outputTokens || 0,
            // Telemetry reflects the model that actually executed, taken from
            // the single authoritative resolved-model struct.
            provider: resolvedModel.provider,
            model: resolvedModel.modelId,
            locality: resolvedModel.locality,
          });
        }
      }
    });

    const uiMessageStream = toUIMessageStream({
      stream: result.stream,
      tools,
    });

    return createUIMessageStreamResponse({
      stream: uiMessageStream,
    });
  } catch (err) {
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

    let proposals;
    if (useAi) {
      proposals = await generateAiProposals(workspace.id, field);
    } else {
      proposals = generateDeterministicProposals(workspace.id, field);
    }

    return c.json({ success: true, proposals });
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
    const proposal = getProposalById(id);
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
    dismissProposal(id);
    return c.json({ success: true });
  } catch (err) {
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
    
    // Attach usage metadata to the last message if available
    const usageInfo = lastStreamUsage.get(threadId);
    if (usageInfo && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.usage) {
        const { estimatedApiCostUsd, costBasis } = computeApiCost(
          usageInfo.provider,
          usageInfo.model,
          usageInfo.locality,
          usageInfo.promptTokens,
          usageInfo.completionTokens,
        );
        lastMsg.usage = {
          promptTokens: usageInfo.promptTokens,
          completionTokens: usageInfo.completionTokens,
          provider: usageInfo.provider,
          model: usageInfo.model,
          cost: estimatedApiCostUsd,
          costBasis,
        };
        lastStreamUsage.delete(threadId);
      }
    }

    clearChatHistory(workspace.id, threadId);
    for (const msg of messages) {
      saveChatMessage(workspace.id, threadId, threadTitle, msg.id, msg.role, msg);
    }
    return c.json({ success: true });
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

route.get('/store-manager/report', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  try {
    const report = await generateStoreManagerReport(workspace.id, workspace.workspacePath);
    return c.json(report);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default route;

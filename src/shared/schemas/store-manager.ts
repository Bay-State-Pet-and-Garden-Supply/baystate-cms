/**
 * Store Manager chat request / UI message schemas (epic #42, #40).
 *
 * Incoming chat messages are validated server-side BEFORE
 * `convertToModelMessages` in two layers:
 *
 * 1. An outer deterministic gate enforces bounded counts/bytes, allowed roles,
 *    allowed part types (unknown part types rejected), and per-part size
 *    bounds — before any tool schema work.
 * 2. The AI SDK v7 `safeValidateUIMessages` then validates tool parts against
 *    the ACTUAL per-tool schemas (input, output, approval parts) so a forged
 *    or malformed tool part cannot reach model conversion or execution.
 */

import { z } from 'zod';
import { safeValidateUIMessages } from 'ai';
import type { UIMessage } from 'ai';
import { StoreManagerPinnedScopeSchema } from './store-manager-scope';

export const STORE_MANAGER_REQUEST_BOUNDS = {
  maxMessages: 100,
  maxMessageTextBytes: 8000,
  maxPartsPerMessage: 40,
  maxPartBytes: 32 * 1024,
  maxIdLength: 200,
  maxThreadIdLength: 200,
  maxSkuLength: 128,
  maxSelectedSkus: 10,
  maxModelIdLength: 200,
  maxTotalRequestBytes: 256 * 1024,
} as const;

/** Part types the runtime understands. Static tool parts use `tool-<name>`. */
const KNOWN_PART_TYPE_PREFIXES = [
  'text',
  'reasoning',
  'step-start',
  'source-url',
  'source-document',
  'file',
  'reasoning-file',
  'data-',
  'custom',
  'tool-',
  'dynamic-tool',
];

function isKnownPartType(type: string): boolean {
  if (type === 'text' || type === 'reasoning' || type === 'step-start' || type === 'custom') return true;
  return KNOWN_PART_TYPE_PREFIXES.some((prefix) => prefix.endsWith('-') ? type.startsWith(prefix) : type === prefix);
}

/** Outer deterministic gate — no AI SDK dependency, fully testable. */
export function validateStoreManagerMessagesShape(messages: unknown): {
  ok: true;
  messages: unknown[];
} | { ok: false; code: string; message: string } {
  if (!Array.isArray(messages)) {
    return { ok: false, code: 'messages_not_array', message: 'messages must be an array.' };
  }
  if (messages.length === 0) {
    return { ok: false, code: 'messages_empty', message: 'messages must not be empty.' };
  }
  if (messages.length > STORE_MANAGER_REQUEST_BOUNDS.maxMessages) {
    return {
      ok: false,
      code: 'messages_too_many',
      message: `messages exceeds the limit of ${STORE_MANAGER_REQUEST_BOUNDS.maxMessages}.`,
    };
  }
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      return { ok: false, code: 'message_not_object', message: 'each message must be an object.' };
    }
    const m = message as Record<string, unknown>;
    if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > STORE_MANAGER_REQUEST_BOUNDS.maxIdLength) {
      return { ok: false, code: 'message_id_invalid', message: 'each message requires a bounded string id.' };
    }
    if (m.role !== 'user' && m.role !== 'assistant') {
      return { ok: false, code: 'message_role_invalid', message: 'message role must be "user" or "assistant".' };
    }
    if (!Array.isArray(m.parts) || m.parts.length === 0) {
      return { ok: false, code: 'message_parts_invalid', message: 'each message requires a non-empty parts array.' };
    }
    if (m.parts.length > STORE_MANAGER_REQUEST_BOUNDS.maxPartsPerMessage) {
      return {
        ok: false,
        code: 'message_parts_too_many',
        message: `message parts exceeds the limit of ${STORE_MANAGER_REQUEST_BOUNDS.maxPartsPerMessage}.`,
      };
    }
    for (const part of m.parts as unknown[]) {
      if (!part || typeof part !== 'object') {
        return { ok: false, code: 'part_not_object', message: 'each part must be an object.' };
      }
      const p = part as Record<string, unknown>;
      if (typeof p.type !== 'string' || !isKnownPartType(p.type)) {
        return {
          ok: false,
          code: 'part_type_unknown',
          message: `unknown message part type: ${String(p.type)}`,
        };
      }
      const text = typeof p.text === 'string' ? p.text : '';
      if (text.length > STORE_MANAGER_REQUEST_BOUNDS.maxMessageTextBytes) {
        return { ok: false, code: 'part_text_too_large', message: 'message part text exceeds the byte limit.' };
      }
      const size = estimatePartBytes(p);
      if (size > STORE_MANAGER_REQUEST_BOUNDS.maxPartBytes) {
        return { ok: false, code: 'part_too_large', message: 'message part exceeds the byte limit.' };
      }
    }
  }
  return { ok: true, messages };
}

function estimatePartBytes(part: Record<string, unknown>): number {
  // Rough but deterministic upper-bound estimate (strings serialized twice).
  try {
    return JSON.stringify(part).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Thrown by `safeValidateStoreManagerMessages` for any inbound message shape
 * or tool-part failure. The route maps this to a 400 before model conversion.
 */
export class StoreManagerMessageValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreManagerMessageValidationError';
    this.code = code;
  }
}

/**
 * Two-layer validation: deterministic outer gate + AI SDK tool-aware
 * validation against the actual tool definitions. Returns the validated
 * messages on success; throws StoreManagerMessageValidationError otherwise.
 */
export async function safeValidateStoreManagerMessages(opts: {
  messages: unknown;
  tools: Record<string, unknown>;
  metadataSchema?: z.ZodType<unknown>;
}): Promise<UIMessage[]> {
  const shape = validateStoreManagerMessagesShape(opts.messages);
  if (!shape.ok) {
    throw new StoreManagerMessageValidationError(shape.code, shape.message);
  }
  let result;
  try {
    result = await safeValidateUIMessages({
      messages: shape.messages,
      tools: opts.tools as never,
      metadataSchema: opts.metadataSchema as never,
    });
  } catch (err) {
    // Some SDK inputs throw directly instead of returning { success: false };
    // normalize both paths to the same typed error so the route always maps
    // to a 400 before model conversion/execution.
    throw new StoreManagerMessageValidationError(
      'tool_part_validation_failed',
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!result.success) {
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    throw new StoreManagerMessageValidationError('tool_part_validation_failed', message);
  }
  return result.data;
}

/** Outer chat request schema (applies after JSON parse in the route). */
export const StoreManagerChatRequestSchema = z.object({
  messages: z.unknown(),
  threadId: z.string().min(1).max(STORE_MANAGER_REQUEST_BOUNDS.maxThreadIdLength).nullable().optional(),
  selectedSkus: z
    .array(z.string().trim().min(1).max(STORE_MANAGER_REQUEST_BOUNDS.maxSkuLength))
    .max(STORE_MANAGER_REQUEST_BOUNDS.maxSelectedSkus)
    .optional(),
  selectedModel: z.string().min(1).max(STORE_MANAGER_REQUEST_BOUNDS.maxModelIdLength).optional(),
  /**
   * Pinned conversational scope (operations console, Issue 2, Locked Decision
   * 5). Bounded identifiers only; the server resolves and workspace-checks it
   * before the run starts. Scope changes start a new run/turn context.
   */
  pinnedScope: StoreManagerPinnedScopeSchema.nullable().optional(),
  id: z.string().optional(),
  trigger: z.string().optional(),
});

export type StoreManagerChatRequest = z.infer<typeof StoreManagerChatRequestSchema>;

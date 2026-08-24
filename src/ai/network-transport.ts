/**
 * Resilient Network Transport for AI Inference.
 *
 * Implements strict redirect blocking (anti-SSRF), error categorization
 * (Availability vs Misconfiguration vs Policy Denial), whole-request timeouts, and OpenAI-compatible dispatch.
 */

import type { ProviderConnection } from './provider-connections';
import { validateConnectionTrustZone } from './provider-connections';

// ─── Error Hierarchy ──────────────────────────────────────────────────────────

export abstract class AiTransportError extends Error {
  readonly isAvailabilityFailure: boolean = false;
  readonly isMisconfiguration: boolean = false;
  readonly isPolicyDenial: boolean = false;
  readonly connectionId?: string;
  readonly modelId?: string;
  readonly statusCode?: number;

  constructor(message: string, connectionId?: string, modelId?: string, statusCode?: number) {
    super(message);
    this.name = 'AiTransportError';
    this.connectionId = connectionId;
    this.modelId = modelId;
    this.statusCode = statusCode;
  }
}

/**
 * Thrown when a remote machine is unreachable (connection refused, timeout, 502/503).
 * Triggers clean, immediate failover to configured fallbacks.
 */
export class AiAvailabilityError extends AiTransportError {
  override readonly isAvailabilityFailure = true;

  constructor(message: string, connectionId?: string, modelId?: string, statusCode?: number) {
    super(message, connectionId, modelId, statusCode);
    this.name = 'AiAvailabilityError';
  }
}

/**
 * Thrown when a host is reachable, but the requested model is missing (HTTP 404) or credentials fail.
 * Allows fallback, but marks the route as Misconfigured with a visible warning.
 */
export class AiMisconfigurationError extends AiTransportError {
  override readonly isMisconfiguration = true;

  constructor(message: string, connectionId?: string, modelId?: string, statusCode?: number) {
    super(message, connectionId, modelId, statusCode);
    this.name = 'AiMisconfigurationError';
  }
}

/**
 * Thrown when a request violates Trust Zone, redirect rules, or data-sharing governance.
 * FAILS CLOSED immediately. Never falls back.
 */
export class AiPolicyDeniedError extends AiTransportError {
  override readonly isPolicyDenial = true;

  constructor(message: string, connectionId?: string, modelId?: string) {
    super(message, connectionId, modelId);
    this.name = 'AiPolicyDeniedError';
  }
}

// ─── Network Transport ────────────────────────────────────────────────────────

export interface FetchWithDeadlinesOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * Executes a fetch request with strict redirect blocking (anti-SSRF) and whole-request timeout.
 */
export async function fetchWithDeadlines(
  url: string,
  options: FetchWithDeadlinesOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 60000,
    signal: callerSignal,
    ...fetchInit
  } = options;

  const controller = new AbortController();

  if (callerSignal) {
    callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason));
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchInit,
      redirect: 'manual', // Strictly reject HTTP redirects to prevent trust-zone / SSRF bypass
      signal: controller.signal,
    });

    // Check for HTTP 3xx Redirects
    if (response.status >= 300 && response.status < 400) {
      throw new AiPolicyDeniedError(
        `HTTP ${response.status} redirect from ${url} rejected: AI endpoints forbid redirects to protect data-sharing boundaries.`,
      );
    }

    return response;
  } catch (err: any) {
    const msg = String(err?.message || '');
    const isTimeout = msg.includes('timed out') || err?.name === 'AbortError' || err?.name === 'TimeoutError';
    const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('Connection refused');

    if (isTimeout || isConnRefused) {
      throw new AiAvailabilityError(
        `Host unreachable at ${url}: ${isTimeout ? `Timed out (${timeoutMs}ms)` : 'Connection refused'}`,
      );
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── OpenAI-Compatible Chat Dispatch ──────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>;
}

export interface ChatCompletionOptions {
  temperature?: number;
  /** OpenAI-compatible frequency_penalty (e.g. packaging-OCR repetition retry). */
  frequencyPenalty?: number;
  maxTokens?: number;
  responseFormat?: { type: 'text' | 'json_object' | 'json_schema'; json_schema?: any };
  tools?: any[];
  reasoningEffort?: string;
  signal?: AbortSignal;
}

/**
 * Dispatches an OpenAI-compatible /chat/completions call against a ProviderConnection.
 */
export async function executeOpenAiChat(
  conn: ProviderConnection,
  modelId: string,
  messages: ChatMessage[],
  options: ChatCompletionOptions = {},
): Promise<{
  content: string;
  toolCalls?: any[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  // 1. Validate Trust Zone first (fail closed)
  try {
    validateConnectionTrustZone(conn);
  } catch (err: any) {
    throw new AiPolicyDeniedError(
      `Trust zone policy violation for connection "${conn.id}": ${err.message}`,
      conn.id,
      modelId,
    );
  }

  const cleanBase = conn.baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'BaystateCMS-AI/1.0',
  };
  if (conn.credential) {
    headers.Authorization = `Bearer ${conn.credential}`;
  }

  const bodyPayload: Record<string, any> = {
    model: modelId,
    messages,
    stream: false,
  };

  if (options.temperature !== undefined) bodyPayload.temperature = options.temperature;
  if (options.frequencyPenalty !== undefined) bodyPayload.frequency_penalty = options.frequencyPenalty;
  if (options.maxTokens !== undefined) bodyPayload.max_tokens = options.maxTokens;
  if (options.reasoningEffort !== undefined) bodyPayload.reasoning_effort = options.reasoningEffort;
  if (options.responseFormat) bodyPayload.response_format = options.responseFormat;
  if (options.tools && options.tools.length > 0) bodyPayload.tools = options.tools;

  let response: Response;
  try {
    response = await fetchWithDeadlines(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      timeoutMs: conn.inferenceTimeoutMs ?? 60000,
      signal: options.signal,
    });
  } catch (err: any) {
    if (err instanceof AiTransportError) {
      throw new (err.constructor as any)(err.message, conn.id, modelId, err.statusCode);
    }
    throw new AiAvailabilityError(
      `Network failure connecting to "${conn.label}" at ${url}: ${err.message}`,
      conn.id,
      modelId,
    );
  }

  if (response.status === 404) {
    const errText = await response.text().catch(() => '');
    throw new AiMisconfigurationError(
      `Model "${modelId}" not found on "${conn.label}" (HTTP 404). Host is online but model is missing/unloaded: ${errText.slice(0, 150)}`,
      conn.id,
      modelId,
      404,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AiMisconfigurationError(
      `Authentication failed for "${conn.label}" (HTTP ${response.status}). Check API key/credential.`,
      conn.id,
      modelId,
      response.status,
    );
  }

  if (response.status >= 500) {
    const errText = await response.text().catch(() => '');
    throw new AiAvailabilityError(
      `Server error from "${conn.label}" (HTTP ${response.status}): ${errText.slice(0, 150)}`,
      conn.id,
      modelId,
      response.status,
    );
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new AiAvailabilityError(
      `HTTP ${response.status} from "${conn.label}": ${errText.slice(0, 150)}`,
      conn.id,
      modelId,
      response.status,
    );
  }

  const data = (await response.json()) as any;
  const choice = data?.choices?.[0];
  const message = choice?.message;
  const content = message?.content ?? '';
  const toolCalls = message?.tool_calls;

  return {
    content,
    toolCalls,
    usage: data?.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

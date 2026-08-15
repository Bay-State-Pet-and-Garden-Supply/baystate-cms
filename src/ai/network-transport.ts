/**
 * Resilient Network Transport for AI Inference.
 *
 * Implements split connect vs. inference timeouts, error categorization
 * (Availability vs Misconfiguration vs Policy Denial), and OpenAI-compatible dispatch.
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
 * Thrown when a remote machine is unreachable (connection refused, connect timeout, 502/503).
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
 * Thrown when a request violates Trust Zone or data-sharing governance.
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
  connectTimeoutMs?: number;
  inferenceTimeoutMs?: number;
}

/**
 * Executes a fetch request with separate connect and inference deadlines.
 */
export async function fetchWithDeadlines(
  url: string,
  options: FetchWithDeadlinesOptions = {},
): Promise<Response> {
  const {
    connectTimeoutMs = 2000,
    inferenceTimeoutMs = 60000,
    signal: callerSignal,
    ...fetchInit
  } = options;

  const controller = new AbortController();

  // Combine caller signal with our internal abort controller
  if (callerSignal) {
    callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason));
  }

  // Phase 1: Connect timeout
  let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort(new Error(`Connect timeout after ${connectTimeoutMs}ms (Host offline or unreachable)`));
  }, connectTimeoutMs);

  // Phase 2: Total inference timeout
  const inferenceTimer = setTimeout(() => {
    controller.abort(new Error(`Inference timeout after ${inferenceTimeoutMs}ms`));
  }, inferenceTimeoutMs);

  try {
    const responsePromise = fetch(url, {
      ...fetchInit,
      signal: controller.signal,
    });

    // Clear connect timer as soon as response headers arrive
    const response = await responsePromise;
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }

    // Clean up inference timer when the body is handled later
    response.clone(); // verify valid response
    clearTimeout(inferenceTimer);
    return response;
  } catch (err: any) {
    if (connectTimer) clearTimeout(connectTimer);
    clearTimeout(inferenceTimer);

    const msg = String(err?.message || '');
    const isConnectTimeout = msg.includes('Connect timeout');
    const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('Connection refused');

    if (isConnectTimeout || isConnRefused) {
      throw new AiAvailabilityError(
        `Host unreachable at ${url}: ${isConnectTimeout ? `Connect timed out (${connectTimeoutMs}ms)` : 'Connection refused'}`,
      );
    }

    if (msg.includes('Inference timeout')) {
      throw new AiAvailabilityError(`Inference request timed out after ${inferenceTimeoutMs}ms at ${url}`);
    }

    throw err;
  }
}

// ─── OpenAI-Compatible Chat Dispatch ──────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>;
}

export interface ChatCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'text' | 'json_object' | 'json_schema'; json_schema?: any };
  tools?: any[];
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
  if (options.maxTokens !== undefined) bodyPayload.max_tokens = options.maxTokens;
  if (options.responseFormat) bodyPayload.response_format = options.responseFormat;
  if (options.tools && options.tools.length > 0) bodyPayload.tools = options.tools;

  let response: Response;
  try {
    response = await fetchWithDeadlines(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      connectTimeoutMs: conn.connectTimeoutMs ?? 2000,
      inferenceTimeoutMs: conn.inferenceTimeoutMs ?? 60000,
      signal: options.signal,
    });
  } catch (err: any) {
    if (err instanceof AiTransportError) {
      // Re-throw typed errors with connection/model context
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

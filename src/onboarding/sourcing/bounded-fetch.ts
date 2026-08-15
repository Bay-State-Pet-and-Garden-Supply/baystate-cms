/**
 * Bounded HTTP transport for sourcing connectors (ADR 0014 / PI-5 style
 * SSRF protections).
 *
 * Every connector request goes through `boundedFetchJson`:
 * - HTTPS ONLY, and the request origin must equal the connection's configured
 *   base URL origin (config allowlist — a connector can never reach a host
 *   the operator did not configure);
 * - redirects are NOT followed (a configured provider cannot redirect the
 *   request to another origin);
 * - composed timeout (per-request deadline + caller AbortSignal), with
 *   caller cancellation and deadline distinguished;
 * - the response body is STREAMED with a hard byte cap (never fully
 *   allocated first) and the content-type must be JSON;
 * - failures are normalized into stable, non-secret error codes; raw
 *   responses, headers, and credentials never appear in error messages.
 */

export const SOURCING_HTTP_ERROR_CODES = {
  configInvalid: 'config_invalid',
  network: 'network_error',
  timeout: 'timeout',
  cancelled: 'cancelled',
  httpStatus: 'http_error',
  bodyTooLarge: 'body_too_large',
  badContentType: 'bad_content_type',
  badJson: 'bad_json',
  redirectBlocked: 'redirect_blocked',
} as const;

export type SourcingHttpErrorCode = (typeof SOURCING_HTTP_ERROR_CODES)[keyof typeof SOURCING_HTTP_ERROR_CODES];

export interface BoundedFetchOptions {
  /** Absolute ISO deadline for this request (composed with signal). */
  deadlineAt?: string;
  /** Caller cancellation (composed with the deadline). */
  signal?: AbortSignal;
  /** Response body cap in bytes (default 2 MB). */
  maxBytes?: number;
  /** Optional override for tests / custom transports. */
  fetchImpl?: typeof fetch;
}

const DEADLINE_REASON = 'sourcing deadline exceeded';

/**
 * Compose the caller signal with a deadline timer. Returns a cleanup fn.
 */
function composeSignals(signal: AbortSignal | undefined, deadlineAt: string | undefined): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const cleanup: Array<() => void> = [];

  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return { signal: controller.signal, cleanup: () => {} };
    }
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort);
    cleanup.push(() => signal.removeEventListener('abort', onAbort));
  }

  if (deadlineAt) {
    const ms = new Date(deadlineAt).getTime() - Date.now();
    if (ms <= 0) {
      controller.abort(new Error(DEADLINE_REASON));
    } else {
      const timer = setTimeout(() => controller.abort(new Error(DEADLINE_REASON)), ms);
      timer.unref?.();
      cleanup.push(() => clearTimeout(timer));
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const fn of cleanup) fn();
    },
  };
}

function isCallerAbort(composed: { signal: AbortSignal }, callerSignal: AbortSignal | undefined): boolean {
  return composed.signal.aborted && (callerSignal?.aborted ?? false);
}

/**
 * Stream the response body with a hard byte cap. Never allocates the whole
 * body when it exceeds the cap.
 */
async function readBodyCapped(response: Response, maxBytes: number, _composedSignal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.bodyTooLarge, `response exceeded ${maxBytes} bytes`);
    return new Uint8Array(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.bodyTooLarge, `response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Fetch a JSON resource with all sourcing bounds applied. Throws normalized
 * `SourcingHttpError` instances (stable code + non-secret message).
 */
export async function boundedFetchJson(
  url: string,
  configuredOrigin: string,
  init: RequestInit,
  options: BoundedFetchOptions = {},
): Promise<unknown> {
  // HTTPS + config allowlist: the request origin must be the configured one.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.configInvalid, 'malformed request URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.configInvalid, 'HTTPS is required for distributor connections');
  }
  let configured: URL;
  try {
    configured = new URL(configuredOrigin);
  } catch {
    throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.configInvalid, 'malformed configured base URL');
  }
  if (parsed.origin !== configured.origin) {
    throw new SourcingHttpError(
      SOURCING_HTTP_ERROR_CODES.configInvalid,
      `request origin ${parsed.origin} does not match configured origin ${configured.origin}`,
    );
  }

  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const fetchImpl = options.fetchImpl ?? fetch;
  const composed = composeSignals(options.signal, options.deadlineAt);

  try {
    let response: Response;
    try {
      // redirect: 'manual' — a provider redirect to another origin is a
      // bounded error, never silently followed.
      response = await fetchImpl(url, { ...init, signal: composed.signal, redirect: 'manual' });
    } catch (e) {
      if (composed.signal.aborted) {
        const signalReason = composed.signal.reason;
        if (signalReason instanceof Error && signalReason.message === DEADLINE_REASON) {
          throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.timeout, 'request timed out');
        }
        if (isCallerAbort(composed, options.signal)) {
          throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.cancelled, 'request cancelled');
        }
        if (e instanceof DOMException && e.name === 'AbortError') {
          throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.timeout, 'request timed out');
        }
        throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.cancelled, 'request cancelled');
      }
      throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.network, 'network failure');
    }

    // Redirects are never followed; any 3xx is a bounded error.
    if (response.status >= 300 && response.status < 400) {
      throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.redirectBlocked, `provider attempted a redirect (HTTP ${response.status})`);
    }
    if (!response.ok) {
      // Status only — never the body (may echo credentials back).
      throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.httpStatus, `provider returned HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.badContentType, 'provider returned non-JSON content');
    }

    let body: Uint8Array;
    try {
      body = await readBodyCapped(response, maxBytes, composed.signal);
    } catch (e) {
      if (e instanceof SourcingHttpError) throw e;
      throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.network, 'network failure while reading response');
    }

    try {
      return JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new SourcingHttpError(SOURCING_HTTP_ERROR_CODES.badJson, 'provider returned malformed JSON');
    }
  } finally {
    composed.cleanup();
  }
}

export class SourcingHttpError extends Error {
  readonly code: SourcingHttpErrorCode;
  constructor(code: SourcingHttpErrorCode, message: string) {
    super(message);
    this.name = 'SourcingHttpError';
    this.code = code;
  }
}

export function toSourceErrorCode(error: unknown): string {
  if (error instanceof SourcingHttpError) return error.code;
  return 'unexpected';
}

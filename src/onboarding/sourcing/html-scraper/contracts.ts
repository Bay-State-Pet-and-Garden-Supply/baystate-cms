import { z } from 'zod';

/**
 * Server-only contracts for Distributor Scraper (`html_scraper`) connectors
 * (ADR 0014 Amendment B, M2).
 *
 * These types are the seam between the deterministic sourcing engine and
 * storefront scraping: fixed login automation, a fixed runtime policy with
 * hard ceilings, a STRICT non-secret connection configuration (no runtime
 * selector/origin/proxy/credential overrides), and bounded runner results
 * that never expose cookies, credentials, headers, or raw responses.
 */

// ─── Login automation (port of BayState auth.py LoginAutomationConfig) ───────

export interface LoginAutomationConfig {
  /** Fixed login page URL (always capped by the remaining engine deadline). */
  loginUrl: string;
  /** Ordered selector chains (primary first; fallbacks follow). */
  usernameSelectors: string[];
  passwordSelectors: string[];
  submitSelectors: string[];
  /** Appears on the authenticated landing page after a successful login. */
  successSelectors: string[];
  /** Ordered login-failure indicators on the login page itself. */
  failureSelectors: string[];
  /** Ordered failure indicators reachable only on the login URL. */
  loginUrlFailureIndicators: string[];
  /** Local login timeout (ms); always capped by the engine deadline. */
  timeoutMs: number;
}

// ─── Runtime policy (fixed per provider; hard ceilings) ───────────────────────

export interface HtmlScraperRuntimePolicy {
  providerId: string;
  /** The single fixed navigation origin (no other origin may be navigated). */
  navigationOrigin: string;
  /** Separately fixed asset/image hosts (display-only; never navigation). */
  assetHosts: string[];
  /** Hard response/HTML cap in bytes (default 2 MiB). */
  responseCapBytes: number;
  /** Max requests per lookup flow. */
  maxRequests: number;
  /** Per-request/navigation timeout ms. */
  requestTimeoutMs: number;
  /** Requests per minute ceiling (public 12, authenticated 6; may lower only). */
  requestsPerMinute: number;
  /** Authenticated session TTL ms (recovered BayState default 15 minutes). */
  sessionTtlMs: number;
  /** At most one normal request retry. */
  retryCount: number;
  /** Whether a Playwright/browser fallback is permitted for this provider. */
  allowBrowserFallback: boolean;
}

// ─── Hard v1 ceilings (single source of truth for config validation) ─────────

export const HTML_SCRAPER_CEILINGS = {
  /** 2 MiB, matching the current bounded sourcing transport. */
  responseCapBytes: 2 * 1024 * 1024,
  /** One request at a time per connection. */
  concurrency: 1,
  /** Session TTL recovered from the BayState auth manager. */
  sessionTtlMs: 15 * 60 * 1000,
  /** At most one normal request retry + exactly one re-login (bounded). */
  retryCount: 1,
  /** Public storefront ceiling. */
  publicRequestsPerMinute: 12,
  /** Authenticated storefront ceiling. */
  authRequestsPerMinute: 6,
  /** Max requests in one lookup flow. */
  maxRequests: 24,
  /** Default per-request timeout. */
  requestTimeoutMs: 30_000,
} as const;

// ─── Strict non-secret connection configuration ───────────────────────────────

/**
 * The ONLY operator-adjustable knobs for a Distributor Scraper connection.
 * Selectors, login URLs, origins, proxy fields, headers, cookies, and values
 * above the code-owned ceilings are REJECTED — the config surface can only
 * REDUCE operational bounds (e.g. a lower rate or shorter timeout), never
 * relax them. Configuration is stored in `distributor_connections.configuration_json`.
 */
export const HtmlScraperConnectionConfigSchema = z
  .object({
    /**
     * Requests/minute; may only lower the provider ceiling (public 12,
     * authenticated 6 — the provider ceiling is applied when building the
     * runtime policy). Absent = ceiling.
     */
    requestsPerMinute: z.number().int().min(1).max(HTML_SCRAPER_CEILINGS.publicRequestsPerMinute).optional(),
    /** Per-request timeout ms; may only lower the 30s ceiling. */
    requestTimeoutMs: z.number().int().min(1_000).max(HTML_SCRAPER_CEILINGS.requestTimeoutMs).optional(),
    /** Response cap bytes; may only lower the 2 MiB ceiling. */
    responseCapBytes: z.number().int().min(64 * 1024).max(HTML_SCRAPER_CEILINGS.responseCapBytes).optional(),
  })
  .strict();

export type HtmlScraperConnectionConfig = z.infer<typeof HtmlScraperConnectionConfigSchema>;

/** Parse a connection's configuration JSON; null when it violates the strict shape. */
export function parseHtmlScraperConnectionConfig(raw: unknown): HtmlScraperConnectionConfig | null {
  const parsed = HtmlScraperConnectionConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ─── Runner results (bounded; never leak credentials/raw state) ───────────────

export interface HtmlScraperTelemetry {
  durationMs: number;
  /** Whether a login attempt happened during this call. */
  loginAttempted: boolean;
  /** Whether a cached session was reused. */
  sessionReused: boolean;
  /** Count of re-logins performed (exactly 0 or 1 for v1). */
  reLoginCount: number;
  /** Count of normal request retries (0..retryCount). */
  retryCount: number;
}

/**
 * A successful transport result: ONLY the final allowlisted URL and the
 * bounded HTML, handed directly to a parser callback. Cookies, credentials,
 * headers, and raw responses never leave the in-memory runner.
 */
export interface HtmlScraperOkResult {
  ok: true;
  finalUrl: string;
  html: string;
  telemetry: HtmlScraperTelemetry;
}

/** A bounded failure with a stable non-secret code. */
export interface HtmlScraperErrorResult {
  ok: false;
  code:
    | 'origin_blocked'
    | 'auth_required'
    | 'auth_failed'
    | 'auth_expired'
    | 'timeout'
    | 'cancelled'
    | 'body_too_large'
    | 'login_failed'
    | 'network_error'
    | 'config_invalid'
    | 'unexpected';
  message: string;
  telemetry: HtmlScraperTelemetry;
}

export type HtmlScraperRunResult = HtmlScraperOkResult | HtmlScraperErrorResult;

/** Stable redaction for structured runner events. */
export function redactHtmlScraperEvent(event: { message: string }): string {
  // Events carry only stable codes and bounded messages; belt-and-braces
  // strip of common secret shapes in case a message ever embeds one.
  return event.message
    .replace(/(password|passwd|pwd|authorization|cookie)([=:\s]+)[^\s,;]+/gi, '$1$2[REDACTED]')
    .replace(/x-api-key[=:\s]+[^\s,;]+/gi, 'x-api-key=[REDACTED]');
}

// ─── Connector-level page fetcher (M3: public/tier-1 connectors) ─────────────

/**
 * Injectable page fetcher used by `html_scraper` connectors. Production
 * implementations bind the bounded session runner; tests inject fixture
 * readers. Results carry only the final allowlisted URL and bounded HTML —
 * never cookies, credentials, headers, or raw responses.
 */
export type ScraperFetchPageResult =
  | { ok: true; html: string; finalUrl: string }
  | { ok: false; code: string; message: string };

export interface ScraperFetchPageOptions {
  signal: AbortSignal;
  deadlineAt: string;
  browserRequired?: boolean;
  waitForSelectors?: string[];
}

export type ScraperFetchPage = (url: string, opts: ScraperFetchPageOptions) => Promise<ScraperFetchPageResult>;

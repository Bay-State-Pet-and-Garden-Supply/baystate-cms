import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import type {
  HtmlScraperRunResult,
  HtmlScraperRuntimePolicy,
  LoginAutomationConfig,
  HtmlScraperTelemetry,
} from './contracts';
import { HTML_SCRAPER_CEILINGS, redactHtmlScraperEvent } from './contracts';
import { sameOrigin, utf8ByteLength, isLoginPage } from './html-utils';
import type { HtmlScraperCredentials } from '../secret-resolver';

/**
 * Dedicated bounded Crawlee session/auth runner for Distributor Scraper
 * (`html_scraper`) connectors (ADR 0014 Amendment B, M2).
 *
 * Deliberately NOT a reuse of `src/extraction-worker/browser/rendered-page-runner.ts`
 * (that runner enables cookie persistence and proxy support — forbidden here).
 *
 * Hard invariants:
 * - cookie/session persistence DISABLED by construction (memory only);
 * - at most ONE re-login per flow; sessions TTL 15 minutes;
 * - origin/redirect/main-frame enforcement; 2 MiB response cap;
 * - caller AbortSignal + deadline composed; pre-abort/expiry starts nothing;
 * - structured redacted events; credentials never logged/persisted;
 * - per-connection login serialization (no portal stampedes).
 *
 * The transport engine is injectable: tests use a fake engine to prove the
 * orchestration logic offline; production uses the lazy-crawlee engine
 * (`createCrawleeHtmlScraperEngine`), exercised by env-gated live smoke.
 */

// ─── Storage ──────────────────────────────────────────────────────────────────

const SOURCING_CRAWLEE_BASE = join(cwd(), '.baystate-cms', 'artifacts', 'crawlee-storage', 'sourcing');

/** Create a unique per-run storage directory BEFORE lazily importing Crawlee. */
export function createSourcingStorageDir(runId: string, baseDir: string = SOURCING_CRAWLEE_BASE): string {
  const dir = join(baseDir, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Remove a per-run storage directory (no-op on failure). */
export function removeSourcingStorageDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // non-critical — storage is under the already-ignored artifacts dir
  }
}

// ─── Crawlee option construction (pure; asserted by tests) ────────────────────

export type CrawlerKind = 'static' | 'browser';

/**
 * Construct the Crawlee crawler options for a Distributor Scraper policy.
 * PURE: tests assert persistence is off, sessions are not persisted, no
 * proxy is configured, and retries/concurrency/rate are bounded.
 */
export function buildCrawlerOptions(policy: HtmlScraperRuntimePolicy, kind: CrawlerKind): Record<string, unknown> {
  return {
    // Sessions: in-memory only.
    useSessionPool: true,
    persistCookiesPerSession: false,
    sessionPoolOptions: {
      persistenceOptions: { enable: false },
      maxPoolSize: 1,
    },
    // No proxy, ever.
    proxyConfiguration: undefined,
    // Bounded execution.
    maxRequestRetries: Math.max(0, policy.retryCount),
    maxRequestsPerMinute: Math.max(1, policy.requestsPerMinute),
    maxConcurrency: HTML_SCRAPER_CEILINGS.concurrency,
    requestHandlerTimeoutSecs: Math.max(1, Math.floor(policy.requestTimeoutMs / 1000)),
    retryOnBlocked: true,
    // Pinned autoscaled pool: sourcing lookups are bounded single-request
    // crawls with an explicit deadline — memory-aware autoscaling adds
    // nothing and would only shed concurrency on a busy dev machine.
    autoscaledPoolOptions: {
      minConcurrency: HTML_SCRAPER_CEILINGS.concurrency,
      maxConcurrency: HTML_SCRAPER_CEILINGS.concurrency,
      desiredConcurrency: HTML_SCRAPER_CEILINGS.concurrency,
    },
    // Browser-only options (ignored by CheerioCrawler).
    ...(kind === 'browser' ? { headless: true } : {}),
  };
}

// ─── Events (structured, redacted) ────────────────────────────────────────────

export type HtmlScraperEvent =
  | { type: 'login_started'; providerId: string }
  | { type: 'login_succeeded'; providerId: string; durationMs: number }
  | { type: 'login_failed'; providerId: string; code: string; durationMs: number }
  | { type: 'session_reused'; providerId: string }
  | { type: 'session_expired'; providerId: string }
  | { type: 'relogin'; providerId: string }
  | { type: 'fetch_result'; providerId: string; ok: boolean; code?: string; durationMs: number };

export type HtmlScraperEventSink = (event: HtmlScraperEvent) => void;

/** Default sink: console.warn with full redaction. Never logs secrets. */
export function defaultHtmlScraperEventSink(event: HtmlScraperEvent): void {
  const code = 'code' in event && event.code ? event.code : '';
  // eslint-disable-next-line no-console
  console.warn(
    `[html-scraper] ${redactHtmlScraperEvent({
      message: `${event.type}${code ? ` code=${code}` : ''} provider=${event.providerId}`,
    })}`,
  );
}

// ─── Injectable transport engine ──────────────────────────────────────────────

export interface HtmlScraperEngineFetchInput {
  url: string;
  /** In-memory auth cookies (null when the provider is public). */
  cookies: Record<string, string> | null;
  policy: HtmlScraperRuntimePolicy;
  signal: AbortSignal;
  deadlineAt: string;
  storageDir: string;
  browserRequired: boolean;
  waitForSelectors: string[];
}

export interface HtmlScraperEngineFetchResult {
  ok: boolean;
  finalUrl: string;
  html: string;
  code?: string;
  message?: string;
  /** Auth signal observed in the response (login page / expired session). */
  authSignal?: 'login_page' | 'auth_ok' | null;
}

export interface HtmlScraperEngineLoginResult {
  ok: boolean;
  code?: string;
  message?: string;
  /** Browser cookies to reuse for authenticated static requests. */
  cookies?: Record<string, string>;
}

export interface HtmlScraperEngine {
  fetch(input: HtmlScraperEngineFetchInput): Promise<HtmlScraperEngineFetchResult>;
  login(input: {
    loginConfig: LoginAutomationConfig;
    credentials: HtmlScraperCredentials;
    policy: HtmlScraperRuntimePolicy;
    signal: AbortSignal;
    deadlineAt: string;
    storageDir: string;
  }): Promise<HtmlScraperEngineLoginResult>;
  close(): Promise<void>;
}

// ─── Session state ────────────────────────────────────────────────────────────

interface SessionState {
  /** Digest of the credentials that created this session. */
  secretDigest: string;
  cookies: Record<string, string>;
  expiresAt: number;
}

export interface HtmlScraperFetchInput {
  connectionId: string;
  providerId: string;
  url: string;
  policy: HtmlScraperRuntimePolicy;
  loginConfig?: LoginAutomationConfig;
  credentials?: HtmlScraperCredentials | null;
  signal: AbortSignal;
  deadlineAt: string;
  browserRequired?: boolean;
  waitForSelectors?: string[];
}

export interface HtmlScraperSessionManager {
  fetchHtml(input: HtmlScraperFetchInput): Promise<HtmlScraperRunResult>;
  closeAll(): Promise<void>;
}

function digestSecret(credentials: HtmlScraperCredentials | null | undefined): string {
  if (!credentials) return '';
  return createHash('sha256').update(`${credentials.username}\0${credentials.password}`).digest('hex');
}

function emptyTelemetry(): HtmlScraperTelemetry {
  return { durationMs: 0, loginAttempted: false, sessionReused: false, reLoginCount: 0, retryCount: 0 };
}

function composeDeadline(deadlineAt: string, localTimeoutMs: number): string {
  const local = new Date(Date.now() + localTimeoutMs).toISOString();
  return deadlineAt && deadlineAt < local ? deadlineAt : local;
}

/**
 * The bounded session orchestrator. All security-sensitive orchestration
 * (session TTL, credential-digest invalidation, one re-login, per-connection
 * login serialization, origin checks, response caps, redaction) lives here
 * and is proven by injected-engine tests.
 */
export function createHtmlScraperSessionManager(
  engine: HtmlScraperEngine,
  deps: { onEvent?: HtmlScraperEventSink; now?: () => number } = {},
): HtmlScraperSessionManager {
  const onEvent = deps.onEvent ?? defaultHtmlScraperEventSink;
  const now = deps.now ?? (() => Date.now());

  const sessions = new Map<string, SessionState>();
  const loginLocks = new Map<string, Promise<SessionState | null>>();
  let closed = false;
  let fetchCount = 0;
  const managerKey = `m${managerSeq++}`;

  async function loginLocked(
    input: HtmlScraperFetchInput,
    policy: HtmlScraperRuntimePolicy,
    storageDir: string,
    digest: string,
  ): Promise<SessionState | null> {
    const existing = loginLocks.get(input.connectionId);
    if (existing) return existing;
    const run = (async (): Promise<SessionState | null> => {
      if (!input.loginConfig || !input.credentials) {
        // A provider with a login config but no credentials fails closed.
        return null;
      }
      onEvent({ type: 'login_started', providerId: input.providerId });
      const loginStarted = now();
      const composedDeadline = composeDeadline(input.deadlineAt, input.loginConfig.timeoutMs);
      const result = await engine.login({
        loginConfig: input.loginConfig,
        credentials: input.credentials,
        policy,
        signal: input.signal,
        deadlineAt: composedDeadline,
        storageDir,
      });
      if (!result.ok || !result.cookies) {
        onEvent({ type: 'login_failed', providerId: input.providerId, code: result.code ?? 'login_failed', durationMs: now() - loginStarted });
        return null;
      }
      onEvent({ type: 'login_succeeded', providerId: input.providerId, durationMs: now() - loginStarted });
      const state: SessionState = {
        secretDigest: digest,
        cookies: result.cookies,
        expiresAt: now() + Math.max(1, policy.sessionTtlMs),
      };
      sessions.set(input.connectionId, state);
      return state;
    })();
    loginLocks.set(input.connectionId, run);
    void run.finally(() => loginLocks.delete(input.connectionId));
    return run;
  }

  async function getOrCreateSession(input: HtmlScraperFetchInput, policy: HtmlScraperRuntimePolicy, storageDir: string): Promise<SessionState | null> {
    const digest = digestSecret(input.credentials);
    const existing = sessions.get(input.connectionId);
    if (existing) {
      if (existing.secretDigest !== digest) {
        // Credential rotation invalidates the prior session.
        sessions.delete(input.connectionId);
        onEvent({ type: 'session_expired', providerId: input.providerId });
      } else if (existing.expiresAt <= now()) {
        sessions.delete(input.connectionId);
        onEvent({ type: 'session_expired', providerId: input.providerId });
      } else {
        onEvent({ type: 'session_reused', providerId: input.providerId });
        return existing;
      }
    }
    return loginLocked(input, policy, storageDir, digest);
  }

  async function fetchHtml(input: HtmlScraperFetchInput): Promise<HtmlScraperRunResult> {
    if (closed) {
      return { ok: false, code: 'unexpected', message: 'session manager is closed', telemetry: { ...emptyTelemetry(), durationMs: 0 } };
    }
    const started = now();
    const baseTelemetry = (overrides: Partial<HtmlScraperTelemetry> = {}): HtmlScraperTelemetry => ({
      ...emptyTelemetry(),
      durationMs: now() - started,
      ...overrides,
    });
    const policy = input.policy;

    // 1. Initial URL must be on the fixed navigation origin.
    if (!sameOrigin(input.url, policy.navigationOrigin)) {
      return { ok: false, code: 'origin_blocked', message: 'initial URL is off the provider navigation origin', telemetry: baseTelemetry() };
    }

    // 2. Compose caller signal + deadline: pre-aborted/expired starts nothing.
    const composedDeadline = composeDeadline(input.deadlineAt, policy.requestTimeoutMs);
    if (input.signal.aborted) {
      return { ok: false, code: 'cancelled', message: 'request cancelled before start', telemetry: baseTelemetry() };
    }
    if (new Date(composedDeadline).getTime() <= now()) {
      return { ok: false, code: 'timeout', message: 'deadline expired before start', telemetry: baseTelemetry() };
    }

    const requiresAuth = Boolean(input.loginConfig);
    let cookies: Record<string, string> | null = null;
    let loginAttempted = false;
    let sessionReused = false;
    let reLoginCount = 0;
    if (requiresAuth) {
      const digest = digestSecret(input.credentials);
      const preExisting = sessions.get(input.connectionId);
      const session = await getOrCreateSession(input, policy, createSourcingStorageDir(`${input.connectionId}-${now()}`));
      loginAttempted = true;
      sessionReused = Boolean(preExisting && preExisting.expiresAt > now() && preExisting.secretDigest === digest);
      if (!session) {
        return { ok: false, code: 'auth_failed', message: 'login could not establish an authenticated session', telemetry: baseTelemetry({ loginAttempted: true }) };
      }
      cookies = session.cookies;
    }

    // 3. Fetch (one normal retry allowed by the engine); exactly one re-login
    //    when the response signals a login page / expired session.
    const storageDir = createSourcingStorageDir(`${input.connectionId}-${now()}`);
    let result: HtmlScraperEngineFetchResult;
    const runFetch = async (): Promise<HtmlScraperEngineFetchResult> => {
      // Per-connection rate ceiling (sliding window) and per-lookup request
      // cap are enforced HERE at the manager boundary — a fresh crawler per
      // engine.fetch() would otherwise reset Crawlee's own limiter.
      if (fetchCount >= Math.max(1, policy.maxRequests)) {
        return { ok: false, finalUrl: input.url, html: '', code: 'rate_limited', message: 'per-lookup request cap exceeded', authSignal: null };
      }
      const slot = await acquireRateSlot(input.connectionId, managerKey, policy.requestsPerMinute, composedDeadline);
      if (!slot) {
        return { ok: false, finalUrl: input.url, html: '', code: 'timeout', message: 'request rate budget exhausted before deadline', authSignal: null };
      }
      fetchCount += 1;
      try {
        return await engine.fetch({
          url: input.url,
          cookies,
          policy,
          signal: input.signal,
          deadlineAt: composedDeadline,
          storageDir,
          browserRequired: input.browserRequired ?? false,
          waitForSelectors: input.waitForSelectors ?? [],
        });
      } catch {
        // Map abort / deadline at the runner boundary too (belt-and-braces on
        // top of the engine's own mapping).
        if (input.signal.aborted) {
          return { ok: false, finalUrl: input.url, html: '', code: 'cancelled', message: 'request cancelled', authSignal: null };
        }
        if (new Date(composedDeadline).getTime() <= now()) {
          return { ok: false, finalUrl: input.url, html: '', code: 'timeout', message: 'request timed out', authSignal: null };
        }
        return { ok: false, finalUrl: input.url, html: '', code: 'unexpected', message: 'transport engine threw', authSignal: null };
      }
    };
    result = await runFetch();

    // Login-page detection: the engine may emit an explicit `login_page`
    // auth signal, OR the fetched body may structurally be the provider's
    // login form (expired/rejected session). Classifying the HTML here (in
    // addition to engine signals) makes the exactly-one-re-login path work
    // with the production crawlee engine too (M4b), not just injected
    // engines that set the signal.
    let loginPageDetected =
      result.authSignal === 'login_page' ||
      (result.ok && Boolean(input.loginConfig) && isLoginPage(result.html, input.loginConfig!));

    try {
      if (loginPageDetected && requiresAuth && reLoginCount === 0) {
        // Retire the stale session and re-login exactly once, then retry once.
        sessions.delete(input.connectionId);
        onEvent({ type: 'relogin', providerId: input.providerId });
        reLoginCount = 1;
        sessionReused = false;
        const digest = digestSecret(input.credentials);
        const session = await loginLocked(input, policy, createSourcingStorageDir(`${input.connectionId}-${now()}`), digest);
        if (!session) {
          return { ok: false, code: 'auth_failed', message: 're-login failed', telemetry: baseTelemetry({ loginAttempted: true, reLoginCount }) };
        }
        cookies = session.cookies;
        result = await runFetch();
        // Recompute on the RETRIED result: the old detection is stale.
        loginPageDetected =
          result.authSignal === 'login_page' ||
          (result.ok && Boolean(input.loginConfig) && isLoginPage(result.html, input.loginConfig!));
      }
    } finally {
      removeSourcingStorageDir(storageDir);
    }

    // Post-retry re-check: if the retried fetch still shows a login page, the
    // session is exhausted — exactly one re-login was already performed.
    if (loginPageDetected && requiresAuth && reLoginCount >= 1) {
      return { ok: false, code: 'auth_expired', message: 'session re-authentication failed after exactly one re-login', telemetry: baseTelemetry({ loginAttempted: true, reLoginCount }) };
    }

    // 4. Final URL must stay on the navigation origin.
    if (result.ok && !sameOrigin(result.finalUrl, policy.navigationOrigin)) {
      return { ok: false, code: 'origin_blocked', message: 'final URL is off the provider navigation origin', telemetry: baseTelemetry({ loginAttempted, sessionReused, reLoginCount }) };
    }

    // 5. Response cap (belt-and-braces on top of the engine's own cap).
    if (result.ok && utf8ByteLength(result.html) > policy.responseCapBytes) {
      return { ok: false, code: 'body_too_large', message: 'response exceeded the HTML cap', telemetry: baseTelemetry({ loginAttempted, sessionReused, reLoginCount }) };
    }

    onEvent({ type: 'fetch_result', providerId: input.providerId, ok: result.ok, code: result.code, durationMs: now() - started });

    if (!result.ok) {
      return {
        ok: false,
        code: (result.code ?? 'unexpected') as 'origin_blocked',
        message: result.message ?? 'transport failed',
        telemetry: baseTelemetry({ loginAttempted, sessionReused, reLoginCount }),
      };
    }
    return {
      ok: true,
      finalUrl: result.finalUrl,
      html: result.html,
      telemetry: baseTelemetry({ loginAttempted, sessionReused, reLoginCount }),
    };
  }

  const manager: HtmlScraperSessionManager = {
    fetchHtml,
    async closeAll() {
      closed = true;
      await engine.close();
      sessions.clear();
      loginLocks.clear();
      activeManagers.delete(manager);
    },
  };
  // Production managers register themselves so the server shutdown hook
  // (closeAllHtmlScraperSessions) can release them; per-lookup `finally`
  // cleanup remains the normal path.
  activeManagers.add(manager);
  return manager;
}

// ─── Global registry for the server shutdown hook ─────────────────────────────

const activeManagers = new Set<HtmlScraperSessionManager>();

/**
 * Per-connection sliding-window rate limiter (shared across managers so a
 * fresh manager/crawler per lookup cannot bypass the provider ceiling).
 * Returns true when a slot was acquired before the deadline.
 */
const requestTimeline = new Map<string, number[]>();
let managerSeq = 0;
async function acquireRateSlot(connectionId: string, managerKey: string, rpm: number, deadlineAt: string): Promise<boolean> {
  const allowed = Math.max(1, Math.floor(rpm));
  const key = `${connectionId}::${managerKey}`;
  for (;;) {
    const nowMs = Date.now();
    if (nowMs >= new Date(deadlineAt).getTime()) return false;
    const windowStart = nowMs - 60_000;
    const times = (requestTimeline.get(key) ?? []).filter((t) => t > windowStart);
    if (times.length < allowed) {
      times.push(nowMs);
      requestTimeline.set(key, times);
      return true;
    }
    const waitMs = Math.max(50, times[0] + 60_000 - nowMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

export function registerHtmlScraperSessionManager(manager: HtmlScraperSessionManager): () => void {
  activeManagers.add(manager);
  return () => activeManagers.delete(manager);
}

/** Close every registered session manager (async server shutdown path). */
export async function closeAllHtmlScraperSessions(): Promise<void> {
  await Promise.all(Array.from(activeManagers, (m) => m.closeAll()));
  activeManagers.clear();
}

// ─── Default (lazy Crawlee) engine ────────────────────────────────────────────

let crawleeImportPromise: Promise<typeof import('crawlee')> | null = null;
function getCrawlee(): Promise<typeof import('crawlee')> {
  // Lazy import: sourcing never loads Crawlee unless a scraper run starts,
  // and the storage directory is created BEFORE this import resolves.
  crawleeImportPromise ??= import('crawlee');
  return crawleeImportPromise;
}

const NAVIGATION_BLOCKED = 'origin_blocked';

/**
 * Run a crawler with caller-abort AND absolute-deadline support (Crawlee's
 * run() has no signal option): on abort we stop the crawler and reject with
 * a stable code, distinguishing the caller's cancellation from the composed
 * deadline expiring mid-flight.
 */
function runCrawler<R>(
  crawler: { run(urls: R): Promise<unknown>; stop(reason?: string): void },
  urls: R,
  signal: AbortSignal,
  deadlineAt: string,
): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(new Error('cancelled'));
  }
  if (new Date(deadlineAt).getTime() <= Date.now()) {
    return Promise.reject(new Error('timeout'));
  }
  return new Promise((resolve, reject) => {
    const internal = new AbortController();
    const deadlineMs = new Date(deadlineAt).getTime() - Date.now();
    const timer = setTimeout(() => internal.abort(), Math.max(0, deadlineMs));
    const onAbort = () => {
      clearTimeout(timer);
      try {
        crawler.stop('aborted');
      } catch {
        // stop is best-effort during teardown
      }
      reject(new Error(internal.signal.aborted && new Date(deadlineAt).getTime() <= Date.now() ? 'timeout' : 'cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    internal.signal.addEventListener('abort', onAbort, { once: true });
    crawler
      .run(urls)
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        internal.signal.removeEventListener('abort', onAbort);
      });
  });
}

const BROWSER_LAUNCH_RACE_RE = /browser has been closed|newPage\(\) failed|Target closed/i;

/**
 * Browser-crawler launch can transiently fail when the previous crawler's
 * browser is still tearing down (observed live on shop.phillipspet.com under
 * Bun: `Target page, context or browser has been closed`). Retry once after a
 * short settle delay — bounded by the same deadline.
 */
async function runBrowserCrawler<R>(
  crawler: { run(urls: R): Promise<unknown>; stop(reason?: string): void },
  urls: R,
  signal: AbortSignal,
  deadlineAt: string,
): Promise<unknown> {
  try {
    return await runCrawler(crawler, urls, signal, deadlineAt);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!BROWSER_LAUNCH_RACE_RE.test(msg) || signal.aborted || new Date(deadlineAt).getTime() <= Date.now()) {
      throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return runCrawler(crawler, urls, signal, deadlineAt);
  }
}

function isAssetHost(url: string, assetHosts: readonly string[]): boolean {
  try {
    return assetHosts.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function waitForAny(page: { waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown> }, selectors: readonly string[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (const selector of selectors) {
    if (Date.now() > deadline) return false;
    try {
      await page.waitForSelector(selector, { timeout: Math.max(0, deadline - Date.now()) });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Race the login success indicators against the failure indicators with a
 * bounded budget. Never depends on `waitForLoadState` — SPA navigations can
 * hang on analytics scripts (observed live on orders.petfoodexperts.com),
 * which previously burned the whole login deadline.
 */
async function waitForLoginOutcome(
  page: { waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown> },
  successSelectors: readonly string[],
  failureSelectors: readonly string[],
  timeoutMs: number,
): Promise<'success' | 'failure' | 'none'> {
  const deadline = Date.now() + timeoutMs;
  const waits: Array<Promise<'success' | 'failure'>> = [
    ...successSelectors.map((sel) =>
      page.waitForSelector(sel, { timeout: Math.max(0, deadline - Date.now()) }).then(() => 'success' as const),
    ),
    ...failureSelectors.map((sel) =>
      page.waitForSelector(sel, { timeout: Math.max(0, deadline - Date.now()) }).then(() => 'failure' as const),
    ),
  ];
  if (waits.length === 0) return 'none';
  try {
    return await Promise.any(waits);
  } catch {
    return 'none';
  }
}

/**
 * Production engine backed by Crawlee (lazily imported). Storage is a unique
 * per-run directory created before the import; cookie/session persistence is
 * disabled by the crawler options; main-frame navigation is origin-enforced
 * via pre-navigation hooks (subresource hosts are capped by the connector's
 * image allowlist); response bodies are capped. Exercised by the env-gated
 * live smoke (M6) — unit tests use injected engines.
 */
export function createCrawleeHtmlScraperEngine(): HtmlScraperEngine {
  // Browser flows (login + JS-rendered fetches) run on DIRECT Playwright —
  // one browser + one context per engine/lookup — instead of Crawlee's
  // PlaywrightCrawler. Crawlee's browser lifecycle proved fragile under Bun
  // when browsers launch back-to-back (login → fetch): `Target page,
  // context or browser has been closed` on newPage (observed live on
  // shop.phillipspet.com, 2026-08-15). The static CheerioCrawler path below
  // remains crawlee-based (proven live by the bradley smoke).
  let playwrightPromise: Promise<typeof import('playwright')> | null = null;
  let browserPromise: Promise<import('playwright').Browser> | null = null;
  let contextPromise: Promise<import('playwright').BrowserContext> | null = null;

  function getPlaywright(): Promise<typeof import('playwright')> {
    playwrightPromise ??= import('playwright');
    return playwrightPromise;
  }

  async function getBrowserContext(): Promise<import('playwright').BrowserContext> {
    contextPromise ??= (async () => {
      const { chromium } = await getPlaywright();
      const browser = await chromium.launch({ headless: true });
      browserPromise = Promise.resolve(browser);
      return browser.newContext({
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      });
    })();
    return contextPromise;
  }

  /** Race `work` against the caller signal AND the absolute deadline. */
  function runBounded<T>(work: () => Promise<T>, signal: AbortSignal, deadlineAt: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('cancelled'));
        return;
      }
      const remaining = new Date(deadlineAt).getTime() - Date.now();
      if (remaining <= 0) {
        reject(new Error('timeout'));
        return;
      }
      const timer = setTimeout(() => reject(new Error('timeout')), remaining);
      const onAbort = () => reject(new Error('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      work().then(
        (v) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  return {
    async login({ loginConfig, credentials, policy, signal, deadlineAt, storageDir }) {
      void storageDir;
      const origin = policy.navigationOrigin;
      try {
        return await runBounded(
          async () => {
            const context = await getBrowserContext();
            const page = await context.newPage();
            try {
              const gotoTimeout = Math.max(
                0,
                Math.min(loginConfig.timeoutMs, policy.requestTimeoutMs, new Date(deadlineAt).getTime() - Date.now()),
              );
              await page.goto(loginConfig.loginUrl, { waitUntil: 'domcontentloaded', timeout: gotoTimeout });
              // A cross-origin redirect that happens to render matching
              // selectors must NEVER receive credentials.
              if (!sameOrigin(page.url(), origin)) {
                throw new Error(NAVIGATION_BLOCKED);
              }
              const fillFirstVisible = async (selectors: readonly string[], value: string): Promise<boolean> => {
                for (const sel of selectors) {
                  try {
                    await page.waitForSelector(sel, { timeout: Math.min(loginConfig.timeoutMs, 10_000) });
                    const el = page.locator(sel).first();
                    if ((await el.count()) > 0) {
                      await el.fill(value);
                      return true;
                    }
                  } catch {
                    // try the next selector in the chain
                  }
                }
                return false;
              };
              const usernameFilled = await fillFirstVisible(loginConfig.usernameSelectors, credentials.username);
              const passwordFilled = await fillFirstVisible(loginConfig.passwordSelectors, credentials.password);
              if (!usernameFilled || !passwordFilled) {
                throw new Error('login_failed');
              }
              let submitted = false;
              for (const sel of loginConfig.submitSelectors) {
                try {
                  await page.waitForSelector(sel, { timeout: Math.min(loginConfig.timeoutMs, 10_000) });
                  const el = page.locator(sel).first();
                  if ((await el.count()) > 0) {
                    await el.click();
                    submitted = true;
                    break;
                  }
                } catch {
                  // try the next submit selector
                }
              }
              if (!submitted) {
                throw new Error('login_failed');
              }
              // Bounded success-vs-failure race — never waitForLoadState
              // (SPA navigations can hang on analytics scripts).
              const loginOutcome = await waitForLoginOutcome(
                page,
                loginConfig.successSelectors,
                loginConfig.failureSelectors,
                Math.min(loginConfig.timeoutMs, 30_000),
              );
              if (loginOutcome !== 'success') {
                throw new Error('login_failed');
              }
              if (!sameOrigin(page.url(), origin)) {
                throw new Error(NAVIGATION_BLOCKED);
              }
              const cookies = await context.cookies();
              return { ok: true, cookies: Object.fromEntries(cookies.map((c) => [c.name, c.value])) };
            } finally {
              await page.close().catch(() => {});
            }
          },
          signal,
          deadlineAt,
        );
      } catch (e) {
        if (new Date(deadlineAt).getTime() <= Date.now()) {
          return { ok: false, code: 'timeout', message: 'login timed out' };
        }
        if (signal.aborted) {
          return { ok: false, code: 'cancelled', message: 'login cancelled' };
        }
        if (e instanceof Error && e.message === NAVIGATION_BLOCKED) {
          return { ok: false, code: 'origin_blocked', message: 'login navigation left the provider origin' };
        }
        const reason = e instanceof Error && e.message === 'login_failed' ? 'login_failed' : 'unexpected';
        return { ok: false, code: reason, message: 'login failed' };
      }
    },

    async fetch({ url, cookies, policy, signal, deadlineAt, storageDir, browserRequired, waitForSelectors }) {
      const origin = policy.navigationOrigin;
      const cookieHeader =
        cookies && Object.keys(cookies).length > 0
          ? { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') }
          : undefined;
      // Static fetches keep the crawlee CheerioCrawler path (proven live).
      if (!browserRequired) {
        const requestOpts: { url: string } = { url };
        try {
          const crawlee = await getCrawlee();
          const config = new crawlee.Configuration({
            storageClientOptions: { localDataDirectory: storageDir },
            // crawlee defaults `availableMemoryRatio` to 0.25 (max memory =
            // 25% of total system RAM) and emits "Memory is critically
            // overloaded" warnings + sheds concurrency whenever the whole
            // dev machine is busy (Chrome + dev servers — observed
            // 2026-08-15). Sourcing crawls are bounded single-request
            // lookups with an explicit deadline: memory-aware autoscaling is
            // noise here. 0.9 is fail-safe — the pool still sheds when the
            // machine is genuinely at 90%+.
            availableMemoryRatio: 0.9,
          });
          let outcome: HtmlScraperEngineFetchResult = {
            ok: false, finalUrl: url, html: '', code: 'unexpected', message: 'no response', authSignal: null,
          };
          const crawler = new crawlee.CheerioCrawler(
            {
              ...buildCrawlerOptions(policy, 'static'),
              // Bun runtime + http2-wrapper's origin-set check rejects
              // default-port normalization on h2-negotiating storefronts
              // (observed live against bradleycaldwell.com). Force HTTP/1.1 —
              // origin/size/deadline/auth bounds are enforced in the
              // requestHandler regardless of protocol.
              preNavigationHooks: [
                async (_ctx, gotOptions) => {
                  gotOptions.http2 = false;
                  // Auth cookies are injected HERE (per-request runtime), so
                  // they never enter the disk-serialized request object.
                  if (cookieHeader) {
                    gotOptions.headers = { ...(gotOptions.headers ?? {}), ...cookieHeader };
                  }
                },
              ],
              async requestHandler(ctx) {
                const { request } = ctx;
                if (!sameOrigin(request.url, origin)) {
                  outcome = { ok: false, finalUrl: request.url, html: '', code: 'origin_blocked', message: 'request left the provider navigation origin', authSignal: null };
                  return;
                }
                const declared = (ctx as { response?: { headers?: Record<string, string | string[] | undefined> } }).response?.headers?.['content-length'];
                if (declared && Number(declared) > policy.responseCapBytes) {
                  outcome = { ok: false, finalUrl: request.url, html: '', code: 'body_too_large', message: 'content-length exceeds the HTML cap', authSignal: null };
                  return;
                }
                const raw = ctx.body;
                const body = typeof raw === 'string' ? raw : raw instanceof Buffer ? raw.toString('utf8') : String(raw ?? '');
                if (utf8ByteLength(body) > policy.responseCapBytes) {
                  outcome = { ok: false, finalUrl: request.url, html: '', code: 'body_too_large', message: 'body exceeds the HTML cap', authSignal: null };
                  return;
                }
                outcome = { ok: true, finalUrl: request.url, html: body, authSignal: 'auth_ok' };
              },
            },
            config,
          );
          await runCrawler(crawler, [requestOpts], signal, deadlineAt);
          await crawler.stop();
          return outcome;
        } catch (e) {
          if (new Date(deadlineAt).getTime() <= Date.now()) {
            return { ok: false, finalUrl: url, html: '', code: 'timeout', message: 'request timed out', authSignal: null };
          }
          if (signal.aborted) {
            return { ok: false, finalUrl: url, html: '', code: 'cancelled', message: 'request cancelled', authSignal: null };
          }
          if (e instanceof Error && e.message === NAVIGATION_BLOCKED) {
            return { ok: false, finalUrl: url, html: '', code: 'origin_blocked', message: 'navigation left the provider origin', authSignal: null };
          }
          return { ok: false, finalUrl: url, html: '', code: 'unexpected', message: 'transport failed', authSignal: null };
        }
      }

      // Browser (JS-rendered) fetches: direct Playwright on the shared
      // context — the login session cookies are already there.
      try {
        return await runBounded(
          async () => {
            const context = await getBrowserContext();
            const page = await context.newPage();
            try {
              const gotoTimeout = Math.max(
                0,
                Math.min(policy.requestTimeoutMs, new Date(deadlineAt).getTime() - Date.now()),
              );
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: gotoTimeout });
              if (!sameOrigin(page.url(), origin)) {
                throw new Error(NAVIGATION_BLOCKED);
              }
              // Wait for ANY declared hydration marker within the remaining
              // budget (the plan: “wait for one of …”).
              const remainingMs = Math.max(0, new Date(deadlineAt).getTime() - Date.now());
              if (waitForSelectors.length > 0) {
                await Promise.any(
                  waitForSelectors.map((sel) =>
                    page.waitForSelector(sel, { timeout: Math.min(policy.requestTimeoutMs, remainingMs) }).then(() => true),
                  ),
                ).catch(() => {});
              }
              if (!sameOrigin(page.url(), origin)) {
                throw new Error(NAVIGATION_BLOCKED);
              }
              const html = await page.content();
              if (utf8ByteLength(html) > policy.responseCapBytes) {
                return { ok: false, finalUrl: page.url(), html: '', code: 'body_too_large', message: 'rendered page exceeds the HTML cap', authSignal: null };
              }
              return { ok: true, finalUrl: page.url(), html, authSignal: 'auth_ok' };
            } finally {
              await page.close().catch(() => {});
            }
          },
          signal,
          deadlineAt,
        );
      } catch (e) {
        if (new Date(deadlineAt).getTime() <= Date.now()) {
          return { ok: false, finalUrl: url, html: '', code: 'timeout', message: 'request timed out', authSignal: null };
        }
        if (signal.aborted) {
          return { ok: false, finalUrl: url, html: '', code: 'cancelled', message: 'request cancelled', authSignal: null };
        }
        if (e instanceof Error && e.message === NAVIGATION_BLOCKED) {
          return { ok: false, finalUrl: url, html: '', code: 'origin_blocked', message: 'navigation left the provider origin', authSignal: null };
        }
        return { ok: false, finalUrl: url, html: '', code: 'unexpected', message: 'transport failed', authSignal: null };
      }
    },

    async close() {
      if (contextPromise) {
        await (await contextPromise).close().catch(() => {});
        contextPromise = null;
      }
      if (browserPromise) {
        await (await browserPromise).close().catch(() => {});
        browserPromise = null;
      }
      playwrightPromise = null;
      crawleeImportPromise = null;
    },
  };
}

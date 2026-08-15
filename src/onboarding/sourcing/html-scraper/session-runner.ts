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

  return {
    fetchHtml,
    async closeAll() {
      closed = true;
      await engine.close();
      sessions.clear();
      loginLocks.clear();
    },
  };
}

// ─── Global registry for the server shutdown hook ─────────────────────────────

const activeManagers = new Set<HtmlScraperSessionManager>();

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
 * Run a crawler with caller-abort support (Crawlee's run() has no signal
 * option): on abort we stop the crawler and reject with a stable code.
 */
function runCrawler<R>(
  crawler: { run(urls: R): Promise<unknown>; stop(reason?: string): void },
  urls: R,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(new Error('cancelled'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      try {
        crawler.stop('aborted');
      } catch {
        // stop is best-effort during teardown
      }
      reject(new Error('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    crawler
      .run(urls)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
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
 * Production engine backed by Crawlee (lazily imported). Storage is a unique
 * per-run directory created before the import; cookie/session persistence is
 * disabled by the crawler options; main-frame navigation is origin-enforced
 * via pre-navigation hooks (subresource hosts are capped by the connector's
 * image allowlist); response bodies are capped. Exercised by the env-gated
 * live smoke (M6) — unit tests use injected engines.
 */
export function createCrawleeHtmlScraperEngine(): HtmlScraperEngine {
  return {
    async login({ loginConfig, credentials, policy, signal, deadlineAt, storageDir }) {
      const origin = policy.navigationOrigin;
      try {
        const crawlee = await getCrawlee();
        const config = new crawlee.Configuration({
          storageClientOptions: { localDataDirectory: storageDir },
        });
        let capturedCookies: Record<string, string> = {};
        const crawler = new crawlee.PlaywrightCrawler(
          {
            ...buildCrawlerOptions(policy, 'browser'),
            preNavigationHooks: [
              async ({ request }, gotoOptions) => {
                if (!sameOrigin(request.url, origin)) {
                  throw new Error(NAVIGATION_BLOCKED);
                }
                gotoOptions.timeout = Math.min(gotoOptions.timeout ?? policy.requestTimeoutMs, policy.requestTimeoutMs);
              },
            ],
            async requestHandler(ctx) {
              const { page } = ctx;
              await page.goto(loginConfig.loginUrl, {
                waitUntil: 'domcontentloaded',
                timeout: Math.min(loginConfig.timeoutMs, policy.requestTimeoutMs),
              });
              for (const sel of loginConfig.usernameSelectors) {
                const el = page.locator(sel).first();
                if ((await el.count()) > 0) {
                  await el.fill(credentials.username);
                  break;
                }
              }
              for (const sel of loginConfig.passwordSelectors) {
                const el = page.locator(sel).first();
                if ((await el.count()) > 0) {
                  await el.fill(credentials.password);
                  break;
                }
              }
              for (const sel of loginConfig.submitSelectors) {
                const el = page.locator(sel).first();
                if ((await el.count()) > 0) {
                  await el.click();
                  break;
                }
              }
              await page.waitForLoadState('domcontentloaded');
              const success = await waitForAny(page, loginConfig.successSelectors, Math.min(loginConfig.timeoutMs, 30_000));
              if (!success) {
                throw new Error('login_failed');
              }
              const cookies = await page.context().cookies();
              capturedCookies = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
            },
          },
          config,
        );
        await runCrawler(crawler, [loginConfig.loginUrl], signal);
        await crawler.stop();
        return { ok: true, cookies: capturedCookies };
      } catch (e) {
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
      const requestOpts: { url: string; headers?: Record<string, string> } = {
        url,
        headers: cookies && Object.keys(cookies).length > 0
          ? { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') }
          : undefined,
      };
      try {
        const crawlee = await getCrawlee();
        const config = new crawlee.Configuration({
          storageClientOptions: { localDataDirectory: storageDir },
        });
        let outcome: HtmlScraperEngineFetchResult = {
          ok: false, finalUrl: url, html: '', code: 'unexpected', message: 'no response', authSignal: null,
        };

        if (browserRequired) {
          const crawler = new crawlee.PlaywrightCrawler(
            {
              ...buildCrawlerOptions(policy, 'browser'),
              preNavigationHooks: [
                async ({ request }, gotoOptions) => {
                  // Main-frame navigation is limited to the navigation origin.
                  if (!sameOrigin(request.url, origin)) {
                    throw new Error(NAVIGATION_BLOCKED);
                  }
                  gotoOptions.timeout = Math.min(gotoOptions.timeout ?? policy.requestTimeoutMs, policy.requestTimeoutMs);
                },
              ],
              async requestHandler(ctx) {
                const { page, request } = ctx;
                for (const sel of waitForSelectors) {
                  await page.waitForSelector(sel, { timeout: Math.min(policy.requestTimeoutMs, 15_000) }).catch(() => {});
                }
                const html = await page.content();
                if (utf8ByteLength(html) > policy.responseCapBytes) {
                  outcome = { ok: false, finalUrl: page.url(), html: '', code: 'body_too_large', message: 'rendered page exceeds the HTML cap', authSignal: null };
                  return;
                }
                outcome = { ok: true, finalUrl: page.url(), html, authSignal: 'auth_ok' };
                void request;
              },
            },
            config,
          );
          await runCrawler(crawler, [requestOpts], signal);
          await crawler.stop();
        } else {
          const crawler = new crawlee.CheerioCrawler(
            {
              ...buildCrawlerOptions(policy, 'static'),
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
          await runCrawler(crawler, [requestOpts], signal);
          await crawler.stop();
        }
        return outcome;
      } catch (e) {
        if (signal.aborted) {
          return { ok: false, finalUrl: url, html: '', code: 'cancelled', message: 'request cancelled', authSignal: null };
        }
        if (e instanceof Error && e.message === NAVIGATION_BLOCKED) {
          return { ok: false, finalUrl: url, html: '', code: 'origin_blocked', message: 'navigation left the provider origin', authSignal: null };
        }
        if (new Date(deadlineAt).getTime() <= Date.now()) {
          return { ok: false, finalUrl: url, html: '', code: 'timeout', message: 'request timed out', authSignal: null };
        }
        return { ok: false, finalUrl: url, html: '', code: 'unexpected', message: 'transport failed', authSignal: null };
      }
    },

    async close() {
      // Crawlee crawlers are stopped per call; nothing global to release here
      // beyond dropping the lazy import reference so a later run re-imports.
      crawleeImportPromise = null;
    },
  };
}

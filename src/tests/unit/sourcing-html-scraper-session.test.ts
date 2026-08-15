import { describe, test, expect, afterEach } from 'vitest';
import {
  createHtmlScraperSessionManager,
  buildCrawlerOptions,
  closeAllHtmlScraperSessions,
  closeAllSharedHtmlScraperManagers,
  getSharedHtmlScraperManager,
  registerHtmlScraperSessionManager,
  sharedHtmlScraperManagerCount,
  type HtmlScraperEngine,
  type HtmlScraperEngineFetchResult,
  type HtmlScraperEngineLoginResult,
} from '../../onboarding/sourcing/html-scraper/session-runner';
import { HTML_SCRAPER_CEILINGS, type HtmlScraperRuntimePolicy, type LoginAutomationConfig } from '../../onboarding/sourcing/html-scraper/contracts';
import { ORGILL_LOGIN } from '../../onboarding/sourcing/html-scraper/login-config';
import type { HtmlScraperCredentials } from '../../onboarding/sourcing/secret-resolver';

const POLICY: HtmlScraperRuntimePolicy = {
  providerId: 'orgill',
  navigationOrigin: 'https://www.orgill.com',
  assetHosts: ['www.orgill.com'],
  responseCapBytes: HTML_SCRAPER_CEILINGS.responseCapBytes,
  maxRequests: HTML_SCRAPER_CEILINGS.maxRequests,
  requestTimeoutMs: HTML_SCRAPER_CEILINGS.requestTimeoutMs,
  requestsPerMinute: HTML_SCRAPER_CEILINGS.authRequestsPerMinute,
  sessionTtlMs: HTML_SCRAPER_CEILINGS.sessionTtlMs,
  retryCount: HTML_SCRAPER_CEILINGS.retryCount,
  allowBrowserFallback: false,
};

const CREDENTIALS: HtmlScraperCredentials = { username: 'user@example.com', password: 'correct horse battery staple' };

function okFetch(overrides: Partial<HtmlScraperEngineFetchResult> = {}): HtmlScraperEngineFetchResult {
  return { ok: true, finalUrl: 'https://www.orgill.com/pdp?sku=1', html: '<h1>Orgill Product</h1>', authSignal: 'auth_ok', ...overrides };
}

class FakeEngine implements HtmlScraperEngine {
  loginCalls = 0;
  fetchCalls: Array<{ url: string; cookies: Record<string, string> | null }> = [];
  closed = false;
  loginScript: () => HtmlScraperEngineLoginResult | Promise<HtmlScraperEngineLoginResult> = () => ({ ok: true, cookies: { sid: 'sess-1' } });
  fetchScript: () => HtmlScraperEngineFetchResult | Promise<HtmlScraperEngineFetchResult> = () => okFetch();

  async login(): Promise<HtmlScraperEngineLoginResult> {
    this.loginCalls += 1;
    return this.loginScript();
  }
  async fetch(input: { url: string; cookies: Record<string, string> | null }): Promise<HtmlScraperEngineFetchResult> {
    this.fetchCalls.push({ url: input.url, cookies: input.cookies });
    return this.fetchScript();
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeInput(overrides: Partial<Parameters<ReturnType<typeof createHtmlScraperSessionManager>['fetchHtml']>[0]> = {}) {
  return {
    connectionId: 'conn-orgill',
    providerId: 'orgill',
    url: 'https://www.orgill.com/SearchResultN.aspx?ddlhQ=755625321923',
    policy: POLICY,
    loginConfig: ORGILL_LOGIN,
    credentials: CREDENTIALS,
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe('html_scraper session runner (injected engine; no network/browser)', () => {
  test('buildCrawlerOptions disables persistence, sets no proxy, and bounds retries/rate/concurrency', () => {
    const opts = buildCrawlerOptions(POLICY, 'static') as Record<string, unknown>;
    expect(opts.useSessionPool).toBe(true);
    expect(opts.persistCookiesPerSession).toBe(false);
    expect((opts.sessionPoolOptions as { persistenceOptions: { enable: boolean } }).persistenceOptions.enable).toBe(false);
    expect(opts.proxyConfiguration).toBeUndefined();
    expect(opts.maxRequestRetries).toBe(1);
    expect(opts.maxConcurrency).toBe(1);
    expect(opts.maxRequestsPerMinute).toBe(6);
    expect(opts.retryOnBlocked).toBe(true);
  });

  test('a fresh authenticated fetch logs in once, reuses cookies for the request', async () => {
    const engine = new FakeEngine();
    const manager = createHtmlScraperSessionManager(engine);
    const result = await manager.fetchHtml(makeInput());
    expect(result.ok).toBe(true);
    expect(engine.loginCalls).toBe(1);
    expect(engine.fetchCalls.length).toBe(1);
    expect(engine.fetchCalls[0].cookies).toEqual({ sid: 'sess-1' });
    await manager.closeAll();
  });

  test('a valid session is reused within the TTL (no second login)', async () => {
    const engine = new FakeEngine();
    const manager = createHtmlScraperSessionManager(engine);
    await manager.fetchHtml(makeInput());
    const second = await manager.fetchHtml(makeInput({ url: 'https://www.orgill.com/SearchResultN.aspx?ddlhQ=2' }));
    expect(second.ok).toBe(true);
    expect(engine.loginCalls).toBe(1);
    expect(engine.fetchCalls.length).toBe(2);
    await manager.closeAll();
  });

  test('session expires after the 15-minute TTL and logs in again', async () => {
    const engine = new FakeEngine();
    let clock = 1_000_000;
    const manager = createHtmlScraperSessionManager(engine, { now: () => clock });
    await manager.fetchHtml(makeInput());
    clock += HTML_SCRAPER_CEILINGS.sessionTtlMs + 1;
    const second = await manager.fetchHtml(makeInput({ url: 'https://www.orgill.com/SearchResultN.aspx?ddlhQ=3' }));
    expect(second.ok).toBe(true);
    expect(engine.loginCalls).toBe(2);
    await manager.closeAll();
  });

  test('credential rotation invalidates the prior session', async () => {
    const engine = new FakeEngine();
    const manager = createHtmlScraperSessionManager(engine);
    await manager.fetchHtml(makeInput());
    const second = await manager.fetchHtml(makeInput({ credentials: { ...CREDENTIALS, password: 'different' } }));
    expect(second.ok).toBe(true);
    expect(engine.loginCalls).toBe(2);
    await manager.closeAll();
  });

  test('per-connection login serialization: concurrent lookups trigger ONE login', async () => {
    const engine = new FakeEngine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    engine.loginScript = () => {
      void gate; // first caller awaits the gate; second caller must not reach login
      return { ok: true, cookies: { sid: 'sess-1' } };
    };
    // Make login slow on the FIRST call by wrapping: count concurrent entries.
    let loginConcurrency = 0;
    let maxLoginConcurrency = 0;
    const realLogin = engine.login.bind(engine);
    engine.login = async (...args) => {
      loginConcurrency += 1;
      maxLoginConcurrency = Math.max(maxLoginConcurrency, loginConcurrency);
      await new Promise((r) => setTimeout(r, 5));
      const res = await realLogin(...args);
      loginConcurrency -= 1;
      return res;
    };
    const manager = createHtmlScraperSessionManager(engine);
    const [a, b] = await Promise.all([
      manager.fetchHtml(makeInput({ url: 'https://www.orgill.com/SearchResultN.aspx?ddlhQ=4' })),
      manager.fetchHtml(makeInput({ url: 'https://www.orgill.com/SearchResultN.aspx?ddlhQ=5' })),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(maxLoginConcurrency).toBe(1);
    expect(engine.loginCalls).toBe(1);
    void release;
    await manager.closeAll();
  });

  test('exactly ONE re-login on a login-page signal, then a successful retry', async () => {
    const engine = new FakeEngine();
    let fetchCount = 0;
    engine.fetchScript = () => {
      fetchCount += 1;
      return fetchCount === 1 ? okFetch({ authSignal: 'login_page' }) : okFetch();
    };
    const events: string[] = [];
    const manager = createHtmlScraperSessionManager(engine, { onEvent: (e) => events.push(e.type) });
    const result = await manager.fetchHtml(makeInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.telemetry.reLoginCount).toBe(1);
    expect(engine.loginCalls).toBe(2); // initial + exactly one re-login
    expect(fetchCount).toBe(2);
    expect(events).toContain('relogin');
    await manager.closeAll();
  });

  test('a second auth signal after re-login fails closed as auth_expired', async () => {
    const engine = new FakeEngine();
    engine.fetchScript = () => okFetch({ authSignal: 'login_page' });
    const manager = createHtmlScraperSessionManager(engine);
    const result = await manager.fetchHtml(makeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('auth_expired');
      expect(result.telemetry.reLoginCount).toBe(1);
    }
    expect(engine.loginCalls).toBe(2);
    await manager.closeAll();
  });

  test('a login-page BODY (no engine auth signal) also triggers exactly one re-login (M4b classification)', async () => {
    const engine = new FakeEngine();
    let fetchCount = 0;
    engine.fetchScript = () => {
      fetchCount += 1;
      return fetchCount === 1
        ? okFetch({
            authSignal: 'auth_ok', // engine did NOT emit login_page
            html: '<form><input id="cphMainContent_ctl00_loginOrgillxs_UserName"/><input id="cphMainContent_ctl00_loginOrgillxs_Password"/></form>',
          })
        : okFetch();
    };
    const events: string[] = [];
    const manager = createHtmlScraperSessionManager(engine, { onEvent: (e) => events.push(e.type) });
    const result = await manager.fetchHtml(makeInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.telemetry.reLoginCount).toBe(1);
    expect(engine.loginCalls).toBe(2); // initial + exactly one re-login
    expect(fetchCount).toBe(2);
    expect(events).toContain('relogin');
    await manager.closeAll();
  });

  test('a login-page body that persists after re-login fails closed as auth_expired', async () => {
    const engine = new FakeEngine();
    engine.fetchScript = () =>
      okFetch({
        authSignal: 'auth_ok',
        html: '<form><input id="cphMainContent_ctl00_loginOrgillxs_UserName"/><input id="cphMainContent_ctl00_loginOrgillxs_Password"/></form>',
      });
    const manager = createHtmlScraperSessionManager(engine);
    const result = await manager.fetchHtml(makeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('auth_expired');
      expect(result.telemetry.reLoginCount).toBe(1);
    }
    expect(engine.loginCalls).toBe(2);
    await manager.closeAll();
  });

  test('login failure without a session fails closed as auth_failed and never fetches', async () => {
    const engine = new FakeEngine();
    engine.loginScript = () => ({ ok: false, code: 'login_failed', message: 'bad credentials' });
    const manager = createHtmlScraperSessionManager(engine);
    const result = await manager.fetchHtml(makeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('auth_failed');
    expect(engine.fetchCalls.length).toBe(0);
    await manager.closeAll();
  });

  test('pre-aborted signal creates NO crawler (no login, no fetch)', async () => {
    const engine = new FakeEngine();
    const manager = createHtmlScraperSessionManager(engine);
    const aborted = new AbortController();
    aborted.abort();
    const result = await manager.fetchHtml(makeInput({ signal: aborted.signal }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('cancelled');
    expect(engine.loginCalls).toBe(0);
    expect(engine.fetchCalls.length).toBe(0);
    await manager.closeAll();
  });

  test('expired deadline starts no crawler', async () => {
    const engine = new FakeEngine();
    const manager = createHtmlScraperSessionManager(engine);
    const result = await manager.fetchHtml(makeInput({ deadlineAt: new Date(Date.now() - 1).toISOString() }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('timeout');
    expect(engine.loginCalls).toBe(0);
    expect(engine.fetchCalls.length).toBe(0);
    await manager.closeAll();
  });

  test('mid-flight abort is mapped to cancelled', async () => {
    const engine = new FakeEngine();
    engine.fetchScript = () =>
      new Promise<HtmlScraperEngineFetchResult>((_resolve, reject) => {
        setTimeout(() => reject(new Error('aborted')), 10);
      });
    const controller = new AbortController();
    const manager = createHtmlScraperSessionManager(engine);
    const resultP = manager.fetchHtml(makeInput({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 2);
    const result = await resultP;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('cancelled');
    await manager.closeAll();
  });

  test('initial URL off the navigation origin fails origin_blocked before any engine call', async () => {
    const engine = new FakeEngine();
    const manager = createHtmlScraperSessionManager(engine);
    const result = await manager.fetchHtml(makeInput({ url: 'https://evil.example.com/Search?x=1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('origin_blocked');
    expect(engine.loginCalls).toBe(0);
    expect(engine.fetchCalls.length).toBe(0);
    await manager.closeAll();
  });

  test('same-origin redirect passes; off-origin final URL fails origin_blocked', async () => {
    const engine = new FakeEngine();
    engine.fetchScript = () => okFetch({ finalUrl: 'https://www.orgill.com/Redirected?x=1' });
    const manager = createHtmlScraperSessionManager(engine);
    const okResult = await manager.fetchHtml(makeInput());
    expect(okResult.ok).toBe(true);
    await manager.closeAll();

    const engine2 = new FakeEngine();
    engine2.fetchScript = () => okFetch({ finalUrl: 'https://evil.example.com/pdp' });
    const manager2 = createHtmlScraperSessionManager(engine2);
    const blocked = await manager2.fetchHtml(makeInput());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('origin_blocked');
    await manager2.closeAll();
  });

  test('an oversized response fails body_too_large (never silently truncated)', async () => {
    const engine = new FakeEngine();
    engine.fetchScript = () => okFetch({ html: 'x'.repeat(HTML_SCRAPER_CEILINGS.responseCapBytes + 1) });
    const manager = createHtmlScraperSessionManager(engine);
    const result = await manager.fetchHtml(makeInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('body_too_large');
    await manager.closeAll();
  });

  test('public connectors (no login config) skip login entirely and pass null cookies', async () => {
    const engine = new FakeEngine();
    engine.fetchScript = () => okFetch({ finalUrl: 'https://www.bradleycaldwell.com/search?term=012345678905' });
    const manager = createHtmlScraperSessionManager(engine);
    const result = await manager.fetchHtml(makeInput({
      providerId: 'bradley',
      loginConfig: undefined,
      credentials: null,
      url: 'https://www.bradleycaldwell.com/search?term=012345678905',
      policy: { ...POLICY, providerId: 'bradley', navigationOrigin: 'https://www.bradleycaldwell.com', requestsPerMinute: HTML_SCRAPER_CEILINGS.publicRequestsPerMinute },
    }));
    expect(result.ok).toBe(true);
    expect(engine.loginCalls).toBe(0);
    expect(engine.fetchCalls[0].cookies).toBeNull();
    await manager.closeAll();
  });

  test('events never contain credentials (redaction seam)', async () => {
    const engine = new FakeEngine();
    const captured: string[] = [];
    const manager = createHtmlScraperSessionManager(engine, {
      onEvent: (e) => captured.push(JSON.stringify(e)),
    });
    await manager.fetchHtml(makeInput());
    const all = captured.join(' ');
    expect(all).not.toContain('correct horse');
    expect(all).not.toContain('user@example.com');
    expect(all).not.toContain('sess-1');
    await manager.closeAll();
  });

  test('closeAllHtmlScraperSessions closes registered managers once', async () => {
    const engine = new FakeEngine();
    const manager = createHtmlScraperSessionManager(engine);
    const unregister = registerHtmlScraperSessionManager(manager);
    await closeAllHtmlScraperSessions();
    expect(engine.closed).toBe(true);
    // A second close is a no-op and cannot double-close.
    await closeAllHtmlScraperSessions();
    expect(engine.closed).toBe(true);
    unregister();
  });
});

describe('shared per-connection session managers (login reuse across lookups)', () => {
  afterEach(async () => {
    await closeAllSharedHtmlScraperManagers();
  });

  test('same connectionId reuses one manager and one engine: ONE login across lookups', async () => {
    const engine = new FakeEngine();
    const manager1 = getSharedHtmlScraperManager('conn-shared-1', () => engine);
    const manager2 = getSharedHtmlScraperManager('conn-shared-1', () => new FakeEngine());
    expect(manager1).toBe(manager2);
    expect(sharedHtmlScraperManagerCount()).toBe(1);

    await manager1.fetchHtml(makeInput({ connectionId: 'conn-shared-1' }));
    await manager2.fetchHtml(
      makeInput({ connectionId: 'conn-shared-1', url: 'https://www.orgill.com/SearchResultN.aspx?ddlhQ=755625321923&x=2' }),
    );
    expect(engine.loginCalls).toBe(1);
    expect(engine.fetchCalls.length).toBe(2);
  });

  test('different connectionIds get separate managers and engines', async () => {
    const engineA = new FakeEngine();
    const engineB = new FakeEngine();
    const a = getSharedHtmlScraperManager('conn-a', () => engineA);
    const b = getSharedHtmlScraperManager('conn-b', () => engineB);
    expect(a).not.toBe(b);
    expect(sharedHtmlScraperManagerCount()).toBe(2);
    await a.fetchHtml(makeInput({ connectionId: 'conn-a' }));
    await b.fetchHtml(makeInput({ connectionId: 'conn-b' }));
    expect(engineA.loginCalls).toBe(1);
    expect(engineB.loginCalls).toBe(1);
  });

  test('closeAllSharedHtmlScraperManagers closes engines and clears the registry', async () => {
    const engine = new FakeEngine();
    getSharedHtmlScraperManager('conn-close', () => engine);
    await closeAllSharedHtmlScraperManagers();
    expect(engine.closed).toBe(true);
    expect(sharedHtmlScraperManagerCount()).toBe(0);
    // A later lookup gets a fresh manager instead of a closed one.
    getSharedHtmlScraperManager('conn-close', () => new FakeEngine());
    expect(sharedHtmlScraperManagerCount()).toBe(1);
  });

  test('per-lookup budget caps ONE lookup, not the shared manager lifetime (regression: rate_limited after maxRequests)', async () => {
    const engine = new FakeEngine();
    const manager = getSharedHtmlScraperManager('conn-budget', () => engine);
    // Small cap + high per-minute ceiling so the test exercises the budget,
    // not the rate limiter (which would take minutes at the real 6/min).
    const fastPolicy = { ...POLICY, maxRequests: 3, requestsPerMinute: 1000 };

    // First lookup: a fresh budget makes every fetchHtml call count against
    // the per-lookup cap — maxRequests fetches succeed, the next is blocked.
    const budget = { used: 0 };
    for (let i = 0; i < fastPolicy.maxRequests; i++) {
      const res = await manager.fetchHtml(makeInput({ connectionId: 'conn-budget', policy: fastPolicy, budget }));
      expect(res.ok).toBe(true);
    }
    const blocked = await manager.fetchHtml(makeInput({ connectionId: 'conn-budget', policy: fastPolicy, budget }));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.code).toBe('rate_limited');
    }

    // Second lookup with a FRESH budget works — the shared manager's
    // lifetime request count must NOT block it (the production bug).
    const budget2 = { used: 0 };
    const again = await manager.fetchHtml(makeInput({ connectionId: 'conn-budget', policy: fastPolicy, budget: budget2 }));
    expect(again.ok).toBe(true);
    expect(engine.loginCalls).toBe(1); // session reused across lookups
    await closeAllSharedHtmlScraperManagers();
  });
});

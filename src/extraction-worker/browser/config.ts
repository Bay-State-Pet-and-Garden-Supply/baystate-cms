/**
 * Worker browser/proxy environment configuration.
 *
 * Reads and validates worker browser settings from environment variables.
 * All config is set at worker startup — live-reload is not expected.
 */

// ─── Env helpers ───────────────────────────────────────────────────────────

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[browser/config] Invalid ${key}="${raw}", falling back to ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type BrowserBackend = 'camoufox' | 'playwright';

export interface WorkerBrowserConfig {
  /** Which browser backend to use for rendered extraction. */
  backend: BrowserBackend;

  /** Whether to run the browser in headless mode. */
  headless: boolean;

  /** Maximum number of concurrent browser pages/contexts. */
  maxConcurrency: number;

  /** Max open pages per browser instance before retirement. */
  maxOpenPagesPerBrowser: number;

  /** Pages to process before retiring a browser instance. */
  retireBrowserAfterPageCount: number;

  /** Navigation timeout in milliseconds. */
  navigationTimeoutMs: number;

  /** Dwell time after page load in milliseconds. */
  dwellMs: number;

  /** Maximum number of request retries per URL. */
  maxRequestRetries: number;

  /** Proxy URLs (comma-separated). Empty array = no proxy. */
  proxyUrls: string[];
}

// ─── Defaults ──────────────────────────────────────────────────────────────

const DEFAULTS: WorkerBrowserConfig = {
  backend: 'camoufox',
  headless: true,
  maxConcurrency: 2,
  maxOpenPagesPerBrowser: 10,
  retireBrowserAfterPageCount: 50,
  navigationTimeoutMs: 25_000,
  dwellMs: 2_000,
  maxRequestRetries: 2,
  proxyUrls: [],
};

// ─── Parser ────────────────────────────────────────────────────────────────

function parseProxyUrls(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse worker browser config from environment variables.
 */
export function loadWorkerBrowserConfig(): WorkerBrowserConfig {
  const backendRaw = envStr('SHOPSITE_CMS_WORKER_BROWSER_BACKEND', DEFAULTS.backend);
  if (backendRaw !== 'camoufox' && backendRaw !== 'playwright') {
    console.warn(
      `[browser/config] Unknown backend "${backendRaw}", falling back to "${DEFAULTS.backend}"`,
    );
  }
  const backend: BrowserBackend =
    backendRaw === 'playwright' ? 'playwright' : 'camoufox';

  return {
    backend,
    headless: envBool('SHOPSITE_CMS_WORKER_HEADLESS', DEFAULTS.headless),
    maxConcurrency: envInt('SHOPSITE_CMS_WORKER_MAX_CONCURRENCY', DEFAULTS.maxConcurrency),
    maxOpenPagesPerBrowser: envInt(
      'SHOPSITE_CMS_WORKER_MAX_OPEN_PAGES',
      DEFAULTS.maxOpenPagesPerBrowser,
    ),
    retireBrowserAfterPageCount: envInt(
      'SHOPSITE_CMS_WORKER_RETIRE_AFTER_PAGES',
      DEFAULTS.retireBrowserAfterPageCount,
    ),
    navigationTimeoutMs: envInt(
      'SHOPSITE_CMS_WORKER_NAVIGATION_TIMEOUT_MS',
      DEFAULTS.navigationTimeoutMs,
    ),
    dwellMs: envInt('SHOPSITE_CMS_WORKER_DWELL_MS', DEFAULTS.dwellMs),
    maxRequestRetries: envInt('SHOPSITE_CMS_WORKER_MAX_RETRIES', DEFAULTS.maxRequestRetries),
    proxyUrls: parseProxyUrls(process.env.SHOPSITE_CMS_WORKER_PROXY_URLS),
  };
}

// ─── Redaction ─────────────────────────────────────────────────────────────

/**
 * Redact credentials from a proxy URL for safe logging.
 * e.g. "http://user:pass@proxy.example.com:8080" → "http://***:***@proxy.example.com:8080"
 */
// fallow-ignore-next-line unused-export — used by tests
export function redactProxyUrl(url: string): string {
  try {
    return url.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@');
  } catch {
    return url;
  }
}

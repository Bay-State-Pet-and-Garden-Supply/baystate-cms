/**
 * Shared Crawlee PlaywrightCrawler runner for single-page and batch
 * rendered extraction tasks.
 *
 * Provides:
 *   - runRenderedPage()    — single URL, returns one result
 *   - runRenderedPages()   — multiple URLs (e.g. validation samples), batch with shared pool
 *
 * Both use Camoufox (or rollback Playwright) via the launch-context factory,
 * optional proxy configuration, session/cookie persistence, and auto-retries.
 */

import { PlaywrightCrawler, Configuration, type PlaywrightCrawlingContext } from 'crawlee';
import { createLaunchContext } from './camoufox-launch';
import { createWorkerProxyConfiguration } from './proxy';
import { loadWorkerBrowserConfig, type WorkerBrowserConfig } from './config';

// ─── Crawlee storage path ─────────────────────────────────────────────────

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Determine the Crawlee storage directory.
 * Uses .shopsite-cms/artifacts/crawlee-storage in the project dir if available,
 * otherwise falls back to a temp directory.
 */
function getCrawleeStorageDir(): string {
  // Try to use the project's artifact area
  const cwd = process.cwd();
  const projectStorage = path.join(cwd, '.shopsite-cms', 'artifacts', 'crawlee-storage');
  return projectStorage;
}

/**
 * Configure Crawlee to use the worker artifact area for storage.
 * Must be called before any Crawlee module is imported, because Crawlee
 * reads CRAWLEE_STORAGE_DIR at module-load time.
 */
// fallow-ignore-next-line unused-export — used by tests
export function configureCrawleeStorage(): void {
  const storageDir = getCrawleeStorageDir();
  process.env.CRAWLEE_STORAGE_DIR = storageDir;
  // Purge stale request queues / datasets from previous runs
  process.env.CRAWLEE_PURGE_ON_START = '1';

  // Ensure the directory exists
  try {
    const fs = require('node:fs');
    fs.mkdirSync(path.join(storageDir, 'request_queues', 'default'), { recursive: true });
  } catch {
    // non-critical — Crawlee will create it if needed
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RenderedPageInput {
  url: string;
  /** Per-URL navigation timeout override (ms). */
  navigationTimeoutMs?: number;
  /** Per-URL dwell time override (ms). */
  dwellMs?: number;
}

export interface RenderedPageSuccess<T> {
  ok: true;
  url: string;
  data: T;
}

export interface RenderedPageFailure {
  ok: false;
  url: string;
  error: string;
}

export type RenderedPageResult<T> = RenderedPageSuccess<T> | RenderedPageFailure;

export interface PageExtractor<T> {
  (ctx: PlaywrightCrawlingContext, dwellMs: number): Promise<T>;
}

// ─── Single page runner ────────────────────────────────────────────────────

/**
 * Open a single rendered page using Crawlee's PlaywrightCrawler and run the
 * provided extractor callback. Returns the extracted data or a failure.
 *
 * This creates a short-lived crawler for one URL. For multiple URLs, use
 * `runRenderedPages()` to reuse the browser pool.
 */
export async function runRenderedPage<T>(
  input: RenderedPageInput,
  extractor: PageExtractor<T>,
  config?: WorkerBrowserConfig,
): Promise<RenderedPageResult<T>> {
  const cfg = config ?? loadWorkerBrowserConfig();
  const launchCtx = await createLaunchContext(cfg);
  const proxyConfig = createWorkerProxyConfiguration(cfg);

  const baseStorageDir = getCrawleeStorageDir();
  const runId = randomUUID();
  const uniqueStorageDir = path.join(baseStorageDir, 'runs', runId);

  // Ensure unique directory exists
  fs.mkdirSync(uniqueStorageDir, { recursive: true });

  const crawleeConfig = new Configuration({
    storageClientOptions: {
      localDataDirectory: uniqueStorageDir,
    },
  });

  let result: T | undefined;
  let failure: string | undefined;

  const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxConcurrency: 1,
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxRequestRetries: cfg.maxRequestRetries,
    requestHandlerTimeoutSecs: Math.ceil((input.navigationTimeoutMs ?? cfg.navigationTimeoutMs) / 1000),
    navigationTimeoutSecs: Math.ceil((input.navigationTimeoutMs ?? cfg.navigationTimeoutMs) / 1000),
    launchContext: {
      launcher: launchCtx.launcher as any,
      launchOptions: launchCtx.launchOptions as any,
    },
    browserPoolOptions: {
      maxOpenPagesPerBrowser: cfg.maxOpenPagesPerBrowser,
      retireBrowserAfterPageCount: cfg.retireBrowserAfterPageCount,
    },
    async requestHandler(ctx) {
      result = await extractor(ctx, input.dwellMs ?? cfg.dwellMs);
    },
    failedRequestHandler({ request }) {
      failure = request.errorMessages?.[0] ?? 'Request failed';
    },
  }, crawleeConfig);

  try {
    await crawler.run([input.url]);
  } finally {
    // Clean up storage directory to avoid disk bloat
    try {
      fs.rmSync(uniqueStorageDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[browser] Failed to clean up Crawlee storage directory ${uniqueStorageDir}:`, e);
    }
  }

  if (failure) {
    return { ok: false, url: input.url, error: failure };
  }

  return { ok: true, url: input.url, data: result! };
}

// ─── Multi-page batch runner ───────────────────────────────────────────────

/**
 * Process multiple rendered pages in a single Crawlee run, reusing the same
 * browser pool across all inputs. This is much more efficient than calling
 * `runRenderedPage()` per URL.
 *
 * Results are returned in input order. Each URL is processed independently;
 * one failure does not cancel the others.
 */
// fallow-ignore-next-line unused-export — used by tests
export async function runRenderedPages<T>(
  inputs: RenderedPageInput[],
  extractor: PageExtractor<T>,
  config?: WorkerBrowserConfig,
): Promise<RenderedPageResult<T>[]> {
  if (inputs.length === 0) return [];

  const cfg = config ?? loadWorkerBrowserConfig();
  const launchCtx = await createLaunchContext(cfg);
  const proxyConfig = createWorkerProxyConfiguration(cfg);

  const baseStorageDir = getCrawleeStorageDir();
  const runId = randomUUID();
  const uniqueStorageDir = path.join(baseStorageDir, 'batches', runId);

  // Ensure unique directory exists
  fs.mkdirSync(uniqueStorageDir, { recursive: true });

  const crawleeConfig = new Configuration({
    storageClientOptions: {
      localDataDirectory: uniqueStorageDir,
    },
  });

  // We need ordered results — use a Map keyed by URL
  // (assumes unique URLs; deduplication is caller's responsibility)
  const resultsMap = new Map<string, RenderedPageResult<T>>();

  const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxyConfig,
    maxConcurrency: Math.min(cfg.maxConcurrency, inputs.length),
    useSessionPool: true,
    persistCookiesPerSession: true,
    maxRequestRetries: cfg.maxRequestRetries,
    requestHandlerTimeoutSecs: Math.ceil(cfg.navigationTimeoutMs / 1000),
    navigationTimeoutSecs: Math.ceil(cfg.navigationTimeoutMs / 1000),
    launchContext: {
      launcher: launchCtx.launcher as any,
      launchOptions: launchCtx.launchOptions as any,
    },
    browserPoolOptions: {
      maxOpenPagesPerBrowser: cfg.maxOpenPagesPerBrowser,
      retireBrowserAfterPageCount: cfg.retireBrowserAfterPageCount,
    },
    async requestHandler(ctx) {
      const data = await extractor(ctx, cfg.dwellMs);
      resultsMap.set(ctx.request.url, { ok: true, url: ctx.request.url, data });
    },
    failedRequestHandler({ request }) {
      const error = request.errorMessages?.[0] ?? 'Request failed';
      resultsMap.set(request.url, { ok: false, url: request.url, error });
    },
  }, crawleeConfig);

  const urls = inputs.map((i) => i.url);
  try {
    await crawler.run(urls);
  } finally {
    // Clean up storage directory to avoid disk bloat
    try {
      fs.rmSync(uniqueStorageDir, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[browser] Failed to clean up Crawlee storage directory ${uniqueStorageDir}:`, e);
    }
  }

  // Return results in input order
  return inputs.map((i) => {
    return resultsMap.get(i.url) ?? { ok: false, url: i.url, error: 'No result produced' };
  });
}

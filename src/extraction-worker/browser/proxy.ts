/**
 * Crawlee ProxyConfiguration factory for the extraction worker.
 *
 * Supports optional residential proxy URLs via comma-separated
 * BAYSTATE_CMS_WORKER_PROXY_URLS env var. Returns undefined when no
 * proxy is configured (direct connection).
 */

import { ProxyConfiguration } from 'crawlee';
import type { WorkerBrowserConfig } from './config';

/**
 * Create a Crawlee ProxyConfiguration from the worker config.
 * Returns undefined when no proxy URLs are configured — Crawlee will
 * use a direct connection.
 */
export function createWorkerProxyConfiguration(
  config: WorkerBrowserConfig,
): ProxyConfiguration | undefined {
  if (!config.proxyUrls || config.proxyUrls.length === 0) {
    return undefined;
  }

  return new ProxyConfiguration({
    proxyUrls: config.proxyUrls,
  });
}

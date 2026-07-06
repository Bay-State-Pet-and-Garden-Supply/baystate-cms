/**
 * Health route for the extraction worker.
 *
 * Returns worker version and available capabilities.
 */

import type { ServerResponse } from 'node:http';
import { loadWorkerBrowserConfig } from '../browser/config';

export interface HealthResponse {
  ok: boolean;
  capabilities: {
    playwright: boolean;
    crawlee: boolean;
    stagehand: boolean;
    camoufox: boolean;
  };
  version: string;
}

export async function handleHealth(res: ServerResponse): Promise<void> {
  let camoufoxAvailable = false;
  try {
    // Attempt to verify Camoufox is installed via dynamic import (ESM-safe).
    const { launchOptions } = await import('camoufox-js');
    camoufoxAvailable = typeof launchOptions === 'function';
  } catch {
    camoufoxAvailable = false;
  }

  const config = loadWorkerBrowserConfig();

  const body: HealthResponse = {
    ok: true,
    capabilities: {
      playwright: true,
      crawlee: true,
      stagehand: false,
      camoufox: camoufoxAvailable,
    },
    version: '0.2.0',
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

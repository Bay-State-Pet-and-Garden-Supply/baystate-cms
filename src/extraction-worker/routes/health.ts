/**
 * Health route for the extraction worker.
 *
 * Returns worker version and available capabilities.
 */

import type { ServerResponse } from 'node:http';

export interface HealthResponse {
  ok: boolean;
  capabilities: {
    playwright: boolean;
    crawlee: boolean;
    stagehand: boolean;
  };
  version: string;
}

export function handleHealth(res: ServerResponse): void {
  const body: HealthResponse = {
    ok: true,
    capabilities: {
      playwright: true,
      crawlee: false,
      stagehand: false,
    },
    version: '0.1.0',
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

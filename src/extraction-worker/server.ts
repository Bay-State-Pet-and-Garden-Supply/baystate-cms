/**
 * Extraction Worker — HTTP Server
 *
 * A zero-dependency Node.js HTTP server for browser-heavy worker tasks.
 * Uses Node's built-in `http` module. Run with tsx in development:
 *
 *   node --import tsx src/extraction-worker/server.ts
 *
 * Environment variables:
 *
 *   SHOPSITE_CMS_WORKER_HOST   — bind address (default: 127.0.0.1)
 *   SHOPSITE_CMS_WORKER_PORT   — bind port    (default: 3032)
 *   SHOPSITE_CMS_WORKER_TOKEN  — bearer token (required; server rejects all requests when unset)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { checkAuth } from './auth';
import { handleHealth } from './routes/health';
import { handleSnapshot } from './routes/snapshot';
import { handleValidate } from './routes/validate';
import { handleExtract } from './routes/extract';
import { handleGenerateSelector } from './routes/generate-selector';


// ─── Config ────────────────────────────────────────────────────────────────────

const HOST = process.env.SHOPSITE_CMS_WORKER_HOST ?? '127.0.0.1';
const PORT = parseInt(process.env.SHOPSITE_CMS_WORKER_PORT ?? '3032', 10);

// ─── Request router ────────────────────────────────────────────────────────────

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { method, url } = req;

  // ── Auth middleware (applies to all routes) ─────────────────────────
  const auth = checkAuth(req);
  if (!auth.authorized) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: auth.message }));
    return;
  }

  // ── Health ───────────────────────────────────────────────────────────
  if (method === 'GET' && url === '/health') {
    await handleHealth(res);
    return;
  }

  // ── Snapshot (Profile Tooling) ────────────────────────────────────────
  if (method === 'POST' && url === '/profile-tooling/snapshot') {
    handleSnapshot(req, res);
    return;
  }

  // ── Validate (Profile Tooling) ───────────────────────────────────────
  if (method === 'POST' && url === '/profile-tooling/validate') {
    handleValidate(req, res);
    return;
  }

  // ── Generate Selector (Paste-Element) ───────────────────────────────────
  if (method === 'POST' && url === '/profile-tooling/generate-selector') {
    handleGenerateSelector(req, res);
    return;
  }


  // ── Trusted Extraction ──────────────────────────────────────────────────
  if (method === 'POST' && url === '/profile-runner/extract') {
    handleExtract(req, res);
    return;
  }

  // ── 404 ────────────────────────────────────────────────────────────────
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: `Not found: ${method} ${url}` }));
}

// ─── Server ────────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error('[server] Unhandled route error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
  });
});

server.listen(PORT, HOST, () => {
  const tokenConfigured =
    process.env.SHOPSITE_CMS_WORKER_TOKEN &&
    process.env.SHOPSITE_CMS_WORKER_TOKEN.length > 0;

  console.log(
    `[extraction-worker] listening on http://${HOST}:${PORT}` +
      (tokenConfigured ? ' (auth enabled)' : ' (auth not configured — set SHOPSITE_CMS_WORKER_TOKEN)'),
  );
});

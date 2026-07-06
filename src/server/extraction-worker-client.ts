/**
 * Extraction Worker Client
 *
 * Typed HTTP client for the separate Node.js extraction worker process.
 * The worker owns Playwright, Crawlee, optional Stagehand/LLM proposal
 * tooling, screenshots, network capture, and browser pooling.
 *
 * This client lives in the Bun API server. It never reads/writes SQLite
 * directly — the worker returns structured results and artifact refs,
 * and the Bun server decides what to persist.
 *
 * # Fail-closed
 *
 * When the worker is unreachable, every call returns a null/error
 * result rather than throwing. The caller is responsible for treating
 * worker unavailability as a reason to fail closed in trusted
 * Extraction.
 *
 * # Security
 *
 * - Uses `127.0.0.1` and bearer-token auth by default.
 * - Never forwards ShopSite credentials or API keys to the worker.
 * - Treats all worker responses as potentially incomplete; the
 *   caller validates and decides what to trust.
 */

import type {
  WorkerHealthResponse,
  SnapshotRequest,
  SnapshotResponse,
  ProfileProposalRequest,
  ProfileProposalResponse,
  ValidateRequest,
  ValidateResponse,
  ExtractRequest,
  ExtractResponse,
  WorkerJobPayload,
  WorkerJobResult,
  GenerateSelectorRequest,
  GenerateSelectorResponse,
  PickElementRequest,
  PickElementResponse,
} from '../shared/schemas/extraction-worker';
import {
  WorkerHealthResponseSchema,
  SnapshotResponseSchema,
  ProfileProposalResponseSchema,
  ValidateResponseSchema,
  ExtractResponseSchema,
  WorkerJobResultSchema,
  GenerateSelectorResponseSchema,
  PickElementResponseSchema,
} from '../shared/schemas/extraction-worker';

// ─── Config ───────────────────────────────────────────────────────────────────

function getWorkerBaseUrl(): string {
  const host = process.env.SHOPSITE_CMS_WORKER_HOST ?? '127.0.0.1';
  const port = process.env.SHOPSITE_CMS_WORKER_PORT ?? '3032';
  return `http://${host}:${port}`;
}

function getWorkerToken(): string | null {
  return process.env.SHOPSITE_CMS_WORKER_TOKEN ?? null;
}

/** Request timeout in ms. Keep it tight so a hung worker doesn't stall the pipeline. */
const WORKER_TIMEOUT_MS = 30_000;

// ─── Internal fetch helper ─────────────────────────────────────────────────────

interface WorkerFetchOptions {
  method?: 'GET' | 'POST';
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

async function workerFetch<T>(
  schema: { parse: (value: unknown) => T },
  options: WorkerFetchOptions,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const { method = 'GET', path, body, timeoutMs = WORKER_TIMEOUT_MS } = options;
  const baseUrl = getWorkerBaseUrl();
  const token = getWorkerToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        error: `Worker responded ${response.status}: ${text.slice(0, 500)}`,
      };
    }

    const raw = await response.json();
    const parsed = schema.parse(raw);
    return { ok: true, data: parsed };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, error: `Worker request timed out after ${timeoutMs}ms` };
    }
    // ZodError or network error — surface the message.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Worker unreachable or response invalid: ${message}`,
    };
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether the extraction worker is alive and report its
 * capabilities. Callers should gate worker-dependent features on the
 * result, and routes can surface worker health in the UI.
 */
export async function getWorkerHealth(): Promise<WorkerHealthResponse | null> {
  const result = await workerFetch(WorkerHealthResponseSchema, {
    path: '/health',
    timeoutMs: 10_000,
  });
  if (!result.ok) {
    console.warn('[ExtractionWorkerClient] Health check failed:', result.error);
    return null;
  }
  return result.data;
}

/**
 * Fetch a single page snapshot for Profile Builder diagnostics.
 *
 * Returns structured page artifacts (HTML ref, screenshot ref,
 * network ref, JSON-LD, embedded data, image candidates, and
 * page-structure signals). This is profile tooling only — the output
 * is never trusted product evidence.
 */
export async function snapshotPage(
  request: SnapshotRequest,
): Promise<{ ok: true; data: SnapshotResponse } | { ok: false; error: string }> {
  return workerFetch(SnapshotResponseSchema, {
    method: 'POST',
    path: '/profile-tooling/snapshot',
    body: request,
  });
}

/**
 * Use deterministic artifacts (plus optional LLM/Stagehand assistance
 * in the worker) to propose a Domain Extractor Profile draft. The
 * proposal is never healthy by itself; the caller must persist it as
 * a proposal and require validation + human approval.
 *
 * For multi-sample or LLM-enabled runs, prefer the queued job path
 * rather than this synchronous call.
 */
async function proposeProfile(
  request: ProfileProposalRequest,
): Promise<{ ok: true; data: ProfileProposalResponse } | { ok: false; error: string }> {
  return workerFetch(ProfileProposalResponseSchema, {
    method: 'POST',
    path: '/profile-tooling/propose',
    body: request,
    timeoutMs: 60_000,
  });
}

/**
 * Run a proposed or approved profile across samples for validation
 * evidence. This is not a health decision — the caller persists
 * validation results and decides Profile Health.
 *
 * Multi-sample sweeps should use the queued job path.
 */
export async function validateProfile(
  request: ValidateRequest,
): Promise<{ ok: true; data: ValidateResponse } | { ok: false; error: string }> {
  return workerFetch(ValidateResponseSchema, {
    method: 'POST',
    path: '/profile-tooling/validate',
    body: request,
    timeoutMs: 120_000,
  });
}

/**
 * Execute a trusted, deterministic extraction after the Bun server
 * has confirmed a healthy Profile Match. The worker runs static or
 * rendered extraction strictly according to approved profile rules.
 *
 * No LLM calls are allowed in this path. No generic fallback is
 * allowed. If the worker cannot produce trusted product evidence,
 * the caller must fail the item or keep it blocked in Extraction.
 */
export async function trustedExtract(
  request: ExtractRequest,
): Promise<{ ok: true; data: ExtractResponse } | { ok: false; error: string }> {
  return workerFetch(ExtractResponseSchema, {
    method: 'POST',
    path: '/profile-runner/extract',
    body: request,
    timeoutMs: 60_000,
  });
}

/**
 * Generate a stable CSS selector from a pasted element's outerHTML.
 * Proxies to the extraction worker's generate-selector endpoint.
 */
export async function generateSelectorFromElement(
  request: GenerateSelectorRequest,
): Promise<{ ok: true; data: GenerateSelectorResponse } | { ok: false; error: string }> {
  return workerFetch(GenerateSelectorResponseSchema, {
    method: 'POST',
    path: '/profile-tooling/generate-selector',
    body: request,
    timeoutMs: 15_000,
  });
}

/**
 * Launch a headful browser for the user to click on an element and
 * generate a stable CSS selector. Proxies to the extraction worker's
 * pick-element endpoint. Has a long timeout (120s) because the user
 * is interacting with the browser.
 */
export async function pickElement(
  request: PickElementRequest,
): Promise<{ ok: true; data: PickElementResponse } | { ok: false; error: string }> {
  return workerFetch(PickElementResponseSchema, {
    method: 'POST',
    path: '/profile-tooling/pick-element',
    body: request,
    timeoutMs: 120_000,
  });
}

/**
 * Submit a queued job to the worker (profile proposal run or
 * validation sweep). The Bun server owns queue state, progress
 * tracking, retries, and persistence; the worker receives the
 * payload and executes.
 */
async function submitWorkerJob(
  jobId: string,
  payload: WorkerJobPayload,
): Promise<{ ok: true; data: WorkerJobResult } | { ok: false; error: string }> {
  return workerFetch(WorkerJobResultSchema, {
    method: 'POST',
    path: '/jobs',
    body: { jobId, ...payload },
    timeoutMs: 10_000,
  });
}

/**
 * Poll a previously submitted queued job for its current status
 * and progress. The Bun server may call this on an interval or in
 * response to an SSE request from the frontend.
 */
async function getWorkerJobStatus(
  jobId: string,
): Promise<{ ok: true; data: WorkerJobResult } | { ok: false; error: string }> {
  return workerFetch(WorkerJobResultSchema, {
    path: `/jobs/${jobId}`,
    timeoutMs: 10_000,
  });
}

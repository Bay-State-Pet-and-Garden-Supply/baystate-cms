/**
 * Epic #46 — shared frontend client for the operator work-state API.
 *
 * The Batch Workspace (and its feature views: Needs Attention, Waiting on
 * Family, Review, Approved / Ready to Export) consume ONLY this module for
 * server-derived work-state data. The server owns all projection logic —
 * this module is a thin typed fetch layer over:
 *
 *   GET  /api/onboarding/batches/:id/work-state
 *   GET  /api/onboarding/items/:id/work-state
 *   POST /api/onboarding/batches/:id/approve
 *   POST /api/onboarding/domains/:domain/release
 *
 * plus an SSE subscription helper reusing the existing batch events stream.
 */
import type {
  BatchWorkState,
  OnboardingWorkState,
  WorkStateCategory,
  WorkStateFilters,
  ApproveItemsResponse,
  DomainReleaseResponse,
  ExtractorProfileBlockersResponse,
} from '../shared/schemas/onboarding-work-state';

const API_BASE = '/api/onboarding';

export { OnboardingApiError } from './onboarding-api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const errorObj = (data as { error?: unknown }).error;
    const errMsg =
      typeof errorObj === 'object' && errorObj !== null && 'message' in errorObj
        ? String((errorObj as { message: unknown }).message)
        : typeof errorObj === 'string'
          ? errorObj
          : `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data as T;
}

// ─── Work-state projection ─────────────────────────────────────────────────────

/**
 * Batch-level operator projection: counts + paginated items.
 * Filters: category, q (upc/name/brand), domain, sourceType, cohortId,
 * reviewState, limit, offset. Invalid filter values fail closed server-side.
 */
export async function getBatchWorkState(
  batchId: string,
  filters?: WorkStateFilters,
): Promise<BatchWorkState> {
  const params = new URLSearchParams();
  if (filters) {
    if (filters.category) params.set('category', filters.category);
    if (filters.q) params.set('q', filters.q);
    if (filters.domain) params.set('domain', filters.domain);
    if (filters.sourceType) params.set('sourceType', filters.sourceType);
    if (filters.cohortId) params.set('cohortId', filters.cohortId);
    if (filters.reviewState) params.set('reviewState', filters.reviewState);
    if (typeof filters.limit === 'number') params.set('limit', String(filters.limit));
    if (typeof filters.offset === 'number') params.set('offset', String(filters.offset));
  }
  const qs = params.toString();
  return request<BatchWorkState>(`/batches/${batchId}/work-state${qs ? `?${qs}` : ''}`);
}

/** Single-item operator projection. */
export async function getItemWorkState(itemId: string): Promise<{ workState: OnboardingWorkState }> {
  return request<{ workState: OnboardingWorkState }>(`/items/${itemId}/work-state`);
}

// ─── Bulk approval ─────────────────────────────────────────────────────────────

/**
 * Bulk approval of reviewed items. Per-item structured outcomes; approval
 * NEVER exports anything. Unreviewed items are rejected by the server.
 */
export async function approveItems(
  batchId: string,
  itemIds: string[],
): Promise<ApproveItemsResponse> {
  return request<ApproveItemsResponse>(`/batches/${batchId}/approve`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

// ─── Domain-level release ──────────────────────────────────────────────────────

/**
 * Deterministic domain-level release: after an extractor profile becomes
 * usable, re-queue blocked extraction items on that domain.
 */
export async function releaseDomainItems(domain: string): Promise<DomainReleaseResponse> {
  return request<DomainReleaseResponse>(`/domains/${encodeURIComponent(domain)}/release`, {
    method: 'POST',
  });
}

/**
 * Domain-level extractor setup queue (epic #46 follow-up, phase 5):
 * missing-profile extraction failures grouped by domain, sorted by
 * blocked-product count.
 */
export async function getExtractorProfileBlockers(batchId: string): Promise<ExtractorProfileBlockersResponse> {
  return request<ExtractorProfileBlockersResponse>(`/batches/${batchId}/extractor-profile-blockers`);
}

// ─── Live events ───────────────────────────────────────────────────────────────

/**
 * Subscribe to batch SSE events (reuses the existing
 * `GET /api/onboarding/batches/:id/events` stream). Returns an unsubscribe
 * function. The stream is a firehose — consumers filter by event type.
 *
 * The server writes NAMED events (`event: item:status` etc.), so listeners
 * are attached per event name plus a fallback `message` handler for any
 * unnamed frames. Data payloads carry the full event object
 * `{ type, batchId, itemId?, data }`.
 */
export function subscribeBatchEvents(
  batchId: string,
  onEvent: (event: { type: string; data: unknown }) => void,
): () => void {
  const sse = new EventSource(`${API_BASE}/batches/${batchId}/events`);
  const handler = (ev: MessageEvent) => {
    try {
      const payload = JSON.parse(ev.data) as { type?: string; [k: string]: unknown };
      onEvent({ type: payload.type ?? ev.type ?? 'message', data: payload });
    } catch {
      onEvent({ type: ev.type ?? 'message', data: ev.data });
    }
  };
  sse.onmessage = handler;
  for (const eventName of ['item:status', 'batch:progress', 'batch:complete', 'batch:error']) {
    sse.addEventListener(eventName, handler);
  }
  sse.onerror = () => {
    // SSE reconnect is automatic; consumers refresh on demand.
  };
  return () => sse.close();
}

export type { WorkStateCategory, WorkStateFilters };

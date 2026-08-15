/**
 * Epic #46 — operator work-state routes (Phases 1/7/8).
 *
 * - `GET  /api/onboarding/batches/:id/work-state` — Batch Workspace
 *   projection (counts + paginated items, server-owned derivation).
 * - `GET  /api/onboarding/items/:id/work-state` — single-item projection.
 * - `POST /api/onboarding/batches/:id/approve` — bulk approval of reviewed
 *   items (per-item structured outcomes; approval NEVER exports).
 * - `POST /api/onboarding/domains/:domain/release` — deterministic
 *   domain-level release: after an extractor profile becomes usable, blocked
 *   extraction items on that domain are re-queued automatically.
 */
import { Hono } from 'hono';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { findBatchById } from '../../db/repositories/onboarding-batch-repo';
import {
  findItemById,
  advanceReviewedItemsToPromotion,
} from '../../db/repositories/onboarding-item-repo';
import {
  getBatchWorkState,
  getItemWorkState,
  type WorkStateFilters,
} from '../../onboarding/onboarding-work-state';
import { getReviewState, markApproved } from '../../db/repositories/onboarding-review-repo';
import { validateReviewCompletionGate } from '../../classification/review-completion-gate';
import { addAuditLog } from '../../db/repositories/audit-log-repo';
import { releaseDomainExtractionItems } from '../../onboarding/domain-release';
import { getOnboardingMetrics } from '../../onboarding/onboarding-telemetry';
import { getWorker } from './onboarding-routes';import {
  ApproveItemsRequestSchema,
  WorkStateCategoryEnum,
  ReviewStateEnum,
} from '../../shared/schemas/onboarding-work-state';
import { SourceTypeEnum } from '../../shared/schemas/onboarding';

const route = new Hono();

// ── Worker poll trigger (test seam) ────────────────────────────────────────────
// The domain-release route kicks the background worker after re-queueing so
// released items are picked up immediately. Unit tests replace the trigger
// with a no-op (a real poll would claim released extraction items and hit the
// extraction worker). Mirrors the codebase's existing test seams (e.g.
// `hooks.afterMemberPipeline` in cohort-curator).
type WorkerPollTrigger = (workspaceId: string, workspacePath: string) => void;
let triggerWorkerPoll: WorkerPollTrigger = (workspaceId, workspacePath) => {
  try {
    getWorker(workspaceId, workspacePath).poll();
  } catch (pollErr) {
    // Background poll failure must never fail the endpoint that triggered it.
    console.error('[OnboardingWorkRoutes] Background worker poll failed (non-blocking):', pollErr);
  }
};

/** Replace the background worker-poll trigger (null restores the no-op). */
export function setWorkerPollTriggerForTest(trigger: WorkerPollTrigger | null): void {
  triggerWorkerPoll = trigger ?? (() => {});
}

/**
 * Parse optional work-state query filters from a Hono request. Invalid enum
 * values fail closed (treated as absent) — never a 500.
 */
function parseWorkStateFilters(c: { req: { query: (key: string) => string | undefined } }): WorkStateFilters {
  const categoryRaw = c.req.query('category');
  const reviewStateRaw = c.req.query('reviewState');
  const sourceTypeRaw = c.req.query('sourceType');
  const limitRaw = c.req.query('limit');
  const offsetRaw = c.req.query('offset');

  const filters: WorkStateFilters = {};
  if (categoryRaw) {
    const parsed = WorkStateCategoryEnum.safeParse(categoryRaw);
    if (parsed.success) filters.category = parsed.data;
  }
  if (reviewStateRaw) {
    const parsed = ReviewStateEnum.safeParse(reviewStateRaw);
    if (parsed.success) filters.reviewState = parsed.data;
  }
  if (sourceTypeRaw) {
    const parsed = SourceTypeEnum.safeParse(sourceTypeRaw);
    if (parsed.success) filters.sourceType = parsed.data;
  }
  const q = c.req.query('q');
  if (q && q.trim()) filters.q = q.trim();
  const domain = c.req.query('domain');
  if (domain && domain.trim()) filters.domain = domain.trim();
  const cohortId = c.req.query('cohortId');
  if (cohortId && cohortId.trim()) filters.cohortId = cohortId.trim();
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
  const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : NaN;
  if (Number.isFinite(limit)) filters.limit = limit;
  if (Number.isFinite(offset)) filters.offset = offset;
  return filters;
}

/**
 * GET /api/onboarding/batches/:id/work-state
 * Server-derived operator work-state projection for the Batch Workspace.
 */
route.get('/onboarding/batches/:id/work-state', async (c) => {
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  const filters = parseWorkStateFilters(c);
  const payload = getBatchWorkState(batchId, filters);
  return c.json(payload);
});

/**
 * GET /api/onboarding/items/:id/work-state
 * Single-item operator work-state projection.
 */
route.get('/onboarding/items/:id/work-state', async (c) => {
  const itemId = c.req.param('id');
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }
  const workspace = findWorkspace();
  const batch = findBatchById(item.batchId);
  if (!workspace || !batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Onboarding item not found' }, 404);
  }
  const workState = getItemWorkState(itemId);
  return c.json({ workState });
});

/**
 * POST /api/onboarding/batches/:id/approve
 * Bulk approval of reviewed items. Per-item structured outcomes — partial
 * failures are visible and retryable. Guardrails (epic #46 Phase 7):
 * - only items with a durable, non-invalidated review can be approved;
 * - the item must be `review / completed` and pass the existing semantic/
 *   review-completion gate (run-linked items);
 * - approval writes durable state + advances the item review → promotion
 *   automatically; it NEVER exports/publishes anything.
 */
route.post('/onboarding/batches/:id/approve', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  if (batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }
  const parsed = ApproveItemsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid approval payload.', issues: parsed.error.issues }, 400);
  }

  const approvedBy = parsed.data.reviewerId && parsed.data.reviewerId.trim()
    ? parsed.data.reviewerId.trim()
    : 'operator';

  // ── Phase 1: validate every item (per-item, fail-closed reasons) ───────
  const validIds: string[] = [];
  const rejected: Array<{ itemId: string; reason: string }> = [];
  for (const id of parsed.data.itemIds) {
    const item = findItemById(id);
    if (!item) {
      rejected.push({ itemId: id, reason: 'item_not_found' });
      continue;
    }
    if (item.batchId !== batchId) {
      rejected.push({ itemId: id, reason: 'item_not_in_batch' });
      continue;
    }
    if (item.stage !== 'review' || item.stageStatus !== 'completed') {
      rejected.push({ itemId: id, reason: `not_eligible:${item.stage}/${item.stageStatus}` });
      continue;
    }
    const reviewState = getReviewState(id);
    if (!reviewState?.reviewedAt) {
      rejected.push({ itemId: id, reason: 'not_reviewed' });
      continue;
    }
    if (reviewState.reviewInvalidatedAt) {
      rejected.push({ itemId: id, reason: 'review_invalidated' });
      continue;
    }
    if (reviewState.approvedAt) {
      rejected.push({ itemId: id, reason: 'already_approved' });
      continue;
    }
    // Run-linked items pass the SAME review-completion gate the review flow
    // enforces (semantic validation + type gates). Legacy items (no run)
    // have no gate.
    const runId = item.curationData?.classificationRunId;
    if (runId) {
      const gate = validateReviewCompletionGate({
        workspaceId: workspace.id,
        onboardingItemId: id,
        productSku: item.upc,
        activeRunId: runId,
      });
      if (!gate.ok) {
        rejected.push({ itemId: id, reason: gate.reason });
        continue;
      }
    }
    validIds.push(id);
  }

  // ── Phase 2: advance review → promotion (guarded; per-item results) ────
  const { advanced, refused } = advanceReviewedItemsToPromotion(validIds);
  const advancedIds: string[] = [];
  for (const id of advanced) {
    // Durable approval write (guarded: reviewed, not invalidated, not
    // already approved). Approval NEVER exports.
    const ok = markApproved({ itemId: id, batchId, approvedBy, origin: 'bulk' });
    if (ok) {
      advancedIds.push(id);
      addAuditLog({
        workspaceId: workspace.id,
        entityType: 'onboarding_item',
        entityId: id,
        action: 'bulk_approve',
        message: `Item approved for export (bulk approval by ${approvedBy})`,
        detailsJson: JSON.stringify({ batchId, origin: 'bulk' }),
      });
    } else {
      rejected.push({ itemId: id, reason: 'approval_write_conflict' });
    }
  }
  for (const refusal of refused) {
    rejected.push({ itemId: refusal.itemId, reason: refusal.reason });
  }

  // ── Phase 3: structured outcome ─────────────────────────────────────────
  const results = [
    ...advancedIds.map(itemId => ({ itemId, status: 'approved' as const, reason: null })),
    ...rejected.map(r => ({ itemId: r.itemId, status: 'rejected' as const, reason: r.reason })),
  ];
  const approvedCount = advancedIds.length;
  const rejectedCount = rejected.length;

  addAuditLog({
    workspaceId: workspace.id,
    entityType: 'onboarding_batch',
    entityId: batchId,
    action: 'bulk_approve',
    message: `Bulk approval completed: ${approvedCount} approved, ${rejectedCount} rejected`,
    detailsJson: JSON.stringify({ approvedCount, rejectedCount, approvedBy: approvedBy }),
  });

  return c.json({ results, approvedCount, rejectedCount, rejected, audited: true });
});

/**
 * POST /api/onboarding/domains/:domain/release
 * Deterministic domain-level release (epic #46 UX workstream 4 / Phase 8):
 * after an extractor profile becomes usable for a domain, every blocked
 * extraction item on that domain is re-queued automatically. Delegates to
 * the canonical `releaseDomainExtractionItems` primitive (Phase 2) with
 * `releaseAllBlocked` — this is the explicit operator-triggered release (the
 * profile was just set up), so every blocked item on the domain releases.
 * A missing profile fails closed (400).
 */
route.post('/onboarding/domains/:domain/release', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const domain = c.req.param('domain').trim().toLowerCase().replace(/^www\./, '');
  if (!domain) {
    return c.json({ error: 'domain is required' }, 400);
  }

  const result = releaseDomainExtractionItems(workspace.id, domain, { releaseAllBlocked: true });
  if (!result.profileAvailable) {
    return c.json({ error: `No usable extractor profile for "${domain}"` }, 400);
  }

  const releasedIds = result.releasedIds;
  const skippedCount = result.skipped.filter(entry => entry.itemId).length;

  // Trigger the worker so re-queued items are picked up immediately.
  if (releasedIds.length > 0) {
    triggerWorkerPoll(workspace.id, workspace.workspacePath);
  }

  addAuditLog({
    workspaceId: workspace.id,
    entityType: 'extractor_profile_domain',
    entityId: domain,
    action: 'domain_release',
    message: `Released ${releasedIds.length} blocked extraction item(s) on ${domain} after profile became usable`,
    detailsJson: JSON.stringify({ released: releasedIds, skippedCount }),
  });

  return c.json({ domain, releasedItemIds: releasedIds, count: releasedIds.length, skippedCount });
});

/**
 * GET /api/onboarding/metrics?batchId=<id>
 * Epic #46 observability — batch-scoped (when batchId is given) or global
 * onboarding success metrics, all derived from durable state at query time.
 * Every metric carries a derivation honesty marker (exact | approximation |
 * not_available).
 */
route.get('/onboarding/metrics', (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const batchIdRaw = c.req.query('batchId');
  if (batchIdRaw) {
    const batch = findBatchById(batchIdRaw);
    if (!batch || batch.workspaceId !== workspace.id) {
      return c.json({ error: 'Batch not found' }, 404);
    }
  }

  const telemetry = getOnboardingMetrics({
    workspaceId: workspace.id,
    batchId: batchIdRaw ?? undefined,
  });
  return c.json(telemetry);
});

export default route;

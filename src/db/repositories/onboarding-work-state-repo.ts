/**
 * Milestone 3 (P1-E) — Bounded work-state bulk repository.
 *
 * All work-state derivation queries are batched per batch (O(1) statements)
 * regardless of item count. No per-item N+1 fan-out. Each method is
 * workspace-agnostic and fail-closed (returns empty map on DB error or corrupt
 * rows, never throws into the projection).
 *
 * This module is the ONLY place work-state code may issue direct SQL for the
 * tables it owns; `src/onboarding/onboarding-work-state.ts` must not call
 * `getDb()` at all.
 */
import { getDb } from '../connection';

// ─── Bulk variant resolutions ───────────────────────────────────────────────

export interface BulkVariantResolution {
  id: string;
  status: string;
  candidates: unknown[];
  identityMatrixHash: string;
  platform: string;
}

/**
 * Bulk load current (non-superseded) variant resolutions for a set of itemIds.
 * Single SELECT ... WHERE onboarding_item_id IN (...) AND superseded_at IS NULL.
 */
export function bulkLoadVariantResolutions(
  itemIds: string[],
): Map<string, BulkVariantResolution> {
  if (itemIds.length === 0) return new Map();
  _incrementQueryCount();
  try {
    const db = getDb();
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = db
      .query(
        `SELECT id, onboarding_item_id, status, candidates_json, identity_matrix_hash, platform
         FROM onboarding_variant_resolutions
         WHERE onboarding_item_id IN (${placeholders}) AND superseded_at IS NULL`,
      )
      .all(...itemIds) as Array<{
      id: string;
      onboarding_item_id: string;
      status: string;
      candidates_json: string;
      identity_matrix_hash: string;
      platform: string;
    }>;
    const map = new Map<string, BulkVariantResolution>();
    for (const r of rows) {
      let candidates: unknown[] = [];
      try {
        candidates = JSON.parse(r.candidates_json);
      } catch {
        candidates = [];
      }
      map.set(r.onboarding_item_id, {
        id: r.id,
        status: r.status,
        candidates,
        identityMatrixHash: r.identity_matrix_hash,
        platform: r.platform,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

// ─── Bulk discovery candidate counts ─────────────────────────────────────────

export function bulkCountDiscoveryCandidates(
  itemIds: string[],
): Map<string, number> {
  if (itemIds.length === 0) return new Map();
  _incrementQueryCount();
  try {
    const db = getDb();
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = db
      .query(
        `SELECT item_id, COUNT(*) as cnt FROM onboarding_sources WHERE item_id IN (${placeholders}) GROUP BY item_id`,
      )
      .all(...itemIds) as Array<{ item_id: string; cnt: number }>;
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.item_id, Number(r.cnt));
    }
    // Ensure zero for items with no sources (fail-closed: absent means 0)
    for (const id of itemIds) {
      if (!map.has(id)) map.set(id, 0);
    }
    return map;
  } catch {
    const map = new Map<string, number>();
    for (const id of itemIds) map.set(id, 0);
    return map;
  }
}

// ─── Bulk cohort run statuses (freezing / running) ──────────────────────────

export function bulkGetCohortRunStatusByItem(
  itemIds: string[],
): Map<string, string> {
  if (itemIds.length === 0) return new Map();
  _incrementQueryCount();
  try {
    const db = getDb();
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = db
      .query(
        `SELECT ccm.onboarding_item_id as item_id, ccr.status as status
         FROM classification_cohort_runs ccr
         JOIN curation_cohort_members ccm ON ccm.cohort_id = ccr.cohort_id
         WHERE ccm.onboarding_item_id IN (${placeholders}) AND ccr.status IN ('freezing','running')`,
      )
      .all(...itemIds) as Array<{ item_id: string; status: string }>;
    const map = new Map<string, string>();
    for (const r of rows) {
      // Prefer freezing over running if multiple (freezing is earlier)
      if (!map.has(r.item_id) || r.status === 'freezing') {
        map.set(r.item_id, r.status);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

// ─── Bulk latest classification run ids ─────────────────────────────────────

/**
 * Bulk fetch latest classification run id per item (by started_at DESC).
 * Single query fetches all runs for itemIds ordered desc, then dedupes to first per item.
 */
export function bulkGetLatestClassificationRunIdByItem(
  itemIds: string[],
): Map<string, string> {
  if (itemIds.length === 0) return new Map();
  _incrementQueryCount();
  try {
    const db = getDb();
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = db
      .query(
        `SELECT id, onboarding_item_id, started_at FROM classification_runs WHERE onboarding_item_id IN (${placeholders}) ORDER BY onboarding_item_id, started_at DESC`,
      )
      .all(...itemIds) as Array<{ id: string; onboarding_item_id: string; started_at: string }>;
    const map = new Map<string, string>();
    for (const r of rows) {
      if (!map.has(r.onboarding_item_id)) {
        map.set(r.onboarding_item_id, r.id);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

// ─── Bulk classification stage results ───────────────────────────────────────

export interface BulkStageRow {
  stage_name: string;
  status: string;
}

export function bulkGetClassificationStageResults(
  runIds: string[],
): Map<string, BulkStageRow[]> {
  if (runIds.length === 0) return new Map();
  _incrementQueryCount();
  try {
    const db = getDb();
    // SQLite has 999 variable limit; chunk if needed
    const CHUNK = 900;
    const map = new Map<string, BulkStageRow[]>();
    for (let i = 0; i < runIds.length; i += CHUNK) {
      const chunk = runIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db
        .query(
          `SELECT run_id, stage_name, status FROM classification_stage_results WHERE run_id IN (${placeholders}) ORDER BY run_id, started_at ASC`,
        )
        .all(...chunk) as Array<{ run_id: string; stage_name: string; status: string }>;
      for (const r of rows) {
        const list = map.get(r.run_id) ?? [];
        list.push({ stage_name: r.stage_name, status: r.status });
        map.set(r.run_id, list);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

// ─── Combined bulk context loader (query budget) ─────────────────────────────

/**
 * Instrumentation counter for query-plan assertions.
 * Each bulk method increments this; tests reset and assert bound.
 */
let _queryCount = 0;
export function _incrementQueryCount(): void {
  _queryCount += 1;
}
export function resetWorkStateQueryCount(): void {
  _queryCount = 0;
}
export function getWorkStateQueryCount(): number {
  return _queryCount;
}



// fallow-ignore-file unused-export

/**
 * Verified Page catalog snapshot (issue #17 work item D1).
 *
 * Classification runs must execute against ONE frozen view of the verified
 * Page catalog. This module performs a single read of the ACTIVE page import
 * plus its matching verified `page_index` rows, validates that every import
 * record has a matching verified row, and returns an immutable snapshot the
 * run creators pass into `buildRuntimeSnapshot()` before a run row exists.
 *
 * Fail-closed contract:
 * - No active import or no usable verified records ⇒ an empty unavailable
 *   snapshot (the run creator records `no_verified_page_catalog`; an enabled
 *   Page target fails readiness/abstains — name-only rows are never options).
 * - Malformed import records, a record without a matching verified row, or an
 *   import/row mismatch during capture ⇒ throw BEFORE run creation so a run
 *   can never start against an inconsistent Page catalog.
 * - Mutating or superseding `page_index`/`page_imports` after capture cannot
 *   change the frozen records a run sees.
 */
import { getActivePageImport, getActiveImportRecords } from '../db/repositories/page-import-repo';
import { listVerifiedPageOptions } from '../db/repositories/page-repo';
import type { PageSnapshotRecord, PageSnapshotState } from './runtime-snapshot';

export interface VerifiedPageSnapshot {
  /**
   * Present only when an active verified import with usable matching rows
   * exists. Null means the catalog is unavailable (no import or no verified
   * rows) and the run must record `no_verified_page_catalog`.
   */
  pageImportId: string | null;
  pageImportHash: string | null;
  /** Verified + available records only, with parent metadata, in stable order. */
  records: PageSnapshotRecord[];
  /** Local page_index row IDs of the verified records. */
  verifiedPageIds: string[];
}

/** Empty unavailable snapshot (no active verified import / no usable rows). */
export const UNAVAILABLE_PAGE_SNAPSHOT: VerifiedPageSnapshot = {
  pageImportId: null,
  pageImportHash: null,
  records: [],
  verifiedPageIds: [],
};

/**
 * One read of the ACTIVE verified Page import for a workspace.
 *
 * @throws when the active import's records do not match the verified
 *   `page_index` rows (import/row drift during capture) — callers must fail
 *   before run creation rather than proceeding with a partial catalog.
 */
export function captureVerifiedPageSnapshot(workspaceId: string): VerifiedPageSnapshot {
  const active = getActivePageImport(workspaceId);
  if (!active) return UNAVAILABLE_PAGE_SNAPSHOT;

  const records = getActiveImportRecords(workspaceId);
  if (records.length === 0) {
    // Active import exists but holds no usable records: unavailable, not a
    // hard failure (an enabled Page target will abstain/fail readiness).
    return UNAVAILABLE_PAGE_SNAPSHOT;
  }

  const rows = listVerifiedPageOptions(workspaceId);
  const rowByIdentity = new Map(rows.map(row => [`${row.identityKind}:${row.identityKey}`, row]));
  const rowById = new Map(rows.map(row => [row.id, row]));

  const out: PageSnapshotRecord[] = [];
  for (const record of records) {
    if (record.identity.status !== 'verified' || record.availability !== 'available') continue;
    const key = `${record.identity.kind}:${record.identity.key}`;
    const row = rowByIdentity.get(key);
    if (!row) {
      throw new Error(
        `Verified Page import changed during capture: no page_index row for identity "${key}" in the active import.`,
      );
    }
    const parent = row.parentId ? (rowById.get(row.parentId) ?? null) : null;
    out.push({
      pageId: row.id,
      pageName: record.name,
      verified: true,
      parentPageId: parent?.id ?? null,
      parentPageName: parent?.name ?? null,
      identityKind: record.identity.kind,
      identityKey: record.identity.key,
      sourceHash: row.sourceHash ?? active.sourceHash,
    });
  }

  if (out.length === 0) return UNAVAILABLE_PAGE_SNAPSHOT;

  return {
    pageImportId: active.id,
    pageImportHash: active.sourceHash,
    records: out,
    verifiedPageIds: out.map(page => page.pageId),
  };
}

/**
 * Convert a captured snapshot into the runtime-snapshot Page state. Name-only
 * observations are preserved as review context only when the catalog is
 * unavailable; they never become assignment identities.
 */
export function toPageSnapshotState(
  snapshot: VerifiedPageSnapshot,
  nameOnlyRecords: PageSnapshotRecord[] = [],
): PageSnapshotState {
  if (snapshot.pageImportId && snapshot.records.length > 0) {
    return { state: 'verified', records: snapshot.records };
  }
  return { state: 'no_verified_page_catalog', nameOnlyRecords };
}

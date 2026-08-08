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
import { getActivePageImport } from '../db/repositories/page-import-repo';
import { getDb } from '../db/connection';
import { PageRecordSchema } from '../shared/schemas/page';
import type { PageRecord } from '../shared/schemas/page';
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
 * One coherent read of the ACTIVE verified Page import for a workspace.
 *
 * Reads the active import row (including its canonical `records_json`) once,
 * then the `page_index` rows belonging to that exact import, and validates a
 * strict 1:1 correspondence: every verified import record must have exactly
 * one matching verified `page_index` row with the same name, availability,
 * parent reference, and source hash — and every verified row for that import
 * must correspond to a verified record. Any drift, malformed records, or
 * parse failure THROWS so a run can never start against an incoherent Page
 * catalog (fail closed before run creation).
 *
 * Unavailable states (no active import, or an active import with genuinely no
 * verified+available records and no verified rows) return the empty
 * UNAVAILABLE_PAGE_SNAPSHOT; the run-start readiness gate then blocks an
 * enabled Page target because the captured snapshot carries no Page IDs.
 */
export function captureVerifiedPageSnapshot(workspaceId: string): VerifiedPageSnapshot {
  const active = getActivePageImport(workspaceId);
  if (!active) return UNAVAILABLE_PAGE_SNAPSHOT;

  // ONE read of the authoritative import records (records_json).
  const db = getDb();
  const importRow = db.query('SELECT records_json FROM page_imports WHERE id = ?').get(active.id) as
    | { records_json: string }
    | undefined;
  if (!importRow) {
    throw new Error(`Verified Page import changed during capture: active import "${active.id}" vanished.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(importRow.records_json);
  } catch {
    throw new Error(
      `Verified Page import changed during capture: malformed records_json in active import "${active.id}".`,
    );
  }
  const recordsResult = PageRecordSchema.array().safeParse(parsed);
  if (!recordsResult.success) {
    throw new Error(
      `Verified Page import changed during capture: invalid records_json in active import "${active.id}".`,
    );
  }
  const records: PageRecord[] = recordsResult.data;

  // One read of the verified page_index rows for THIS import (any availability)
  // so drift between the import records and child rows is visible.
  const rows = db.query(
    `SELECT id, name, parent_id, source_hash, identity_kind, identity_key, availability
     FROM page_index
     WHERE workspace_id = ? AND import_id = ? AND identity_status = 'verified'`,
  ).all(workspaceId, active.id) as Array<{
    id: string;
    name: string;
    parent_id: string | null;
    source_hash: string | null;
    identity_kind: string;
    identity_key: string;
    availability: string;
  }>;

  const verifiedRecords = records.filter(r => r.identity.status === 'verified');

  // Strict 1:1 correspondence between verified import records and verified
  // page_index rows (by identity key). Missing rows, extra rows, or a name/
  // availability/source-hash mismatch are all capture-time drift → throw.
  if (rows.length !== verifiedRecords.length) {
    throw new Error(
      `Verified Page import changed during capture: active import "${active.id}" has ` +
        `${verifiedRecords.length} verified record(s) but ${rows.length} verified page_index row(s).`,
    );
  }
  const rowByIdentity = new Map(rows.map(row => [`${row.identity_kind}:${row.identity_key}`, row]));
  for (const record of verifiedRecords) {
    const key = `${record.identity.kind}:${record.identity.key}`;
    const row = rowByIdentity.get(key);
    if (!row) {
      throw new Error(
        `Verified Page import changed during capture: no page_index row for identity "${key}" in the active import.`,
      );
    }
    if (row.name !== record.name) {
      throw new Error(
        `Verified Page import changed during capture: name mismatch for identity "${key}".`,
      );
    }
    if (row.availability !== record.availability) {
      throw new Error(
        `Verified Page import changed during capture: availability mismatch for identity "${key}".`,
      );
    }
    if (row.source_hash !== null && row.source_hash !== active.sourceHash) {
      throw new Error(
        `Verified Page import changed during capture: source hash mismatch for identity "${key}".`,
      );
    }
  }

  // Resolve parent metadata within the verified set for this import. The
  // parent reference on a record names another record's identity key.
  const parentRowByIdentity = new Map(
    verifiedRecords.map(record => [`${record.identity.kind}:${record.identity.key}`, record]),
  );

  const out: PageSnapshotRecord[] = [];
  for (const record of verifiedRecords) {
    if (record.availability !== 'available') continue;
    const key = `${record.identity.kind}:${record.identity.key}`;
    const row = rowByIdentity.get(key)!;
    let parentPageId: string | null = null;
    let parentPageName: string | null = null;
    if (record.parentRef) {
      const parentRecord = parentRowByIdentity.get(`${record.identity.kind}:${record.parentRef}`);
      if (!parentRecord) {
        throw new Error(
          `Verified Page import changed during capture: parent "${record.parentRef}" not found for identity "${key}".`,
        );
      }
      const parentRow = rowByIdentity.get(`${record.identity.kind}:${record.parentRef}`);
      if (!parentRow) {
        throw new Error(
          `Verified Page import changed during capture: no parent page_index row for identity "${key}".`,
        );
      }
      if (row.parent_id !== parentRow.id) {
        throw new Error(
          `Verified Page import changed during capture: parent mismatch for identity "${key}".`,
        );
      }
      parentPageId = parentRow.id;
      parentPageName = parentRow.name;
    } else if (row.parent_id !== null) {
      throw new Error(
        `Verified Page import changed during capture: unexpected parent for identity "${key}".`,
      );
    }
    out.push({
      pageId: row.id,
      pageName: record.name,
      verified: true,
      parentPageId,
      parentPageName,
      identityKind: record.identity.kind,
      identityKey: record.identity.key,
      sourceHash: active.sourceHash,
    });
  }

  if (out.length === 0) {
    // No verified+available rows at all: an unavailable catalog. The
    // run-start readiness gate blocks an enabled Page target (no Page IDs).
    return UNAVAILABLE_PAGE_SNAPSHOT;
  }

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

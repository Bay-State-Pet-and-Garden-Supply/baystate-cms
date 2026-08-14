/**
 * store_manager_preferences repository (operations console, Issue 2).
 *
 * Explicit, versioned workspace operational configuration. Revisions are
 * IMMUTABLE — this repository only ever INSERTs preference rows; editing
 * creates a new version. One active revision per workspace is tracked by the
 * `store_manager_preference_active` pointer. Content is bounded and
 * content-addressed (SHA-256). No chat-write path exists: only the explicit
 * Settings service calls these functions.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { ensureStoreManagerOperationsSchema } from '../store-manager-operations-migration';
import { hashCanonicalJson } from '../../shared/stable-id';
import { STORE_MANAGER_PREFERENCE_BOUNDS } from '../../shared/schemas/store-manager-preferences';
import type { StoreManagerPreferencesContent } from '../../shared/schemas/store-manager-preferences';

export interface StoreManagerPreferenceRow {
  id: string;
  workspace_id: string;
  version: number;
  content_json: string;
  content_hash: string;
  actor_class: string;
  created_at: string;
}

export class StoreManagerPreferenceRepoError extends Error {
  readonly code: 'bound_exceeded' | 'not_found' | 'foreign_workspace';
  constructor(code: StoreManagerPreferenceRepoError['code'], message: string) {
    super(message);
    this.name = 'StoreManagerPreferenceRepoError';
    this.code = code;
  }
}

function mapRow(row: Record<string, unknown>): StoreManagerPreferenceRow {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    version: Number(row.version),
    content_json: String(row.content_json),
    content_hash: String(row.content_hash),
    actor_class: String(row.actor_class),
    created_at: String(row.created_at),
  };
}

/**
 * Insert one immutable revision and point the active pointer at it, in one
 * transaction. Version = active version + 1 (1 for a first revision).
 */
export function createPreferenceRevision(
  workspaceId: string,
  content: StoreManagerPreferencesContent,
  actorClass: 'operator' | 'system_schedule' | 'system_event' | 'replay' | 'preview' = 'operator',
): StoreManagerPreferenceRow {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const contentJson = JSON.stringify(content);
  if (contentJson.length > STORE_MANAGER_PREFERENCE_BOUNDS.maxContentJsonBytes) {
    throw new StoreManagerPreferenceRepoError(
      'bound_exceeded',
      `Preference content exceeds the ${STORE_MANAGER_PREFERENCE_BOUNDS.maxContentJsonBytes}-byte bound.`,
    );
  }
  const contentHash = hashCanonicalJson(content);
  const now = new Date().toISOString();
  const active = getActivePreferenceRevision(workspaceId);
  const version = (active?.version ?? 0) + 1;
  const id = randomUUID();

  db.exec('BEGIN');
  try {
    db.run(
      `INSERT INTO store_manager_preferences
         (id, workspace_id, version, content_json, content_hash, actor_class, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, version, contentJson, contentHash, actorClass, now],
    );
    db.run(
      `INSERT INTO store_manager_preference_active (workspace_id, preference_id, activated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         preference_id = EXCLUDED.preference_id,
         activated_at = EXCLUDED.activated_at`,
      [workspaceId, id, now],
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getPreferenceRevision(workspaceId, id)!;
}

export function getPreferenceRevision(
  workspaceId: string,
  preferenceId: string,
): StoreManagerPreferenceRow | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM store_manager_preferences WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, preferenceId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/** Active revision for a workspace, or null when none saved. */
export function getActivePreferenceRevision(workspaceId: string): StoreManagerPreferenceRow | null {
  const db = getDb();
  const row = db
    .query(
      `SELECT p.* FROM store_manager_preferences p
       JOIN store_manager_preference_active a ON a.preference_id = p.id
       WHERE a.workspace_id = ?`,
    )
    .get(workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

/** Content-addressed hash of the active revision (null when none). */
export function getActivePreferenceContentHash(workspaceId: string): string | null {
  const active = getActivePreferenceRevision(workspaceId);
  return active ? active.content_hash : null;
}

export function listPreferenceRevisions(workspaceId: string, limit = 50): StoreManagerPreferenceRow[] {
  const db = getDb();
  const bounded = Math.min(Math.max(limit, 1), 200);
  const rows = db
    .query(
      'SELECT * FROM store_manager_preferences WHERE workspace_id = ? ORDER BY version DESC LIMIT ?',
    )
    .all(workspaceId, bounded) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/** Active revision content (parsed) — the shape the executor's policy hash
 * captures for every new run. */
export function getActivePreferenceContent(workspaceId: string): StoreManagerPreferencesContent | null {
  const active = getActivePreferenceRevision(workspaceId);
  if (!active) return null;
  try {
    return JSON.parse(active.content_json) as StoreManagerPreferencesContent;
  } catch {
    return null;
  }
}

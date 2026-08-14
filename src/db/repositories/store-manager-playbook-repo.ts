/**
 * store_manager_playbooks / _versions repository (operations console, Issue 6).
 *
 * A playbook is a logical row plus IMMUTABLE content-addressed version rows.
 * Every edit appends a new version (copy-on-edit); versions are verified by
 * their stored definition hash on read (tamper detection). Activation is an
 * explicit reviewed operation recording actor/time/hash, and only one active
 * version may exist per workspace+playbook. Workspace identity is part of
 * every contract: foreign playbooks are indistinguishable from missing ones.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import { ensureStoreManagerOperationsSchema } from '../store-manager-operations-migration';
import type { StoreManagerPlaybookStatus } from '../../shared/schemas/store-manager-playbook';

export interface StoreManagerPlaybookRow {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  templateKind: string | null;
  currentVersion: number;
  status: StoreManagerPlaybookStatus;
  activeVersion: number | null;
  activeHash: string | null;
  activatedAt: string | null;
  activatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoreManagerPlaybookVersionRow {
  id: string;
  workspaceId: string;
  playbookId: string;
  version: number;
  definitionJson: string;
  definitionHash: string;
  createdAt: string;
}

export interface CreatePlaybookInput {
  id?: string;
  workspaceId: string;
  name: string;
  description?: string;
  templateKind?: string | null;
  createdAt?: string;
}

export interface AppendVersionInput {
  id?: string;
  workspaceId: string;
  playbookId: string;
  version: number;
  definitionJson: string;
  definitionHash: string;
  createdAt?: string;
}

function mapPlaybookRow(row: Record<string, unknown>): StoreManagerPlaybookRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    name: String(row.name),
    description: String(row.description ?? ''),
    templateKind: row.template_kind ? String(row.template_kind) : null,
    currentVersion: Number(row.current_version),
    status: String(row.status) as StoreManagerPlaybookStatus,
    activeVersion: row.active_version != null ? Number(row.active_version) : null,
    activeHash: row.active_hash ? String(row.active_hash) : null,
    activatedAt: row.activated_at ? String(row.activated_at) : null,
    activatedBy: row.activated_by ? String(row.activated_by) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapVersionRow(row: Record<string, unknown>): StoreManagerPlaybookVersionRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    playbookId: String(row.playbook_id),
    version: Number(row.version),
    definitionJson: String(row.definition_json),
    definitionHash: String(row.definition_hash),
    createdAt: String(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Logical playbook
// ---------------------------------------------------------------------------

export function createPlaybook(input: CreatePlaybookInput): StoreManagerPlaybookRow {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const now = input.createdAt ?? new Date().toISOString();
  const id = input.id ?? randomUUID();
  db.run(
    `INSERT INTO store_manager_playbooks
       (id, workspace_id, name, description, template_kind, current_version,
        status, active_version, active_hash, activated_at, activated_by,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 'draft', NULL, NULL, NULL, NULL, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.name,
      input.description ?? '',
      input.templateKind ?? null,
      now,
      now,
    ],
  );
  return getPlaybookForWorkspace(input.workspaceId, id)!;
}

export function getPlaybookForWorkspace(workspaceId: string, playbookId: string): StoreManagerPlaybookRow | null {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const row = db
    .query('SELECT * FROM store_manager_playbooks WHERE id = ? AND workspace_id = ?')
    .get(playbookId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapPlaybookRow(row) : null;
}

export function listPlaybooksForWorkspace(workspaceId: string, limit = 100): StoreManagerPlaybookRow[] {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const rows = db
    .query(
      `SELECT * FROM store_manager_playbooks WHERE workspace_id = ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(workspaceId, Math.min(limit, 200)) as Array<Record<string, unknown>>;
  return rows.map(mapPlaybookRow);
}

export function updatePlaybookPointer(input: {
  workspaceId: string;
  playbookId: string;
  name: string;
  description: string;
  currentVersion: number;
  updatedAt?: string;
}): StoreManagerPlaybookRow | null {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const now = input.updatedAt ?? new Date().toISOString();
  const result = db
    .query(
      `UPDATE store_manager_playbooks
       SET name = ?, description = ?, current_version = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    )
    .run(input.name, input.description, input.currentVersion, now, input.playbookId, input.workspaceId);
  if (Number(result.changes) === 0) return null;
  return getPlaybookForWorkspace(input.workspaceId, input.playbookId);
}

// ---------------------------------------------------------------------------
// Immutable versions
// ---------------------------------------------------------------------------

export function appendPlaybookVersion(input: AppendVersionInput): StoreManagerPlaybookVersionRow {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const now = input.createdAt ?? new Date().toISOString();
  const id = input.id ?? randomUUID();
  db.run(
    `INSERT INTO store_manager_playbook_versions
       (id, workspace_id, playbook_id, version, definition_json, definition_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.playbookId,
      input.version,
      input.definitionJson,
      input.definitionHash,
      now,
    ],
  );
  return {
    id,
    workspaceId: input.workspaceId,
    playbookId: input.playbookId,
    version: input.version,
    definitionJson: input.definitionJson,
    definitionHash: input.definitionHash,
    createdAt: now,
  };
}

export function getPlaybookVersionForWorkspace(
  workspaceId: string,
  playbookId: string,
  version: number,
): StoreManagerPlaybookVersionRow | null {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const row = db
    .query(
      `SELECT * FROM store_manager_playbook_versions
       WHERE workspace_id = ? AND playbook_id = ? AND version = ?`,
    )
    .get(workspaceId, playbookId, version) as Record<string, unknown> | undefined;
  return row ? mapVersionRow(row) : null;
}

export function listPlaybookVersionsForWorkspace(
  workspaceId: string,
  playbookId: string,
  limit = 50,
): StoreManagerPlaybookVersionRow[] {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const rows = db
    .query(
      `SELECT * FROM store_manager_playbook_versions
       WHERE workspace_id = ? AND playbook_id = ?
       ORDER BY version DESC LIMIT ?`,
    )
    .all(workspaceId, playbookId, Math.min(limit, 200)) as Array<Record<string, unknown>>;
  return rows.map(mapVersionRow);
}

// ---------------------------------------------------------------------------
// Activation (explicit reviewed operation; one active version per workspace)
// ---------------------------------------------------------------------------

export function activatePlaybookVersion(input: {
  workspaceId: string;
  playbookId: string;
  version: number;
  definitionHash: string;
  activatedBy: string;
  activatedAt?: string;
}): StoreManagerPlaybookRow | null {
  ensureStoreManagerOperationsSchema();
  const db = getDb();
  const now = input.activatedAt ?? new Date().toISOString();
  db.exec('BEGIN');
  try {
    // Verify the exact version exists with the claimed hash in this workspace.
    const versionRow = db
      .query(
        `SELECT definition_hash FROM store_manager_playbook_versions
         WHERE workspace_id = ? AND playbook_id = ? AND version = ?`,
      )
      .get(input.workspaceId, input.playbookId, input.version) as { definition_hash: string } | undefined;
    if (!versionRow || versionRow.definition_hash !== input.definitionHash) {
      db.exec('ROLLBACK');
      return null;
    }
    db.query(
      `UPDATE store_manager_playbooks
       SET status = 'active', active_version = ?, active_hash = ?,
           activated_at = ?, activated_by = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`,
    ).run(
      input.version,
      input.definitionHash,
      now,
      input.activatedBy,
      now,
      input.playbookId,
      input.workspaceId,
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getPlaybookForWorkspace(input.workspaceId, input.playbookId);
}

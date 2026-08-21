// story: e08s01 — server-derived singleton workspace guard (global Hub, fail-closed on >1 legacy rows)
import { getDb } from '../connection';
import type { Workspace } from '@/shared/types';

function mapRow(row: Record<string, unknown>): Workspace {
  return {
    id: String(row.id),
    name: String(row.name),
    workspacePath: String(row.workspace_path),
    gitPath: String(row.git_path),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    bootstrapStatus: String(row.bootstrap_status) as Workspace['bootstrapStatus'],
    baselineCommit: row.baseline_commit ? String(row.baseline_commit) : null,
  };
}

export class MultipleWorkspacesError extends Error {
  workspaces: Workspace[];
  constructor(workspaces: Workspace[]) {
    super(`multiple_workspaces: ${workspaces.length} legacy workspaces found`);
    this.name = 'MultipleWorkspacesError';
    this.workspaces = workspaces;
  }
}

export function getServerSingletonWorkspace(): Workspace | null {
  const db = getDb();
  const rows = db.query('SELECT * FROM workspace ORDER BY created_at ASC').all() as Record<string, unknown>[];
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new MultipleWorkspacesError(rows.map(mapRow));
  return mapRow(rows[0]);
}

export function requireServerSingletonWorkspace(): Workspace {
  const ws = getServerSingletonWorkspace();
  if (!ws) throw new Error('no_workspace: workspace not initialized');
  return ws;
}

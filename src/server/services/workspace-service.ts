import { randomUUID } from 'node:crypto';
import path from 'path';
import { getDb } from '../../db/connection';
import { findWorkspace, updateWorkspacePaths } from '../../db/repositories/workspace-repo';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext, ClassificationConfigLoadError, ClassificationConfigNotConfiguredError } from '../../classification/config-loader';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { upsertRegistryEntry, listRegistry } from '../../db/repositories/field-registry-repo';
import { migrateLegacyWorkspaceIfNeeded, getStoreCatalogPath } from './migration-service';
import type { Workspace } from '../../shared/types';

/**
 * Load the classification configuration for a workspace and record the result
 * on the workspace object. Unconfigured workspaces carry no config and no
 * error; configured-but-invalid workspaces propagate the typed error through
 * `classificationConfigError` instead of silently falling through to a stale
 * SQLite cache. The config object is never derived from the cache here.
 */
function attachClassificationConfig(ws: Workspace, workspacePath: string): void {
  try {
    const activationContext = createRuntimeActivationContext(workspacePath);
    const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
    if (authority.kind === 'v2') {
      // The derived cache was written transactionally at activation; never
      // re-sync the v2 bundle through the v1-shaped cache mirror.
      ws.classificationConfig = authority.bundle as unknown as Workspace['classificationConfig'];
      ws.classificationConfigError = null;
      return;
    }
    syncConfigToCache(ws.id, authority.config);
    ws.classificationConfig = authority.config;
    ws.classificationConfigError = null;
  } catch (err) {
    if (err instanceof ClassificationConfigNotConfiguredError) {
      // Unconfigured is a valid empty state, not an error.
      ws.classificationConfig = undefined;
      ws.classificationConfigError = null;
      return;
    }
    if (err instanceof ClassificationConfigLoadError) {
      // Configuration exists but is invalid: fail closed, never reuse a stale cache.
      ws.classificationConfig = undefined;
      ws.classificationConfigError = err.message;
      return;
    }
    ws.classificationConfig = undefined;
    ws.classificationConfigError = err instanceof Error ? err.message : String(err);
  }
}

export function getCurrentWorkspace(): Workspace | null {
  try {
    const ws = findWorkspace();
    if (ws) {
      attachClassificationConfig(ws, ws.workspacePath);
      return ws;
    }
  } catch {
    // Database not initialized yet
  }

  // Trigger migration / initialization of single store catalog
  const catalogPath = migrateLegacyWorkspaceIfNeeded();
  const ws = findWorkspace();
  if (ws) {
    attachClassificationConfig(ws, catalogPath);
  }
  return ws;
}

export function loadWorkspace(workspacePath?: string): Workspace | null {
  const targetPath = workspacePath ? path.resolve(workspacePath.trim()) : getStoreCatalogPath();
  const ws = findWorkspace();
  if (ws && ws.workspacePath !== targetPath) {
    const gitPath = path.join(targetPath, '.git');
    updateWorkspacePaths(ws.id, targetPath, gitPath);
    ws.workspacePath = targetPath;
    ws.gitPath = gitPath;
  }
  return getCurrentWorkspace();
}

/**
 * Ensures the field_registry has an entry for every ProductField key present
 * in product_index.custom_fields. Runs on catalog load so the
 * registry stays 1:1 with the live catalog.
 */
export function syncFieldRegistryFromProductIndex(workspaceId: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  const rows = db
    .query("SELECT custom_fields FROM product_index WHERE custom_fields IS NOT NULL AND custom_fields != '' AND custom_fields != '{}' LIMIT 5000")
    .all() as Array<{ custom_fields: string | null }>;

  const allKeys = new Set<string>();
  for (const row of rows) {
    if (!row.custom_fields) continue;
    try {
      const customFields = JSON.parse(String(row.custom_fields)) as Record<string, unknown>;
      for (const key of Object.keys(customFields)) {
        if (key.startsWith('ProductField')) allKeys.add(key);
      }
    } catch { /* skip malformed */ }
  }

  if (allKeys.size === 0) return;

  const existing = listRegistry(workspaceId);
  const existingNames = new Set(existing.map(entry => entry.xmlField));

  let newCount = 0;
  for (const key of allKeys) {
    if (existingNames.has(key)) continue;
    upsertRegistryEntry({
      id: randomUUID(),
      workspaceId,
      xmlField: key,
      label: key,
      kind: 'custom',
      dataType: 'string',
      editable: true,
      required: false,
      uiGroup: 'Custom Fields',
      sampleValuesJson: null,
      createdAt: now,
      updatedAt: now,
    });
    newCount++;
  }
  if (newCount > 0) {
    console.log(`[WorkspaceService] Synced ${newCount} missing field_registry entries from product_index.`);
  }
}

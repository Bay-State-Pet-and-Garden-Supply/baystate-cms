import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';

const lazyRequire = createRequire(import.meta.url);

const DEFAULT_WORKSPACE_ID = 'default';
const DEFAULT_WORKSPACE_NAME = 'Bay State Store';

export function getStoreCatalogPath(): string {
  return path.resolve(process.cwd(), 'storage', 'catalog');
}

export function migrateLegacyWorkspaceIfNeeded(): string {
  const targetDir = getStoreCatalogPath();
  const legacyDir = path.resolve(process.cwd(), 'workspaces', 'Bay State');
  const genericWorkspacesDir = path.resolve(process.cwd(), 'workspaces');
  const recentFile = path.resolve(process.cwd(), '.recent-workspaces.json');

  // Check if legacy workspace exists and target catalog is not yet migrated
  const hasLegacyWorkspace = fs.existsSync(legacyDir);
  const targetManifest = path.join(targetDir, 'store', 'manifest.json');
  const targetDb = path.join(targetDir, '.shopsite-cms', 'app.db');

  if (hasLegacyWorkspace && (!fs.existsSync(targetManifest) || !fs.existsSync(targetDb))) {
    console.log(`[Migration] Migrating legacy workspace from "${legacyDir}" to "${targetDir}"...`);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 1. Move/Copy database folder (.shopsite-cms)
    const srcDotShopsite = path.join(legacyDir, '.shopsite-cms');
    const dstDotShopsite = path.join(targetDir, '.shopsite-cms');
    if (fs.existsSync(srcDotShopsite)) {
      copyOrMoveDirSync(srcDotShopsite, dstDotShopsite);
    }

    // 2. Move/Copy products folder
    const srcProducts = path.join(legacyDir, 'products');
    const dstProducts = path.join(targetDir, 'products');
    if (fs.existsSync(srcProducts)) {
      copyOrMoveDirSync(srcProducts, dstProducts);
    }

    // 3. Move/Copy store folder
    const srcStore = path.join(legacyDir, 'store');
    const dstStore = path.join(targetDir, 'store');
    if (fs.existsSync(srcStore)) {
      copyOrMoveDirSync(srcStore, dstStore);
    }

    // 4. Move/Copy exports folder
    const srcExports = path.join(legacyDir, 'exports');
    const dstExports = path.join(targetDir, 'exports');
    if (fs.existsSync(srcExports)) {
      copyOrMoveDirSync(srcExports, dstExports);
    }

    // 5. Move/Copy brand-domain-mappings.json
    const srcBrandMappings = path.join(legacyDir, 'brand-domain-mappings.json');
    const dstBrandMappings = path.join(targetDir, 'brand-domain-mappings.json');
    if (fs.existsSync(srcBrandMappings)) {
      fs.copyFileSync(srcBrandMappings, dstBrandMappings);
    }

    // 6. Move/Copy catalog .git repository
    const srcGit = path.join(legacyDir, '.git');
    const dstGit = path.join(targetDir, '.git');
    if (fs.existsSync(srcGit)) {
      copyOrMoveDirSync(srcGit, dstGit);
    }

    console.log(`[Migration] Files migrated to "${targetDir}". Updating database workspace record...`);
  }

  // Ensure target directory structure exists even for fresh installations
  ensureCatalogStructure(targetDir);

  // Initialize DB at target location & update single workspace record
  const dbPath = path.join(targetDir, '.shopsite-cms', 'app.db');
  initDb(dbPath);
  runMigrations();
  updateWorkspaceRecord(targetDir);

  // Clean up legacy workspaces folder & .recent-workspaces.json if migration succeeded
  if (hasLegacyWorkspace && fs.existsSync(targetDb)) {
    try {
      fs.rmSync(genericWorkspacesDir, { recursive: true, force: true });
      if (fs.existsSync(recentFile)) {
        fs.rmSync(recentFile, { force: true });
      }
      console.log(`[Migration] Successfully cleaned up legacy workspaces directory.`);
    } catch (err) {
      console.warn(`[Migration] Failed to remove legacy workspaces directory:`, err);
    }
  }

  return targetDir;
}

function ensureCatalogStructure(targetDir: string): void {
  const dirs = [
    targetDir,
    path.join(targetDir, 'products'),
    path.join(targetDir, 'store'),
    path.join(targetDir, 'exports'),
    path.join(targetDir, '.shopsite-cms'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Best-effort, idempotent seeding of a workspace's default approved Product
 * Intelligence policy (P0-2). Called from updateWorkspaceRecord so newly
 * created workspaces get a default approved-policy record immediately, not
 * only on their first PI run.
 *
 * The repo/run-service modules are loaded lazily (createRequire) so this
 * module stays importable in environments without bun:sqlite (e.g. vitest);
 * failures are swallowed because the PI run route re-seeds lazily and
 * idempotently — this hook is a safety net, not the enforcement point.
 */
export function seedDefaultApprovedPolicyForWorkspace(workspaceId: string): void {
  try {
    const runService = lazyRequire('../../product-intelligence/run-service') as typeof import('../../product-intelligence/run-service');
    const approvedPolicyRepo = lazyRequire('../../db/repositories/pi-approved-policy-repo') as typeof import('../../db/repositories/pi-approved-policy-repo');
    const defaultPolicy = runService.buildDefaultPiPolicy();
    approvedPolicyRepo.seedDefaultApprovedPolicy(workspaceId, JSON.stringify(defaultPolicy), defaultPolicy.configId);
  } catch {
    // pi_approved_policies may not exist yet during early bootstrap, or the
    // lazy requires failed in a non-bun environment; the run route's lazy
    // seed covers this idempotently.
  }
}

function updateWorkspaceRecord(targetDir: string): void {
  const db = getDb();
  const gitPath = path.join(targetDir, '.git');
  const now = new Date().toISOString();

  const existing = db.query('SELECT id FROM workspace LIMIT 1').get() as { id: string } | undefined;
  if (existing) {
    db.run(
      `UPDATE workspace SET workspace_path = ?, git_path = ?, updated_at = ? WHERE id = ?`,
      [targetDir, gitPath, now, existing.id],
    );
    // Also ensure workspace ID in foreign key tables matches if needed
  } else {
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME, targetDir, gitPath, now, now, 'not_started'],
    );
  }
  // Ensure the workspace's default approved PI policy exists for both the
  // newly inserted row and the pre-existing row (idempotent; run route
  // re-seeds lazily as the authoritative fallback).
  seedDefaultApprovedPolicyForWorkspace(existing?.id ?? DEFAULT_WORKSPACE_ID);
}

function copyOrMoveDirSync(src: string, dst: string): void {
  if (!fs.existsSync(dst)) {
    fs.mkdirSync(dst, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyOrMoveDirSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

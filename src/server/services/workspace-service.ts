import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace, findWorkspace, updateWorkspacePaths } from '../../db/repositories/workspace-repo';
import { GitClient } from '../../git/git-client';
import { createWorkspaceDirs, writeGitignore, writeStoreConfig } from '../../git/workspace-files';
import { saveClassificationConfig, loadClassificationConfig } from '../../classification/config-loader';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import type { ClassificationConfig } from '../../shared/types';

import type { Workspace } from '../../shared/types';

function validateWorkspacePath(userPath: string): void {
  const resolved = path.resolve(userPath.trim());

  // Reject root
  if (resolved === '/') {
    throw new Error('Cannot create workspace at filesystem root.');
  }

  // Reject home directory itself
  const homeDir = os.homedir();
  if (resolved === homeDir) {
    throw new Error('Cannot create workspace at home directory.');
  }

  // Reject system directories
  const systemDirs = ['/etc', '/var', '/tmp', '/usr', '/bin', '/sbin', '/dev', '/proc', '/sys'];
  for (const sysDir of systemDirs) {
    if (resolved === sysDir || resolved.startsWith(sysDir + '/')) {
      throw new Error(`Cannot create workspace at system directory (${sysDir}).`);
    }
  }

  // Check if path is inside home but not the system dirs - allowed
}

export function createWorkspace(name: string, workspacePath: string): { workspace: Workspace; dbPath: string } {
  validateWorkspacePath(workspacePath);

  const resolved = path.resolve(workspacePath.trim());

  // If directory exists but isn't empty and isn't already a ShopSite workspace, reject
  if (fs.existsSync(resolved)) {
    const hasManifest = fs.existsSync(path.join(resolved, 'store', 'manifest.json'));
    if (!hasManifest) {
      const entries = fs.readdirSync(resolved).filter(e => !e.startsWith('.'));
      if (entries.length > 0) {
        throw new Error(`Directory "${resolved}" is not empty and does not contain a ShopSite CMS workspace. Choose an empty directory or an existing workspace.`);
      }
    }
  }

  // Create directories
  const dirs = createWorkspaceDirs(workspacePath);
  writeGitignore(workspacePath);

  // Set up git repo
  const git = new GitClient(workspacePath);
  git.init();

  // Initialize SQLite database in .shopsite-cms
  const dbPath = path.join(dirs.dotShopsite, 'app.db');
  initDb(dbPath);
  runMigrations();
  backfillProductIndex(workspacePath);

  // Create workspace record
  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: randomUUID(),
    name,
    workspacePath,
    gitPath: dirs.git,
    createdAt: now,
    updatedAt: now,
    bootstrapStatus: 'not_started',
    baselineCommit: null,
  };
  insertWorkspace(workspace);
  addRecentWorkspace(name, workspacePath);

  // Write store manifest
  writeStoreConfig(workspacePath, 'manifest.json', {
    workspaceName: name,
    workspaceId: workspace.id,
    appVersion: '0.1.0',
    schemaVersion: 1,
    productCount: 0,
    generatedAt: now,
    baselineCommit: null,
  });

  // Write empty field registry
  writeStoreConfig(workspacePath, 'field-registry.json', {
    schemaVersion: 1,
    entries: [],
  });

  // Write default classification config (empty, seed files)
  const nowStr = new Date().toISOString();
  const defaultClassConfig: ClassificationConfig = {
    manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: nowStr, updatedAt: nowStr, fileVersions: {} },
    productTypes: [],
    attributes: [],
    attributeProfiles: [],
    attributeMappings: [],
    guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  };
  saveClassificationConfig(workspacePath, defaultClassConfig);
  syncConfigToCache(workspace.id, defaultClassConfig);

  // Write adapter settings
  writeStoreConfig(workspacePath, 'adapter-settings.json', {
    xmlVersion: '15.0',
    defaultPublishFlags: { htmlpages: true, index: true },
    productUploadMatchingKey: 'SKU',
    defaultNewRecords: true,
    versionVariableOptions: {
      checkpoint: 500,
      useOptimizer: false,
      sitemap: false,
    },
  });

  return { workspace, dbPath };
}

export function loadWorkspace(workspacePath: string): Workspace | null {
  validateWorkspacePath(workspacePath);

  const resolved = path.resolve(workspacePath.trim());
  const dbPath = path.join(resolved, '.shopsite-cms', 'app.db');
  if (!fs.existsSync(dbPath)) {
    return null;
  }

  // Verify app manifest exists
  const hasManifest = fs.existsSync(path.join(resolved, 'store', 'manifest.json'));
  if (!hasManifest) {
    return null;
  }

  initDb(dbPath);
  runMigrations();
  backfillProductIndex(workspacePath);

  const ws = findWorkspace();
  if (ws) {
    // Load classification config into SQLite cache
    try {
      const classConfig = loadClassificationConfig(resolved);
      syncConfigToCache(ws.id, classConfig);
    } catch (err) {
      console.warn('[WorkspaceService] Failed to load classification config:', err);
    }

    const resolvedGit = path.join(resolved, '.git');
    if (ws.workspacePath !== resolved || ws.gitPath !== resolvedGit) {
      updateWorkspacePaths(ws.id, resolved, resolvedGit);
      ws.workspacePath = resolved;
      ws.gitPath = resolvedGit;
    }
    addRecentWorkspace(ws.name, workspacePath);
  }
  return ws;
}

export function getCurrentWorkspace(): Workspace | null {
  try {
    const ws = findWorkspace();
    if (ws) return ws;
  } catch {
    // DB not initialized
  }
  return autoLoadLastWorkspace();
}

export function closeWorkspace(): void {
  closeDb();
}

export interface RecentWorkspace {
  name: string;
  path: string;
  lastOpened: string;
}

const RECENT_WORKSPACES_FILE = path.join(process.cwd(), '.recent-workspaces.json');

export function getRecentWorkspaces(): RecentWorkspace[] {
  try {
    if (fs.existsSync(RECENT_WORKSPACES_FILE)) {
      const data = fs.readFileSync(RECENT_WORKSPACES_FILE, 'utf-8');
      return JSON.parse(data) as RecentWorkspace[];
    }
  } catch (err) {
    console.error('Failed to read recent workspaces:', err);
  }
  return [];
}

export function saveRecentWorkspaces(list: RecentWorkspace[]): void {
  try {
    fs.writeFileSync(RECENT_WORKSPACES_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save recent workspaces:', err);
  }
}

export function addRecentWorkspace(name: string, workspacePath: string): void {
  const resolved = path.resolve(workspacePath.trim());
  let list = getRecentWorkspaces();
  list = list.filter(item => path.resolve(item.path) !== resolved);
  list.unshift({
    name,
    path: resolved,
    lastOpened: new Date().toISOString()
  });
  if (list.length > 5) {
    list = list.slice(0, 5);
  }
  saveRecentWorkspaces(list);
}

export function removeRecentWorkspace(workspacePath: string): void {
  const resolved = path.resolve(workspacePath.trim());
  let list = getRecentWorkspaces();
  list = list.filter(item => path.resolve(item.path) !== resolved);
  saveRecentWorkspaces(list);
}

export function autoLoadLastWorkspace(): Workspace | null {
  const list = getRecentWorkspaces();
  if (list.length === 0) return null;
  const last = list[0];
  try {
    if (!fs.existsSync(last.path)) {
      removeRecentWorkspace(last.path);
      return null;
    }
    return loadWorkspace(last.path);
  } catch (err) {
    console.error(`Failed to auto-load workspace at ${last.path}:`, err);
    return null;
  }
}

export function backfillProductIndex(workspacePath: string): void {
  const db = getDb();
  const needsBackfill = db.query("SELECT COUNT(*) as count FROM product_index WHERE custom_fields IS NULL").get() as { count: number } | undefined;
  const count = needsBackfill?.count ?? 0;
  if (count > 0) {
    const productsDir = path.join(workspacePath, 'products');
    if (fs.existsSync(productsDir)) {
      const files = fs.readdirSync(productsDir);
      const stmt = db.prepare(`
        UPDATE product_index 
        SET description = ?, search_keywords = ?, custom_fields = ?
        WHERE sku = ?
      `);
      
      const trans = db.transaction(() => {
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          try {
            const content = fs.readFileSync(path.join(productsDir, file), 'utf-8');
            const product = JSON.parse(content);
            stmt.run(
              product.core.description || null,
              product.core.seo.searchKeywords || null,
              JSON.stringify(product.customFields || {}),
              product.sku
            );
          } catch (e) {
            console.error(`Failed to backfill product file ${file}:`, e);
          }
        }
      });
      trans();
    }
  }
}

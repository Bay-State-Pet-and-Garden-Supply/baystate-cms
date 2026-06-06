import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace, findWorkspace } from '../../db/repositories/workspace-repo';
import { GitClient } from '../../git/git-client';
import { createWorkspaceDirs, writeGitignore, writeStoreConfig } from '../../git/workspace-files';

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
  return findWorkspace();
}

export function getCurrentWorkspace(): Workspace | null {
  try {
    return findWorkspace();
  } catch {
    return null;
  }
}

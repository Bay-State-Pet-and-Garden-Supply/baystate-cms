import fs from 'node:fs';
import path from 'node:path';
import { findWorkspace } from '../db/repositories/workspace-repo';
import { generateCandidate, buildFocusedFiles } from './config-generator';
import { computeClassificationBundleHash } from './config-validation';
import { BayStatePetGardenSeed } from './config-seeds/bay-state-pet-garden-v1';
import { scanCatalogEvidence } from './catalog-evidence';
import { loadRuntimeConfig } from './config-loader';
import { upsertConfigSnapshot, syncConfigToCache } from '../db/repositories/classification-config-repo';
import { canonicalJsonFileString, sha256Hex } from '../shared/stable-id';
import { assertTaxonomyMutable } from './taxonomy-freeze';
import type { ClassificationConfig } from '../shared/types';

/**
 * Synchronizes the approved seed taxonomy (BayStatePetGardenSeed) into the
 * active workspace's store/classification/ bundle directory and updates the
 * SQLite runtime cache.
 */
export async function syncSeedToWorkspace(
  workspacePath: string,
  workspaceId: string,
): Promise<ClassificationConfig> {
  // P0 taxonomy freeze: seed sync rewrites the live taxonomy directory and
  // must fail closed until a new immutable taxonomy release is deployed.
  assertTaxonomyMutable('seed sync');

  const ws = findWorkspace();
  const evidence = await scanCatalogEvidence(workspacePath, workspaceId);
  const evidenceStr = canonicalJsonFileString(evidence);
  const evidenceHash = sha256Hex(evidenceStr);

  const candidate = generateCandidate(BayStatePetGardenSeed, evidence);
  const focusedFiles = buildFocusedFiles(candidate.bundle);

  const targetDir = path.join(workspacePath, 'store', 'classification');
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 1. Write catalog-evidence.json
  fs.writeFileSync(path.join(targetDir, 'catalog-evidence.json'), evidenceStr, 'utf-8');

  // 2. Write focused files
  for (const [fileName, content] of Object.entries(focusedFiles)) {
    fs.writeFileSync(path.join(targetDir, fileName), content, 'utf-8');
  }

  // 3. Write active manifest.json
  const manifestWithoutHash = {
    ...candidate.bundle.manifest,
    lifecycle: 'active' as const,
    sourceCatalogCommit: ws?.baselineCommit || '0000000000000000000000000000000000000000',
    catalogEvidenceHash: evidenceHash,
  };

  const activeManifest = {
    ...manifestWithoutHash,
    bundleHash: computeClassificationBundleHash(manifestWithoutHash),
  };

  fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(activeManifest, null, 2), 'utf-8');

  const activeBundle = {
    ...candidate.bundle,
    manifest: activeManifest,
  };

  // 4. Upsert DB snapshot & sync runtime cache
  upsertConfigSnapshot(workspaceId, activeBundle);
  syncConfigToCache(workspaceId, activeBundle as unknown as Parameters<typeof syncConfigToCache>[1]);

  return loadRuntimeConfig(workspacePath, workspaceId);
}

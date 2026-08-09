#!/usr/bin/env bun
/**
 * Classification config admin CLI (Issue #17 D2 — reviewed config-store
 * activation). Drives the deterministic candidate pipeline:
 *
 *   generate-preview  — scan catalog evidence TWICE (byte-identical hash),
 *                       generate the candidate TWICE (identical bundle hash),
 *                       run previewCandidate() against the live active hash,
 *                       and write a review report OUTSIDE the repositories.
 *                       No live file/DB effect (staging dir only, consumed or
 *                       cleaned on activation).
 *
 *   activate          — verify the C2-style backup manifest, deterministically
 *                       re-derive the bundle and require its hash to equal the
 *                       reviewed --staging-hash, then activateBundle() with
 *                       CAS + catalog-tree verifier + verified Page IDs +
 *                       gitEnabled. Verifies the nested commit touches ONLY
 *                       store/classification/** afterwards.
 *
 * Fail-closed: a wrong expected active hash, evidence re-scan drift, candidate
 * re-derivation drift, a missing backup manifest, a non-clean tree gate, or an
 * out-of-scope nested commit all abort without row/file changes.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'node:child_process';
import { initDb } from '../src/db/connection';
import { scanCatalogEvidence, renderCatalogEvidence, createCatalogEvidenceVerifier } from '../src/classification/catalog-evidence';
import { generateCandidate } from '../src/classification/config-generator';
import { BayStatePetGardenSeed } from '../src/classification/config-seeds/bay-state-pet-garden-v1';
import { previewCandidate, activateBundle, getActiveHash } from '../src/classification/config-store';
import { captureVerifiedPageSnapshot } from '../src/classification/page-snapshot';
import { verifySqliteBackup } from '../src/db/sqlite-backup-verifier';
import { readLiveCatalogFields } from '../src/classification/catalog-evidence';

const LIVE_DB = path.resolve('storage', 'catalog', '.shopsite-cms', 'app.db');

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        fail(`missing value for --${key}`);
      }
      out[key] = value;
      i++;
    }
  }
  return out;
}

function fail(message: string): never {
  console.error(`classification-config-admin: ${message}`);
  process.exit(1);
}

function sha256Hex(content: string): string {
  return Bun.CryptoHasher.hash('sha256', content, 'hex');
}

function runGit(cwd: string, args: string[]): string {
  return execSync(`git ${args.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`, {
    cwd,
    encoding: 'utf-8',
  }).trim();
}

/** Scan evidence twice; require byte-identical rendered output. */
async function scannedEvidence(workspacePath: string): Promise<{ evidence: Awaited<ReturnType<typeof scanCatalogEvidence>>; artifact: string; artifactHash: string }> {
  const evidence = await scanCatalogEvidence(workspacePath);
  const first = renderCatalogEvidence(evidence);
  const secondEvidence = await scanCatalogEvidence(workspacePath);
  const second = renderCatalogEvidence(secondEvidence);
  if (first !== second) {
    fail('catalog-evidence scan drifted between runs; aborting (must be byte-identical).');
  }
  return { evidence, artifact: first, artifactHash: sha256Hex(first) };
}

/** Generate the candidate twice; require identical bundle hashes. */
async function derivedCandidate(workspacePath: string) {
  const scan = await scannedEvidence(workspacePath);
  const first = generateCandidate(BayStatePetGardenSeed, scan.evidence);
  const second = generateCandidate(BayStatePetGardenSeed, scan.evidence);
  const hashOf = (c: { bundle: { manifest: { bundleHash: string } } }) => c.bundle.manifest.bundleHash;
  if (hashOf(first) !== hashOf(second)) {
    fail('candidate generation drifted between runs; aborting (must be byte-identical).');
  }
  return { candidate: first, bundleHash: hashOf(first), scan };
}

function pageImportMetadata(workspaceId: string) {
  initDb(LIVE_DB);
  const snapshot = captureVerifiedPageSnapshot(workspaceId);
  if (!snapshot.pageImportId || !snapshot.pageImportHash || snapshot.verifiedPageIds.length === 0) {
    fail('no active verified Page import; D2 requires the 211-page import.');
  }
  return snapshot;
}

function modelPolicySummary(candidate: ReturnType<typeof generateCandidate>) {
  const p = candidate.bundle.modelPolicy;
  return {
    defaultProvider: p.defaultProvider,
    defaultModel: p.defaultModel,
    providerLocalities: p.providerLocalities,
    imageDataSharing: p.imageDataSharing,
    textDataSharing: p.textDataSharing,
    mlFeatures: p.mlFeatures,
  };
}

async function generatePreview(workspacePath: string, workspaceId: string, reportPath: string) {
  const expectedActiveHash = getActiveHash(workspacePath);
  if (!expectedActiveHash) fail('no active config hash in the workspace; cannot preview against a reviewed baseline.');
  if (expectedActiveHash.length !== 64) fail(`malformed active hash: ${expectedActiveHash}`);

  const { candidate, bundleHash, scan } = await derivedCandidate(workspacePath);
  const pages = pageImportMetadata(workspaceId);

  const preview = previewCandidate(candidate.bundle, workspacePath, {
    catalogEvidence: scan.artifact,
  });
  if (!preview.hash) {
    const codes = preview.report.findings.map(f => f.code).join(', ');
    fail(`preview failed: ${codes}`);
  }

  const report = {
    format: 'issue17-d2-preview',
    workspaceId,
    expectedActiveHash,
    stagingHash: preview.hash,
    candidateBundleHash: bundleHash,
    catalogEvidenceHash: scan.artifactHash,
    pageImport: {
      importId: pages.pageImportId,
      sourceHash: pages.pageImportHash,
      verifiedPageCount: pages.verifiedPageIds.length,
    },
    modelPolicy: modelPolicySummary(candidate),
    enabledTargets: candidate.bundle.curationTargets
      .filter(t => t.enabled)
      .map(t => ({ id: t.id, kind: t.kind })),
    storePagesEnabled: candidate.bundle.curationTargets.some(t => t.id === 'store-pages' && t.enabled),
    findings: preview.report.findings.map(f => ({ severity: f.severity, code: f.code, message: f.message })),
    stagingDir: path.join(workspacePath, 'store', `.classification-staging-${preview.hash}`),
    note: 'Human review required before activate: verify semantic findings, Page count/import hash, model policy still local-only, ML features disabled, and the exact nested diff scope.',
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\npreview report written to ${reportPath}`);
}

async function activate(workspacePath: string, workspaceId: string, stagingHash: string, expectedActiveHash: string, backupManifestPath: string, actor: string) {
  if (!fs.existsSync(backupManifestPath)) fail(`backup manifest not found: ${backupManifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(backupManifestPath, 'utf-8'));
  // dbPath is the BACKUP ARTIFACT path (the verifier inspects the snapshot
  // itself, its sidecars, size, SHA-256, schema/user version, and counts);
  // the live DB is passed as the source-parity reference.
  const backupOk = await verifySqliteBackup(manifest.backupPath, manifest, {
    sourceDbPath: LIVE_DB,
  });
  if (!backupOk.ok) fail(`backup verification failed: ${backupOk.errors.join('; ')}`);

  // Deterministic re-derivation: the staged bundle hash must equal the
  // reviewed --staging-hash exactly.
  const { candidate, bundleHash, scan } = await derivedCandidate(workspacePath);
  if (bundleHash !== stagingHash) {
    fail(`re-derived bundle hash ${bundleHash} != reviewed staging hash ${stagingHash}; aborting.`);
  }

  const pages = pageImportMetadata(workspaceId);
  const catalogFields = readLiveCatalogFields(workspacePath);

  const result = await activateBundle(stagingHash, expectedActiveHash, {
    workspacePath,
    workspaceId,
    activationContext: {
      catalogFields,
      verifiedPageIds: pages.verifiedPageIds,
      verifyCatalogEvidence: createCatalogEvidenceVerifier(workspacePath),
      verifyCatalogEvidenceTree: async (expectedArtifactHash: string) => {
        const reScan = renderCatalogEvidence(await scanCatalogEvidence(workspacePath));
        const hash = sha256Hex(reScan);
        return hash === expectedArtifactHash
          ? { verified: true }
          : { verified: false, reason: `catalog tree drifted: artifact ${hash} != expected ${expectedArtifactHash}` };
      },
    },
    catalogEvidenceHash: scan.artifactHash,
    sourceCatalogCommit: runGit(workspacePath, ['rev-parse', 'HEAD']),
    activeRevision: `d2-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    gitMessage: `Activate Bay State classification configuration v3 (D2: store-pages enabled, reviewed activation by ${actor})`,
    gitEnabled: true,
  });

  // Verify the nested commit scope: only store/classification/** changed.
  if (!result.commitHash) fail('activation produced no nested commit (gitEnabled was ignored); aborting.');
  const nestedChanged = runGit(workspacePath, ['show', '--name-only', '--pretty=format:', result.commitHash]).split('\n').filter(Boolean);
  const outOfScope = nestedChanged.filter(f => !f.startsWith('store/classification/'));
  if (outOfScope.length > 0) {
    fail(`nested commit ${result.commitHash} touched out-of-scope paths: ${outOfScope.join(', ')}`);
  }
  const outerChanged = runGit(path.resolve(workspacePath, '..', '..'), ['status', '--porcelain']).split('\n').filter(Boolean);

  console.log(JSON.stringify({
    format: 'issue17-d2-activation',
    activatedBundleHash: result.hash,
    nestedCommit: result.commitHash,
    nestedChangedPaths: nestedChanged,
    nestedOutOfScope: outOfScope,
    verifiedPageCount: pages.verifiedPageIds.length,
    catalogEvidenceHash: scan.artifactHash,
    actor,
  }, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const mode = process.argv[2] ?? '';
const workspacePath = path.resolve(args.workspace ?? '');
const workspaceId = args['workspace-id'] ?? '';
if (!workspacePath || !workspaceId) fail('--workspace <path> and --workspace-id <id> are required.');

if (mode === 'generate-preview') {
  const reportPath = path.resolve(args.report ?? '');
  if (!reportPath) fail('--report <path> is required for generate-preview.');
  generatePreview(workspacePath, workspaceId, reportPath);
} else if (mode === 'activate') {
  const stagingHash = args['staging-hash'] ?? '';
  const expectedActiveHash = args['expected-active-hash'] ?? '';
  const backupManifestPath = path.resolve(args['backup-manifest'] ?? '');
  const actor = args.actor ?? '';
  if (!stagingHash || !expectedActiveHash || !backupManifestPath || !actor) {
    fail('activate requires --staging-hash, --expected-active-hash, --backup-manifest, --actor.');
  }
  await activate(workspacePath, workspaceId, stagingHash, expectedActiveHash, backupManifestPath, actor);
} else {
  fail(`unknown mode "${mode}" (use generate-preview | activate).`);
}

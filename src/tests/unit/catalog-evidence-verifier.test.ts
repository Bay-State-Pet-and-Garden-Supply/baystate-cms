import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createCatalogEvidenceVerifier,
  readLiveCatalogFields,
  renderCatalogEvidence,
  scanCatalogEvidence,
  verifyCatalogEvidenceTreeIntegrity,
} from '../../classification/catalog-evidence';
import { sha256Hex } from '../../shared/stable-id';
import type { CatalogEvidence } from '../../classification/catalog-evidence';

const FIELDS = ['ProductField16', 'ProductField17', 'ProductField18', 'ProductField4', 'ProductField8'];

function runGit(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
}

describe('catalog-evidence verifier (Milestone 7)', () => {
  let root: string;
  let sourceCommit: string;
  let artifactHash: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-verifier-'));
    fs.mkdirSync(path.join(root, 'products'), { recursive: true });
    fs.mkdirSync(path.join(root, 'store', 'classification'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'products', '001.json'),
      JSON.stringify({ sku: '001', customFields: { ProductField16: 'Purina', ProductField17: 'Dog' } }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, 'store', 'field-registry.json'),
      JSON.stringify({ entries: FIELDS.map(xmlField => ({ xmlField, label: xmlField, kind: 'custom' })) }),
      'utf-8',
    );

    runGit(root, ['init']);
    // CI runners have no global git identity; configure a local one so the
    // seed commit succeeds everywhere.
    runGit(root, ['config', 'user.email', 'catalog-evidence-verifier@example.com']);
    runGit(root, ['config', 'user.name', 'Catalog Evidence Verifier Test']);
    runGit(root, ['add', '--', 'products/001.json', 'store/field-registry.json']);
    runGit(root, ['commit', '-m', 'seed evidence workspace']);
    sourceCommit = runGit(root, ['rev-parse', 'HEAD']);
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function generateAndCommitArtifact(): Promise<string> {
    const evidence = await scanCatalogEvidence(root);
    const artifact = renderCatalogEvidence(evidence);
    const hash = sha256Hex(artifact);
    fs.writeFileSync(path.join(root, 'store', 'classification', 'catalog-evidence.json'), artifact, 'utf-8');
    runGit(root, ['add', '--', 'store/classification/catalog-evidence.json']);
    runGit(root, ['commit', '-m', `commit artifact ${hash}`]);
    return hash;
  }

  it('readLiveCatalogFields returns the registry xmlFields sorted and deduplicated', () => {
    expect(readLiveCatalogFields(root)).toEqual([...FIELDS].sort());
    expect(readLiveCatalogFields(path.join(root, 'no-such-dir'))).toEqual([]);
  });

  it('verifies a committed artifact, source commit ancestry, and live field attestation', async () => {
    artifactHash = await generateAndCommitArtifact();
    const verifier = createCatalogEvidenceVerifier(root);
    const result = verifier({
      catalogEvidenceHash: artifactHash,
      sourceCatalogCommit: sourceCommit,
      catalogFields: new Set(readLiveCatalogFields(root)),
    });
    expect(result.verified).toBe(true);
  });

  it('fails closed when the artifact is missing', () => {
    const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-missing-'));
    fs.mkdirSync(path.join(missingRoot, 'store', 'classification'), { recursive: true });
    const verifier = createCatalogEvidenceVerifier(missingRoot);
    const result = verifier({
      catalogEvidenceHash: artifactHash,
      sourceCatalogCommit: sourceCommit,
      catalogFields: new Set(readLiveCatalogFields(root)),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('missing');
    fs.rmSync(missingRoot, { recursive: true, force: true });
  });

  it('fails closed when the committed artifact bytes were tampered (hash mismatch)', () => {
    const artifactPath = path.join(root, 'store', 'classification', 'catalog-evidence.json');
    fs.writeFileSync(artifactPath, artifactHash, 'utf-8'); // not the real artifact
    const verifier = createCatalogEvidenceVerifier(root);
    const result = verifier({
      catalogEvidenceHash: artifactHash,
      sourceCatalogCommit: sourceCommit,
      catalogFields: new Set(readLiveCatalogFields(root)),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('does not match');
  });

  it('fails closed when the source catalog commit is not an ancestor of HEAD', async () => {
    // Restore the real artifact bytes on disk (verifier binds to bytes, not
    // the commit state).
    const evidence = await scanCatalogEvidence(root);
    fs.writeFileSync(path.join(root, 'store', 'classification', 'catalog-evidence.json'), renderCatalogEvidence(evidence), 'utf-8');
    const verifier = createCatalogEvidenceVerifier(root);
    const result = verifier({
      catalogEvidenceHash: artifactHash,
      sourceCatalogCommit: '0'.repeat(40),
      catalogFields: new Set(readLiveCatalogFields(root)),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('ancestor');
  });

  it('fails closed when the attested field set does not match the live registry', () => {
    const verifier = createCatalogEvidenceVerifier(root);
    const result = verifier({
      catalogEvidenceHash: artifactHash,
      sourceCatalogCommit: sourceCommit,
      catalogFields: new Set(['ProductField16', 'ProductField999']),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('xmlFields');
  });

  it('tree integrity: re-scan matches the expected artifact hash and detects drift', async () => {
    const evidence = await scanCatalogEvidence(root);
    const artifact = renderCatalogEvidence(evidence);
    const hash = sha256Hex(artifact);

    const match = await verifyCatalogEvidenceTreeIntegrity(root, hash);
    expect(match.verified).toBe(true);

    // Drift: add a product file after the artifact was generated.
    fs.writeFileSync(
      path.join(root, 'products', '002.json'),
      JSON.stringify({ sku: '002', customFields: { ProductField16: 'Blue Buffalo' } }),
      'utf-8',
    );
    const drifted = await verifyCatalogEvidenceTreeIntegrity(root, hash);
    expect(drifted.verified).toBe(false);
    expect(drifted.reason).toContain('does not match');

    // Undo the drift to keep later tests (if any) stable.
    fs.rmSync(path.join(root, 'products', '002.json'), { force: true });
  });
});

describe('catalog-evidence scan determinism on the verifier path', () => {
  it('produces byte-identical artifacts across repeated scans', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-determinism-'));
    fs.mkdirSync(path.join(root, 'products'), { recursive: true });
    fs.mkdirSync(path.join(root, 'store'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'products', 'a.json'),
      JSON.stringify({ sku: 'a', customFields: { ProductField16: 'Purina' } }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(root, 'store', 'field-registry.json'),
      JSON.stringify({ entries: [{ xmlField: 'ProductField16' }] }),
      'utf-8',
    );
    const first = await scanCatalogEvidence(root);
    const second = await scanCatalogEvidence(root);
    expect(renderCatalogEvidence(first)).toBe(renderCatalogEvidence(second));
    expect(sha256Hex(renderCatalogEvidence(first))).toBe(sha256Hex(renderCatalogEvidence(second)));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

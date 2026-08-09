/**
 * Atomic, immutable, content-addressed corpus manifests.
 *
 * A manifest lists the SHA-256 of every artifact file in a dataset directory.
 * It is serialized with sorted canonical JSON, named after its own digest
 * (`manifest-<digest>.json`), and written atomically (temp file + rename).
 * No timestamps or absolute paths are ever included, so identical inputs
 * produce byte-identical manifests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { canonicalJsonStringify, sha256Hex } from '../shared/stable-id.js';

const CORPUS_MANIFEST_FORMAT_VERSION = 1;

export interface CorpusManifestFileEntry {
  name: string;
  sha256: string;
}

export interface CorpusManifest {
  formatVersion: number;
  files: CorpusManifestFileEntry[];
}

/** Computes the content-addressed digest of a manifest. */
export function computeManifestDigest(manifest: CorpusManifest): string {
  return sha256Hex(`manifest:${canonicalJsonStringify(manifest)}`);
}

/** Canonical manifest filename for a given digest. */
function manifestFileName(digest: string): string {
  return `manifest-${digest}.json`;
}

/** Builds a sorted manifest from a map of relative file names to digests. */
export function buildCorpusManifest(fileDigests: Record<string, string>): CorpusManifest {
  const files = Object.entries(fileDigests)
    .map(([name, sha256]) => ({ name, sha256 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { formatVersion: CORPUS_MANIFEST_FORMAT_VERSION, files };
}

/** SHA-256 of a file's bytes. */
export function hashFileBytes(filePath: string): string {
  return sha256Hex(fs.readFileSync(filePath));
}

/**
 * Atomically writes a manifest into `dir` and returns the absolute path.
 * Creates `dir` if needed. Uses a temp file + rename so a crash never leaves
 * a partially written manifest.
 */
export function writeCorpusManifestAtomic(dir: string, manifest: CorpusManifest): string {
  fs.mkdirSync(dir, { recursive: true });
  const digest = computeManifestDigest(manifest);
  const fileName = manifestFileName(digest);
  const targetPath = path.join(dir, fileName);
  const content = canonicalJsonStringify(manifest);
  const tempPath = path.join(dir, `.${fileName}.tmp-${process.pid}`);
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, targetPath);
  return targetPath;
}

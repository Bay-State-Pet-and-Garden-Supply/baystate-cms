/**
 * Artifact helpers for the extraction worker.
 *
 * All snapshot/profile-tooling artifacts are written under:
 *   <cwd>/.shopsite-cms/artifacts/profile-builder/<domain>/<job-id>/
 *
 * The worker writes these files and returns relative paths from the project
 * root. The Bun server decides which references to persist in SQLite.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { randomBytes } from 'node:crypto';

const PROJECT_ROOT = resolve(process.cwd());

/**
 * Build the base artifact directory for profile-builder artifacts.
 * The full path is: <PROJECT_ROOT>/.shopsite-cms/artifacts/profile-builder/
 */
function getArtifactsBase(): string {
  return join(PROJECT_ROOT, '.shopsite-cms', 'artifacts', 'profile-builder');
}

/**
 * Resolve the absolute path for a domain/jobId artifact directory.
 * Creates parent directories recursively.
 */
export function resolveArtifactDir(domain: string, jobId: string): string {
  const dir = join(getArtifactsBase(), domain, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write an artifact file to the given directory.
 *
 * @param dir  - Absolute path to the artifact directory (from resolveArtifactDir).
 * @param name - File name (e.g. "page.html", "screenshot.png").
 * @param content - String or Buffer content to write.
 * @returns The relative path from the project root (for use in API responses).
 */
export function writeArtifact(dir: string, name: string, content: string | Buffer): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  return relative(PROJECT_ROOT, filePath);
}

/**
 * Generate a unique job ID for snapshot runs.
 * Format: snapshot-<unix-ms>-<random-4-hex>
 */
export function generateJobId(): string {
  const timestamp = Date.now();
  return `snapshot-${timestamp}-${randomBytes(2).toString('hex')}`;
}

/**
 * Extract the registered domain (hostname without www.) from a URL.
 */
export function extractDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown-domain';
  }
}

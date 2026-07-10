/**
 * Snapshot Artifact Resolver
 *
 * Securely resolves and reads snapshot HTML from the shared filesystem.
 * The extraction worker writes artifacts under .shopsite-cms/artifacts/profile-builder/
 * and the Bun API server reads them through this resolver.
 *
 * MVP deployment constraint:
 * The snapshot worker and Bun API server must share the
 * .shopsite-cms/artifacts filesystem. When they split to separate hosts,
 * this resolver must be replaced with object-storage or artifact-service lookups.
 *
 * Testability: The artifact root and max bytes can be injected as constructor
 * arguments to createResolver(), making tests independent of process.cwd().
 */

import { realpathSync, statSync, readFileSync } from 'node:fs';
import { resolve, relative, sep, parse } from 'node:path';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_ARTIFACT_ROOT = resolve(
  process.cwd(),
  '.shopsite-cms',
  'artifacts',
  'profile-builder',
);

const DEFAULT_MAX_BYTES = 2_000_000;

// ─── Error classes ──────────────────────────────────────────────────────────

export class InvalidArtifactReferenceError extends Error {
  public readonly code = 'INVALID_ARTIFACT_REFERENCE';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArtifactReferenceError';
  }
}

export class SnapshotNotFoundError extends Error {
  public readonly code = 'SNAPSHOT_NOT_FOUND';
  constructor() {
    super('Snapshot artifact not found. Capture a new page snapshot.');
    this.name = 'SnapshotNotFoundError';
  }
}

export class SnapshotTooLargeError extends Error {
  public readonly code = 'SNAPSHOT_TOO_LARGE';
  constructor(bytes: number) {
    super(
      `Snapshot artifact exceeds the maximum size of ${(DEFAULT_MAX_BYTES / 1_000_000).toFixed(0)} MB (${(bytes / 1_000_000).toFixed(1)} MB).`,
    );
    this.name = 'SnapshotTooLargeError';
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ResolvedSnapshotArtifact {
  /** The resolved absolute filesystem path (for logging/diagnostics). */
  absolutePath: string;
  /** The full HTML content of the snapshot. */
  html: string;
  /** File size in bytes. */
  bytes: number;
}

export interface ArtifactResolverOptions {
  /** Root directory for artifact resolution (default: .shopsite-cms/artifacts/profile-builder). */
  artifactRoot?: string;
  /** Maximum file size in bytes (default: 2_000_000). */
  maxBytes?: number;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a resolver instance with the given (or default) root and max size.
 *
 * Most callers use the default export. Tests inject a temp directory
 * as the artifact root.
 */
export function createResolver(options: ArtifactResolverOptions = {}) {
  const root = options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const resolvedRoot = resolve(root);

  // Canonicalize the root path through realpathSync so symlinks are resolved
  // consistently with candidate files (macOS /tmp → /private/tmp).
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolvedRoot);
  } catch {
    // If the root doesn't exist yet, use the resolved path as-is
    canonicalRoot = resolvedRoot;
  }

  return {
    /**
     * Resolve a snapshot HTML artifact reference to its content.
     *
     * Security rules:
     * 1. Reject absolute paths — only relative refs from caller's reference frame.
     * 2. Resolve symlinks via realpathSync.
     * 3. Verify the final real path is within the artifact root.
     * 4. Require .html extension.
     * 5. Reject directories and non-regular files.
     * 6. Enforce max file size.
     *
     * Never returns unresolved filesystem paths in error messages.
     */
    resolve(htmlRef: string): ResolvedSnapshotArtifact {
      // Normalize references that are relative to the project root
      const projectRoot = resolve(process.cwd());
      const absoluteCandidate = resolve(projectRoot, htmlRef);
      if (isWithinRoot(canonicalRoot, absoluteCandidate)) {
        htmlRef = relative(canonicalRoot, absoluteCandidate);
      }

      // 1. Reject absolute paths
      if (parse(htmlRef).root !== '') {
        throw new InvalidArtifactReferenceError(
          'Absolute paths are not allowed for artifact references.',
        );
      }

      // Windows-style drive letter check
      if (/^[A-Za-z]:[\\/]/.test(htmlRef)) {
        throw new InvalidArtifactReferenceError(
          'Absolute paths are not allowed for artifact references.',
        );
      }

      // 2. Resolve from the artifact root
      const candidate = resolve(canonicalRoot, htmlRef);

      // 2a. Check containment on the resolved candidate path BEFORE
      //     resolving symlinks. This ensures traversal attacks are
      //     caught even when the target file doesn't exist.
      if (!isWithinRoot(canonicalRoot, candidate)) {
        throw new InvalidArtifactReferenceError(
          'Artifact reference is outside the allowed directory.',
        );
      }

      // 3. Resolve symlinks to get the real path
      let realPath: string;
      try {
        realPath = realpathSync(candidate);
      } catch (err: unknown) {
        if (isNodeError(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
          throw new SnapshotNotFoundError();
        }
        throw new InvalidArtifactReferenceError(
          'Unable to resolve artifact reference.',
        );
      }

      // 4. Verify the real path is within the artifact root
      //     (symlink targets may differ from the candidate path)
      if (!isWithinRoot(canonicalRoot, realPath)) {
        throw new InvalidArtifactReferenceError(
          'Artifact reference is outside the allowed directory.',
        );
      }

      // 5. Require .html extension
      if (!realPath.toLowerCase().endsWith('.html')) {
        throw new InvalidArtifactReferenceError(
          'Artifact must be an HTML file.',
        );
      }

      // 6. Stat the resolved path — reject directories and non-regular files
      let stats;
      try {
        stats = statSync(realPath);
      } catch (err: unknown) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          throw new SnapshotNotFoundError();
        }
        throw new InvalidArtifactReferenceError(
          'Unable to access artifact file.',
        );
      }

      if (!stats.isFile()) {
        throw new InvalidArtifactReferenceError(
          'Artifact path is not a regular file.',
        );
      }

      // 7. Enforce max file size
      if (stats.size > maxBytes) {
        throw new SnapshotTooLargeError(stats.size);
      }

      // 8. Read the file
      let html: string;
      try {
        html = readFileSync(realPath, 'utf-8');
      } catch {
        throw new SnapshotNotFoundError();
      }

      return {
        absolutePath: realPath,
        html,
        bytes: stats.size,
      };
    },

    /** Expose the resolved root for diagnostics. */
    get root(): string {
      return canonicalRoot;
    },

    /** Expose the max bytes limit for diagnostics. */
    get maxBytes(): number {
      return maxBytes;
    },
  };
}

// ─── Default singleton ──────────────────────────────────────────────────────

const defaultResolver = createResolver();

export const resolveSnapshotArtifact = defaultResolver.resolve.bind(defaultResolver);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check whether `candidatePath` (must already be resolved) is a descendant
 * of `root` (must already be resolved). Uses path.relative and verifies the
 * relative path does not start with '..' or equal '..' or ''.
 *
 * Handles sibling-prefix attacks: artifacts/profile-builder-evil
 * would produce a relative path starting with '..' from the real root.
 */
function isWithinRoot(root: string, candidatePath: string): boolean {
  const rel = relative(root, candidatePath);

  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !rel.startsWith('../') &&
    !sepAtStart(rel) &&
    !isAbsolute(rel)
  );
}

function sepAtStart(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\');
}

function isAbsolute(p: string): boolean {
  return parse(p).root !== '';
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

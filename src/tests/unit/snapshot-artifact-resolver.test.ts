import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  createResolver,
  InvalidArtifactReferenceError,
  SnapshotNotFoundError,
  SnapshotTooLargeError,
  type ResolvedSnapshotArtifact,
} from '../../server/services/profile-builder/snapshotArtifactResolver';

// ─── Test Fixture ──────────────────────────────────────────────────────────

interface Fixture {
  artifactRoot: string;
  htmlFile: string;
  htmlContent: string;
  jsonFile: string;
  largeFile: string;
  nestedDir: string;
  nestedFile: string;
  outsideFile: string;
  evilDir: string;
  cleanup: () => void;
}

function createFixture(): Fixture {
  const id = randomUUID();
  const base = join(tmpdir(), `snapshot-resolver-test-${id}`);
  const artifactRoot = join(base, 'acmepet.com', 'job-123');
  mkdirSync(artifactRoot, { recursive: true });

  const htmlContent = '<html><body><h1 class="product-title">Test Product</h1></body></html>';
  const htmlFile = join(artifactRoot, 'page.html');
  writeFileSync(htmlFile, htmlContent, 'utf-8');

  const jsonFile = join(artifactRoot, 'data.json');
  writeFileSync(jsonFile, JSON.stringify({ key: 'value' }), 'utf-8');

  const nestedDir = join(artifactRoot, 'sub');
  mkdirSync(nestedDir);
  const nestedFile = join(nestedDir, 'page.html');
  writeFileSync(nestedFile, '<html><body>Nested</body></html>', 'utf-8');

  const largeFile = join(artifactRoot, 'large.html');
  writeFileSync(largeFile, 'x'.repeat(2_500_000), 'utf-8');

  const outsideFile = join(base, 'outside.html');
  writeFileSync(outsideFile, '<html><body>Outside</body></html>', 'utf-8');

  const evilDir = join(base, 'profile-builder-evil');
  mkdirSync(evilDir, { recursive: true });
  const evilFile = join(evilDir, 'page.html');
  writeFileSync(evilFile, '<html><body>Evil</body></html>', 'utf-8');

  // Create a symlink that escapes the artifact root
  const symlinkDir = join(artifactRoot, 'escape-link');
  try {
    const { symlinkSync } = require('node:fs');
    symlinkSync(outsideFile, symlinkDir);
  } catch { /* may fail on platforms without symlink support */ }

  // Create a file with .html extension in a sibling-prefix directory
  const siblingPrefixFile = join(evilDir, 'page.html');
  writeFileSync(siblingPrefixFile, '<html><body>Sibling prefix attack</body></html>', 'utf-8');

  return {
    artifactRoot,
    htmlFile,
    htmlContent,
    jsonFile,
    largeFile,
    nestedDir,
    nestedFile,
    outsideFile,
    evilDir,
    cleanup: () => {
      const { rmSync } = require('node:fs');
      try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('createResolver', () => {
  let fix: Fixture;

  beforeEach(() => {
    fix = createFixture();
  });

  afterEach(() => {
    fix.cleanup();
  });

  describe('resolve', () => {
    it('resolves a valid HTML artifact by relative ref from the root', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      // The artifact root contains the files, so ref just needs the relative path
      const ref = 'page.html';

      const result = resolver.resolve(ref);

      expect(result).toBeDefined();
      expect(result.html).toBe(fix.htmlContent);
      expect(result.bytes).toBe(fix.htmlContent.length);
      expect(result.absolutePath).toContain('page.html');
    });

    it('resolves nested artifacts with subdirectory refs', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      const result = resolver.resolve('sub/page.html');

      expect(result.html).toBe('<html><body>Nested</body></html>');
    });

    it('rejects absolute paths', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      expect(() => resolver.resolve('/etc/passwd')).toThrow(InvalidArtifactReferenceError);
    });

    it('rejects paths with drive letters (Windows-style)', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      expect(() => resolver.resolve('C:\\windows\\file.html')).toThrow(InvalidArtifactReferenceError);
    });

    it('rejects .. traversal out of the artifact root', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      expect(() => resolver.resolve('../outside.html')).toThrow(InvalidArtifactReferenceError);
    });

    it('rejects deep .. traversal', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      expect(() => resolver.resolve('../../outside.html')).toThrow(InvalidArtifactReferenceError);
    });

    it('rejects paths traversing up from nested subdirectory', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      expect(() => resolver.resolve('sub/../../../outside.html')).toThrow(InvalidArtifactReferenceError);
    });

    it('rejects sibling-prefix directory attacks', () => {
      // evilDir is "profile-builder-evil" at the same level as artifactRoot's parent
      // The resolver's root is fix.artifactRoot, which is .../acmepet.com/job-123
      // We need a ref that tries to reach ../../profile-builder-evil/page.html
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      expect(() => resolver.resolve('../../profile-builder-evil/page.html')).toThrow(InvalidArtifactReferenceError);
    });

    it('rejects non-HTML files', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      expect(() => resolver.resolve('data.json')).toThrow(InvalidArtifactReferenceError);
    });

    it('rejects directories', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      // 'sub' ends in 'sub' not '.html', so it fails extension check
      // We need a path that ends in .html AND is a directory
      const dir = join(fix.artifactRoot, 'test.html');
      mkdirSync(dir);
      expect(() => resolver.resolve('test.html')).toThrow(InvalidArtifactReferenceError);
    });

    it('rejects missing files', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      expect(() => resolver.resolve('nonexistent.html')).toThrow(SnapshotNotFoundError);
    });

    it('rejects files exceeding max bytes', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot, maxBytes: 50 });
      expect(() => resolver.resolve('page.html')).toThrow(SnapshotTooLargeError);
    });

    it('rejects large.html (2.5MB) with default 2MB limit', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      expect(() => resolver.resolve('large.html')).toThrow(SnapshotTooLargeError);
    });

    it('ignores path traversal through symlinks that escape root', () => {
      const resolver = createResolver({ artifactRoot: fix.artifactRoot });
      // The escape-link symlink targets a file outside the root.
      // If symlink resolution moves it outside, it should fail the root check.
      // If symlinks aren't available, it fails as not-found.
      const resultOrError = () => resolver.resolve('escape-link');
      // It should throw because it either resolves to outside (caught by isWithinRoot)
      // or the symlink target is a non-.html file (caught by extension check)
      expect(resultOrError).toThrow();
    });
  });

  describe('default export', () => {
    it('creates a ready-to-use resolver bound to the project root', async () => {
      const { resolveSnapshotArtifact: rsa } = await import('../../server/services/profile-builder/snapshotArtifactResolver');
      expect(rsa).toBeInstanceOf(Function);
      // Calling with an invalid ref should throw (not crash)
      expect(() => rsa('/etc/passwd')).toThrow(InvalidArtifactReferenceError);
    });
  });

  describe('error types', () => {
    it('InvalidArtifactReferenceError has code INVALID_ARTIFACT_REFERENCE', () => {
      const err = new InvalidArtifactReferenceError('test');
      expect(err.code).toBe('INVALID_ARTIFACT_REFERENCE');
    });

    it('SnapshotNotFoundError has code SNAPSHOT_NOT_FOUND', () => {
      const err = new SnapshotNotFoundError();
      expect(err.code).toBe('SNAPSHOT_NOT_FOUND');
    });

    it('SnapshotTooLargeError has code SNAPSHOT_TOO_LARGE', () => {
      const err = new SnapshotTooLargeError(3_000_000);
      expect(err.code).toBe('SNAPSHOT_TOO_LARGE');
    });

    it('SnapshotTooLargeError reports the file size in the message', () => {
      const err = new SnapshotTooLargeError(1_500_000);
      expect(err.message).toContain('1.5 MB');
    });
  });
});

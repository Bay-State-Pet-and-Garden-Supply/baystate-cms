/**
 * Artifact URL resolution helpers for the profile builder.
 *
 * Snapshot responses return artifact refs such as `screenshotRef` and `htmlRef`.
 * These may be local filesystem paths under
 * `.baystate-cms/artifacts/` or URL-like strings. This module provides a
 * default resolver that only returns browser-readable URLs for refs that
 * already look like URLs.
 *
 * The parent integration can supply an `artifactUrlResolver` prop to
 * provide a custom resolution strategy (e.g. via an artifact-serving
 * backend endpoint).
 *
 * No Bun-only imports — safe for Vite/React frontend.
 */

/**
 * Default artifact URL resolver.
 *
 * Only returns refs that are already URL-like:
 *   - `http://` or `https://` URLs
 *   - Absolute paths starting with `/`
 *
 * Returns `null` for local filesystem paths (e.g.
 * `.baystate-cms/artifacts/profile-builder/...`) that the browser
 * cannot read directly.
 */
export function defaultArtifactUrlResolver(ref: string): string | null {
  if (!ref) return null;

  const trimmed = ref.trim();
  if (!trimmed) return null;

  // Already a full URL.
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }

  // Absolute path (server-routable).
  if (trimmed.startsWith('/')) {
    return trimmed;
  }

  // Local filesystem path — not browser-accessible.
  return null;
}

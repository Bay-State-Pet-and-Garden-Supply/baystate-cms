import { getApiKey } from '../../db/repositories/api-key-repo';
import { parseHtmlScraperCredentials as parseCredentials } from './html-scraper/credentials';
export type { HtmlScraperCredentials, HtmlScraperSecretParse } from './html-scraper/credentials';

/** Re-export the strict parser from its pure module (server path). */
export const parseHtmlScraperCredentials = parseCredentials;

/**
 * Secret resolution for distributor connections (ADR 0014).
 *
 * Connections store ONLY a `secret_ref` — an opaque identifier that is
 * resolved server-side immediately before connector execution. Resolution
 * order:
 *   1. an environment variable whose name equals `secretRef`;
 *   2. an `api_keys` row whose service name equals `secretRef`.
 *
 * Resolved material is NEVER returned to callers of the connection API,
 * never logged, and never persisted. A null result means the operator has
 * not provisioned the secret yet — the engine skips the connection with a
 * stable `secret_missing` reason (never a thrown error, never a fallback to
 * another connection's credentials).
 */

/** Environment variables are read per call so config changes apply live. */
export function resolveSecret(secretRef: string | null): string | null {
  if (!secretRef) return null;
  const fromEnv = process.env[secretRef];
  if (isUsableSecret(fromEnv)) return fromEnv;
  const apiKey = getApiKey(secretRef);
  if (apiKey && isUsableSecret(apiKey.api_key)) return apiKey.api_key;
  return null;
}

/**
 * A secret is usable only when non-empty AND not a UI mask (the project
 * convention: masked values start with '•' — sending one to a provider
 * would silently break lookups, so it is treated as unprovisioned).
 */
function isUsableSecret(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('•');
}

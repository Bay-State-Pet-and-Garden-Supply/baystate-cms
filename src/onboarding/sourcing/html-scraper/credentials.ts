/**
 * Strict `html_scraper` credential parsing (ADR 0014 Amendment B, M2).
 *
 * PURE module with no DB/env/network imports so it can run under any test
 * runner. `secret-resolver.ts` re-exports these from the server path.
 */

/**
 * Credential shape for Distributor Scraper (`html_scraper`) connections:
 * exactly nonblank `username` and `password` strings. Resolved server-side
 * from the opaque `secret_ref`; never returned, logged, or persisted.
 */
export interface HtmlScraperCredentials {
  username: string;
  password: string;
}

export type HtmlScraperSecretParse =
  | { ok: true; credentials: HtmlScraperCredentials }
  | { ok: false; code: 'secret_missing' | 'credential_invalid' };

/** A secret is usable only when non-empty AND not a UI mask ('•'-prefixed). */
function isUsableSecret(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('•');
}

/**
 * Strict parser for a resolved `html_scraper` secret JSON payload.
 *
 * Accepts EXACTLY a JSON object with nonblank string fields `username` and
 * `password`. It does not coerce values, echo Zod/parse issues, trim or
 * alter a valid password, or accept extra credential fields. Missing /
 * masked material is `secret_missing`; malformed JSON / non-object / arrays /
 * blank or non-string fields / extra keys are `credential_invalid`. The
 * input is never included in any message or log.
 */
export function parseHtmlScraperCredentials(raw: string | null | undefined): HtmlScraperSecretParse {
  if (!isUsableSecret(raw ?? undefined)) {
    return { ok: false, code: 'secret_missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw as string);
  } catch {
    return { ok: false, code: 'credential_invalid' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'credential_invalid' };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2) {
    return { ok: false, code: 'credential_invalid' };
  }
  const username = record.username;
  const password = record.password;
  if (typeof username !== 'string' || username.length === 0) {
    return { ok: false, code: 'credential_invalid' };
  }
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, code: 'credential_invalid' };
  }
  // A password that starts with a UI mask is treated as unprovisioned.
  if (password.startsWith('•')) {
    return { ok: false, code: 'secret_missing' };
  }
  return { ok: true, credentials: { username, password } };
}

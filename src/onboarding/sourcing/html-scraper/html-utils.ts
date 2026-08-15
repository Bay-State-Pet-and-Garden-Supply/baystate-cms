import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';

/**
 * Pure HTML helpers for Distributor Scraper connectors (ADR 0014 Amendment
 * B, M2). Ordered selector fallback, text/list extraction, GTIN equality,
 * same-origin URL resolution, HTTPS image filtering, dedupe, and
 * result/no-result/auth marker detection.
 *
 * These helpers have NO network, DB, env, or logging side effects: they
 * operate on fixture strings / Cheerio instances only, so unit tests can
 * exercise every selector path offline.
 */

export type HtmlInput = string | CheerioAPI;

/** Parse HTML once and return a Cheerio instance (pure — no network). */
export function loadHtml(html: string): CheerioAPI {
  return cheerio.load(html);
}

/** Coerce a string or existing Cheerio instance. */
export function toCheerio(input: HtmlInput): CheerioAPI {
  return typeof input === 'string' ? loadHtml(input) : input;
}

/**
 * Ordered selector fallback: return the first nonblank text result among the
 * selectors. `extract` defaults to trimmed text; pass `attr` for attributes
 * (e.g. 'src', 'href'). Never throws on an unknown selector.
 */
export function firstText(
  input: HtmlInput,
  selectors: readonly string[],
  attr?: string,
): string | null {
  const $ = toCheerio(input);
  for (const selector of selectors) {
    try {
      const el = $(selector).first();
      if (el.length === 0) continue;
      const value = attr ? el.attr(attr) : el.text();
      const cleaned = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
      if (cleaned) return cleaned;
    } catch {
      // Unrecognized selector syntax is treated as no-match (fail closed).
      continue;
    }
  }
  return null;
}

/** Extract a list of trimmed values from all matches of `selector`. */
export function textList(input: HtmlInput, selector: string, attr?: string): string[] {
  const $ = toCheerio(input);
  const out: string[] = [];
  try {
    $(selector).each((_i, el) => {
      const value = attr ? $(el).attr(attr) : $(el).text();
      const cleaned = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
      if (cleaned) out.push(cleaned);
    });
  } catch {
    // Unrecognized selector syntax → empty list (fail closed).
  }
  return out;
}

/** True when ANY selector matches at least one element. */
export function anyMatches(input: HtmlInput, selectors: readonly string[]): boolean {
  const $ = toCheerio(input);
  for (const selector of selectors) {
    try {
      if ($(selector).length > 0) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** True when the document contains a recognized auth/登录 failure marker. */
export function isAuthFailurePage(input: HtmlInput, failureSelectors: readonly string[]): boolean {
  return anyMatches(input, failureSelectors);
}

/** True when the document contains a recognized success indicator. */
export function isAuthSuccessPage(input: HtmlInput, successSelectors: readonly string[]): boolean {
  return anyMatches(input, successSelectors);
}

/** True when the document contains a recognized no-result marker. */
export function isNoResultPage(input: HtmlInput, noResultSelectors: readonly string[]): boolean {
  return anyMatches(input, noResultSelectors);
}

/**
 * True when the document structurally looks like the provider's login page:
 * the login form's username/password field selectors or any login-failure
 * indicator is present. Used by the session runner to detect an expired /
 * rejected session that returned the login form instead of content — in
 * addition to any engine-emitted auth signal (M4b). Over-detection is
 * fail-closed safe (an auth signal blocks a lookup instead of risking a
 * wrong stocking verdict).
 */
export function isLoginPage(
  input: HtmlInput,
  loginConfig: { usernameSelectors: readonly string[]; passwordSelectors: readonly string[]; failureSelectors?: readonly string[] },
): boolean {
  const $ = toCheerio(input);
  const selectors = [
    ...loginConfig.usernameSelectors,
    ...loginConfig.passwordSelectors,
    ...(loginConfig.failureSelectors ?? []),
  ];
  for (const selector of selectors) {
    try {
      if ($(selector).length > 0) return true;
    } catch {
      continue;
    }
  }
  // Script-wrapped templates (e.g. SFCC `XC_SiteLogin` login forms) are raw
  // text to the parser, so the field markup is invisible to selector queries.
  // The SERIALIZED html still contains the exact `id="..."` markup; a raw
  // substring check catches it. Over-detection is fail-closed safe (an auth
  // signal blocks a lookup instead of risking a wrong stocking verdict).
  if (typeof input === 'string') {
    for (const selector of selectors) {
      const m = /^#([A-Za-z][\w:-]*)$/.exec(selector);
      if (m && input.includes(`id="${m[1]}"`)) return true;
    }
  }
  return false;
}

// ─── URL / identifier helpers ─────────────────────────────────────────────────

/** Exact normalized GTIN equality (reuses the shared normalizer rule). */
export function sameGtin(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = a?.replace(/\D/g, '') ?? '';
  const nb = b?.replace(/\D/g, '') ?? '';
  if (na.length < 8 || na.length > 14 || nb.length < 8 || nb.length > 14) return false;
  return na === nb;
}

/** True when `url` shares the origin of `origin` (both must parse). */
export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** True when `url` is HTTPS and its host is in `allowedHosts` (or null = any). */
export function isAllowedHttpsUrl(url: string, allowedHosts?: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false; // no userinfo
  if (!allowedHosts || allowedHosts.length === 0) return true;
  return allowedHosts.includes(parsed.hostname);
}

/** Resolve `href` against `baseUrl` (null when either is malformed). */
export function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

/** Deduplicate preserving first-seen order. */
export function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Byte length of a string (UTF-8), for response-cap checks. */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

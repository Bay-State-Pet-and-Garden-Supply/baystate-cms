/**
 * Canonical safe URL/hostname policy for the offline corpus pipeline.
 *
 * Centralizes URL validation so every crawler, importer, and dataset pipeline
 * applies the same rules:
 * - only http/https schemes
 * - no credentials (userinfo)
 * - no IP literals, private/reserved targets, or localhost
 * - no malformed or deceptive hostnames
 * - no unsupported ports
 * - deterministic canonicalization for identity hashing
 * - conservative cross-origin redirect policy
 */

import { isIP } from 'node:net';
import { sha256Hex } from '../shared/stable-id.js';

export type UrlValidationIssue =
  | 'unsupported_scheme'
  | 'missing_host'
  | 'malformed_host'
  | 'ip_target'
  | 'private_target'
  | 'reserved_target'
  | 'credentials'
  | 'unsupported_port'
  | 'deceptive_suffix'
  | 'excessive_length';

export interface UrlValidationResult {
  ok: boolean;
  canonicalUrl?: string;
  hostname?: string;
  registrableDomain?: string;
  issues: UrlValidationIssue[];
}

/** Common service ports that must never be crawled. */
const BLOCKED_PORTS = new Set([
  21, 22, 23, 25, 53, 110, 135, 139, 143, 445, 465, 587, 993, 995, 1433, 1521,
  2049, 3306, 3389, 5432, 5900, 6379, 8081, 8443, 9200, 27017,
]);

/** Ports that are explicitly permitted for http(s) traffic. */
const ALLOWED_PORTS = new Set([80, 443, 8080, 8888]);

/**
 * A small, conservative public-suffix list. `registrableDomain` is derived by
 * matching the longest known suffix; anything not covered falls back to the
 * final two labels. This is a heuristic for crawler safety, not a full PSL.
 */
const PUBLIC_SUFFIXES: string[] = [
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
  'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.mx', 'co.in', 'com.cn',
  'com', 'org', 'net', 'io', 'co', 'info', 'biz', 'edu', 'gov', 'mil', 'me',
];

/** Labels that are never acceptable in a crawlable hostname. */
const RESERVED_HOST_LABELS = new Set([
  'localhost', 'local', 'internal', 'invalid', 'test', 'example', 'home',
]);

function labelsOf(hostname: string): string[] {
  return hostname.toLowerCase().replace(/\.$/, '').split('.');
}

/** Returns the registrable domain (the suffix plus one label above it). */
export function registrableDomain(hostname: string): string {
  const labels = labelsOf(hostname);
  if (labels.length <= 1) return hostname.toLowerCase();

  const joined = labels.join('.');
  for (const suffix of PUBLIC_SUFFIXES) {
    if (joined.endsWith(`.${suffix}`) || joined === suffix) {
      const suffixLabels = suffix.split('.').length;
      if (labels.length > suffixLabels) {
        return labels.slice(labels.length - suffixLabels - 1).join('.');
      }
      return joined;
    }
  }
  return labels.slice(-2).join('.');
}

function isPrivateIpv4(octets: number[]): boolean {
  if (octets.length !== 4) return false;
  const [a, b] = octets;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 127 ||
    a === 0 ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower === '::1' ||
    lower.startsWith('::ffff:')
  );
}

function isMalformedHost(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return true;
  const labels = labelsOf(hostname);
  if (labels.length === 0) return true;
  if (labels.some((label) => label.length === 0 || label.length > 63)) return true;
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return true;
  return false;
}

/** Returns true when the hostname's registrable domain is not in the allowlist. */
function isDeceptiveHost(hostname: string, allowedRegistrableDomains?: ReadonlySet<string>): boolean {
  const domain = registrableDomain(hostname);
  if (allowedRegistrableDomains && allowedRegistrableDomains.size > 0) {
    // The registrable domain must be allowed, or the host must be a subdomain
    // of an allowed domain (handled by registrableDomain matching).
    return !allowedRegistrableDomains.has(domain);
  }
  // Without an allowlist, reject obvious look-alike patterns.
  if (/\.[a-z0-9-]+\.(com|org|net)\.[a-z]{2,}$/.test(hostname)) return true;
  if (/^(?:[a-z0-9-]+\.)?(?:[a-z0-9-]+)\.(com|org|net)\.(?:com|org|net|co|io)$/i.test(hostname)) return true;
  return false;
}

/**
 * Validates and canonically normalizes a URL for corpus ingestion.
 */
export function validateUrl(rawUrl: string, allowedRegistrableDomains?: ReadonlySet<string>): UrlValidationResult {
  const issues: UrlValidationIssue[] = [];

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, issues: ['malformed_host'] };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    issues.push('unsupported_scheme');
  }
  if (!url.hostname) {
    issues.push('missing_host');
    return { ok: false, issues };
  }

  const hostname = url.hostname.toLowerCase();
  const cleanHost = hostname.replace(/^\[|\]$/g, '');

  if (url.username || url.password) {
    issues.push('credentials');
  }

  const ipVersion = isIP(cleanHost);
  if (ipVersion === 4 || ipVersion === 6) {
    issues.push('ip_target');
    if (ipVersion === 4) {
      const octets = cleanHost.split('.').map(Number);
      if (isPrivateIpv4(octets)) issues.push('private_target');
    } else if (isPrivateIpv6(cleanHost)) {
      issues.push('private_target');
    }
    return { ok: false, issues };
  }

  if (RESERVED_HOST_LABELS.has(cleanHost)) {
    issues.push('reserved_target');
    return { ok: false, issues };
  }

  // Reject hosts whose registrable domain ends in a reserved pseudo-TLD.
  if (/(?:^|\.)(?:local|internal|invalid|test|localhost|home)$/.test(cleanHost)) {
    issues.push('reserved_target');
    return { ok: false, issues };
  }

  if (isMalformedHost(cleanHost)) {
    issues.push('malformed_host');
    return { ok: false, issues };
  }

  if (url.port) {
    const port = Number(url.port);
    if (BLOCKED_PORTS.has(port) || (!ALLOWED_PORTS.has(port) && port !== 80 && port !== 443)) {
      issues.push('unsupported_port');
    }
  }

  const domain = registrableDomain(cleanHost);
  if (isDeceptiveHost(cleanHost, allowedRegistrableDomains)) {
    issues.push('deceptive_suffix');
  }

  if (url.href.length > 2048) {
    issues.push('excessive_length');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // Canonicalize: lowercase scheme+host, strip default ports, strip hash.
  const canonical = `${url.protocol}//${hostname}${canonicalPort(url)}${url.pathname}${url.search}`;
  return { ok: true, canonicalUrl: canonical, hostname: cleanHost, registrableDomain: domain, issues: [] };
}

/**
 * Source-scoped SHA-256 entity identity for a canonical source URL.
 * Collision-resistant: two distinct source locators never collide.
 */
export function computeEntityId(sourceUrl: string): string {
  const canonical = validateUrl(sourceUrl).canonicalUrl || sourceUrl;
  return sha256Hex(`entity:${canonical}`);
}

function canonicalPort(url: URL): string {
  if (!url.port) return '';
  if (url.protocol === 'http:' && url.port === '80') return '';
  if (url.protocol === 'https:' && url.port === '443') return '';
  return `:${url.port}`;
}

export type RedirectDecision =
  | { allowed: true; canonicalUrl: string }
  | { allowed: false; reason: string };

/**
 * Conservative redirect policy:
 * - both endpoints must be valid per `validateUrl`
 * - https → http downgrades are rejected
 * - cross-registrable-domain redirects are rejected unless the target domain
 *   is explicitly allowed
 */
export function evaluateRedirect(
  fromUrl: string,
  toUrl: string,
  allowedRegistrableDomains?: ReadonlySet<string>,
): RedirectDecision {
  const from = validateUrl(fromUrl, allowedRegistrableDomains);
  const to = validateUrl(toUrl, allowedRegistrableDomains);
  if (!from.ok) return { allowed: false, reason: `Invalid source URL: ${from.issues.join(',')}` };
  if (!to.ok) return { allowed: false, reason: `Invalid redirect target: ${to.issues.join(',')}` };
  if (from.canonicalUrl!.startsWith('https://') && to.canonicalUrl!.startsWith('http://')) {
    return { allowed: false, reason: 'Redirect downgrades https to http' };
  }
  const fromDomain = from.registrableDomain!;
  const toDomain = to.registrableDomain!;
  if (fromDomain !== toDomain && !(allowedRegistrableDomains && allowedRegistrableDomains.has(toDomain))) {
    return { allowed: false, reason: `Cross-domain redirect ${fromDomain} → ${toDomain} not allowed` };
  }
  return { allowed: true, canonicalUrl: to.canonicalUrl! };
}

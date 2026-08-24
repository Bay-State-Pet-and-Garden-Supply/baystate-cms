/**
 * Shared IP classification (SSRF floor).
 *
 * Pure classifier moved verbatim from src/product-intelligence/policy/policy-gateway.ts
 * during the Agent Lab decommission (ADR-0030, Phase 1 PR 1.1). Consumers:
 * policy-gateway (until its Phase 3 deletion), store-manager image repair,
 * extraction-worker network guards.
 */

const PRIVATE_IPV4 = [
  { ip: '10.0.0.0', bits: 8 },
  { ip: '172.16.0.0', bits: 12 },
  { ip: '192.168.0.0', bits: 16 },
  { ip: '127.0.0.0', bits: 8 },
  { ip: '169.254.0.0', bits: 16 }, // link-local
  { ip: '0.0.0.0', bits: 8 },
  { ip: '100.64.0.0', bits: 10 }, // CGNAT
] as const;

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv4InRange(ip: string, range: { ip: string; bits: number }): boolean {
  const value = ipv4ToNumber(ip);
  const base = ipv4ToNumber(range.ip);
  if (value === null || base === null) return false;
  const mask = range.bits === 0 ? 0 : (~0 << (32 - range.bits)) >>> 0;
  return (value & mask) === (base & mask);
}

/** Classify a numeric IPv4/IPv6 address as private/link-local or public. */
export function classifyIp(address: string): 'private' | 'link_local' | 'public' | 'unknown' {
  if (address.includes(':')) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::' || lower.startsWith('0:0:0:0:0:0:0:1')) return 'link_local';
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return 'private';
    if (lower.startsWith('::ffff:')) return classifyIp(lower.slice(7));
    return 'public';
  }
  for (const range of PRIVATE_IPV4) {
    if (ipv4InRange(address, range)) {
      return range.ip.startsWith('169.254') || range.ip === '0.0.0.0' ? 'link_local' : 'private';
    }
  }
  return ipv4ToNumber(address) !== null ? 'public' : 'unknown';
}

export function isPrivateOrLinkLocal(address: string): boolean {
  const kind = classifyIp(address);
  return kind === 'private' || kind === 'link_local';
}

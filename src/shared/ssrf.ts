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

function parseIpv4Part(part: string): number | null {
  if (!part) return null;
  let val: number;
  if (/^0x[0-9a-fA-F]+$/i.test(part)) {
    val = parseInt(part, 16);
  } else if (/^0[0-7]+$/.test(part)) {
    val = parseInt(part, 8);
  } else if (/^(0|[1-9][0-9]*)$/.test(part)) {
    val = parseInt(part, 10);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(val) || val < 0) return null;
  return val;
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = parts.map(parseIpv4Part);
  if (nums.some((n) => n === null)) return null;

  const validNums = nums as number[];

  if (parts.length === 1) {
    return validNums[0] <= 0xffffffff ? validNums[0] >>> 0 : null;
  }
  if (parts.length === 2) {
    if (validNums[0] > 255 || validNums[1] > 0xffffff) return null;
    return ((validNums[0] << 24) | validNums[1]) >>> 0;
  }
  if (parts.length === 3) {
    if (validNums[0] > 255 || validNums[1] > 255 || validNums[2] > 0xffff) return null;
    return ((validNums[0] << 24) | (validNums[1] << 16) | validNums[2]) >>> 0;
  }
  if (validNums.some((n) => n > 255)) return null;
  return ((validNums[0] << 24) | (validNums[1] << 16) | (validNums[2] << 8) | validNums[3]) >>> 0;
}

function ipv4InRange(ip: string, range: { ip: string; bits: number }): boolean {
  const value = ipv4ToNumber(ip);
  const base = ipv4ToNumber(range.ip);
  if (value === null || base === null) return false;
  const mask = range.bits === 0 ? 0 : (~0 << (32 - range.bits)) >>> 0;
  return ((value & mask) >>> 0) === ((base & mask) >>> 0);
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

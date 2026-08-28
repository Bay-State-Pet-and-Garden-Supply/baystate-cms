import crypto from 'node:crypto';

/**
 * Performs a timing-safe comparison of two secret strings (e.g., API tokens).
 *
 * Direct string comparison (`a === b`) short-circuits on the first non-matching byte,
 * which exposes a side-channel timing vulnerability allowing attackers to measure byte-by-byte
 * response timing differences to guess secrets.
 *
 * Hashing both inputs with SHA-256 ensures equal fixed 32-byte lengths for `crypto.timingSafeEqual`
 * and guarantees constant-time comparison regardless of string length or prefix matches.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

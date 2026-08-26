import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string comparison to prevent timing attacks / side-channel leaks
 * when comparing sensitive strings like API tokens and secrets.
 *
 * Hashes inputs with SHA-256 to produce fixed 32-byte buffers before running
 * `crypto.timingSafeEqual`, ensuring constant-time execution regardless of
 * input lengths or string content differences.
 */
export function safeTimingEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

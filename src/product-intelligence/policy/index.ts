/**
 * Product Intelligence policy enforcement (PI-5).
 *
 * The policy gateway is the single enforcement point for model, network, and
 * budget decisions; immutable snapshot verification guarantees runs execute
 * under exactly the captured policy.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/22
 */
export * from './policy-gateway';
import { sha256Hex } from '../../shared/stable-id';
import type { ProductIntelligencePolicy } from '../contracts';

/**
 * Verify a policy snapshot is self-consistent: configId must equal the
 * SHA-256 of the policy's canonical JSON. A tampered or stale policy is
 * rejected before any run starts.
 */
export function verifyPolicySnapshot(policy: ProductIntelligencePolicy): { valid: boolean; reason?: string } {
  const { configId, ...rest } = policy;
  // Rebuild with configId first to match the canonical hashing order used by
  // buildDefaultPiPolicy (configId is the schema's first property).
  const recomputed = sha256Hex(JSON.stringify({ configId: 'pending', ...rest }));
  if (recomputed !== configId) {
    return { valid: false, reason: `policy configId ${configId} does not match its content (${recomputed.slice(0, 12)}…)` };
  }
  return { valid: true };
}

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
import type {
  DataSharingPolicy,
  NetworkPolicy,
  ProductIntelligencePolicy,
} from '../contracts';

/**
 * Compute the canonical configId for a policy and return it with that
 * configId attached. Mirrors buildDefaultPiPolicy's hashing convention
 * (configId first, value 'pending', then the rest) so verifyPolicySnapshot
 * accepts the result.
 */
export function computePolicyConfigId(policy: ProductIntelligencePolicy): ProductIntelligencePolicy {
  const withPending = { ...policy, configId: 'pending' };
  const configId = sha256Hex(JSON.stringify(withPending));
  return { ...withPending, configId };
}

/**
 * Restrictiveness order for dataSharingPolicy: higher = more restrictive.
 * Overrides may only move toward a MORE restrictive policy.
 */
const DATA_SHARING_RESTRICTIVENESS: Record<DataSharingPolicy, number> = {
  cloud_models_and_sources: 0,
  cloud_models_only: 1,
  local_only: 2,
};

/**
 * P0-2: deterministic reduction lattice over a caller-supplied override set
 * applied to an approved (server-authoritative) base policy.
 *
 * Allowed: tool/domain allowlists may only shrink; numeric limits may only
 * decrease; dataSharingPolicy may only become more restrictive.
 * Forbidden: any networkPolicy change, any modelRoute override, and any
 * change to configId (the server computes it). Throws Error with a precise
 * message on the first violation; returns the merged policy otherwise.
 */
export function assertReducingOverride(
  base: ProductIntelligencePolicy,
  overrides: Partial<ProductIntelligencePolicy>,
): ProductIntelligencePolicy {
  if ('configId' in overrides && overrides.configId !== base.configId) {
    throw new Error('configId is not caller-overridable; the server computes it from the approved policy');
  }
  if ('modelRoute' in overrides) {
    throw new Error('modelRoute is not caller-overridable; the model route is server-authoritative');
  }
  if ('networkPolicy' in overrides && overrides.networkPolicy !== base.networkPolicy) {
    throw new Error(
      `networkPolicy override rejected: '${String(overrides.networkPolicy)}' differs from the approved '${base.networkPolicy}'; network mode is server-authoritative`,
    );
  }

  const allowlistKeys = ['allowedTools', 'researchTools', 'allowedSourceDomains'] as const;
  for (const key of allowlistKeys) {
    const over = overrides[key];
    if (over === undefined) continue;
    const baseSet = new Set(base[key]);
    const extra = over.filter((entry) => !baseSet.has(entry));
    if (extra.length > 0) {
      throw new Error(
        `${key} override rejected: [${extra.join(', ')}] not present in the approved policy (allowlists may only shrink)`,
      );
    }
  }

  const numericKeys = ['maxResponseBytes', 'maxToolCalls', 'deadlineMs'] as const;
  for (const key of numericKeys) {
    const over = overrides[key];
    if (over === undefined) continue;
    if (over > base[key]) {
      throw new Error(`${key} override rejected: ${over} exceeds the approved limit ${base[key]} (limits may only decrease)`);
    }
  }

  if ('maxCostUsd' in overrides) {
    const over = overrides.maxCostUsd;
    if (over !== undefined && over !== null) {
      const approved = base.maxCostUsd;
      if (approved === null || approved === undefined || over > approved) {
        throw new Error(
          `maxCostUsd override rejected: ${over} exceeds the approved budget ${approved ?? 'unlimited'}`,
        );
      }
    }
  }

  if (
    'dataSharingPolicy' in overrides &&
    overrides.dataSharingPolicy !== undefined &&
    overrides.dataSharingPolicy !== base.dataSharingPolicy
  ) {
    const baseRank = DATA_SHARING_RESTRICTIVENESS[base.dataSharingPolicy];
    const overRank = DATA_SHARING_RESTRICTIVENESS[overrides.dataSharingPolicy];
    if (overRank < baseRank) {
      throw new Error(
        `dataSharingPolicy override rejected: '${overrides.dataSharingPolicy}' is less restrictive than the approved '${base.dataSharingPolicy}'`,
      );
    }
  }

  return { ...base, ...overrides };
}

/** Type re-exports kept for callers that import through policy/index. */
export type { DataSharingPolicy, NetworkPolicy };

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

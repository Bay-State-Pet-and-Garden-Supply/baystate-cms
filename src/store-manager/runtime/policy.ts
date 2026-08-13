/**
 * Store Manager per-turn runtime policy (epic #42, #40).
 *
 * The policy is immutable for the lifetime of a turn. Defaults are
 * server-owned constants; a request or model message can never raise a budget,
 * extend a deadline, expand an allowlist/phase, or change the approval policy.
 * `policyHash` fingerprints the effective immutable fields so a tampered or
 * stale policy can be detected in events/audit rows.
 */

import { hashCanonicalJson } from '../../shared/stable-id';

export interface StoreManagerPolicyInput {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  /**
   * Server-owned per-turn narrowing of the immutable defaults. Only the
   * executor/route may pass these (test seams and operator configuration);
   * a request or model message can never widen them.
   */
  overrides?: Partial<Pick<StoreManagerRuntimePolicy, 'deadlineMs' | 'maxToolCalls' | 'maxOutputBytes' | 'maxModelCostUsd' | 'perCallTimeoutMs'>>;
}

export interface StoreManagerRuntimePolicy {
  version: 1;
  policyHash: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  /** Tool names (and implicit versions) allowed this turn — the adapter registry surface. */
  allowedToolNames: readonly string[];
  /** Phases the model may move through this turn. */
  allowedPhases: readonly ('investigate' | 'approve' | 'verify')[];
  /** Maximum tool dispatches per turn. */
  maxToolCalls: number;
  /** Maximum serialized bytes for a single tool output. */
  maxOutputBytes: number;
  /** Maximum model cost (USD) for the whole turn; recorded post-hoc when exceeded. */
  maxModelCostUsd: number;
  /** Whole-turn deadline (ms from turn start). */
  deadlineMs: number;
  /** Per-call timeout (ms) composed with the caller signal. */
  perCallTimeoutMs: number;
  /** Read-only tools run autonomously; persistent classes require signed operator approval. */
  approvalPolicy: 'required_for_persistent';
}

// Server-owned defaults. These are the floor and the ceiling — the executor
// only narrows them (never widens) when constructing a turn.
export const STORE_MANAGER_POLICY_DEFAULTS = {
  maxToolCalls: 10,
  maxOutputBytes: 128 * 1024,
  maxModelCostUsd: 10,
  deadlineMs: 10 * 60 * 1000,
  perCallTimeoutMs: 60 * 1000,
} as const;

function effectivePolicy(input: StoreManagerPolicyInput, allowedToolNames: readonly string[]) {
  const o = input.overrides ?? {};
  return {
    version: 1 as const,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    allowedToolNames,
    allowedPhases: ['investigate', 'approve', 'verify'] as const,
    maxToolCalls: o.maxToolCalls ?? STORE_MANAGER_POLICY_DEFAULTS.maxToolCalls,
    maxOutputBytes: o.maxOutputBytes ?? STORE_MANAGER_POLICY_DEFAULTS.maxOutputBytes,
    maxModelCostUsd: o.maxModelCostUsd ?? STORE_MANAGER_POLICY_DEFAULTS.maxModelCostUsd,
    deadlineMs: o.deadlineMs ?? STORE_MANAGER_POLICY_DEFAULTS.deadlineMs,
    perCallTimeoutMs: o.perCallTimeoutMs ?? STORE_MANAGER_POLICY_DEFAULTS.perCallTimeoutMs,
    approvalPolicy: 'required_for_persistent' as const,
  };
}

/**
 * Build the immutable policy for one turn. `allowedToolNames` comes from the
 * adapter registry (server-owned), never from the request.
 */
export function createStoreManagerPolicy(
  input: StoreManagerPolicyInput,
  allowedToolNames: readonly string[],
): StoreManagerRuntimePolicy {
  const base = effectivePolicy(input, allowedToolNames);
  return {
    ...base,
    policyHash: hashCanonicalJson(base),
  };
}

/**
 * Convenience: recompute the fingerprint hash for a serialized policy without
 * constructing one (used by session repo to verify a stored policy hash).
 */
export function computePolicyHash(policy: Omit<StoreManagerRuntimePolicy, 'policyHash'>): string {
  return hashCanonicalJson(policy);
}

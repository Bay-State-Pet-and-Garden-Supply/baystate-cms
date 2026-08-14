/**
 * Store Manager per-run runtime policy (epic #42, #40; operations console v2).
 *
 * The policy is immutable for the lifetime of a run. Defaults are
 * server-owned constants; a request or model message can never raise a budget,
 * extend a deadline, expand an allowlist/phase, or change the approval policy.
 * `policyHash` fingerprints the effective immutable fields so a tampered or
 * stale policy can be detected in events/audit rows.
 *
 * v2 adds the operations-console surface: entrypoint, execution mode
 * (interactive | unattended_read_only | preview), actor class, name+version
 * tool allowlists, pinned scope, prompt version, and preferences hash.
 * Unattended/preview modes carry `approvalPolicy = 'deny_persistent'`: the
 * registry refuses every persistent-risk adapter before approval or side
 * effects, even when model messages carry forged approval parts.
 */

import { hashCanonicalJson } from '../../shared/stable-id';
import type {
  StoreManagerEntrypoint,
  StoreManagerExecutionMode,
  StoreManagerActorClass,
  StoreManagerPinnedScope,
} from '../../shared/schemas/store-manager-operations';

export interface StoreManagerPolicyInput {
  workspaceId: string;
  sessionId: string;
  turnId: string;
  entrypoint?: StoreManagerEntrypoint;
  executionMode?: StoreManagerExecutionMode;
  actorClass?: StoreManagerActorClass;
  pinnedScope?: StoreManagerPinnedScope;
  promptVersion?: string;
  preferencesHash?: string | null;
  /**
   * Server-owned per-run narrowing of the immutable defaults. Only the
   * executor/route may pass these (test seams and operator configuration);
   * a request or model message can never widen them.
   */
  overrides?: Partial<Pick<StoreManagerRuntimePolicy, 'deadlineMs' | 'maxToolCalls' | 'maxOutputBytes' | 'maxModelCostUsd' | 'perCallTimeoutMs'>>;
}

export interface StoreManagerToolNameVersion {
  name: string;
  version: number;
}

export interface StoreManagerRuntimePolicy {
  version: 2;
  policyHash: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  /** Entrypoint that produced this run (one authority, many entrypoints). */
  entrypoint: StoreManagerEntrypoint;
  /** Execution mode enforced at registry dispatch. */
  executionMode: StoreManagerExecutionMode;
  /** Actor class that initiated the run (never human for unattended modes). */
  actorClass: StoreManagerActorClass;
  /** Tool name+version pairs allowed this run — the adapter registry surface. */
  allowedToolNames: readonly string[];
  allowedToolNameVersions: readonly StoreManagerToolNameVersion[];
  /** Phases the model may move through this run. */
  allowedPhases: readonly ('investigate' | 'approve' | 'verify')[];
  /** Maximum tool dispatches per run. */
  maxToolCalls: number;
  /** Maximum serialized bytes for a single tool output. */
  maxOutputBytes: number;
  /** Maximum model cost (USD) for the whole run; recorded post-hoc when exceeded. */
  maxModelCostUsd: number;
  /** Whole-run deadline (ms from run start). */
  deadlineMs: number;
  /** Per-call timeout (ms) composed with the caller signal. */
  perCallTimeoutMs: number;
  /**
   * `required_for_persistent`: read tools run autonomously, persistent classes
   * require signed operator approval. `deny_persistent`: unattended/preview —
   * persistent classes are refused at registry dispatch before side effects.
   */
  approvalPolicy: 'required_for_persistent' | 'deny_persistent';
  /** Derived: true when `approvalPolicy === 'deny_persistent'`. */
  denyPersistent: boolean;
  /** Pinned scope (bounded identifiers only); null when unpinned. */
  pinnedScope: StoreManagerPinnedScope | null;
  /** Versioned system-prompt identifier captured for this run. */
  promptVersion: string | null;
  /** Active workspace-preference revision hash, if preferences are in effect. */
  preferencesHash: string | null;
}

// Server-owned defaults. These are the floor and the ceiling — the executor
// only narrows them (never widens) when constructing a run.
export const STORE_MANAGER_POLICY_DEFAULTS = {
  maxToolCalls: 10,
  maxOutputBytes: 128 * 1024,
  maxModelCostUsd: 10,
  deadlineMs: 10 * 60 * 1000,
  perCallTimeoutMs: 60 * 1000,
} as const;

function effectivePolicy(
  input: StoreManagerPolicyInput,
  allowedToolNameVersions: readonly StoreManagerToolNameVersion[],
) {
  const o = input.overrides ?? {};
  const executionMode: StoreManagerExecutionMode = input.executionMode ?? 'interactive';
  const entrypoint: StoreManagerEntrypoint = input.entrypoint ?? 'chat';
  const actorClass: StoreManagerActorClass = input.actorClass ?? 'operator';
  const denyPersistent = executionMode !== 'interactive';
  return {
    version: 2 as const,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    entrypoint,
    executionMode,
    actorClass,
    allowedToolNames: allowedToolNameVersions.map((p) => p.name),
    allowedToolNameVersions,
    allowedPhases: ['investigate', 'approve', 'verify'] as const,
    maxToolCalls: o.maxToolCalls ?? STORE_MANAGER_POLICY_DEFAULTS.maxToolCalls,
    maxOutputBytes: o.maxOutputBytes ?? STORE_MANAGER_POLICY_DEFAULTS.maxOutputBytes,
    maxModelCostUsd: o.maxModelCostUsd ?? STORE_MANAGER_POLICY_DEFAULTS.maxModelCostUsd,
    deadlineMs: o.deadlineMs ?? STORE_MANAGER_POLICY_DEFAULTS.deadlineMs,
    perCallTimeoutMs: o.perCallTimeoutMs ?? STORE_MANAGER_POLICY_DEFAULTS.perCallTimeoutMs,
    approvalPolicy: denyPersistent ? ('deny_persistent' as const) : ('required_for_persistent' as const),
    denyPersistent,
    pinnedScope: input.pinnedScope ?? null,
    promptVersion: input.promptVersion ?? null,
    preferencesHash: input.preferencesHash ?? null,
  };
}

/**
 * Server-owned allowlist derivation for unattended/preview modes (Issue 4):
 * only `riskClass = 'read'` adapters are allowed. Interactive runs get the
 * full registry surface (persistent tools still require signed approval).
 */
export function deriveRunToolAllowlist(
  adapters: ReadonlyArray<{ name: string; version: number; riskClass: string }>,
  executionMode: StoreManagerExecutionMode,
): readonly StoreManagerToolNameVersion[] {
  if (executionMode === 'interactive') {
    return adapters.map((a) => ({ name: a.name, version: a.version }));
  }
  return adapters
    .filter((a) => a.riskClass === 'read')
    .map((a) => ({ name: a.name, version: a.version }));
}

/**
 * Build the immutable policy for one run. `allowedToolNameVersions` comes from
 * the adapter registry (server-owned), never from the request.
 */
export function createStoreManagerPolicy(
  input: StoreManagerPolicyInput,
  allowedToolNameVersions: readonly StoreManagerToolNameVersion[],
): StoreManagerRuntimePolicy {
  const base = effectivePolicy(input, allowedToolNameVersions);
  return {
    ...base,
    policyHash: hashCanonicalJson(base),
  };
}

/**
 * Convenience: recompute the fingerprint hash for a serialized policy without
 * constructing one (used by the session repository to verify a stored policy
 * snapshot).
 */
export function computePolicyHash(policy: Omit<StoreManagerRuntimePolicy, 'policyHash'>): string {
  return hashCanonicalJson(policy);
}

/**
 * Serialize the effective immutable policy for durable snapshot storage
 * (policyHash excluded; recomputed on read). The snapshot contains no secrets.
 */
export function policyToSnapshotJson(policy: StoreManagerRuntimePolicy): string {
  const { policyHash: _policyHash, ...rest } = policy;
  return JSON.stringify(rest);
}

/**
 * Verify a stored policy snapshot against its recorded hash. Returns false for
 * malformed JSON, a missing hash field, or a hash mismatch so inspection /
 * replay can fail closed with `policy_snapshot_invalid`.
 */
export function verifyPolicySnapshot(snapshotJson: string, expectedHash: string): boolean {
  try {
    const parsed = JSON.parse(snapshotJson) as Omit<StoreManagerRuntimePolicy, 'policyHash'>;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 2) return false;
    return computePolicyHash(parsed) === expectedHash;
  } catch {
    return false;
  }
}

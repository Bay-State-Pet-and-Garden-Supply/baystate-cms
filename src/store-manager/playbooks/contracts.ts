/**
 * Store Manager playbook contracts (operations console, Issue 6).
 *
 * The validator is registry-aware: it resolves every tool reference against
 * the CURRENT StoreManagerToolRegistry metadata (name, version, risk class,
 * approval requirement, supported scope kinds) and rejects any definition
 * whose stored claims disagree with the registry (version drift, forged risk
 * downgrade, unregistered tools). To stay pure and testable, the validator
 * receives a minimal resolver interface instead of importing the runtime
 * registry directly.
 */

import type { StoreManagerScopeKind } from '../../shared/schemas/store-manager-operations';
import type { StoreManagerPlaybookRiskClass } from '../../shared/schemas/store-manager-playbook';

/** Minimal adapter metadata the validator needs (a slice of the runtime adapter). */
export interface StoreManagerPlaybookToolMetadata {
  name: string;
  version: number;
  riskClass: StoreManagerPlaybookRiskClass;
  requiresApproval: boolean;
  /** Undefined = the adapter does not declare scope support (legacy behavior). */
  supportedScopes?: readonly StoreManagerScopeKind[];
}

/**
 * Resolve the current registered metadata for one tool; undefined = unregistered.
 * `requestedVersion` lets a multi-version registry surface distinguish exact
 * tool versions; single-version registries ignore it (and version drift then
 * fails closed in the validator).
 */
export type StoreManagerPlaybookToolResolver = (
  toolName: string,
  requestedVersion?: number,
) => StoreManagerPlaybookToolMetadata | undefined;

/** Validation failure vocabulary (fail closed, machine-readable codes). */
export type StoreManagerPlaybookValidationCode =
  | 'unknown_tool'
  | 'tool_version_drift'
  | 'step_cycle'
  | 'forward_dependency'
  | 'unknown_dependency'
  | 'unknown_variable'
  | 'duplicate_step_id'
  | 'unbounded_fan_out'
  | 'missing_approval_before_mutation'
  | 'approval_without_diff'
  | 'missing_verification'
  | 'missing_proposal_risk_declaration'
  | 'risk_downgrade_forgery'
  | 'scope_mismatch'
  | 'read_step_requires_read_tool'
  | 'execute_requires_persistent_tool'
  | 'verify_requires_read_tools'
  | 'mixed_tool_versions'
  | 'invalid_definition';

export class StoreManagerPlaybookValidationError extends Error {
  readonly code: StoreManagerPlaybookValidationCode;
  readonly stepId: string | null;
  constructor(code: StoreManagerPlaybookValidationCode, message: string, stepId: string | null = null) {
    super(message);
    this.name = 'StoreManagerPlaybookValidationError';
    this.code = code;
    this.stepId = stepId;
  }
}

/** Static risk shape derived from registered adapter metadata. */
export interface StoreManagerPlaybookStaticRisk {
  riskClasses: readonly StoreManagerPlaybookRiskClass[];
  /** Persistent tool dispatches that require an approval checkpoint. */
  expectedApprovals: readonly { toolName: string; toolVersion: number }[];
  /** True when any step is `network_filesystem_repair`. */
  networkActivity: 'none' | 'bounded';
  /** Diff kinds this playbook is expected to produce (diff before, verification_diff after). */
  expectedDiffKinds: readonly ('diff' | 'verification_diff')[];
  hasMutationStep: boolean;
  hasVerifyStep: boolean;
  /** Tool references that appear with inconsistent versions across steps. */
  mixedToolVersions: readonly string[];
}

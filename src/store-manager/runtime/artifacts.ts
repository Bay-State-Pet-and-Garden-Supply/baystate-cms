/**
 * Store Manager run artifacts + preview compilation (operations console,
 * Issue 1).
 *
 * Artifacts are immutable, content-addressed, bounded, and redacted by
 * construction. Preview compilation resolves registered contracts, scope,
 * risks, expected approvals, likely output kinds, and budgets WITHOUT any
 * model invocation or tool dispatch — it is a contract preview only and never
 * reads live data.
 */

import { randomUUID } from 'node:crypto';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  STORE_MANAGER_OPERATIONS_BOUNDS,
  type StoreManagerArtifact,
  type StoreManagerArtifactKind,
  type StoreManagerExecutionRequest,
  type StoreManagerPreviewDescriptor,
} from '../../shared/schemas/store-manager-operations';
import type { StoreManagerRuntimePolicy } from './policy';
import type { StoreManagerToolRegistry } from './tool-registry';

export interface CreateStoreManagerArtifactInput {
  runId: string;
  workspaceId: string;
  kind: StoreManagerArtifactKind;
  schemaVersion: number;
  content: unknown;
  id?: string;
  createdAt?: string;
}

/**
 * Build a bounded, content-addressed artifact. Throws when the serialized
 * content exceeds the artifact byte bound (fail closed rather than truncating
 * an authoritative record).
 */
export function createStoreManagerArtifact(input: CreateStoreManagerArtifactInput): StoreManagerArtifact {
  const serialized = JSON.stringify(input.content);
  if (serialized === undefined || serialized.length > STORE_MANAGER_OPERATIONS_BOUNDS.maxArtifactContentBytes) {
    throw new Error(
      `Artifact content exceeds the ${STORE_MANAGER_OPERATIONS_BOUNDS.maxArtifactContentBytes}-byte bound; refusing to persist.`,
    );
  }
  return {
    id: input.id ?? randomUUID(),
    runId: input.runId,
    workspaceId: input.workspaceId,
    kind: input.kind,
    schemaVersion: input.schemaVersion,
    contentHash: hashCanonicalJson(input.content),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function hashScope(scope: StoreManagerExecutionRequest['pinnedScope'] | null | undefined): string | null {
  if (!scope) return null;
  return hashCanonicalJson(scope);
}

/**
 * Compile the zero-execution preview descriptor for a request.
 *
 * - expectedTools: policy-derived registry surface (name/version/risk/approval
 *   metadata + whether the pinned scope is honored);
 * - expectedApprovals: persistent tools that WOULD require operator approval
 *   in interactive mode;
 * - persistentToolsDenied: true in unattended/preview modes (registry enforces);
 * - networkActivity: 'bounded' only when a network/filesystem-repair adapter
 *   is in the allowlist AND interactive; otherwise 'none' (contract-derived);
 * - modelCalls/toolDispatches are literally 0 — nothing executes here.
 */
export function compileExecutionPreview(
  request: StoreManagerExecutionRequest,
  registry: StoreManagerToolRegistry,
  policy: StoreManagerRuntimePolicy,
): StoreManagerPreviewDescriptor {
  const adapters = registry.all().filter((adapter) =>
    policy.allowedToolNameVersions.some((p) => p.name === adapter.name && p.version === adapter.version),
  );
  const expectedTools = adapters.map((adapter) => {
    const scopeSupported =
      !policy.pinnedScope || !adapter.supportedScopes || adapter.supportedScopes.length === 0
        ? true
        : adapter.supportedScopes.includes(policy.pinnedScope.kind);
    return {
      name: adapter.name,
      version: adapter.version,
      riskClass: adapter.riskClass,
      requiresApproval: adapter.requiresApproval,
      allowedPhases: [...adapter.allowedPhases],
      scopeSupported,
    };
  });
  const expectedApprovals = adapters
    .filter((adapter) => adapter.requiresApproval && policy.approvalPolicy === 'required_for_persistent')
    .map((adapter) => ({ toolName: adapter.name, toolVersion: adapter.version }));
  const hasRepairAdapter = adapters.some((adapter) => adapter.riskClass === 'network_filesystem_repair');

  return {
    entrypoint: request.entrypoint,
    executionMode: request.executionMode,
    actorClass: policy.actorClass,
    runId: request.runId,
    objectiveHash: hashCanonicalJson(request.objective),
    scopeHash: hashScope(request.pinnedScope),
    expectedTools,
    expectedApprovals,
    persistentToolsDenied: policy.denyPersistent,
    budgets: {
      maxToolCalls: policy.maxToolCalls,
      deadlineMs: policy.deadlineMs,
      maxModelCostUsd: policy.maxModelCostUsd,
      perCallTimeoutMs: policy.perCallTimeoutMs,
    },
    networkActivity: !policy.denyPersistent && hasRepairAdapter ? 'bounded' : 'none',
    modelCalls: 0,
    toolDispatches: 0,
  };
}

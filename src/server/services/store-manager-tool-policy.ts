/**
 * Store Manager tool policy registry (epic #42, #34).
 *
 * Every agent-callable tool has exactly one immutable metadata entry: risk
 * class, side effects, approval requirement, scope summary, and the exact
 * state transition the tool performs. This registry is the single source of
 * truth for `streamText.toolApproval` configuration and for the runtime
 * wrapper that re-checks risk/approval immediately before execution.
 *
 * This module is intentionally import-free so it stays pure and testable on
 * both the server and client sides.
 */

export type ToolRiskClass =
  | 'read'
  | 'proposal_write'
  | 'catalog_mutation'
  | 'network_filesystem_repair';

export interface StoreManagerToolPolicy {
  /** Stable tool name (must equal the key in `createStoreManagerTools`). */
  name: string;
  /** Bump on any breaking contract change. */
  version: number;
  riskClass: ToolRiskClass;
  /** Human-readable side-effect description for approval cards and audits. */
  sideEffects: string;
  /** Whether execution requires explicit operator approval. */
  requiresApproval: boolean;
  /** Exact state transition this tool performs ('none' for read tools). */
  stateTransition: string;
  /** Normalized one-line scope summary for the approval card. */
  scopeSummary: (input: Record<string, unknown>) => string;
}

export const STORE_MANAGER_TOOL_POLICIES: Record<string, StoreManagerToolPolicy> = {
  // ------------------------------------------------------------------ read --
  getDashboardStats: {
    name: 'getDashboardStats',
    version: 1,
    riskClass: 'read',
    sideEffects: 'none',
    requiresApproval: false,
    stateTransition: 'none',
    scopeSummary: () => 'dashboard metrics',
  },
  getCatalogHealthReport: {
    name: 'getCatalogHealthReport',
    version: 1,
    riskClass: 'read',
    sideEffects: 'none',
    requiresApproval: false,
    stateTransition: 'none',
    scopeSummary: () => 'catalog health summary',
  },
  listCatalogHealthIssues: {
    name: 'listCatalogHealthIssues',
    version: 1,
    riskClass: 'read',
    sideEffects: 'none',
    requiresApproval: false,
    stateTransition: 'none',
    scopeSummary: (input) =>
      `catalog health issues${typeof input.search === 'string' && input.search ? ` matching "${input.search}"` : ''}`,
  },
  searchProducts: {
    name: 'searchProducts',
    version: 1,
    riskClass: 'read',
    sideEffects: 'none',
    requiresApproval: false,
    stateTransition: 'none',
    scopeSummary: (input) =>
      `product search${typeof input.search === 'string' && input.search ? ` for "${input.search}"` : ''}`,
  },
  getProductFieldAudit: {
    name: 'getProductFieldAudit',
    version: 1,
    riskClass: 'read',
    sideEffects: 'none',
    requiresApproval: false,
    stateTransition: 'none',
    scopeSummary: (input) => `ProductField ${String(input.field ?? '?')} audit`,
  },
  proposeProductFieldNormalization: {
    name: 'proposeProductFieldNormalization',
    version: 1,
    riskClass: 'read',
    sideEffects: 'none (transient in-memory preview; nothing is persisted)',
    requiresApproval: false,
    stateTransition: 'none (in-memory recommendation only)',
    scopeSummary: (input) =>
      `transient ${String(input.strategy ?? 'safe_duplicates')} normalization preview for ${String(input.field ?? '?')}`,
  },
  listStoredProposals: {
    name: 'listStoredProposals',
    version: 1,
    riskClass: 'read',
    sideEffects: 'none',
    requiresApproval: false,
    stateTransition: 'none',
    scopeSummary: (input) =>
      `stored proposals${typeof input.field === 'string' && input.field ? ` for ${input.field}` : ''}`,
  },
  explainNextActions: {
    name: 'explainNextActions',
    version: 1,
    riskClass: 'read',
    sideEffects: 'none',
    requiresApproval: false,
    stateTransition: 'none',
    scopeSummary: () => 'recommended next actions',
  },
  // ---------------------------------------------------------- proposal_write --
  generateNormalizationProposals: {
    name: 'generateNormalizationProposals',
    version: 1,
    riskClass: 'proposal_write',
    sideEffects:
      'creates stored normalization proposals (DB rows, status "proposed") for the requested field',
    requiresApproval: true,
    stateTransition: 'stored proposal created (status: proposed); catalog unchanged',
    scopeSummary: (input) => `store normalization proposals for ${String(input.field ?? '?')}`,
  },
  dismissNormalizationProposal: {
    name: 'dismissNormalizationProposal',
    version: 1,
    riskClass: 'proposal_write',
    sideEffects: 'marks a stored proposal dismissed (DB status change)',
    requiresApproval: true,
    stateTransition: 'stored proposal -> dismissed; catalog unchanged',
    scopeSummary: (input) => `dismiss stored proposal ${String(input.proposalId ?? '?')}`,
  },
  // ---------------------------------------------------------- catalog_mutation --
  applyNormalizationProposal: {
    name: 'applyNormalizationProposal',
    version: 1,
    riskClass: 'catalog_mutation',
    sideEffects:
      'stages proposal value updates for affected products into the active Change Set (draft only; no catalog/workspace write)',
    requiresApproval: true,
    stateTransition:
      'stored proposal -> staged in Change Set (draft changes); not approved, not published, not synced',
    scopeSummary: (input) => `stage stored proposal ${String(input.proposalId ?? '?')} in a Change Set`,
  },
  // ------------------------------------------------- network_filesystem_repair --
  repairChangeSetImages: {
    name: 'repairChangeSetImages',
    version: 1,
    riskClass: 'network_filesystem_repair',
    sideEffects:
      'outbound network downloads and image file writes under the workspace products/images root',
    requiresApproval: true,
    stateTransition: 'Change Set images re-downloaded into workspace (filesystem write)',
    scopeSummary: (input) => `re-download images for Change Set ${String(input.changeSetId ?? '?')}`,
  },
};

export const STORE_MANAGER_RISK_LABELS: Record<ToolRiskClass, string> = {
  read: 'Read (no side effects)',
  proposal_write: 'Persistent proposal write',
  catalog_mutation: 'Catalog / Change Set mutation',
  network_filesystem_repair: 'Network + filesystem repair',
};

/** Look up a tool policy; returns undefined for unknown tools. */
export function getStoreManagerToolPolicy(toolName: string): StoreManagerToolPolicy | undefined {
  return STORE_MANAGER_TOOL_POLICIES[toolName];
}

/**
 * Fail closed: unknown tools must never execute. Throws when the tool name
 * has no policy registry entry.
 */
export function requireStoreManagerToolPolicy(toolName: string): StoreManagerToolPolicy {
  const policy = STORE_MANAGER_TOOL_POLICIES[toolName];
  if (!policy) {
    throw new Error(
      `Store Manager tool "${toolName}" has no policy registry entry and cannot execute.`,
    );
  }
  return policy;
}

/**
 * Build the `streamText.toolApproval` per-tool configuration from the policy
 * registry: read tools are `not-applicable`, every persistent class is
 * `user-approval`. Throws if a tool lacks a policy entry so a new unclassified
 * tool fails at configuration time instead of executing unguarded.
 */
export function buildToolApprovalConfig<T extends Record<string, unknown>>(
  tools: T,
): { [K in keyof T]?: 'not-applicable' | 'user-approval' } {
  const config: Record<string, 'not-applicable' | 'user-approval'> = {};
  for (const name of Object.keys(tools)) {
    const policy = requireStoreManagerToolPolicy(name);
    config[name] = policy.requiresApproval ? 'user-approval' : 'not-applicable';
  }
  return config as { [K in keyof T]?: 'not-applicable' | 'user-approval' };
}

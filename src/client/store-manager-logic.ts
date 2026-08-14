/**
 * Store Manager client-side derivation (epic #42, #34).
 *
 * Pure functions only — no React, no fetch, no imports from src/server
 * (those pull bun:sqlite / node:fs and break the Vite build). The server
 * policy registry in `store-manager-tool-policy.ts` remains the authority for
 * enforcement; this module centralizes the display copy, risk labels, and the
 * canonical state vocabulary so tool panels and the approval card render
 * unambiguous, non-optimistic language.
 */

export type StoreManagerRiskClass =
  | 'read'
  | 'proposal_write'
  | 'catalog_mutation'
  | 'network_filesystem_repair';

export interface StoreManagerToolDisplayMeta {
  riskClass: StoreManagerRiskClass;
  requiresApproval: boolean;
  /** Exact action label shown on the approval card. */
  actionLabel: string;
  /** Exact state transition the tool performs ('none' for reads). */
  stateTransition: string;
}

/**
 * Client display metadata, kept deliberately small. `store-manager-client-logic.test.ts`
 * cross-checks this map against the server policy registry (tool names, risk
 * classes, and approval requirements) so the two cannot drift silently.
 */
export const STORE_MANAGER_TOOL_DISPLAY: Record<string, StoreManagerToolDisplayMeta> = {
  getDashboardStats: {
    riskClass: 'read',
    requiresApproval: false,
    actionLabel: 'Read dashboard metrics',
    stateTransition: 'none',
  },
  getCatalogHealthReport: {
    riskClass: 'read',
    requiresApproval: false,
    actionLabel: 'Read catalog health summary',
    stateTransition: 'none',
  },
  listCatalogHealthIssues: {
    riskClass: 'read',
    requiresApproval: false,
    actionLabel: 'List catalog health issues',
    stateTransition: 'none',
  },
  searchProducts: {
    riskClass: 'read',
    requiresApproval: false,
    actionLabel: 'Search products',
    stateTransition: 'none',
  },
  getProductFieldAudit: {
    riskClass: 'read',
    requiresApproval: false,
    actionLabel: 'Audit a ProductField',
    stateTransition: 'none',
  },
  proposeProductFieldNormalization: {
    riskClass: 'read',
    requiresApproval: false,
    actionLabel: 'Preview normalization recommendations',
    stateTransition: 'none (in-memory recommendation only)',
  },
  listStoredProposals: {
    riskClass: 'read',
    requiresApproval: false,
    actionLabel: 'List stored proposals',
    stateTransition: 'none',
  },
  explainNextActions: {
    riskClass: 'read',
    requiresApproval: false,
    actionLabel: 'Explain next actions',
    stateTransition: 'none',
  },
  generateNormalizationProposals: {
    riskClass: 'proposal_write',
    requiresApproval: true,
    actionLabel: 'Store normalization proposals',
    stateTransition: 'stored proposal created (status: proposed); catalog unchanged',
  },
  dismissNormalizationProposal: {
    riskClass: 'proposal_write',
    requiresApproval: true,
    actionLabel: 'Dismiss a stored proposal',
    stateTransition: 'stored proposal -> dismissed; catalog unchanged',
  },
  applyNormalizationProposal: {
    riskClass: 'catalog_mutation',
    requiresApproval: true,
    actionLabel: 'Stage a stored proposal in a Change Set',
    stateTransition: 'stored proposal -> staged in Change Set (draft changes); not approved, not published, not synced',
  },
  repairChangeSetImages: {
    riskClass: 'network_filesystem_repair',
    requiresApproval: true,
    actionLabel: 'Repair Change Set images (network download + file write)',
    stateTransition: 'Change Set images re-downloaded into workspace products/images',
  },

  // Operations console read adapters (Issues 2/7): registry-name entries so
  // the client display map matches the server policy registry exactly.
  getChangeSetDetail: {
    riskClass: 'read',
    requiresApproval: false,
    actionLabel: 'Read Change Set detail and diff',
    stateTransition: 'none',
  },
  getStoreManagerReport: {
    riskClass: 'read',
    requiresApproval: false,
    actionLabel: 'Generate a deterministic operational report',
    stateTransition: 'none',
  },
  history_query: {
    riskClass: 'read',
    requiresApproval: false,
    actionLabel: 'Run a bounded history query',
    stateTransition: 'none',
  },
  bulk_apply_stored_proposals: {
    riskClass: 'catalog_mutation',
    requiresApproval: true,
    actionLabel: 'Stage the exact bulk-review batch in a Change Set',
    stateTransition: 'bulk batch (pending) -> proposals staged in Change Set (draft); batch status applied; not approved, not published, not synced',
  },
};

export const STORE_MANAGER_RISK_LABELS: Record<StoreManagerRiskClass, string> = {
  read: 'Read only — no side effects',
  proposal_write: 'Persistent proposal write',
  catalog_mutation: 'Catalog / Change Set mutation',
  network_filesystem_repair: 'Network + filesystem write',
};

export function getStoreManagerToolDisplayMeta(
  toolName: string,
): StoreManagerToolDisplayMeta | undefined {
  return STORE_MANAGER_TOOL_DISPLAY[toolName];
}

export interface ApprovalCardCopy {
  title: string;
  risk: string;
  scope: string;
  transition: string;
}

/** Bounded one-line scope description for a tool invocation. */
function describeScope(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'generateNormalizationProposals':
      return `Field: ${String(input.field ?? '?')}`;
    case 'dismissNormalizationProposal':
    case 'applyNormalizationProposal':
      return `Proposal: ${String(input.proposalId ?? '?')}`;
    case 'repairChangeSetImages':
      return `Change Set: ${String(input.changeSetId ?? '?')}`;
    default:
      return 'Catalog workspace';
  }
}

/** Exact approval-card copy for a tool call (action, risk, scope, transition). */
export function approvalCardCopy(
  toolName: string,
  input: Record<string, unknown>,
): ApprovalCardCopy {
  const meta = STORE_MANAGER_TOOL_DISPLAY[toolName];
  if (!meta) {
    return {
      title: `Execute ${toolName}`,
      risk: 'Unknown tool',
      scope: 'Unknown',
      transition: 'Unknown',
    };
  }
  return {
    title: meta.actionLabel,
    risk: STORE_MANAGER_RISK_LABELS[meta.riskClass],
    scope: describeScope(toolName, input),
    transition: meta.stateTransition,
  };
}

/** Denial outcome text — must never imply execution happened. */
export function deniedOutcomeText(toolName: string): string {
  const meta = STORE_MANAGER_TOOL_DISPLAY[toolName];
  return meta
    ? `Not executed — ${meta.actionLabel.toLowerCase()} was denied by the operator.`
    : 'Not executed — action was denied by the operator.';
}

/** Approval outcome text — approval is not execution; catalog state is unchanged until a tool result confirms it. */
export function approvedAwaitingExecutionText(toolName: string): string {
  const meta = STORE_MANAGER_TOOL_DISPLAY[toolName];
  return meta
    ? `Approved — ${meta.actionLabel.toLowerCase()} is executing. Catalog state is unchanged until the tool result confirms it.`
    : 'Approved — tool is executing. Catalog state is unchanged until the tool result confirms it.';
}

/**
 * Canonical state vocabulary (epic #42, #34/#41). Every term has one meaning;
 * the prompt and UI must never conflate stored, staged, approved, imported,
 * published, or synced.
 */
export const STORE_MANAGER_STATE_TERMS = {
  recommendation: 'recommendation (in-memory, not persisted)',
  storedProposal: 'stored proposal (status: proposed)',
  stagedInChangeSet: 'staged in Change Set (draft changes; not approved / published / synced)',
  changeSetApproved: 'Change Set approved (not necessarily imported / published / synced)',
  pushed: 'pushed (push workflow completed)',
  imported: 'imported to ShopSite (not necessarily published)',
  published: 'published (storefront publication confirmed)',
  synced: 'synced (remote synchronization confirmed)',
} as const;

export type StoreManagerStateTerm = keyof typeof STORE_MANAGER_STATE_TERMS;

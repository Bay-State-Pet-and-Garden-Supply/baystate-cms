/**
 * Store Manager playbook pure client logic (operations console, Issue 6).
 *
 * Deterministic presentation helpers for playbook definitions and static
 * risk. All derivation is pure (no API, no React) so it stays unit-testable;
 * the client never interprets steps or executes anything.
 */

import type {
  StoreManagerPlaybookStep,
  StoreManagerPlaybookSummary,
  StoreManagerPlaybookStaticRisk,
  StoreManagerPlaybookRiskClass,
} from './store-manager-api';

export function stepKindLabel(kind: StoreManagerPlaybookStep['kind']): string {
  switch (kind) {
    case 'read':
      return 'Read';
    case 'summarize':
      return 'Summarize';
    case 'propose':
      return 'Propose';
    case 'approval_checkpoint':
      return 'Approval checkpoint';
    case 'execute':
      return 'Execute';
    case 'verify':
      return 'Verify';
  }
}

export function riskClassLabel(risk: StoreManagerPlaybookRiskClass): string {
  switch (risk) {
    case 'read':
      return 'Read (no side effects)';
    case 'proposal_write':
      return 'Persistent proposal write';
    case 'catalog_mutation':
      return 'Catalog / Change Set mutation';
    case 'network_filesystem_repair':
      return 'Network + filesystem repair';
  }
}

export function riskTone(risk: StoreManagerPlaybookRiskClass): 'ok' | 'warn' | 'bad' {
  switch (risk) {
    case 'read':
      return 'ok';
    case 'proposal_write':
      return 'warn';
    case 'catalog_mutation':
      return 'bad';
    case 'network_filesystem_repair':
      return 'bad';
  }
}

export function networkActivityLabel(activity: 'none' | 'bounded'): string {
  return activity === 'none' ? 'No network activity' : 'Bounded network activity';
}

export function stepSummary(step: StoreManagerPlaybookStep): string {
  if (step.kind === 'read' && step.toolName) {
    const tool = `${step.toolName} v${step.toolVersion ?? '?'}`;
    const template = step.inputTemplate ? Object.keys(step.inputTemplate).join(', ') : 'default inputs';
    return `${tool} — ${template || 'no inputs'}`;
  }
  if (step.kind === 'execute' && step.toolName) {
    const risk = step.declaredRiskClass;
    return `${step.toolName} v${step.toolVersion ?? '?'} (${riskClassLabel(risk ?? 'catalog_mutation')}) — after approval`;
  }
  if (step.kind === 'verify' && step.toolNames) {
    return step.toolNames.map((t) => `${t.toolName} v${t.toolVersion}`).join(', ');
  }
  if (step.kind === 'approval_checkpoint') return 'Diff bundle shown to the operator; nothing runs until approved';
  if (step.kind === 'propose') {
    return step.mode === 'persistent_stored'
      ? 'Persistent stored proposal (risk declared, approval still required)'
      : 'Transient preview only (nothing persisted)';
  }
  if (step.kind === 'summarize') {
    return step.mode === 'model_bounded' ? 'Bounded model summary' : 'Deterministic artifact summary';
  }
  return '';
}

export function playbookStatusLabel(status: StoreManagerPlaybookSummary['status']): string {
  return status === 'active' ? 'Active' : 'Draft (inert)';
}

export function playbookStatusTone(status: StoreManagerPlaybookSummary['status']): 'ok' | 'neutral' | 'warn' {
  return status === 'active' ? 'ok' : 'neutral';
}

export function sortPlaybooks(playbooks: StoreManagerPlaybookSummary[]): StoreManagerPlaybookSummary[] {
  return [...playbooks].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function staticRiskSummary(risk: StoreManagerPlaybookStaticRisk | null): string {
  if (!risk) return 'Unknown';
  const parts: string[] = [];
  if (risk.hasMutationStep) parts.push('contains a mutation step');
  if (risk.expectedApprovals.length > 0) parts.push(`${risk.expectedApprovals.length} approval checkpoint(s)`);
  parts.push(networkActivityLabel(risk.networkActivity));
  return parts.join(' · ');
}

export function activationNote(playbook: StoreManagerPlaybookSummary): string | null {
  if (playbook.status !== 'active' || !playbook.activatedAt || !playbook.activeVersion) return null;
  return `Activated v${playbook.activeVersion} by ${playbook.activatedBy ?? 'operator'} on ${new Date(playbook.activatedAt).toLocaleString()}`;
}

/** Human-readable step kind sequence, e.g. "Read → Summarize → Propose → Checkpoint → Execute → Verify". */
export function stepSequence(steps: StoreManagerPlaybookStep[]): string {
  return steps.map((s) => stepKindLabel(s.kind)).join(' → ');
}

export function variableTypeLabel(type: string): string {
  switch (type) {
    case 'product_field':
      return 'ProductField';
    case 'change_set_id':
      return 'Change Set ID';
    case 'sku':
      return 'SKU';
    case 'vendor_id':
      return 'Vendor';
    default:
      return 'String';
  }
}

/**
 * Store Manager event-trigger registry (operations console, Issue 5).
 *
 * Four locked read-only trigger templates (plan Locked Decision 8). Each
 * template is a server-owned descriptor: a bounded objective the model is
 * asked to pursue inside the unattended read-only runtime policy (persistent
 * adapters are denied at registry dispatch before any side effect). Triggers
 * are inert until copied into a workspace definition and enabled; users may
 * change supported config/scope/model only — never the objective or the
 * read-only posture.
 *
 * Import-finished observation is deliberately CONSERVATIVE: an occurrence is
 * emitted only when the configured import observation is terminal AND all
 * selected Product SKUs are known. If terminality cannot be proven from
 * committed durable state, the worker records a `diagnostic` occurrence and
 * never guesses a completion.
 */

import type {
  StoreManagerTriggerKind,
  StoreManagerTriggerConfig,
  StoreManagerTriggerTemplate,
} from '../../shared/schemas/store-manager-trigger';

export interface StoreManagerTriggerTemplateDescriptor extends StoreManagerTriggerTemplate {
  kind: StoreManagerTriggerKind;
  defaultConfig: StoreManagerTriggerConfig;
}

export const STORE_MANAGER_TRIGGER_TEMPLATES: readonly StoreManagerTriggerTemplateDescriptor[] = [
  {
    kind: 'import_finished',
    name: 'Import finished — audit its products',
    description:
      'When an Onboarding Batch reaches the terminal import observation (every item terminal and every Product SKU known), audit the imported products read-only.',
    objective:
      'Audit the Product SKUs that finished importing for the observed Onboarding Batch (read-only). Inspect authoritative catalog evidence for these SKUs and summarize issues, anomalies, and anything needing review. If the batch or SKUs are not provably terminal, record a diagnostic and do not guess. Do not stage, approve, publish, sync, or repair anything.',
    defaultConfig: { kind: 'import_finished', batchId: null },
    scopeSummary: 'sku_set of the imported products (batch-derived, bounded)',
    readOnly: true,
  },
  {
    kind: 'change_set_approved',
    name: 'Change Set approved — verification offer',
    description:
      'When a Change Set becomes approved, prepare a read-only verification offer/report. Never pushes, publishes, or syncs automatically.',
    objective:
      'Prepare a read-only verification report for the just-approved Change Set. Inspect its items, affected Product SKUs, and current catalog state, then summarize what the verification pass should check. This is a verification OFFER only: never push, publish, sync, or otherwise act on the Change Set.',
    defaultConfig: { kind: 'change_set_approved' },
    scopeSummary: 'change_set scope (workspace-scoped)',
    readOnly: true,
  },
  {
    kind: 'sync_failed',
    name: 'Sync failed — remediation investigation',
    description:
      'When a sync job fails, investigate the recorded redacted failure evidence and prepare a remediation report. Never retries or re-runs the sync.',
    objective:
      'Investigate the recorded failure evidence of the failed sync job (read-only, redacted evidence only). Summarize the error class, affected change set, and any repeated patterns, and prepare a remediation report for the operator. Never retry, re-run, or trigger a sync, and never stage, approve, publish, or repair anything.',
    defaultConfig: { kind: 'sync_failed' },
    scopeSummary: 'sync job scope (redacted stored evidence)',
    readOnly: true,
  },
  {
    kind: 'product_field_drift',
    name: 'ProductField drift — review set',
    description:
      'When pending cleanup work for a ProductField grows by at least the configured threshold between observations, generate a deterministic review set/report.',
    objective:
      'ProductField drift was detected: pending review work for a ProductField grew past the configured threshold (read-only). Generate a deterministic review set/report for that field: summarize the field, the pending proposal count, and the growth. Do not stage, approve, publish, sync, repair, or store anything.',
    defaultConfig: { kind: 'product_field_drift', threshold: 5 },
    scopeSummary: 'product_field scope (field from the drift)',
    readOnly: true,
  },
];

export function getTriggerTemplate(kind: StoreManagerTriggerKind): StoreManagerTriggerTemplateDescriptor | null {
  return STORE_MANAGER_TRIGGER_TEMPLATES.find((t) => t.kind === kind) ?? null;
}

export function listTriggerTemplates(): readonly StoreManagerTriggerTemplateDescriptor[] {
  return STORE_MANAGER_TRIGGER_TEMPLATES;
}

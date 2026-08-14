/**
 * Store Manager playbook starter templates (operations console, Issue 6).
 *
 * Four code-owned, inert template descriptors (plan Locked Decision 10 /
 * Issue 6 Work item 5). Templates are NOT runnable playbooks: they validate
 * against the current registry but do nothing until copied into a workspace
 * draft and explicitly activated. Users may edit a copy; the originals are
 * immutable code. Weekly taxonomy cleanup uses Store Manager ProductField
 * cleanup vocabulary and never touches classification configuration.
 */

import type { StoreManagerPlaybookStep } from '../../shared/schemas/store-manager-playbook';
import type { StoreManagerPlaybookTemplateKind } from '../../shared/schemas/store-manager-playbook';

export interface StoreManagerPlaybookTemplateDescriptor {
  kind: StoreManagerPlaybookTemplateKind;
  name: string;
  description: string;
  /** Suggested name for the copied workspace draft. */
  defaultName: string;
  scopeAllowedKinds: readonly string[];
  variables: readonly { name: string; type: string; required: boolean }[];
  steps: readonly StoreManagerPlaybookStep[];
}

export const STORE_MANAGER_PLAYBOOK_TEMPLATES: readonly StoreManagerPlaybookTemplateDescriptor[] = [
  {
    kind: 'weekly_taxonomy_cleanup',
    name: 'Weekly taxonomy cleanup',
    description:
      'Audit a ProductField for casing/whitespace/separator issues, summarize cleanup opportunities, and (after operator approval at the checkpoint) store deterministic normalization proposals for review. Never changes classification configuration.',
    defaultName: 'Weekly taxonomy cleanup',
    scopeAllowedKinds: ['product_field'],
    variables: [
      { name: 'field', type: 'product_field', required: true },
    ],
    steps: [
      {
        stepId: 'audit',
        kind: 'read',
        description: 'Audit the pinned ProductField for value-quality issues and duplicate groups.',
        toolName: 'getProductFieldAudit',
        toolVersion: 1,
        inputTemplate: { field: '{{field}}', limit: 200 },
      },
      {
        stepId: 'summarize',
        kind: 'summarize',
        description: 'Aggregate the audit into a bounded cleanup summary (deterministic).',
        mode: 'deterministic',
      },
      {
        stepId: 'propose',
        kind: 'propose',
        description: 'Prepare a transient preview of normalization opportunities.',
        mode: 'transient_preview',
      },
      {
        stepId: 'checkpoint',
        kind: 'approval_checkpoint',
        description: 'Operator reviews the diff bundle and approves or stops before anything is stored.',
        diffRequired: true,
      },
      {
        stepId: 'store',
        kind: 'execute',
        description: 'Store deterministic normalization proposals for the field (status "proposed").',
        toolName: 'store_product_field_normalization_proposals',
        toolVersion: 1,
        inputTemplate: { field: '{{field}}' },
        declaredRiskClass: 'proposal_write',
      },
      {
        stepId: 'verify',
        kind: 'verify',
        description: 'Verify the stored proposals are present and reviewable.',
        toolNames: [{ toolName: 'listStoredProposals', toolVersion: 1 }],
      },
    ],
  },
  {
    kind: 'new_vendor_import_review',
    name: 'New vendor import review',
    description:
      'Review newly imported SKUs for a vendor, summarize quality signals, and — after operator approval — stage the associated stored proposal into the active Change Set (draft only).',
    defaultName: 'New vendor import review',
    scopeAllowedKinds: ['sku_set'],
    variables: [
      { name: 'vendorName', type: 'string', required: true },
      { name: 'proposalId', type: 'string', required: true },
    ],
    steps: [
      {
        stepId: 'search',
        kind: 'read',
        description: 'Read the vendor-scoped SKU set from the product index.',
        toolName: 'searchProducts',
        toolVersion: 1,
        inputTemplate: { search: '{{vendorName}}', limit: 200 },
      },
      {
        stepId: 'summarize',
        kind: 'summarize',
        description: 'Summarize quality signals for the reviewed SKUs (deterministic).',
        mode: 'deterministic',
      },
      {
        stepId: 'checkpoint',
        kind: 'approval_checkpoint',
        description: 'Operator reviews the import-review diff bundle before any staging.',
        diffRequired: true,
      },
      {
        stepId: 'stage',
        kind: 'execute',
        description: 'Stage the reviewed stored proposal into the active Change Set (draft only).',
        toolName: 'stage_stored_proposal_in_change_set',
        toolVersion: 1,
        inputTemplate: { proposalId: '{{proposalId}}' },
        declaredRiskClass: 'catalog_mutation',
      },
      {
        stepId: 'verify',
        kind: 'verify',
        description: 'Verify the staged SKUs against the product index.',
        toolNames: [{ toolName: 'searchProducts', toolVersion: 1 }],
      },
    ],
  },
  {
    kind: 'image_integrity_pass',
    name: 'Image integrity pass',
    description:
      'Inspect a Change Set for image-integrity findings and, after operator approval at the checkpoint, re-download images for the approved Change Set. Verify afterwards.',
    defaultName: 'Image integrity pass',
    scopeAllowedKinds: ['change_set'],
    variables: [
      { name: 'changeSetId', type: 'change_set_id', required: true },
    ],
    steps: [
      {
        stepId: 'inspect',
        kind: 'read',
        description: 'Inspect the Change Set: state, items, and image status.',
        toolName: 'getChangeSetDetail',
        toolVersion: 1,
        inputTemplate: { changeSetId: '{{changeSetId}}' },
      },
      {
        stepId: 'summarize',
        kind: 'summarize',
        description: 'Summarize image-integrity findings (deterministic).',
        mode: 'deterministic',
      },
      {
        stepId: 'checkpoint',
        kind: 'approval_checkpoint',
        description: 'Operator approves the repair diff (exact items, affected files, network estimate).',
        diffRequired: true,
      },
      {
        stepId: 'repair',
        kind: 'execute',
        description: 'Re-download images for the approved Change Set (network + filesystem repair).',
        toolName: 'repair_approved_change_set_images',
        toolVersion: 1,
        inputTemplate: { changeSetId: '{{changeSetId}}' },
        declaredRiskClass: 'network_filesystem_repair',
      },
      {
        stepId: 'verify',
        kind: 'verify',
        description: 'Verify the repaired images and final Change Set state.',
        toolNames: [{ toolName: 'getChangeSetDetail', toolVersion: 1 }],
      },
    ],
  },
  {
    kind: 'launch_readiness_check',
    name: 'Launch readiness check',
    description:
      'Pure read-only launch checklist: dashboard stats, catalog health, deterministic operational report, and a summary. No mutation, no approval checkpoint, no execute step.',
    defaultName: 'Launch readiness check',
    scopeAllowedKinds: [],
    variables: [],
    steps: [
      {
        stepId: 'stats',
        kind: 'read',
        description: 'Read dashboard metrics.',
        toolName: 'getDashboardStats',
        toolVersion: 1,
        inputTemplate: {},
      },
      {
        stepId: 'health',
        kind: 'read',
        description: 'Read catalog health totals.',
        toolName: 'getCatalogHealthReport',
        toolVersion: 1,
        inputTemplate: {},
      },
      {
        stepId: 'report',
        kind: 'read',
        description: 'Assemble the deterministic operational report.',
        toolName: 'getStoreManagerReport',
        toolVersion: 1,
        inputTemplate: { focus: 'full' },
      },
      {
        stepId: 'summarize',
        kind: 'summarize',
        description: 'Summarize readiness signals (deterministic).',
        mode: 'deterministic',
      },
    ],
  },
];

/** Look up a template descriptor by kind. */
export function findStoreManagerPlaybookTemplate(
  kind: StoreManagerPlaybookTemplateKind,
): StoreManagerPlaybookTemplateDescriptor | undefined {
  return STORE_MANAGER_PLAYBOOK_TEMPLATES.find((t) => t.kind === kind);
}

/** Stable palette descriptors (the client renders only these). */
export function describeStoreManagerPlaybookTemplates(): {
  kind: StoreManagerPlaybookTemplateKind;
  name: string;
  description: string;
  scopeAllowedKinds: readonly string[];
  stepCount: number;
}[] {
  return STORE_MANAGER_PLAYBOOK_TEMPLATES.map((t) => ({
    kind: t.kind,
    name: t.name,
    description: t.description,
    scopeAllowedKinds: t.scopeAllowedKinds,
    stepCount: t.steps.length,
  }));
}

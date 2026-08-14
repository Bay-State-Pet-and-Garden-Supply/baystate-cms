// @vitest-environment node
/**
 * Operations console, Issue 6 — playbook starter templates.
 *
 * All four code-owned templates must validate against the CURRENT registry,
 * be read-safe until copied+activated (inert descriptors), and use Store
 * Manager ProductField cleanup vocabulary (never classification config).
 */

import { describe, it, expect } from 'vitest';
import { STORE_MANAGER_PLAYBOOK_TEMPLATES } from '../../store-manager/playbooks/templates';
import { validateStoreManagerPlaybook } from '../../store-manager/playbooks/validator';
import { createStoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import type {
  StoreManagerPlaybookDefinition,
  StoreManagerPlaybookStep,
} from '../../shared/schemas/store-manager-playbook';

const registry = createStoreManagerToolRegistry();
const resolve = registry.playbookResolver();

function templateToDefinition(kind: string): StoreManagerPlaybookDefinition {
  const template = STORE_MANAGER_PLAYBOOK_TEMPLATES.find((t) => t.kind === kind);
  expect(template).toBeTruthy();
  return {
    id: 'template-preview',
    workspaceId: 'ws-1',
    name: template!.name,
    description: template!.description,
    templateKind: template!.kind,
    version: 1,
    status: 'draft',
    scopeInput: { allowedKinds: template!.scopeAllowedKinds as StoreManagerPlaybookDefinition['scopeInput']['allowedKinds'], maxSkus: 200 },
    variables: template!.variables.map((v) => ({
      name: v.name,
      type: v.type as StoreManagerPlaybookDefinition['variables'][number]['type'],
      required: v.required,
    })),
    steps: template!.steps.map((s) => ({ ...s })),
    definitionHash: 'a'.repeat(64),
    activatedAt: null,
    activatedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('Store Manager playbook templates (Issue 6)', () => {
  it('provides exactly the four locked templates', () => {
    expect(STORE_MANAGER_PLAYBOOK_TEMPLATES.map((t) => t.kind).sort()).toEqual([
      'image_integrity_pass',
      'launch_readiness_check',
      'new_vendor_import_review',
      'weekly_taxonomy_cleanup',
    ]);
  });

  it('all four templates validate against the current registry and stay inactive', () => {
    for (const template of STORE_MANAGER_PLAYBOOK_TEMPLATES) {
      const definition = templateToDefinition(template.kind);
      const risk = validateStoreManagerPlaybook(definition, resolve);
      expect(risk.networkActivity).toBeDefined();
      // Inert: the template itself is data; activation is a separate reviewed op.
      expect(definition.status).toBe('draft');
      expect(definition.activatedAt).toBeNull();
    }
  });

  it('weekly taxonomy cleanup is a ProductField cleanup playbook, not classification config', () => {
    const definition = templateToDefinition('weekly_taxonomy_cleanup');
    expect(definition.scopeInput.allowedKinds).toEqual(['product_field']);
    const steps = definition.steps;
    expect(steps.some((s) => s.kind === 'read' && s.toolName === 'getProductFieldAudit')).toBe(true);
    expect(steps.some((s) => s.kind === 'execute' && s.toolName === 'store_product_field_normalization_proposals')).toBe(true);
    // It must not reference any classification configuration tool.
    const names = steps
      .filter((s): s is StoreManagerPlaybookStep & { toolName: string } => s.kind === 'read' || s.kind === 'execute')
      .map((s) => s.toolName);
    expect(names).not.toContain('updateClassificationConfig');
    expect(names).not.toContain('setProductType');
  });

  it('launch readiness check is mutation-free (no execute, no checkpoint, no verify required)', () => {
    const definition = templateToDefinition('launch_readiness_check');
    const steps = definition.steps;
    expect(steps.some((s) => s.kind === 'execute')).toBe(false);
    expect(steps.some((s) => s.kind === 'approval_checkpoint')).toBe(false);
    expect(steps.every((s) => s.kind === 'read' || s.kind === 'summarize')).toBe(true);
    const risk = validateStoreManagerPlaybook(definition, resolve);
    expect(risk.hasMutationStep).toBe(false);
    expect(risk.expectedApprovals).toEqual([]);
  });

  it('image integrity pass declares the network/filesystem repair risk', () => {
    const definition = templateToDefinition('image_integrity_pass');
    const repairStep = definition.steps.find((s) => s.kind === 'execute');
    expect(repairStep).toBeTruthy();
    expect((repairStep as StoreManagerPlaybookStep & { declaredRiskClass?: string }).declaredRiskClass).toBe('network_filesystem_repair');
    const risk = validateStoreManagerPlaybook(definition, resolve);
    expect(risk.networkActivity).toBe('bounded');
  });

  it('new vendor import review stages only into a Change Set (draft)', () => {
    const definition = templateToDefinition('new_vendor_import_review');
    const executeStep = definition.steps.find((s) => s.kind === 'execute');
    expect((executeStep as StoreManagerPlaybookStep & { toolName: string }).toolName).toBe('stage_stored_proposal_in_change_set');
    const risk = validateStoreManagerPlaybook(definition, resolve);
    expect(risk.hasMutationStep).toBe(true);
    expect(risk.expectedDiffKinds).toContain('diff');
  });
});

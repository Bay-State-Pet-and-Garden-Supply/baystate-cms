// @vitest-environment node
/**
 * Operations console, Issue 6 — playbook DSL validator.
 *
 * Pure tests (no DB): the validator is registry-aware and fail-closed. A
 * playbook can never grant authority or hide a registered tool's risk; any
 * disagreement with the CURRENT registry metadata rejects the definition.
 */

import { describe, it, expect } from 'vitest';
import { validateStoreManagerPlaybook } from '../../store-manager/playbooks/validator';
import { StoreManagerPlaybookValidationError } from '../../store-manager/playbooks/contracts';
import { createStoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import type { StoreManagerPlaybookDefinition, StoreManagerPlaybookStep } from '../../shared/schemas/store-manager-playbook';

const registry = createStoreManagerToolRegistry();
const resolve = registry.playbookResolver();

function makeDefinition(
  steps: StoreManagerPlaybookStep[],
  overrides: Partial<StoreManagerPlaybookDefinition> = {},
): StoreManagerPlaybookDefinition {
  return {
    id: 'pb-1',
    workspaceId: 'ws-1',
    name: 'Test playbook',
    description: 'A valid registry-aware playbook.',
    templateKind: null,
    version: 1,
    status: 'draft',
    scopeInput: { allowedKinds: ['product_field'], maxSkus: 200 },
    variables: [{ name: 'field', type: 'product_field', required: true }],
    steps,
    definitionHash: 'a'.repeat(64),
    activatedAt: null,
    activatedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const VALID_STEPS: StoreManagerPlaybookStep[] = [
  {
    stepId: 'read-1',
    kind: 'read',
    toolName: 'getProductFieldAudit',
    toolVersion: 1,
    inputTemplate: { field: '{{field}}', limit: 100 },
  },
  { stepId: 'sum-1', kind: 'summarize', mode: 'deterministic' },
  { stepId: 'prop-1', kind: 'propose', mode: 'transient_preview' },
  { stepId: 'chk-1', kind: 'approval_checkpoint', diffRequired: true },
  {
    stepId: 'exec-1',
    kind: 'execute',
    toolName: 'store_product_field_normalization_proposals',
    toolVersion: 1,
    inputTemplate: { field: '{{field}}' },
    declaredRiskClass: 'proposal_write',
  },
  { stepId: 'ver-1', kind: 'verify', toolNames: [{ toolName: 'listStoredProposals', toolVersion: 1 }] },
];

function expectCode(fn: () => unknown, code: StoreManagerPlaybookValidationError['code']): void {
  try {
    fn();
    expect.fail(`expected validation error code "${code}"`);
  } catch (err) {
    expect(err).toBeInstanceOf(StoreManagerPlaybookValidationError);
    expect((err as StoreManagerPlaybookValidationError).code).toBe(code);
  }
}

describe('Store Manager playbook validator (Issue 6)', () => {
  it('accepts the canonical read→summarize→propose→checkpoint→execute→verify shape', () => {
    const risk = validateStoreManagerPlaybook(makeDefinition(VALID_STEPS), resolve);
    expect(risk.hasMutationStep).toBe(true);
    expect(risk.hasVerifyStep).toBe(true);
    expect(risk.expectedApprovals).toEqual([
      { toolName: 'store_product_field_normalization_proposals', toolVersion: 1 },
    ]);
    expect(risk.networkActivity).toBe('none');
    expect(risk.expectedDiffKinds).toContain('diff');
    expect(risk.expectedDiffKinds).toContain('verification_diff');
    expect(risk.riskClasses).toContain('proposal_write');
  });

  it('rejects an unregistered tool', () => {
    const steps = [
      {
        stepId: 'read-1',
        kind: 'read' as const,
        toolName: 'not_a_real_tool',
        toolVersion: 1,
        inputTemplate: {},
      },
    ];
    expectCode(() => validateStoreManagerPlaybook(makeDefinition(steps, { scopeInput: { allowedKinds: [], maxSkus: 200 } }), resolve), 'unknown_tool');
  });

  it('rejects version drift against the current registry', () => {
    const steps = [
      {
        stepId: 'read-1',
        kind: 'read' as const,
        toolName: 'getProductFieldAudit',
        toolVersion: 99,
        inputTemplate: {},
      },
    ];
    expectCode(() => validateStoreManagerPlaybook(makeDefinition(steps), resolve), 'tool_version_drift');
  });

  it('rejects a cycle and forward dependencies', () => {
    const steps: StoreManagerPlaybookStep[] = [
      {
        stepId: 'read-1',
        kind: 'read',
        toolName: 'getProductFieldAudit',
        toolVersion: 1,
        inputTemplate: {},
      },
      { stepId: 'sum-1', kind: 'summarize', mode: 'deterministic', dependsOnStepIds: ['read-1'] },
    ];
    // Forward dependency: sum-1 depends on read-1 (later in the array).
    expectCode(
      () => validateStoreManagerPlaybook(makeDefinition([steps[1], steps[0]]), resolve),
      'forward_dependency',
    );
    // Self reference.
    const selfRef: StoreManagerPlaybookStep = {
      stepId: 'read-1',
      kind: 'read',
      toolName: 'getProductFieldAudit',
      toolVersion: 1,
      inputTemplate: {},
      dependsOnStepIds: ['read-1'],
    };
    expectCode(() => validateStoreManagerPlaybook(makeDefinition([selfRef]), resolve), 'step_cycle');
  });

  it('rejects an unknown dependency and duplicate step ids', () => {
    const steps: StoreManagerPlaybookStep[] = [
      {
        stepId: 'read-1',
        kind: 'read',
        toolName: 'getProductFieldAudit',
        toolVersion: 1,
        inputTemplate: {},
        dependsOnStepIds: ['ghost'],
      },
    ];
    expectCode(() => validateStoreManagerPlaybook(makeDefinition(steps), resolve), 'unknown_dependency');
    const dup: StoreManagerPlaybookStep = {
      stepId: 'read-1',
      kind: 'read',
      toolName: 'getProductFieldAudit',
      toolVersion: 1,
      inputTemplate: {},
    };
    expectCode(() => validateStoreManagerPlaybook(makeDefinition([dup, dup]), resolve), 'duplicate_step_id');
  });

  it('rejects an unknown variable reference', () => {
    const steps: StoreManagerPlaybookStep[] = [
      {
        stepId: 'read-1',
        kind: 'read',
        toolName: 'getProductFieldAudit',
        toolVersion: 1,
        inputTemplate: { field: '{{missingVar}}' },
      },
    ];
    expectCode(() => validateStoreManagerPlaybook(makeDefinition(steps), resolve), 'unknown_variable');
  });

  it('rejects mutation without an immediately-preceding approval checkpoint', () => {
    const steps: StoreManagerPlaybookStep[] = [
      {
        stepId: 'read-1',
        kind: 'read',
        toolName: 'getProductFieldAudit',
        toolVersion: 1,
        inputTemplate: { field: '{{field}}' },
      },
      {
        stepId: 'exec-1',
        kind: 'execute',
        toolName: 'store_product_field_normalization_proposals',
        toolVersion: 1,
        inputTemplate: { field: '{{field}}' },
        declaredRiskClass: 'proposal_write',
      },
      { stepId: 'ver-1', kind: 'verify', toolNames: [{ toolName: 'listStoredProposals', toolVersion: 1 }] },
    ];
    expectCode(() => validateStoreManagerPlaybook(makeDefinition(steps), resolve), 'missing_approval_before_mutation');
  });

  it('rejects an approval checkpoint without a diff', () => {
    const steps: StoreManagerPlaybookStep[] = [
      { stepId: 'chk-1', kind: 'approval_checkpoint', diffRequired: false as never },
    ];
    expectCode(() => validateStoreManagerPlaybook(makeDefinition(steps, { scopeInput: { allowedKinds: [], maxSkus: 200 } }), resolve), 'approval_without_diff');
  });

  it('rejects missing verification after a mutation', () => {
    const steps: StoreManagerPlaybookStep[] = [
      { stepId: 'chk-1', kind: 'approval_checkpoint', diffRequired: true },
      {
        stepId: 'exec-1',
        kind: 'execute',
        toolName: 'store_product_field_normalization_proposals',
        toolVersion: 1,
        inputTemplate: { field: '{{field}}' },
        declaredRiskClass: 'proposal_write',
      },
    ];
    expectCode(() => validateStoreManagerPlaybook(makeDefinition(steps), resolve), 'missing_verification');
  });

  it('rejects a persistent stored proposal without an explicit risk declaration', () => {
    const steps: StoreManagerPlaybookStep[] = [
      { stepId: 'prop-1', kind: 'propose', mode: 'persistent_stored' },
    ];
    expectCode(
      () => validateStoreManagerPlaybook(makeDefinition(steps, { scopeInput: { allowedKinds: [], maxSkus: 200 } }), resolve),
      'missing_proposal_risk_declaration',
    );
  });

  it('rejects a forged risk downgrade (declared risk disagrees with registry)', () => {
    const steps: StoreManagerPlaybookStep[] = [
      { stepId: 'chk-1', kind: 'approval_checkpoint', diffRequired: true },
      {
        stepId: 'exec-1',
        kind: 'execute',
        toolName: 'stage_stored_proposal_in_change_set',
        toolVersion: 1,
        inputTemplate: { proposalId: '{{proposalId}}' },
        declaredRiskClass: 'read', // forged: registry says catalog_mutation
      },
      { stepId: 'ver-1', kind: 'verify', toolNames: [{ toolName: 'getChangeSetDetail', toolVersion: 1 }] },
    ];
    expectCode(
      () =>
        validateStoreManagerPlaybook(
          makeDefinition(steps, {
            scopeInput: { allowedKinds: ['change_set'], maxSkus: 200 },
            variables: [
              { name: 'proposalId', type: 'string', required: true },
            ],
          }),
          resolve,
        ),
      'risk_downgrade_forgery',
    );
  });

  it('rejects a read step that references a persistent tool', () => {
    const steps: StoreManagerPlaybookStep[] = [
      {
        stepId: 'read-1',
        kind: 'read',
        toolName: 'store_product_field_normalization_proposals',
        toolVersion: 1,
        inputTemplate: { field: '{{field}}' },
      },
    ];
    expectCode(() => validateStoreManagerPlaybook(makeDefinition(steps), resolve), 'read_step_requires_read_tool');
  });

  it('rejects an execute step that references a read-only tool', () => {
    const steps: StoreManagerPlaybookStep[] = [
      { stepId: 'chk-1', kind: 'approval_checkpoint', diffRequired: true },
      {
        stepId: 'exec-1',
        kind: 'execute',
        toolName: 'getProductFieldAudit',
        toolVersion: 1,
        inputTemplate: { field: '{{field}}' },
      },
    ];
    expectCode(() => validateStoreManagerPlaybook(makeDefinition(steps), resolve), 'execute_requires_persistent_tool');
  });

  it('rejects scope mismatch (tool cannot honor the playbook scope)', () => {
    const steps: StoreManagerPlaybookStep[] = [
      {
        stepId: 'read-1',
        kind: 'read',
        toolName: 'getChangeSetDetail', // supports change_set only
        toolVersion: 1,
        inputTemplate: {},
      },
    ];
    // Playbook pins sku_set; getChangeSetDetail cannot honor it.
    expectCode(
      () =>
        validateStoreManagerPlaybook(
          makeDefinition(steps, { scopeInput: { allowedKinds: ['sku_set'], maxSkus: 200 } }),
          resolve,
        ),
      'scope_mismatch',
    );
  });

  it('rejects mixed tool versions for the same tool name', () => {
    // Custom resolver exposing two versions of the same logical tool — a
    // multi-version registry scenario the default single-version registry
    // cannot produce, so this injects the drift scenario directly.
    const multiResolver = (toolName: string, requestedVersion?: number) => {
      if (toolName === 'customRead') {
        return { name: 'customRead', version: requestedVersion ?? 1, riskClass: 'read' as const, requiresApproval: false, supportedScopes: [] as const };
      }
      return resolve(toolName);
    };
    const steps: StoreManagerPlaybookStep[] = [
      { stepId: 'read-1', kind: 'read', toolName: 'customRead', toolVersion: 1, inputTemplate: {} },
      { stepId: 'read-2', kind: 'read', toolName: 'customRead', toolVersion: 2, inputTemplate: {} },
    ];
    expectCode(
      () => validateStoreManagerPlaybook(makeDefinition(steps, { scopeInput: { allowedKinds: [], maxSkus: 200 } }), multiResolver),
      'mixed_tool_versions',
    );
  });

  it('rejects unbounded sku_set fan-out', () => {
    expectCode(
      () =>
        validateStoreManagerPlaybook(
          makeDefinition(
            [{ stepId: 'r1', kind: 'read', toolName: 'searchProducts', toolVersion: 1, inputTemplate: {} }],
            { scopeInput: { allowedKinds: ['sku_set'], maxSkus: 5000 } },
          ),
          resolve,
        ),
      'unbounded_fan_out',
    );
  });
});

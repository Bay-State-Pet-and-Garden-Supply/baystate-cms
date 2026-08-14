/**
 * Store Manager playbook validator (operations console, Issue 6).
 *
 * Registry-aware, fail-closed validation of immutable playbook definitions.
 * Every tool reference must resolve against the CURRENT registry metadata;
 * stored claims that disagree (version drift, forged risk downgrade,
 * unregistered tools) reject the whole definition. The DSL is data-only and
 * bounded: no loops, no free-form tool names, no code, no scope widening.
 *
 * A playbook can never grant authority or hide a registered tool's risk:
 * - an `execute` step requires an immediately-preceding `approval_checkpoint`
 *   (mutation before approval is rejected),
 * - an `approval_checkpoint` structurally requires a diff (`diffRequired`),
 * - any playbook with a mutation step must contain a `verify` step,
 * - `propose` with `mode: 'persistent_stored'` requires an explicit
 *   `proposalWriteRiskDeclared` flag,
 * - a step's `declaredRiskClass` (when present) must equal the registry's
 *   current risk class.
 */

import type {
  StoreManagerPlaybookDefinition,
  StoreManagerPlaybookStep,
  StoreManagerPlaybookVariable,
  StoreManagerPlaybookToolRef,
} from '../../shared/schemas/store-manager-playbook';
import type {
  StoreManagerPlaybookStaticRisk,
  StoreManagerPlaybookToolResolver,
  StoreManagerPlaybookToolMetadata,
} from './contracts';
import { StoreManagerPlaybookValidationError } from './contracts';

const VARIABLE_REFERENCE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function collectVariableReferences(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(VARIABLE_REFERENCE)) out.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectVariableReferences(entry, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectVariableReferences(entry, out);
    }
  }
}

function toolRefsOfStep(step: StoreManagerPlaybookStep): StoreManagerPlaybookToolRef[] {
  switch (step.kind) {
    case 'read':
    case 'execute':
      return [{ toolName: step.toolName, toolVersion: step.toolVersion }];
    case 'verify':
      return [...step.toolNames];
    case 'summarize':
    case 'propose':
    case 'approval_checkpoint':
      return [];
  }
}

function toolNameForStep(step: StoreManagerPlaybookStep): string | null {
  if (step.kind === 'read' || step.kind === 'execute') return step.toolName;
  if (step.kind === 'verify') return step.toolNames.length === 1 ? step.toolNames[0].toolName : null;
  return null;
}

function inputTemplateOfStep(step: StoreManagerPlaybookStep): Record<string, unknown> | null {
  if (step.kind === 'read' || step.kind === 'execute') return step.inputTemplate;
  return null;
}

/** Resolve a tool with the registry; reject unknown tools and version drift. */
function requireTool(
  ref: StoreManagerPlaybookToolRef,
  resolve: StoreManagerPlaybookToolResolver,
  stepId: string,
): StoreManagerPlaybookToolMetadata {
  const meta = resolve(ref.toolName, ref.toolVersion);
  if (!meta) {
    throw new StoreManagerPlaybookValidationError(
      'unknown_tool',
      `Step "${stepId}" references unregistered tool "${ref.toolName}".`,
      stepId,
    );
  }
  if (meta.version !== ref.toolVersion) {
    throw new StoreManagerPlaybookValidationError(
      'tool_version_drift',
      `Step "${stepId}" references "${ref.toolName}" v${ref.toolVersion} but the current registry has v${meta.version}.`,
      stepId,
    );
  }
  return meta;
}

function scopeCompatible(
  playbookKinds: readonly string[],
  toolSupportedScopes: readonly string[] | undefined,
): boolean {
  if (toolSupportedScopes === undefined) return true; // legacy adapter: no declaration
  if (playbookKinds.length === 0) return true; // catalog-wide run: no pin to violate
  if (toolSupportedScopes.length === 0) return false; // catalog-wide-only tool under a pinned scope
  return toolSupportedScopes.some((kind) => playbookKinds.includes(kind));
}

/**
 * Validate a playbook definition against the current registry. Throws
 * `StoreManagerPlaybookValidationError` on the first failure; returns the
 * static risk shape on success.
 */
export function validateStoreManagerPlaybook(
  definition: StoreManagerPlaybookDefinition,
  resolve: StoreManagerPlaybookToolResolver,
): StoreManagerPlaybookStaticRisk {
  const steps = definition.steps;
  const variables = new Map<string, StoreManagerPlaybookVariable>(
    definition.variables.map((v) => [v.name, v]),
  );

  // --- identity / structure -------------------------------------------------
  if (new Set(steps.map((s) => s.stepId)).size !== steps.length) {
    throw new StoreManagerPlaybookValidationError(
      'duplicate_step_id',
      'Playbook steps must have unique stepId values.',
    );
  }
  if (definition.scopeInput.allowedKinds.length === 0 && definition.scopeInput.maxSkus > 0) {
    // Allowed: catalog-wide playbooks keep the SKU cap harmless.
  }

  // --- dependency graph: no cycles, no forward/self/unknown references -------
  const indexById = new Map(steps.map((s, i) => [s.stepId, i]));
  const inDegree = new Map(steps.map((s) => [s.stepId, 0]));
  for (const step of steps) {
    for (const dep of step.dependsOnStepIds ?? []) {
      if (!indexById.has(dep)) {
        throw new StoreManagerPlaybookValidationError(
          'unknown_dependency',
          `Step "${step.stepId}" depends on unknown step "${dep}".`,
          step.stepId,
        );
      }
      if (dep === step.stepId) {
        throw new StoreManagerPlaybookValidationError(
          'step_cycle',
          `Step "${step.stepId}" depends on itself.`,
          step.stepId,
        );
      }
      if (indexById.get(dep)! >= indexById.get(step.stepId)!) {
        throw new StoreManagerPlaybookValidationError(
          'forward_dependency',
          `Step "${step.stepId}" depends on a later step "${dep}" (forward/cyclic dependency).`,
          step.stepId,
        );
      }
      inDegree.set(step.stepId, (inDegree.get(step.stepId) ?? 0) + 1);
    }
  }
  // Kahn cycle check (belt and suspenders for forward-reference topology).
  {
    const queue = steps.filter((s) => (inDegree.get(s.stepId) ?? 0) === 0).map((s) => s.stepId);
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const step of steps) {
        if (step.dependsOnStepIds?.includes(id)) {
          inDegree.set(step.stepId, (inDegree.get(step.stepId) ?? 0) - 1);
          if ((inDegree.get(step.stepId) ?? 0) === 0) queue.push(step.stepId);
        }
      }
    }
    if (seen.size !== steps.length) {
      throw new StoreManagerPlaybookValidationError(
        'step_cycle',
        'Playbook step dependencies contain a cycle.',
      );
    }
  }

  // --- tool resolution + risk computation + scope compatibility ---------------
  const riskClasses = new Set<StoreManagerPlaybookStaticRisk['riskClasses'][number]>();
  const expectedApprovals: { toolName: string; toolVersion: number }[] = [];
  const toolVersionByName = new Map<string, number>();
  const mixedToolVersions = new Set<string>();
  let networkActivity: 'none' | 'bounded' = 'none';
  let hasMutationStep = false;
  let hasVerifyStep = false;
  const expectedDiffKinds = new Set<'diff' | 'verification_diff'>();

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const refs = toolRefsOfStep(step);
    for (const ref of refs) {
      const meta = requireTool(ref, resolve, step.stepId);
      riskClasses.add(meta.riskClass);
      const existing = toolVersionByName.get(ref.toolName);
      if (existing !== undefined && existing !== ref.toolVersion) {
        mixedToolVersions.add(ref.toolName);
      }
      toolVersionByName.set(ref.toolName, ref.toolVersion);
      if (!scopeCompatible(definition.scopeInput.allowedKinds, meta.supportedScopes)) {
        throw new StoreManagerPlaybookValidationError(
          'scope_mismatch',
          `Tool "${ref.toolName}" (step "${step.stepId}") cannot honor the playbook's pinned scope kinds.`,
          step.stepId,
        );
      }
    }

    switch (step.kind) {
      case 'read': {
        const meta = requireTool({ toolName: step.toolName, toolVersion: step.toolVersion }, resolve, step.stepId);
        if (meta.riskClass !== 'read') {
          throw new StoreManagerPlaybookValidationError(
            'read_step_requires_read_tool',
            `Step "${step.stepId}" is a read step but "${step.toolName}" is risk class "${meta.riskClass}".`,
            step.stepId,
          );
        }
        break;
      }
      case 'summarize':
        break;
      case 'propose': {
        if (step.mode === 'persistent_stored' && step.proposalWriteRiskDeclared !== true) {
          throw new StoreManagerPlaybookValidationError(
            'missing_proposal_risk_declaration',
            `Step "${step.stepId}" declares a persistent stored proposal without explicitly declaring the proposal-write risk.`,
            step.stepId,
          );
        }
        if (step.mode === 'persistent_stored') {
          riskClasses.add('proposal_write');
        }
        break;
      }
      case 'approval_checkpoint': {
        if (step.diffRequired !== true) {
          throw new StoreManagerPlaybookValidationError(
            'approval_without_diff',
            `Step "${step.stepId}" is an approval checkpoint without a mandatory diff.`,
            step.stepId,
          );
        }
        break;
      }
      case 'execute': {
        hasMutationStep = true;
        const meta = requireTool({ toolName: step.toolName, toolVersion: step.toolVersion }, resolve, step.stepId);
        if (meta.riskClass === 'read') {
          throw new StoreManagerPlaybookValidationError(
            'execute_requires_persistent_tool',
            `Step "${step.stepId}" is an execute step but "${step.toolName}" is read-only; only persistent tools may be executed.`,
            step.stepId,
          );
        }
        if (step.declaredRiskClass !== undefined && step.declaredRiskClass !== meta.riskClass) {
          throw new StoreManagerPlaybookValidationError(
            'risk_downgrade_forgery',
            `Step "${step.stepId}" claims risk class "${step.declaredRiskClass}" for "${step.toolName}" but the registry says "${meta.riskClass}".`,
            step.stepId,
          );
        }
        if (networkActivity === 'none' && meta.riskClass === 'network_filesystem_repair') {
          networkActivity = 'bounded';
        }
        expectedApprovals.push({ toolName: step.toolName, toolVersion: step.toolVersion });
        expectedDiffKinds.add('diff');
        break;
      }
      case 'verify': {
        hasVerifyStep = true;
        expectedDiffKinds.add('verification_diff');
        for (const ref of step.toolNames) {
          const verifyMeta = requireTool(ref, resolve, step.stepId);
          if (verifyMeta.riskClass !== 'read') {
            throw new StoreManagerPlaybookValidationError(
              'verify_requires_read_tools',
              `Step "${step.stepId}" verify references non-read tool "${ref.toolName}".`,
              step.stepId,
            );
          }
        }
        break;
      }
    }
  }

  // --- cross-step rules ------------------------------------------------------
  // Mutation before approval: every execute step must be immediately preceded
  // by an approval_checkpoint (or depend on one declared earlier).
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.kind !== 'execute') continue;
    const preceding = i > 0 ? steps[i - 1] : null;
    const hasCheckpointDep =
      step.dependsOnStepIds?.some(
        (dep) => steps[indexById.get(dep)!].kind === 'approval_checkpoint',
      ) ?? false;
    if (!hasCheckpointDep && preceding?.kind !== 'approval_checkpoint') {
      throw new StoreManagerPlaybookValidationError(
        'missing_approval_before_mutation',
        `Step "${step.stepId}" mutates via "${step.toolName}" but is not immediately preceded by an approval checkpoint bound to a diff.`,
        step.stepId,
      );
    }
  }
  // Missing verification: any mutation step requires a verify step AFTER it.
  let lastMutationIndex = -1;
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i].kind === 'execute') lastMutationIndex = i;
  }
  if (lastMutationIndex >= 0) {
    let verifyAfter = false;
    for (let i = lastMutationIndex + 1; i < steps.length; i += 1) {
      if (steps[i].kind === 'verify') verifyAfter = true;
    }
    if (!verifyAfter) {
      throw new StoreManagerPlaybookValidationError(
        'missing_verification',
        'Playbook contains a mutation step but no verify step after it.',
      );
    }
  }

  // --- variable validation -----------------------------------------------------
  for (const step of steps) {
    const template = inputTemplateOfStep(step);
    if (!template) continue;
    const refs = new Set<string>();
    collectVariableReferences(template, refs);
    for (const ref of refs) {
      if (!variables.has(ref)) {
        throw new StoreManagerPlaybookValidationError(
          'unknown_variable',
          `Step "${step.stepId}" references undeclared variable "{{${ref}}}".`,
          step.stepId,
        );
      }
    }
  }
  // Scope fan-out bound: a playbook that pins sku_set must not declare more
  // SKUs than the cap (schema default enforces the cap on the scope contract).
  if (
    definition.scopeInput.allowedKinds.includes('sku_set') &&
    definition.scopeInput.maxSkus > STORE_MANAGER_SKU_CAP_DEFAULT
  ) {
    throw new StoreManagerPlaybookValidationError(
      'unbounded_fan_out',
      `Playbook pins sku_set scope with maxSkus ${definition.scopeInput.maxSkus} exceeding the bound ${STORE_MANAGER_SKU_CAP_DEFAULT}.`,
    );
  }
  if (mixedToolVersions.size > 0) {
    throw new StoreManagerPlaybookValidationError(
      'mixed_tool_versions',
      `Playbook references the same tool with inconsistent versions: ${[...mixedToolVersions].join(', ')}.`,
    );
  }

  return {
    riskClasses: [...riskClasses],
    expectedApprovals,
    networkActivity,
    expectedDiffKinds: [...expectedDiffKinds],
    hasMutationStep,
    hasVerifyStep,
    mixedToolVersions: [],
  };
}

/** Default SKU cap (mirrors the shared bounds constant). */
const STORE_MANAGER_SKU_CAP_DEFAULT = 200;

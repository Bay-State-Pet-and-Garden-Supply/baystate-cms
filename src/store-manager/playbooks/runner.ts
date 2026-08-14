/**
 * Store Manager playbook runner (operations console, Issue 7).
 *
 * Executes immutable, registry-validated playbook definitions ONE STEP AT A
 * TIME. Every executable step invokes `runStoreManagerExecution` with
 * entrypoint `playbook` and exact playbook lineage — the runner NEVER calls an
 * adapter `.execute` directly. Approval checkpoints pause the run with a
 * deterministic action diff; only a fresh operator approval bound to the exact
 * diff hash resumes it (the runner passes server-recorded approvals into the
 * execution context; it never synthesizes approval messages). Verify steps
 * force declared read tools through the registry and persist an authoritative
 * verification diff — a tool success result alone is never "verified".
 */

import { randomUUID } from 'node:crypto';
import type { ResolvedAiSdkModel } from '../../server/services/ai-sdk-model-resolver';
import { runStoreManagerExecution, type StoreManagerExecutionResult } from '../runtime/executor';
import { createStoreManagerExecutionRequest } from '../runtime/execution-request';
import { StoreManagerToolRegistry, createStoreManagerToolRegistry } from '../runtime/tool-registry';
import { computeAdapterPreviewDiff, playbookToolCallId } from '../runtime/action-preview';
import { buildStoreManagerActionDiff } from '../runtime/action-preview';
import { hashCanonicalJson } from '../../shared/stable-id';
import { StoreManagerPlaybookDefinitionSchema, type StoreManagerPlaybookDefinition, type StoreManagerPlaybookStep } from '../../shared/schemas/store-manager-playbook';
import { validateStoreManagerPlaybook } from './validator';
import { getPlaybookForWorkspace, getPlaybookVersionForWorkspace } from '../../db/repositories/store-manager-playbook-repo';
import {
  createStoreManagerPlaybookRun,
  createStoreManagerPlaybookStep,
  getStoreManagerPlaybookRun,
  listStoreManagerPlaybookSteps,
  updateStoreManagerPlaybookRunStatus,
  updateStoreManagerPlaybookStep,
  claimStoreManagerPlaybookRun,
  releaseStoreManagerPlaybookRun,
  type StoreManagerPlaybookRunRow,
  type StoreManagerPlaybookStepRow,
} from '../../db/repositories/store-manager-playbook-run-repo';
import { createStoreManagerRunArtifact } from '../../db/repositories/store-manager-session-repo';
import { createStoreManagerArtifact } from '../runtime/artifacts';
import { getStoreManagerEvents } from '../../db/repositories/store-manager-session-repo';
import { getStoreManagerFlags } from '../flags';
import { listRegistry } from '../../db/repositories/field-registry-repo';

export class StoreManagerPlaybookRunError extends Error {
  readonly code:
    | 'playbook_not_found'
    | 'version_not_found'
    | 'not_active'
    | 'definition_tampered'
    | 'validation_failed'
    | 'variables_invalid'
    | 'run_not_found'
    | 'run_not_paused'
    | 'checkpoint_mismatch'
    | 'approval_required'
    | 'approval_expired'
    | 'lease_conflict'
    | 'step_failed'
    | 'disabled';
  constructor(code: StoreManagerPlaybookRunError['code'], message: string) {
    super(message);
    this.name = 'StoreManagerPlaybookRunError';
    this.code = code;
  }
}

export interface RunPlaybookOptions {
  workspaceId: string;
  workspacePath: string;
  playbookId: string;
  /** Defaults to the active version. */
  version?: number;
  variables: Record<string, unknown>;
  runId?: string;
  /** `operator` only can approve checkpoints; schedule/event actors never can. */
  actor?: string;
  registry?: StoreManagerToolRegistry;
  resolveModel?: (selectedModel?: string) => ResolvedAiSdkModel;
  now?: () => Date;
  policyOverrides?: Record<string, number>;
}

export interface StoreManagerPlaybookStepView {
  stepId: string;
  kind: StoreManagerPlaybookStep['kind'];
  status: StoreManagerPlaybookStepRow['status'];
  toolName: string | null;
  diffHash: string | null;
  executionRunId: string | null;
  output: unknown;
  errorCode: string | null;
  approvalRequired: boolean;
}

export interface StoreManagerPlaybookRunResult {
  runId: string;
  playbookId: string;
  version: number;
  status: 'running' | 'paused_at_checkpoint' | 'completed' | 'failed';
  currentStepId: string | null;
  steps: StoreManagerPlaybookStepView[];
  checkpoint:
    | {
        stepId: string;
        toolName: string;
        toolCallId: string;
        diffHash: string;
        expiresAtMs: number;
      }
    | null;
  errorCode: string | null;
}

const CHECKPOINT_APPROVAL_MS = 30 * 60 * 1000;
const LEASE_MS = 10 * 60 * 1000;
const MAX_VARIABLES = 10;

function nowMs(deps: { now?: () => Date }): number {
  return (deps.now?.() ?? new Date()).getTime();
}

// ---------------------------------------------------------------------------
// Definition loading + validation
// ---------------------------------------------------------------------------

function loadActiveDefinition(
  workspaceId: string,
  playbookId: string,
  version: number | undefined,
  registry: StoreManagerToolRegistry,
): { definition: StoreManagerPlaybookDefinition; version: number } {
  const playbook = getPlaybookForWorkspace(workspaceId, playbookId);
  if (!playbook) {
    throw new StoreManagerPlaybookRunError('playbook_not_found', 'Playbook not found in this workspace.');
  }
  if (playbook.status !== 'active' || playbook.activeVersion === null) {
    throw new StoreManagerPlaybookRunError(
      'not_active',
      'Playbook is not active; activate an immutable version before running.',
    );
  }
  const effectiveVersion = version ?? playbook.activeVersion;
  const versionRow = getPlaybookVersionForWorkspace(workspaceId, playbookId, effectiveVersion);
  if (!versionRow) {
    throw new StoreManagerPlaybookRunError('version_not_found', 'Playbook version not found in this workspace.');
  }
  const parsed = StoreManagerPlaybookDefinitionSchema.safeParse(JSON.parse(versionRow.definitionJson));
  if (!parsed.success || parsed.data.definitionHash !== versionRow.definitionHash) {
    throw new StoreManagerPlaybookRunError(
      'definition_tampered',
      'Playbook version content does not match its recorded hash (tamper detected).',
    );
  }
  // Re-validate against the CURRENT registry: version drift / risk downgrade /
  // unregistered tools fail closed at run time as well as at activation time.
  const resolver = registry.playbookResolver();
  validateStoreManagerPlaybook(parsed.data, resolver);
  return { definition: parsed.data, version: effectiveVersion };
}

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

function resolveVariables(
  definition: StoreManagerPlaybookDefinition,
  variables: Record<string, unknown>,
  workspaceId: string,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const variable of definition.variables.slice(0, MAX_VARIABLES)) {
    const value = variables[variable.name];
    if (value === undefined) {
      if (variable.required) {
        throw new StoreManagerPlaybookRunError(
          'variables_invalid',
          `Playbook requires variable "${variable.name}".`,
        );
      }
      continue;
    }
    switch (variable.type) {
      case 'string':
        if (typeof value !== 'string' || value.length === 0 || value.length > 500) {
          throw new StoreManagerPlaybookRunError('variables_invalid', `Variable "${variable.name}" must be a bounded string.`);
        }
        resolved[variable.name] = value;
        break;
      case 'product_field': {
        if (typeof value !== 'string' || value.length > 200) {
          throw new StoreManagerPlaybookRunError('variables_invalid', `Variable "${variable.name}" must be a ProductField identifier.`);
        }
        const known = listRegistry(workspaceId).some((f) => f.xmlField === value);
        if (!known) {
          throw new StoreManagerPlaybookRunError(
            'variables_invalid',
            `Variable "${variable.name}" is not a registered ProductField in this workspace.`,
          );
        }
        resolved[variable.name] = value;
        break;
      }
      case 'change_set_id':
      case 'sku':
      case 'vendor_id':
        if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
          throw new StoreManagerPlaybookRunError('variables_invalid', `Variable "${variable.name}" must be a bounded identifier.`);
        }
        resolved[variable.name] = value;
        break;
    }
  }
  return resolved;
}

const VARIABLE_REFERENCE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function interpolateTemplate(template: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  const interpolate = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(VARIABLE_REFERENCE, (_match, name: string) => {
        if (!(name in variables)) throw new StoreManagerPlaybookRunError('variables_invalid', `Unknown variable "{{${name}}}".`);
        return String(variables[name]);
      });
    }
    if (Array.isArray(value)) return value.map(interpolate);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolate(v);
      return out;
    }
    return value;
  };
  return interpolate(template) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Single-step execution through the common runner
// ---------------------------------------------------------------------------

interface StepExecution {
  result: StoreManagerExecutionResult;
  expectedToolCalled: boolean;
  inputMatched: boolean;
}

async function executeStepRun(
  opts: {
    workspaceId: string;
    workspacePath: string;
    playbookId: string;
    playbookVersion: number;
    step: StoreManagerPlaybookStep;
    objective: string;
    expectedToolName: string;
    expectedInput: Record<string, unknown>;
    registry: StoreManagerToolRegistry;
    resolveModel?: (selectedModel?: string) => ResolvedAiSdkModel;
    now?: () => Date;
    policyOverrides?: Record<string, number>;
    serverApprovedCalls?: ReadonlyArray<{ toolCallId: string; approvalId: string; diffHash: string; expiresAt: number }>;
    boundDiffHashes?: ReadonlyMap<string, string>;
  },
): Promise<StepExecution> {
  // Each step is its own bounded execution run (fresh session id) so step
  // runs never collide and each one carries exact playbook lineage.
  const executionRunId = randomUUID();
  const request = createStoreManagerExecutionRequest({
    workspaceId: opts.workspaceId,
    workspacePath: opts.workspacePath,
    threadId: null,
    runId: executionRunId,
    entrypoint: 'playbook',
    executionMode: 'interactive',
    objective: opts.objective.slice(0, 2000),
    lineage: {
      playbookId: opts.playbookId,
      playbookVersion: opts.playbookVersion,
      stepId: opts.step.stepId,
      stepKind: opts.step.kind,
    },
  });
  const result = await runStoreManagerExecution(request, {
    registry: opts.registry,
    resolveModel: opts.resolveModel,
    now: opts.now,
    policyOverrides: opts.policyOverrides,
    executionContextExtras: {
      serverApprovedCalls: opts.serverApprovedCalls,
      boundDiffHashes: opts.boundDiffHashes,
    },
  });

  const expectedDigest = hashCanonicalJson(opts.expectedInput);
  let expectedToolCalled = false;
  let inputMatched = false;
  if (result.kind === 'completed') {
    const events = getStoreManagerEvents(opts.workspaceId, executionRunId);
    for (const event of events) {
      if (event.type === 'tool_dispatched' && event.toolName === opts.expectedToolName) {
        expectedToolCalled = true;
        if (event.inputDigest === expectedDigest) inputMatched = true;
      }
    }
  }
  return { result, expectedToolCalled, inputMatched };
}

// ---------------------------------------------------------------------------
// Step loop (shared by fresh runs and resumes)
// ---------------------------------------------------------------------------

async function runStepsFrom(
  opts: {
    workspaceId: string;
    workspacePath: string;
    runId: string;
    playbookId: string;
    definition: StoreManagerPlaybookDefinition;
    version: number;
    variables: Record<string, unknown>;
    registry: StoreManagerToolRegistry;
    resolveModel?: (selectedModel?: string) => ResolvedAiSdkModel;
    now?: () => Date;
    policyOverrides?: Record<string, number>;
    resumeFromIndex: number;
    checkpointApproval: { toolCallId: string; approvalId: string; diffHash: string; expiresAt: number } | null;
  },
): Promise<StoreManagerPlaybookRunResult> {
  const {
    workspaceId,
    workspacePath,
    runId,
    playbookId,
    definition,
    version,
    variables,
    registry,
    resumeFromIndex,
  } = opts;
  const steps = definition.steps;

  const markRunning = (stepId: string) =>
    updateStoreManagerPlaybookStep(workspaceId, runId, stepId, { status: 'running' });

  const failStep = (stepId: string, errorCode: string) =>
    updateStoreManagerPlaybookStep(workspaceId, runId, stepId, { status: 'failed', errorCode });

  for (let i = resumeFromIndex; i < steps.length; i += 1) {
    const step = steps[i];
    markRunning(step.stepId);
    updateStoreManagerPlaybookRunStatus(workspaceId, runId, 'running', { currentStepId: step.stepId });

    switch (step.kind) {
      case 'read': {
        const expectedInput = interpolateTemplate(step.inputTemplate, variables);
        const execution = await executeStepRun({
          workspaceId,
          workspacePath,
          playbookId,
          playbookVersion: version,
          step,
          objective: `Playbook step contract:\nstep: ${step.stepId}\nkind: read\ntool: ${step.toolName}\ninput: ${JSON.stringify(expectedInput)}\nCall the tool exactly once with that exact input and report the output.`,
          expectedToolName: step.toolName,
          expectedInput,
          registry,
          resolveModel: opts.resolveModel,
          now: opts.now,
          policyOverrides: opts.policyOverrides,
        });
        if (execution.result.kind !== 'completed') {
          failStep(step.stepId, 'step_run_aborted');
          throw new StoreManagerPlaybookRunError('step_failed', `Playbook step "${step.stepId}" did not complete.`);
        }
        if (!execution.expectedToolCalled || !execution.inputMatched) {
          failStep(step.stepId, 'step_contract_violation');
          throw new StoreManagerPlaybookRunError(
            'step_failed',
            `Playbook step "${step.stepId}" did not call "${step.toolName}" with the declared input.`,
          );
        }
        const output = execution.result.output.toolResults.find((t) => t.toolName === step.toolName);
        updateStoreManagerPlaybookStep(workspaceId, runId, step.stepId, {
          status: 'executed',
          executionRunId: execution.result.runId,
          output: output?.output ?? { success: true },
        });
        break;
      }

      case 'summarize': {
        const priorOutputs = listStoreManagerPlaybookSteps(workspaceId, runId)
          .filter((s) => s.step_id !== step.stepId && s.output_json)
          .slice(-5)
          .map((s) => ({ stepId: s.step_id, output: JSON.parse(s.output_json!) }));
        if (step.mode === 'model_bounded') {
          const execution = await executeStepRun({
            workspaceId,
            workspacePath,
            playbookId,
            playbookVersion: version,
            step,
            objective: `Playbook step contract:\nstep: ${step.stepId}\nkind: summarize\nmode: model_bounded\nSummarize the prior structured step outputs without inventing facts.`,
            expectedToolName: '__summarize_no_tool__',
            expectedInput: {},
            registry,
            resolveModel: opts.resolveModel,
            now: opts.now,
            policyOverrides: opts.policyOverrides,
          });
          const summary = execution.result.kind === 'completed' ? execution.result.output.text : '';
          const artifact = createStoreManagerArtifact({
            runId,
            workspaceId,
            kind: 'report',
            schemaVersion: 1,
            content: { mode: 'model_bounded', summary: summary.slice(0, 4000) },
          });
          createStoreManagerRunArtifact({
            workspaceId,
            runId,
            kind: 'report',
            schemaVersion: 1,
            contentJson: JSON.stringify({ mode: 'model_bounded', summary: summary.slice(0, 4000) }),
            contentHash: artifact.contentHash,
            id: artifact.id,
            createdAt: artifact.createdAt,
          });
          updateStoreManagerPlaybookStep(workspaceId, runId, step.stepId, {
            status: 'executed',
            output: { mode: 'model_bounded', summary: summary.slice(0, 4000) },
            artifactId: artifact.id,
          });
        } else {
          // deterministic aggregation
          const artifactContent = { mode: 'deterministic', outputs: priorOutputs.slice(0, 10) };
          const artifact = createStoreManagerArtifact({
            runId,
            workspaceId,
            kind: 'report',
            schemaVersion: 1,
            content: artifactContent,
          });
          createStoreManagerRunArtifact({
            workspaceId,
            runId,
            kind: 'report',
            schemaVersion: 1,
            contentJson: JSON.stringify(artifactContent),
            contentHash: artifact.contentHash,
            id: artifact.id,
            createdAt: artifact.createdAt,
          });
          updateStoreManagerPlaybookStep(workspaceId, runId, step.stepId, {
            status: 'executed',
            output: artifactContent,
            artifactId: artifact.id,
          });
        }
        break;
      }

      case 'propose': {
        if (step.mode === 'transient_preview') {
          const artifact = createStoreManagerArtifact({
            runId,
            workspaceId,
            kind: 'candidate_proposal_set',
            schemaVersion: 1,
            content: { mode: 'transient_preview', note: 'transient preview only; nothing stored' },
          });
          createStoreManagerRunArtifact({
            workspaceId,
            runId,
            kind: 'candidate_proposal_set',
            schemaVersion: 1,
            contentJson: JSON.stringify({ mode: 'transient_preview', note: 'transient preview only; nothing stored' }),
            contentHash: artifact.contentHash,
            id: artifact.id,
            createdAt: artifact.createdAt,
          });
          updateStoreManagerPlaybookStep(workspaceId, runId, step.stepId, {
            status: 'executed',
            artifactId: artifact.id,
            output: { mode: 'transient_preview' },
          });
          break;
        }
        // persistent_stored: behaves like an execute step for the proposal tool,
        // requiring the immediately-preceding approved checkpoint.
        const expectedInput: Record<string, unknown> = {};
        const toolName = 'store_product_field_normalization_proposals';
        const field = variables[definition.variables.find((v) => v.type === 'product_field')?.name ?? '__none__'];
        if (typeof field === 'string') {
          expectedInput.field = field;
        }
        if (opts.checkpointApproval) {
          const execution = await executeStepRun({
            workspaceId,
            workspacePath,
            playbookId,
            playbookVersion: version,
            step,
            objective: `Playbook step contract:\nstep: ${step.stepId}\nkind: propose\nmode: persistent_stored\ntool: ${toolName}\ntoolCallId: ${opts.checkpointApproval.toolCallId}\ninput: ${JSON.stringify(expectedInput)}\nCall the tool exactly once with that exact toolCallId and input, and report the output.`,
            expectedToolName: toolName,
            expectedInput,
            registry,
            resolveModel: opts.resolveModel,
            now: opts.now,
            policyOverrides: opts.policyOverrides,
            serverApprovedCalls: [opts.checkpointApproval],
            boundDiffHashes: new Map([[opts.checkpointApproval.toolCallId, opts.checkpointApproval.diffHash]]),
          });
          updateStoreManagerPlaybookStep(workspaceId, runId, step.stepId, {
            status: 'executed',
            executionRunId: execution.result.kind === 'completed' ? execution.result.runId : null,
            output: execution.result.kind === 'completed' ? execution.result.output.toolResults.find((t) => t.toolName === toolName)?.output : undefined,
          });
          opts.checkpointApproval = null; // single-use
        } else {
          failStep(step.stepId, 'approval_required');
          throw new StoreManagerPlaybookRunError(
            'approval_required',
            `Persistent propose step "${step.stepId}" requires an approved checkpoint.`,
          );
        }
        break;
      }

      case 'approval_checkpoint': {
        // Build the deterministic diff for the tool of the NEXT persistent step.
        const nextStep = steps[i + 1];
        if (!nextStep) {
          failStep(step.stepId, 'checkpoint_without_target');
          throw new StoreManagerPlaybookRunError('step_failed', `Approval checkpoint "${step.stepId}" has no following step to approve.`);
        }
        const isPersistentNext =
          nextStep.kind === 'execute' || (nextStep.kind === 'propose' && nextStep.mode === 'persistent_stored');
        if (!isPersistentNext) {
          failStep(step.stepId, 'checkpoint_not_preceding_mutation');
          throw new StoreManagerPlaybookRunError(
            'step_failed',
            `Approval checkpoint "${step.stepId}" must precede a persistent step (execute or persistent_stored propose).`,
          );
        }
        const targetToolName = nextStep.kind === 'execute' ? nextStep.toolName : 'store_product_field_normalization_proposals';
        const adapter = registry.get(targetToolName);
        const targetInput =
          nextStep.kind === 'execute' ? interpolateTemplate(nextStep.inputTemplate, variables) : {};
        const toolCallId = playbookToolCallId(runId, step.stepId);
        let diffHash = '';
        if (adapter && adapter.previewDiff) {
          const diff = await computeAdapterPreviewDiff(adapter, targetInput, {
            workspaceId,
            workspacePath,
            sessionId: runId,
            executionId: runId,
            deadlineAt: nowMs(opts) + LEASE_MS,
            pinnedScope: null,
            entrypoint: 'playbook',
            emit: () => undefined,
          });
          if (diff) {
            diffHash = diff.diffHash;
            const artifact = createStoreManagerArtifact({
              runId,
              workspaceId,
              kind: 'diff',
              schemaVersion: 1,
              content: diff,
            });
            createStoreManagerRunArtifact({
              workspaceId,
              runId,
              kind: 'diff',
              schemaVersion: 1,
              contentJson: JSON.stringify(diff),
              contentHash: artifact.contentHash,
              id: artifact.id,
              createdAt: artifact.createdAt,
            });
            updateStoreManagerPlaybookStep(workspaceId, runId, step.stepId, { artifactId: artifact.id });
          }
        }
        const expiresAt = nowMs(opts) + CHECKPOINT_APPROVAL_MS;
        updateStoreManagerPlaybookStep(workspaceId, runId, step.stepId, {
          status: 'waiting_approval',
          toolCallId,
          diffHash,
          approvalExpiresAt: new Date(expiresAt).toISOString(),
        });
        updateStoreManagerPlaybookRunStatus(workspaceId, runId, 'paused_at_checkpoint', {
          currentStepId: step.stepId,
        });
        releaseStoreManagerPlaybookRun(workspaceId, runId);
        return buildResult(workspaceId, runId, playbookId, version, 'paused_at_checkpoint', step.stepId, {
          stepId: step.stepId,
          toolName: targetToolName,
          toolCallId,
          diffHash,
          expiresAtMs: expiresAt,
        });
      }

      case 'execute': {
        const expectedInput = interpolateTemplate(step.inputTemplate, variables);
        if (!opts.checkpointApproval) {
          failStep(step.stepId, 'approval_required');
          throw new StoreManagerPlaybookRunError(
            'approval_required',
            `Execute step "${step.stepId}" requires an approved checkpoint bound to its diff.`,
          );
        }
        const execution = await executeStepRun({
          workspaceId,
          workspacePath,
          playbookId,
          playbookVersion: version,
          step,
          objective: `Playbook step contract:\nstep: ${step.stepId}\nkind: execute\ntool: ${step.toolName}\ntoolCallId: ${opts.checkpointApproval.toolCallId}\ninput: ${JSON.stringify(expectedInput)}\nCall the persistent tool exactly once with that exact toolCallId and input, and report the output exactly.`,
          expectedToolName: step.toolName,
          expectedInput,
          registry,
          resolveModel: opts.resolveModel,
          now: opts.now,
          policyOverrides: opts.policyOverrides,
          serverApprovedCalls: [opts.checkpointApproval],
          boundDiffHashes: new Map([[opts.checkpointApproval.toolCallId, opts.checkpointApproval.diffHash]]),
        });
        if (!execution.expectedToolCalled || !execution.inputMatched) {
          failStep(step.stepId, 'step_contract_violation');
          throw new StoreManagerPlaybookRunError(
            'step_failed',
            `Playbook step "${step.stepId}" did not call "${step.toolName}" with the declared input.`,
          );
        }
        const output = execution.result.kind === 'completed' ? execution.result.output.toolResults.find((t) => t.toolName === step.toolName)?.output : undefined;
        updateStoreManagerPlaybookStep(workspaceId, runId, step.stepId, {
          status: 'executed',
          executionRunId: execution.result.kind === 'completed' ? execution.result.runId : null,
          output: output ?? { success: true },
        });
        opts.checkpointApproval = null; // single-use consumed
        break;
      }

      case 'verify': {
        // Force declared verification reads through the registry (one run per
        // declared read tool is the safe, bounded choice for Issue 7).
        const verifyOutputs: unknown[] = [];
        for (const ref of step.toolNames) {
          const execution = await executeStepRun({
            workspaceId,
            workspacePath,
            playbookId,
            playbookVersion: version,
            step,
            objective: `Playbook step contract:\nstep: ${step.stepId}\nkind: verify\ntool: ${ref.toolName}\nCall the read tool and report its output for verification.`,
            expectedToolName: ref.toolName,
            expectedInput: {},
            registry,
            resolveModel: opts.resolveModel,
            now: opts.now,
            policyOverrides: opts.policyOverrides,
          });
          if (!execution.expectedToolCalled) {
            failStep(step.stepId, 'verify_contract_violation');
            throw new StoreManagerPlaybookRunError(
              'step_failed',
              `Verify step "${step.stepId}" did not call the declared read tool "${ref.toolName}".`,
            );
          }
          if (execution.result.kind === 'completed') {
            const output = execution.result.output.toolResults.find((t) => t.toolName === ref.toolName)?.output;
            if (output !== undefined) verifyOutputs.push(output);
          }
        }
        updateStoreManagerPlaybookStep(workspaceId, runId, step.stepId, {
          output: verifyOutputs.slice(0, 20),
        });
        // Authoritative verification diff derived from the verify read outputs
        // (bounded). A tool success result alone is never "verified" without
        // this artifact.
        const verifyOutputsForDiff = executionOutputsForStep(workspaceId, runId, step.stepId);
        const itemCount = findItemCount(verifyOutputs);
        const verifiedSkus = findSkus(verifyOutputs);
        const verification = {
          schemaVersion: 1 as const,
          runId,
          turnId: null,
          toolName: step.toolNames[0]?.toolName ?? 'verify',
          toolVersion: step.toolNames[0]?.toolVersion ?? 1,
          workspaceId,
          scopeHash: null,
          verifiedSkuCount: itemCount,
          perSku: verifiedSkus.slice(0, 200),
          perSkuTruncated: verifiedSkus.length > 200,
          changeSet: null,
          verificationHash: hashCanonicalJson({
            toolName: step.toolNames[0]?.toolName ?? 'verify',
            verifiedSkuCount: itemCount,
            perSku: verifiedSkus.slice(0, 200),
          }),
          generatedAt: (opts.now?.() ?? new Date()).toISOString(),
        };
        const artifact = createStoreManagerArtifact({
          runId,
          workspaceId,
          kind: 'verification_diff',
          schemaVersion: 1,
          content: verification,
        });
        createStoreManagerRunArtifact({
          workspaceId,
          runId,
          kind: 'verification_diff',
          schemaVersion: 1,
          contentJson: JSON.stringify(verification),
          contentHash: artifact.contentHash,
          id: artifact.id,
          createdAt: artifact.createdAt,
        });
        updateStoreManagerPlaybookStep(workspaceId, runId, step.stepId, {
          status: 'verified',
          artifactId: artifact.id,
          output: verification,
        });
        break;
      }
    }
  }

  updateStoreManagerPlaybookRunStatus(workspaceId, runId, 'completed', { currentStepId: null });
  releaseStoreManagerPlaybookRun(workspaceId, runId);
  return buildResult(workspaceId, runId, playbookId, version, 'completed', null, null);
}

function executionOutputsForStep(workspaceId: string, runId: string, stepId: string): unknown[] {
  const row = listStoreManagerPlaybookSteps(workspaceId, runId).find((s) => s.step_id === stepId);
  if (!row?.output_json) return [];
  const parsed = JSON.parse(row.output_json) as unknown;
  const outputs = Array.isArray(parsed) ? parsed : [parsed];
  return outputs;
}

function findItemCount(outputs: unknown[]): number {
  for (const output of outputs) {
    if (output && typeof output === 'object') {
      const maybe = (output as Record<string, unknown>).itemCount;
      if (typeof maybe === 'number' && Number.isFinite(maybe)) return Math.max(0, Math.floor(maybe));
    }
  }
  return 0;
}

function findSkus(outputs: unknown[]): Array<{ sku: string; status: 'verified' | 'skipped' | 'error'; note?: string }> {
  const skus: Array<{ sku: string; status: 'verified' | 'skipped' | 'error'; note?: string }> = [];
  for (const output of outputs) {
    if (output && typeof output === 'object') {
      const items = (output as Record<string, unknown>).items;
      if (Array.isArray(items)) {
        for (const item of items) {
          const sku = item && typeof item === 'object' ? (item as Record<string, unknown>).sku : undefined;
          if (typeof sku === 'string' && sku) {
            skus.push({ sku, status: 'verified' });
          }
        }
      }
    }
  }
  return skus;
}

function buildResult(
  workspaceId: string,
  runId: string,
  playbookId: string,
  version: number,
  status: 'running' | 'paused_at_checkpoint' | 'completed' | 'failed',
  currentStepId: string | null,
  checkpoint: StoreManagerPlaybookRunResult['checkpoint'],
): StoreManagerPlaybookRunResult {
  const stepRows = listStoreManagerPlaybookSteps(workspaceId, runId);
  return {
    runId,
    playbookId,
    version,
    status,
    currentStepId,
    steps: stepRows.map((row) => ({
      stepId: row.step_id,
      kind: row.kind as StoreManagerPlaybookStep['kind'],
      status: row.status,
      toolName: row.tool_name,
      diffHash: row.diff_hash,
      executionRunId: row.execution_run_id,
      output: row.output_json ? safeParse(row.output_json) : null,
      errorCode: row.error_code,
      approvalRequired: row.kind === 'execute' || (row.kind === 'propose'),
    })),
    checkpoint,
    errorCode: null,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Start a playbook run. Runs synchronously until the first approval
 * checkpoint (pause) or completion. Throws `StoreManagerPlaybookRunError`
 * fail-closed on definition/tamper/validation/approval problems.
 */
export async function runStoreManagerPlaybook(
  options: RunPlaybookOptions,
): Promise<StoreManagerPlaybookRunResult> {
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.playbooksEnabled) {
    throw new StoreManagerPlaybookRunError(
      'disabled',
      'Playbooks are disabled (flag or kill switch).',
    );
  }
  const registry = options.registry ?? createStoreManagerToolRegistry();
  const { definition, version } = loadActiveDefinition(
    options.workspaceId,
    options.playbookId,
    options.version,
    registry,
  );
  const resolvedVariables = resolveVariables(definition, options.variables, options.workspaceId);
  const runId = options.runId ?? randomUUID();

  createStoreManagerPlaybookRun({
    id: runId,
    workspaceId: options.workspaceId,
    workspacePath: options.workspacePath,
    playbookId: options.playbookId,
    playbookVersion: version,
    definitionHash: definition.definitionHash,
    variables: resolvedVariables,
    scope: null,
    actor: options.actor ?? 'operator',
  });
  for (const step of definition.steps) {
    createStoreManagerPlaybookStep({
      workspaceId: options.workspaceId,
      runId,
      stepId: step.stepId,
      kind: step.kind,
      toolName: step.kind === 'read' || step.kind === 'execute' ? step.toolName : null,
      toolVersion: step.kind === 'read' || step.kind === 'execute' ? step.toolVersion : null,
    });
  }
  claimStoreManagerPlaybookRun(
    options.workspaceId,
    runId,
    `runner:${options.actor ?? 'operator'}`,
    new Date(nowMs(options) + LEASE_MS).toISOString(),
  );

  try {
    return await runStepsFrom({
      workspaceId: options.workspaceId,
      workspacePath: options.workspacePath,
      runId,
      playbookId: options.playbookId,
      definition,
      version,
      variables: resolvedVariables,
      registry,
      resolveModel: options.resolveModel,
      now: options.now,
      policyOverrides: options.policyOverrides,
      resumeFromIndex: 0,
      checkpointApproval: null,
    });
  } catch (err) {
    const run = getStoreManagerPlaybookRun(options.workspaceId, runId);
    if (run && run.status !== 'paused_at_checkpoint') {
      updateStoreManagerPlaybookRunStatus(options.workspaceId, runId, 'failed', {
        errorCode: err instanceof StoreManagerPlaybookRunError ? err.code : 'run_failed',
      });
    }
    releaseStoreManagerPlaybookRun(options.workspaceId, runId);
    throw err;
  }
}

/**
 * Resume a paused playbook run at its approval checkpoint. `approve: true`
 * requires the EXACT diff hash the checkpoint was paused on (binding); the
 * checkpoint then authorizes the following persistent step in one execution
 * context, consumed once. `approve: false` denies and fails the run closed.
 */
export async function resumeStoreManagerPlaybookRun(
  workspaceId: string,
  runId: string,
  options: {
    approve: boolean;
    actor: string;
    diffHash: string;
    registry?: StoreManagerToolRegistry;
    resolveModel?: (selectedModel?: string) => ResolvedAiSdkModel;
    now?: () => Date;
    policyOverrides?: Record<string, number>;
  },
): Promise<StoreManagerPlaybookRunResult> {
  const flags = getStoreManagerFlags();
  if (flags.killSwitch || !flags.playbooksEnabled) {
    throw new StoreManagerPlaybookRunError('disabled', 'Playbooks are disabled (flag or kill switch).');
  }
  const run = getStoreManagerPlaybookRun(workspaceId, runId);
  if (!run) {
    throw new StoreManagerPlaybookRunError('run_not_found', 'Playbook run not found in this workspace.');
  }
  if (run.status !== 'paused_at_checkpoint') {
    throw new StoreManagerPlaybookRunError(
      'run_not_paused',
      'Playbook run is not paused at a checkpoint.',
    );
  }
  const actor = options.actor;
  if (actor !== 'operator') {
    throw new StoreManagerPlaybookRunError(
      'approval_required',
      'Only an operator can approve a playbook checkpoint (schedule/event identities cannot approve).',
    );
  }
  const claimed = claimStoreManagerPlaybookRun(
    workspaceId,
    runId,
    `runner:${actor}`,
    new Date(nowMs(options) + LEASE_MS).toISOString(),
  );
  if (!claimed) {
    throw new StoreManagerPlaybookRunError('lease_conflict', 'Playbook run is claimed by another worker.');
  }

  const steps = listStoreManagerPlaybookSteps(workspaceId, runId);
  const checkpointStep = steps.find((s) => s.status === 'waiting_approval');
  if (!checkpointStep || !checkpointStep.tool_call_id) {
    releaseStoreManagerPlaybookRun(workspaceId, runId);
    throw new StoreManagerPlaybookRunError('run_not_paused', 'No pending checkpoint approval found.');
  }
  if (checkpointStep.approval_expires_at && new Date(checkpointStep.approval_expires_at).getTime() < nowMs(options)) {
    releaseStoreManagerPlaybookRun(workspaceId, runId);
    throw new StoreManagerPlaybookRunError('approval_expired', 'Checkpoint approval has expired; start a fresh run.');
  }

  if (!options.approve) {
    updateStoreManagerPlaybookStep(workspaceId, runId, checkpointStep.step_id, { status: 'denied' });
    updateStoreManagerPlaybookRunStatus(workspaceId, runId, 'failed', {
      currentStepId: checkpointStep.step_id,
      errorCode: 'checkpoint_denied',
    });
    releaseStoreManagerPlaybookRun(workspaceId, runId);
    return {
      runId,
      playbookId: run.playbook_id,
      version: run.playbook_version,
      status: 'failed',
      currentStepId: checkpointStep.step_id,
      steps: buildResult(workspaceId, runId, run.playbook_id, run.playbook_version, 'failed', checkpointStep.step_id, null).steps,
      checkpoint: null,
      errorCode: 'checkpoint_denied',
    };
  }

  // Exact diff binding: the resumed approval must match the paused diff.
  if (checkpointStep.diff_hash && options.diffHash !== checkpointStep.diff_hash) {
    releaseStoreManagerPlaybookRun(workspaceId, runId);
    throw new StoreManagerPlaybookRunError(
      'checkpoint_mismatch',
      'The approval diff hash does not match the paused checkpoint; re-preview and re-approve.',
    );
  }

  const expiresAtMs = nowMs(options) + CHECKPOINT_APPROVAL_MS;
  updateStoreManagerPlaybookStep(workspaceId, runId, checkpointStep.step_id, {
    status: 'approved',
    approvalActor: actor,
    approvalDiffHash: checkpointStep.diff_hash ?? undefined,
    approvalExpiresAt: new Date(expiresAtMs).toISOString(),
  });

  const { definition, version } = loadActiveDefinition(
    workspaceId,
    run.playbook_id,
    run.playbook_version,
    options.registry ?? createStoreManagerToolRegistry(),
  );
  const resumeIndex = definition.steps.findIndex((s) => s.stepId === checkpointStep.step_id) + 1;
  const checkpointApproval = {
    toolCallId: checkpointStep.tool_call_id,
    approvalId: `cp-${runId}:${checkpointStep.step_id}`,
    diffHash: checkpointStep.diff_hash ?? '',
    expiresAt: expiresAtMs,
  };

  try {
    return await runStepsFrom({
      workspaceId,
      workspacePath: run.workspace_path,
      runId,
      playbookId: run.playbook_id,
      definition,
      version,
      variables: safeParse(run.variables_json) as Record<string, unknown>,
      registry: options.registry ?? createStoreManagerToolRegistry(),
      resolveModel: options.resolveModel,
      now: options.now,
      policyOverrides: options.policyOverrides,
      resumeFromIndex: resumeIndex,
      checkpointApproval,
    });
  } catch (err) {
    updateStoreManagerPlaybookRunStatus(workspaceId, runId, 'failed', {
      errorCode: err instanceof StoreManagerPlaybookRunError ? err.code : 'run_failed',
    });
    releaseStoreManagerPlaybookRun(workspaceId, runId);
    throw err;
  }
}

/** Read-only run detail (workspace-scoped; no lease claim). */
export function getStoreManagerPlaybookRunDetail(
  workspaceId: string,
  runId: string,
): { run: StoreManagerPlaybookRunRow | null; steps: StoreManagerPlaybookStepRow[] } {
  return {
    run: getStoreManagerPlaybookRun(workspaceId, runId),
    steps: listStoreManagerPlaybookSteps(workspaceId, runId),
  };
}

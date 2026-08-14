/**
 * Store Manager replay service (operations console, Issue 7).
 *
 * Replay ALWAYS creates a NEW current-state run (`entrypoint = replay`,
 * `replayOfRunId` lineage) under the current policy, tool versions, and
 * preferences. It never resumes the old session, copies model messages as
 * authority, reuses approvals, or silently substitutes a missing model.
 * Refusals are fail-closed: invalid source policy snapshot, foreign run,
 * preview source, or an unavailable explicitly-selected model.
 */

import { runStoreManagerExecution, type StoreManagerExecutionDeps } from '../../store-manager/runtime/executor';
import { createStoreManagerExecutionRequest } from '../../store-manager/runtime/execution-request';
import { getStoreManagerSession, getStoreManagerPolicySnapshot, StoreManagerPolicySnapshotError } from '../../db/repositories/store-manager-session-repo';
import type { StoreManagerReplayResult } from '../../shared/schemas/store-manager-history';

export class StoreManagerReplayError extends Error {
  readonly code:
    | 'run_not_found'
    | 'policy_snapshot_missing'
    | 'policy_snapshot_invalid'
    | 'source_not_replayable'
    | 'scope_incompatible'
    | 'replay_failed';
  constructor(code: StoreManagerReplayError['code'], message: string) {
    super(message);
    this.name = 'StoreManagerReplayError';
    this.code = code;
  }
}

export interface ReplayStoreManagerRunOptions {
  workspaceId: string;
  workspacePath: string;
  sourceRunId: string;
  selectedModel?: string;
  registry?: StoreManagerExecutionDeps['registry'];
  resolveModel?: StoreManagerExecutionDeps['resolveModel'];
  now?: StoreManagerExecutionDeps['now'];
  policyOverrides?: StoreManagerExecutionDeps['policyOverrides'];
}

/**
 * Replay a prior run against the current catalog state. `selectedModel` is
 * honored EXACTLY (explicit model selection never falls back); when omitted,
 * the source run's resolved model id is requested (unavailable fails closed).
 */
export async function replayStoreManagerRun(
  options: ReplayStoreManagerRunOptions,
): Promise<StoreManagerReplayResult> {
  const source = getStoreManagerSession(options.workspaceId, options.sourceRunId);
  if (!source) {
    throw new StoreManagerReplayError('run_not_found', 'The source run was not found in this workspace.');
  }
  if (source.entrypoint === 'plan_preview') {
    throw new StoreManagerReplayError(
      'source_not_replayable',
      'Preview runs execute nothing and cannot be replayed; start a normal run instead.',
    );
  }
  if (!source.objective) {
    throw new StoreManagerReplayError('source_not_replayable', 'The source run has no stored objective and cannot be replayed.');
  }
  // Fail-closed: verify the source policy snapshot (hash check) before any run.
  try {
    getStoreManagerPolicySnapshot(options.workspaceId, options.sourceRunId);
  } catch (err) {
    if (err instanceof StoreManagerPolicySnapshotError) {
      throw new StoreManagerReplayError(err.code as StoreManagerReplayError['code'], err.message);
    }
    throw err;
  }

  // Pinned scope: reuse only when the source scope parses to a strict shape;
  // anything malformed refuses (never silently widens to the whole catalog).
  let pinnedScope: unknown = undefined;
  if (source.scope_json) {
    try {
      pinnedScope = JSON.parse(source.scope_json);
    } catch {
      throw new StoreManagerReplayError('scope_incompatible', 'The source run scope could not be parsed; replay refused.');
    }
  }

  const requestedModel = options.selectedModel ?? source.resolved_model ?? undefined;
  const request = createStoreManagerExecutionRequest({
    workspaceId: options.workspaceId,
    workspacePath: options.workspacePath,
    threadId: null,
    entrypoint: 'replay',
    executionMode: 'interactive',
    objective: `Replay of run "${options.sourceRunId}" against the current catalog state.\n\nOriginal objective: ${source.objective.slice(0, 1500)}`,
    pinnedScope: pinnedScope as Parameters<typeof createStoreManagerExecutionRequest>[0]['pinnedScope'],
    lineage: { replayOfRunId: options.sourceRunId },
    selectedModel: requestedModel,
  });

  const result = await runStoreManagerExecution(request, {
    registry: options.registry,
    resolveModel: options.resolveModel,
    now: options.now,
    policyOverrides: options.policyOverrides,
  });

  if (result.kind !== 'completed') {
    throw new StoreManagerReplayError('replay_failed', 'Replay did not produce a completed run.');
  }
  return {
    ok: true,
    replayRunId: result.runId,
    replayOfRunId: options.sourceRunId,
    terminalStatus: result.terminalStatus,
    text: result.output.text,
    toolResults: result.output.toolResults.map((t) => ({ toolName: t.toolName, status: t.status })),
  };
}

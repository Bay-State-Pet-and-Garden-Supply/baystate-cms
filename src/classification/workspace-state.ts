/**
 * Workspace classification state (P3 — release-aware loading).
 *
 * The workspace pins the immutable taxonomy release it runs on via
 * `store/classification/state.json`:
 *
 * ```json
 * {
 *   "activeTaxonomyRevision": "bay-state-v3",
 *   "updatedAt": "2026-08-16T12:00:00.000Z"
 * }
 * ```
 *
 * The pin is the ONLY release-reference the workspace owns. Immutable release
 * definitions live under `src/classification/releases/<revision>/` and are
 * resolved + hard-validated by `release-validation.ts`. Workspaces WITHOUT a
 * pin are pre-migration: the loader MIGRATES them to `bay-state-v3` (see
 * `migrateWorkspaceToRelease`) unless a legacy v2 workspace bundle exists.
 *
 * This module owns read/write of the pin. It is deliberately dependency-free
 * (only node fs/path + the shared zod schema) so config-loader can import it
 * without circular imports.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ClassificationSlugSchema, StrictIsoDateTimeStringSchema } from '../shared/schemas/classification';

export const DEFAULT_TAXONOMY_REVISION = 'bay-state-v3' as const;

export const WorkspaceClassificationStateSchema = z.object({
  activeTaxonomyRevision: ClassificationSlugSchema.nullable(),
  updatedAt: StrictIsoDateTimeStringSchema,
}).strict();
export type WorkspaceClassificationState = z.infer<typeof WorkspaceClassificationStateSchema>;

export function workspaceStatePath(workspacePath: string): string {
  return path.join(workspacePath, 'store', 'classification', 'state.json');
}

/**
 * Read the workspace's active-taxonomy pin. Returns null when no state.json
 * exists (pre-migration workspace). A malformed state file fails closed with
 * a clear error rather than being silently ignored.
 */
export function readWorkspaceState(workspacePath: string): WorkspaceClassificationState | null {
  const filePath = workspaceStatePath(workspacePath);
  if (!fs.existsSync(filePath)) return null;
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Unable to read workspace classification state ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`Workspace classification state ${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = WorkspaceClassificationStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Workspace classification state ${filePath} is invalid: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * Write the workspace's active-taxonomy pin. Creates store/classification if
 * needed. The release itself is NOT validated here — `loadTaxonomyRelease`
 * hard-validates it at load time.
 */
export function writeWorkspaceState(workspacePath: string, state: WorkspaceClassificationState): void {
  const filePath = workspaceStatePath(workspacePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Migrate a pre-pin workspace to the default taxonomy release. Persists the
 * pin and returns the written state. Throws if the write fails (fail closed —
 * the caller never silently falls back to a stale workspace bundle).
 */
export function migrateWorkspaceToRelease(
  workspacePath: string,
  revision: string = DEFAULT_TAXONOMY_REVISION,
): WorkspaceClassificationState {
  const state: WorkspaceClassificationState = {
    activeTaxonomyRevision: revision,
    updatedAt: new Date().toISOString(),
  };
  writeWorkspaceState(workspacePath, state);
  return state;
}

/**
 * Store Manager playbook service (operations console, Issue 6).
 *
 * Storage + registry-aware validation of immutable playbook definitions.
 * No execution here (the runner is Issue 7): this service owns template copy
 * (create draft), copy-on-edit versioning (immutable content-addressed rows),
 * explicit reviewed activation, and tamper-verified reads. Every write path
 * validates the definition against the CURRENT tool registry first.
 */

import { hashCanonicalJson } from '../../shared/stable-id';
import type {
  StoreManagerPlaybookDefinition,
  StoreManagerPlaybookSaveDraftRequest,
  StoreManagerPlaybookVersion,
  StoreManagerPlaybookSummary,
  StoreManagerPlaybookScopeInput,
  StoreManagerPlaybookVariableType,
  StoreManagerPlaybookTemplateKind,
} from '../../shared/schemas/store-manager-playbook';
import {
  StoreManagerPlaybookDefinitionSchema,
} from '../../shared/schemas/store-manager-playbook';
import {
  createPlaybook,
  appendPlaybookVersion,
  getPlaybookForWorkspace,
  getPlaybookVersionForWorkspace,
  listPlaybooksForWorkspace,
  listPlaybookVersionsForWorkspace,
  updatePlaybookPointer,
  activatePlaybookVersion,
  type StoreManagerPlaybookRow,
  type StoreManagerPlaybookVersionRow,
} from '../../db/repositories/store-manager-playbook-repo';
import { createStoreManagerToolRegistry } from '../../store-manager/runtime/tool-registry';
import { validateStoreManagerPlaybook } from '../../store-manager/playbooks/validator';
import { StoreManagerPlaybookValidationError } from '../../store-manager/playbooks/contracts';
import { findStoreManagerPlaybookTemplate } from '../../store-manager/playbooks/templates';

export class StoreManagerPlaybookError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreManagerPlaybookError';
    this.code = code;
  }
}

const resolveRegistry = createStoreManagerToolRegistry();

/** Registry-backed resolver for the validator (Issue 6 seam). */
const resolverForToolName = resolveRegistry.playbookResolver();

/** Canonical content hash over the immutable playbook payload (minus the hash/identity fields). */
function contentHashFor(payload: {
  name: string;
  description?: string;
  scopeInput: StoreManagerPlaybookScopeInput;
  variables: StoreManagerPlaybookDefinition['variables'];
  steps: StoreManagerPlaybookDefinition['steps'];
}): string {
  return hashCanonicalJson(payload);
}

function toVersion(
  row: StoreManagerPlaybookVersionRow,
): StoreManagerPlaybookVersion {
  const parsed = StoreManagerPlaybookDefinitionSchema.safeParse(JSON.parse(row.definitionJson));
  if (!parsed.success) {
    throw new StoreManagerPlaybookError(
      'definition_invalid',
      'Stored playbook version failed schema validation (tampered or corrupt).',
    );
  }
  // Tamper detection: the recorded hash field AND the DB hash column must both
  // equal a fresh content hash — a same-shape content mutation (e.g. renaming
  // a step) changes the content even when the recorded hash field is intact.
  const freshHash = contentHashFor({
    name: parsed.data.name,
    description: parsed.data.description,
    scopeInput: parsed.data.scopeInput,
    variables: parsed.data.variables,
    steps: parsed.data.steps,
  });
  if (freshHash !== row.definitionHash || parsed.data.definitionHash !== row.definitionHash) {
    throw new StoreManagerPlaybookError(
      'definition_tampered',
      'Stored playbook version hash does not match its content (tamper detected).',
    );
  }
  return { ...parsed.data, versionId: row.id };
}

function toSummary(row: StoreManagerPlaybookRow): StoreManagerPlaybookSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    templateKind: row.templateKind as StoreManagerPlaybookSummary['templateKind'],
    currentVersion: row.currentVersion,
    status: row.status,
    activeVersion: row.activeVersion,
    activeHash: row.activeHash,
    activatedAt: row.activatedAt,
    activatedBy: row.activatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Copy a code-owned starter template into a workspace draft (version 1).
 * Templates are inert descriptors; copying creates a draft that does nothing
 * until explicitly activated (and, later, run).
 */
export function createPlaybookFromTemplate(
  workspaceId: string,
  input: { templateKind: string; name?: string },
  deps: { now?: () => Date } = {},
): StoreManagerPlaybookSummary {
  const template = findStoreManagerPlaybookTemplate(
    input.templateKind as StoreManagerPlaybookTemplateKind,
  );
  if (!template) {
    throw new StoreManagerPlaybookError(
      'unknown_template',
      `Unknown playbook template "${input.templateKind}".`,
    );
  }
  const now = deps.now?.() ?? new Date();
  const name = (input.name ?? template.defaultName).trim();

  const scopeInput: StoreManagerPlaybookScopeInput = {
    allowedKinds: template.scopeAllowedKinds as StoreManagerPlaybookScopeInput['allowedKinds'],
    maxSkus: 200,
  };
  const variables = template.variables.map((v) => ({
    name: v.name,
    type: v.type as StoreManagerPlaybookVariableType,
    required: v.required,
  }));
  const steps = template.steps.map((s) => ({ ...s }));

  const content = { name, description: template.description, scopeInput, variables, steps };
  const definitionHash = contentHashFor(content);

  const row = createPlaybook({
    workspaceId,
    name,
    description: template.description,
    templateKind: template.kind,
    createdAt: now.toISOString(),
  });

  // Draft version 1 is always written atomically with the logical row.
  const draftDefinition: StoreManagerPlaybookDefinition = {
    id: row.id,
    workspaceId,
    name,
    description: template.description,
    templateKind: template.kind,
    version: 1,
    status: 'draft',
    scopeInput,
    variables,
    steps,
    definitionHash,
    activatedAt: null,
    activatedBy: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  validateStoreManagerPlaybook(draftDefinition, resolverForToolName);
  appendPlaybookVersion({
    workspaceId,
    playbookId: row.id,
    version: 1,
    definitionJson: JSON.stringify(draftDefinition),
    definitionHash,
    createdAt: now.toISOString(),
  });
  return toSummary(getPlaybookForWorkspace(workspaceId, row.id)!);
}

export function listPlaybooks(workspaceId: string): StoreManagerPlaybookSummary[] {
  return listPlaybooksForWorkspace(workspaceId).map(toSummary);
}

export function getPlaybook(workspaceId: string, id: string): StoreManagerPlaybookSummary | null {
  const row = getPlaybookForWorkspace(workspaceId, id);
  return row ? toSummary(row) : null;
}

export function getPlaybookVersion(
  workspaceId: string,
  id: string,
  version: number,
): StoreManagerPlaybookVersion | null {
  const row = getPlaybookVersionForWorkspace(workspaceId, id, version);
  return row ? toVersion(row) : null;
}

export function getPlaybookVersions(
  workspaceId: string,
  id: string,
): StoreManagerPlaybookVersion[] {
  return listPlaybookVersionsForWorkspace(workspaceId, id).map(toVersion);
}

export interface SaveDraftResult {
  version: StoreManagerPlaybookVersion;
  staticRisk: ReturnType<typeof validateStoreManagerPlaybook>;
}

/**
 * Copy-on-edit: save a NEW immutable draft version validated against the
 * current registry. The previous version is never modified.
 */
export function savePlaybookDraft(
  workspaceId: string,
  id: string,
  input: StoreManagerPlaybookSaveDraftRequest,
  deps: { now?: () => Date } = {},
): SaveDraftResult {
  const playbook = getPlaybookForWorkspace(workspaceId, id);
  if (!playbook) {
    throw new StoreManagerPlaybookError('not_found', 'Playbook not found in this workspace.');
  }
  const now = deps.now?.() ?? new Date();
  const nextVersion = playbook.currentVersion + 1;
  const content = {
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    scopeInput: input.scopeInput,
    variables: input.variables,
    steps: input.steps,
  };
  const definitionHash = contentHashFor(content);
  const draft: StoreManagerPlaybookDefinition = {
    id,
    workspaceId,
    name: content.name,
    description: content.description,
    templateKind: playbook.templateKind as StoreManagerPlaybookDefinition['templateKind'],
    version: nextVersion,
    status: playbook.status,
    scopeInput: content.scopeInput,
    variables: content.variables,
    steps: content.steps,
    definitionHash,
    activatedAt: playbook.activeVersion === null ? null : playbook.activatedAt,
    activatedBy: playbook.activeVersion === null ? null : playbook.activatedBy,
    createdAt: playbook.createdAt,
    updatedAt: now.toISOString(),
  };
  const staticRisk = validateStoreManagerPlaybook(draft, resolverForToolName);
  const row = appendPlaybookVersion({
    workspaceId,
    playbookId: id,
    version: nextVersion,
    definitionJson: JSON.stringify(draft),
    definitionHash,
    createdAt: now.toISOString(),
  });
  // A draft edit deactivates any previously active version (activation must be
  // an explicit reviewed decision again after any change).
  updatePlaybookPointer({
    workspaceId,
    playbookId: id,
    name: content.name,
    description: content.description,
    currentVersion: nextVersion,
    updatedAt: now.toISOString(),
  });
  return { version: toVersion(row), staticRisk };
}

/**
 * Activate a specific immutable version. Requires a valid content hash match
 * and a version that exists in this workspace; records actor/time. Activation
 * of a draft (unmodified) version is allowed — the playbook is inert until
 * activated, and the runner (Issue 7) gates execution behind flags + approval
 * checkpoints.
 */
export function activatePlaybook(
  workspaceId: string,
  id: string,
  version: number,
  actor: string,
  deps: { now?: () => Date } = {},
): StoreManagerPlaybookSummary {
  const playbook = getPlaybookForWorkspace(workspaceId, id);
  if (!playbook) {
    throw new StoreManagerPlaybookError('not_found', 'Playbook not found in this workspace.');
  }
  const versionRow = getPlaybookVersionForWorkspace(workspaceId, id, version);
  if (!versionRow) {
    throw new StoreManagerPlaybookError('version_not_found', 'Playbook version not found.');
  }
  const parsed = StoreManagerPlaybookDefinitionSchema.safeParse(JSON.parse(versionRow.definitionJson));
  if (!parsed.success || parsed.data.definitionHash !== versionRow.definitionHash) {
    throw new StoreManagerPlaybookError(
      'definition_tampered',
      'Playbook version content does not match its recorded hash (tamper detected).',
    );
  }
  // Re-validate against the CURRENT registry before activation: a stored
  // version whose tools have drifted or whose risk metadata disagrees with the
  // registry must fail closed at activation time, not at run time.
  validateStoreManagerPlaybook(parsed.data, resolverForToolName);
  const now = deps.now?.() ?? new Date();
  const updated = activatePlaybookVersion({
    workspaceId,
    playbookId: id,
    version,
    definitionHash: versionRow.definitionHash,
    activatedBy: actor,
    activatedAt: now.toISOString(),
  });
  if (!updated) {
    throw new StoreManagerPlaybookError('activation_failed', 'Playbook activation failed.');
  }
  return toSummary(updated);
}

// Re-export the validator error so routes can map validation failures uniformly.
export { StoreManagerPlaybookValidationError };

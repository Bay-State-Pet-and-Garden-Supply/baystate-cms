// fallow-ignore-file unused-export

/**
 * Surgical edits to the ACTIVE v2 classification bundle's Curation Targets.
 *
 * Allows updating curation target settings (such as `enabled`, `selectionMode`,
 * `optionSource`, `required`, `sortOrder`) on existing curation targets in the
 * active v2 bundle.
 *
 * Invariants (Issue #31 D5):
 * - Targets may reference existing attribute mappings but may NEVER create new mappings.
 * - Targets for unmapped fields/attributes fail closed if they attempt to synthesize mappings.
 * - The edited bundle passes active-mode validation before anything is written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ClassificationFocusedFileNames,
  ClassificationManifestV2Schema,
  CurationTargetConfigV2Schema,
  type ClassificationConfigBundleV2,
  type CurationTargetConfigV2,
} from '../shared/schemas/classification';
import { canonicalJsonFileString, sha256Hex } from '../shared/stable-id';
import { buildFocusedFiles } from './config-generator';
import {
  computeClassificationBundleHash,
  validateClassificationConfigBundle,
} from './config-validation';
import {
  checkedClassificationDirectory,
  checkedClassificationDirectoryForWrite,
  createRuntimeActivationContext,
  loadRuntimeConfigAuthority,
  type VerifiedActivationContext,
} from './config-loader';
import { commitClassificationScope } from './config-store';
import {
  syncConfigToCache,
  upsertConfigSnapshot,
} from '../db/repositories/classification-config-repo';
import { deriveCurationApplicability } from './curation-applicability';
import { listCurationTargetCandidates } from './curation-targets';

export class CurationTargetEditError extends Error {
  constructor(
    public readonly code:
      | 'v2_required'
      | 'invalid_edit'
      | 'unmapped_target'
      | 'validation_failed'
      | 'write_error',
    message: string,
  ) {
    super(message);
    this.name = 'CurationTargetEditError';
  }
}

export interface CurationTargetEditResult {
  bundleHash: string;
  commitHash: string | null;
  targets: CurationTargetConfigV2[];
}

/**
 * Apply target updates to the active v2 bundle.
 */
export function applyCurationTargetEdits(
  workspacePath: string,
  workspaceId: string,
  rawTargets: unknown[],
  options: { gitEnabled?: boolean; gitMessage?: string } = {},
): CurationTargetEditResult {
  const activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  if (authority.kind !== 'v2') {
    throw new CurationTargetEditError(
      'v2_required',
      'Curation target edits require an active v2 classification bundle; this workspace has no active v2 configuration.',
    );
  }

  return applyEditsToBundle(
    workspacePath,
    workspaceId,
    authority.bundle,
    activationContext,
    rawTargets,
    options,
  );
}

function applyEditsToBundle(
  workspacePath: string,
  workspaceId: string,
  bundle: ClassificationConfigBundleV2,
  activationContext: VerifiedActivationContext,
  rawTargets: unknown[],
  options: { gitEnabled?: boolean; gitMessage?: string },
): CurationTargetEditResult {
  const mappingByCatalogField = new Map(bundle.attributeMappings.map(m => [m.catalogField, m]));
  const mappingByAttributeId = new Map(bundle.attributeMappings.map(m => [m.attributeId, m]));

  const nextTargets = [...bundle.curationTargets];

  const attributeMap = new Map(bundle.attributes.map(a => [a.id, a]));

  const matchedTargetIds = new Set<string>();

  for (const raw of rawTargets) {
    if (!raw || typeof raw !== 'object') continue;
    const input = raw as Record<string, unknown>;

    const kind = String(input.kind ?? 'product_field');
    const catalogField = typeof input.catalogField === 'string' ? input.catalogField : null;
    const targetId = typeof input.id === 'string' ? input.id : null;
    const attributeId = typeof input.attributeId === 'string' ? input.attributeId : null;

    // Match existing target in bundle
    const existingIndex = nextTargets.findIndex(t =>
      (targetId && t.id === targetId) ||
      (kind === 'product_field' && catalogField && t.catalogField === catalogField) ||
      (kind === t.kind && kind !== 'product_field'),
    );

    if (existingIndex >= 0) {
      const existing = nextTargets[existingIndex];
      matchedTargetIds.add(existing.id);
      const targetAttrId = attributeId ?? existing.attributeId;
      const attr = targetAttrId ? attributeMap.get(targetAttrId) : null;
      const requestedSource = input.optionSource === 'live_store' ? 'live_store' : (input.optionSource === 'configured' ? 'configured' : existing.optionSource);
      const optionSource = (attr && attr.valueMode !== 'controlled') ? 'configured' : requestedSource;

      const updated: CurationTargetConfigV2 = {
        ...existing,
        label: typeof input.label === 'string' && input.label ? input.label : existing.label,
        enabled: typeof input.enabled === 'boolean' ? input.enabled : existing.enabled,
        mandatory: typeof input.mandatory === 'boolean' ? input.mandatory : existing.mandatory,
        selectionMode: input.selectionMode === 'multiple' ? 'multiple' : (input.selectionMode === 'single' ? 'single' : existing.selectionMode),
        optionSource,
        required: typeof input.required === 'boolean' ? input.required : existing.required,
        sortOrder: typeof input.sortOrder === 'number' ? input.sortOrder : existing.sortOrder,
      };

      const parsed = CurationTargetConfigV2Schema.safeParse(updated);
      if (!parsed.success) {
        throw new CurationTargetEditError(
          'invalid_edit',
          `Invalid target payload for ${existing.label}: ${parsed.error.issues.map(i => i.message).join('; ')}`,
        );
      }
      nextTargets[existingIndex] = parsed.data;
    } else if (kind === 'product_field' && catalogField) {
      // Issue #31 D5: a new target may reference an existing mapping, but never create one.
      const mapping = mappingByCatalogField.get(catalogField) ?? (attributeId ? mappingByAttributeId.get(attributeId) : null);
      if (!mapping) {
        throw new CurationTargetEditError(
          'unmapped_target',
          `Target for catalog field "${catalogField}" has no existing attribute mapping. Configure the mapping in the mapping editor first.`,
        );
      }

      const newTarget: CurationTargetConfigV2 = {
        id: targetId ?? `target-${catalogField.toLowerCase()}`,
        kind: 'product_field',
        label: typeof input.label === 'string' && input.label ? input.label : catalogField,
        enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
        mandatory: typeof input.mandatory === 'boolean' ? input.mandatory : false,
        selectionMode: input.selectionMode === 'multiple' ? 'multiple' : 'single',
        attributeId: mapping.attributeId,
        catalogField: mapping.catalogField,
        optionSource: input.optionSource === 'live_store' ? 'live_store' : 'configured',
        required: typeof input.required === 'boolean' ? input.required : false,
        sortOrder: typeof input.sortOrder === 'number' ? input.sortOrder : nextTargets.length,
      };

      const parsed = CurationTargetConfigV2Schema.safeParse(newTarget);
      if (!parsed.success) {
        throw new CurationTargetEditError(
          'invalid_edit',
          `Invalid target payload for ${catalogField}: ${parsed.error.issues.map(i => i.message).join('; ')}`,
        );
      }
      nextTargets.push(parsed.data);
      matchedTargetIds.add(parsed.data.id);
    }
  }

  // Reconcile omitted targets: Any non-mandatory product_field target omitted from rawTargets is disabled.
  for (let i = 0; i < nextTargets.length; i++) {
    const t = nextTargets[i];
    if (t.kind === 'product_field' && !t.mandatory && !matchedTargetIds.has(t.id)) {
      nextTargets[i] = { ...t, enabled: false };
    }
  }

  // ── Rebuild manifest and focused files ─────────────────────────────────────
  const bundleWithoutManifest = {
    ...bundle,
    curationTargets: nextTargets,
  } as Omit<ClassificationConfigBundleV2, 'manifest'> & { manifest?: unknown };
  delete bundleWithoutManifest.manifest;

  const focusedFiles = buildFocusedFiles(bundleWithoutManifest);
  const fileVersions = Object.fromEntries(
    ClassificationFocusedFileNames.map(fileName => [fileName, sha256Hex(focusedFiles[fileName])]),
  );
  const updatedAt = new Date().toISOString();
  const manifestWithoutHash = { ...bundle.manifest, updatedAt, fileVersions };
  const manifest = ClassificationManifestV2Schema.parse({
    ...manifestWithoutHash,
    bundleHash: computeClassificationBundleHash(manifestWithoutHash),
  });
  const newBundle: ClassificationConfigBundleV2 = {
    ...bundleWithoutManifest,
    manifest,
  } as ClassificationConfigBundleV2;

  // ── Fail-closed active validation ──────────────────────────────────────────
  const report = validateClassificationConfigBundle(newBundle, {
    mode: 'active',
    focusedFileContents: focusedFiles,
    catalogFields: activationContext.catalogFields,
    verifiedPageIds: activationContext.verifiedPageIds,
    verifiedQualificationReceiptDigests: activationContext.verifiedQualificationReceiptDigests,
    verifyCatalogEvidence: activationContext.verifyCatalogEvidence,
  });

  const fatalFindings = report.findings.filter(
    finding => finding.severity === 'error' && finding.code !== 'verified_page_catalog_required',
  );
  if (fatalFindings.length > 0) {
    throw new CurationTargetEditError(
      'validation_failed',
      `Edited curation targets bundle failed active validation:\n${fatalFindings.map(f => `[${f.code}] ${f.path}: ${f.message}`).join('\n')}`,
    );
  }

  // ── Write changed files ────────────────────────────────────────────────────
  const checkedDir = checkedClassificationDirectoryForWrite(workspacePath);
  const dir = checkedDir.path;
  const files: Record<string, unknown> = {
    'curation-targets.json': focusedFiles['curation-targets.json'],
    'manifest.json': canonicalJsonFileString(manifest),
  };
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  for (const [fileName, value] of Object.entries(files)) {
    const currentDir = checkedClassificationDirectory(workspacePath);
    if (currentDir.realPath !== checkedDir.realPath) {
      throw new CurationTargetEditError(
        'write_error',
        `Classification directory identity changed during write: ${dir}`,
      );
    }
    const filePath = path.join(currentDir.path, fileName);
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(
        filePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow,
      );
      const openedStat = fs.fstatSync(descriptor);
      if (!openedStat.isFile()) {
        throw new CurationTargetEditError(
          'write_error',
          `Opened classification path is not a regular file: ${filePath}`,
        );
      }
      fs.writeFileSync(descriptor, typeof value === 'string' ? value : canonicalJsonFileString(value), 'utf8');
    } catch (error) {
      if (error instanceof CurationTargetEditError) throw error;
      throw new CurationTargetEditError(
        'write_error',
        `Unable to write classification file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (descriptor !== null) {
        try { fs.closeSync(descriptor); } catch { /* ignore */ }
      }
    }
  }

  // ── Sync SQLite cache & snapshots ──────────────────────────────────────────
  try {
    syncConfigToCache(workspaceId, newBundle as unknown as Parameters<typeof syncConfigToCache>[1]);
  } catch (error) {
    throw new CurationTargetEditError(
      'write_error',
      `Cache mirror sync failed after file write: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  upsertConfigSnapshot(workspaceId, newBundle, manifest.sourceCatalogCommit);

  // ── Scoped Git commit ──────────────────────────────────────────────────────
  let commitHash: string | null = null;
  if (options.gitEnabled !== false) {
    try {
      commitHash = commitClassificationScope(
        workspacePath,
        options.gitMessage ?? 'Update curation targets configuration',
      );
    } catch (error) {
      console.warn(`[CurationTargetEditor] Git commit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    bundleHash: manifest.bundleHash,
    commitHash,
    targets: newBundle.curationTargets,
  };
}

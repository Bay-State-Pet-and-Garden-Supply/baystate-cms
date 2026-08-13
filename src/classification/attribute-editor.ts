// fallow-ignore-file unused-export

/**
 * Surgical edits to attributes in the ACTIVE v2 classification bundle.
 *
 * Allows updating attribute configuration (such as `isUniversal`) directly in
 * the active v2 bundle under active contract rules.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  ClassificationFocusedFileNames,
  ClassificationManifestV2Schema,
  type AttributeMappingConfigV2,
  type ClassificationConfigBundleV2,
  type ProductAttributeConfigV2,
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

export class AttributeEditError extends Error {
  constructor(
    public readonly code:
      | 'v2_required'
      | 'invalid_edit'
      | 'unknown_attribute'
      | 'validation_failed'
      | 'write_error',
    message: string,
  ) {
    super(message);
    this.name = 'AttributeEditError';
  }
}

export const AttributeEditSchema = z
  .object({
    isUniversal: z.boolean().optional(),
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  })
  .strict();

export type AttributeEditInput = z.infer<typeof AttributeEditSchema>;

export interface AttributeEditResult {
  bundleHash: string;
  commitHash: string | null;
  attribute: ProductAttributeConfigV2;
}

/**
 * Apply surgical updates to an attribute in the active v2 bundle.
 */
export function applyAttributeEdits(
  workspacePath: string,
  workspaceId: string,
  attributeId: string,
  updates: AttributeEditInput,
  options: { gitEnabled?: boolean; gitMessage?: string } = {},
): AttributeEditResult {
  const activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  if (authority.kind !== 'v2') {
    throw new AttributeEditError(
      'v2_required',
      'Attribute edits require an active v2 classification bundle; this workspace has no active v2 configuration.',
    );
  }

  return applyEditsToBundle(
    workspacePath,
    workspaceId,
    authority.bundle,
    activationContext,
    attributeId,
    updates,
    options,
  );
}

function applyEditsToBundle(
  workspacePath: string,
  workspaceId: string,
  bundle: ClassificationConfigBundleV2,
  activationContext: VerifiedActivationContext,
  attributeId: string,
  updates: AttributeEditInput,
  options: { gitEnabled?: boolean; gitMessage?: string },
): AttributeEditResult {
  const parsed = AttributeEditSchema.safeParse(updates);
  if (!parsed.success) {
    throw new AttributeEditError(
      'invalid_edit',
      `Invalid attribute update payload: ${parsed.error.issues.map(i => i.message).join('; ')}`,
    );
  }

  const nextAttributes = [...bundle.attributes];
  const attrIndex = nextAttributes.findIndex(a => a.id === attributeId);
  if (attrIndex === -1) {
    throw new AttributeEditError(
      'unknown_attribute',
      `Attribute "${attributeId}" does not exist in the active v2 bundle.`,
    );
  }

  const existing = nextAttributes[attrIndex];
  const updatedAttribute: ProductAttributeConfigV2 = {
    ...existing,
    name: updates.name ?? existing.name,
    description: updates.description !== undefined ? updates.description : existing.description,
    isUniversal: updates.isUniversal !== undefined ? updates.isUniversal : existing.isUniversal,
  };

  nextAttributes[attrIndex] = updatedAttribute;

  // ── Rebuild manifest and focused files ─────────────────────────────────────
  const bundleWithoutManifest = {
    ...bundle,
    attributes: nextAttributes,
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
    throw new AttributeEditError(
      'validation_failed',
      `Edited attribute bundle failed active validation:\n${fatalFindings.map(f => `[${f.code}] ${f.path}: ${f.message}`).join('\n')}`,
    );
  }

  // ── Write changed files ────────────────────────────────────────────────────
  const checkedDir = checkedClassificationDirectoryForWrite(workspacePath);
  const dir = checkedDir.path;
  const files: Record<string, unknown> = {
    'attributes.json': focusedFiles['attributes.json'],
    'manifest.json': canonicalJsonFileString(manifest),
  };
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  for (const [fileName, value] of Object.entries(files)) {
    const currentDir = checkedClassificationDirectory(workspacePath);
    if (currentDir.realPath !== checkedDir.realPath) {
      throw new AttributeEditError(
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
        throw new AttributeEditError(
          'write_error',
          `Opened classification path is not a regular file: ${filePath}`,
        );
      }
      fs.writeFileSync(descriptor, typeof value === 'string' ? value : canonicalJsonFileString(value), 'utf8');
    } catch (error) {
      if (error instanceof AttributeEditError) throw error;
      throw new AttributeEditError(
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
    throw new AttributeEditError(
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
        options.gitMessage ?? `Update attribute configuration for ${updatedAttribute.name}`,
      );
    } catch (error) {
      console.warn(`[AttributeEditor] Git commit failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    bundleHash: manifest.bundleHash,
    commitHash,
    attribute: updatedAttribute,
  };
}

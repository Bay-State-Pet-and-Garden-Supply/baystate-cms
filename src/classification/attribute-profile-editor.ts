import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CardinalityEnum,
  ClassificationFocusedFileNames,
  ClassificationManifestV2Schema,
  type AttributeProfileConfigV2,
  type ClassificationConfigBundleV2,
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

export class AttributeProfileEditError extends Error {
  constructor(
    public readonly code:
      | 'v2_required'
      | 'invalid_edit'
      | 'unknown_product_type'
      | 'unknown_attribute'
      | 'validation_failed'
      | 'write_error',
    message: string,
  ) {
    super(message);
    this.name = 'AttributeProfileEditError';
  }
}

/** One edit entry for an attribute within a Product Type attribute profile. */
export const AttributeProfileEditSchema = z
  .object({
    attributeId: z.string().min(1),
    included: z.boolean(),
    required: z.boolean().optional(),
    cardinality: CardinalityEnum.optional(),
  })
  .strict();

export type AttributeProfileEdit = z.infer<typeof AttributeProfileEditSchema>;

export const AttributeProfileEditsPayloadSchema = z
  .object({
    edits: z.array(AttributeProfileEditSchema).min(1),
  })
  .strict();

export interface AttributeProfileEditResult {
  bundleHash: string;
  commitHash: string | null;
  productTypeId: string;
  profileId: string;
  updatedAttributeIds: string[];
}

function toSlug(input: string, fallback = 'profile'): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const safe = slug || fallback;
  return /^[a-z]/.test(safe) ? safe : `${fallback}-${safe}`;
}

/**
 * Apply surgical edits to a Product Type's attribute profile in the active v2 bundle.
 */
export function applyAttributeProfileEdits(
  workspacePath: string,
  workspaceId: string,
  productTypeId: string,
  edits: AttributeProfileEdit[],
  options: { gitEnabled?: boolean; gitMessage?: string } = {},
): AttributeProfileEditResult {
  const activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  if (authority.kind !== 'v2') {
    throw new AttributeProfileEditError(
      'v2_required',
      'Attribute profile edits require an active v2 classification bundle; this workspace has no active v2 configuration.',
    );
  }
  return applyEditsToBundle(
    workspacePath,
    workspaceId,
    productTypeId,
    authority.bundle,
    activationContext,
    edits,
    options,
  );
}

function applyEditsToBundle(
  workspacePath: string,
  workspaceId: string,
  productTypeId: string,
  bundle: ClassificationConfigBundleV2,
  activationContext: VerifiedActivationContext,
  edits: AttributeProfileEdit[],
  options: { gitEnabled?: boolean; gitMessage?: string },
): AttributeProfileEditResult {
  const parsedEdits = z.array(AttributeProfileEditSchema).safeParse(edits);
  if (!parsedEdits.success) {
    throw new AttributeProfileEditError(
      'invalid_edit',
      `Invalid attribute profile edit payload: ${parsedEdits.error.issues
        .map(issue => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  const nextProductTypes = [...bundle.productTypes];
  const productTypeIndex = nextProductTypes.findIndex(pt => pt.id === productTypeId);
  if (productTypeIndex === -1) {
    throw new AttributeProfileEditError(
      'unknown_product_type',
      `Product Type "${productTypeId}" does not exist in the active v2 bundle.`,
    );
  }
  const productType = { ...nextProductTypes[productTypeIndex] };

  const validAttributeIds = new Set(bundle.attributes.map(a => a.id));
  for (const edit of edits) {
    if (!validAttributeIds.has(edit.attributeId)) {
      throw new AttributeProfileEditError(
        'unknown_attribute',
        `Attribute "${edit.attributeId}" does not exist in the active v2 bundle.`,
      );
    }
  }

  const nextProfiles = [...bundle.attributeProfiles];
  let profileIndex = nextProfiles.findIndex(
    p => p.id === productType.attributeProfileId || p.productTypeId === productTypeId,
  );

  let profile: AttributeProfileConfigV2;
  if (profileIndex >= 0) {
    profile = { ...nextProfiles[profileIndex], attributes: [...nextProfiles[profileIndex].attributes] };
  } else {
    const profileId = productType.attributeProfileId ?? toSlug(`${productTypeId}-profile`);
    profile = {
      id: profileId,
      productTypeId,
      name: `${productType.name} Profile`,
      attributes: [],
      oldIdAliases: [],
    };
    productType.attributeProfileId = profileId;
    nextProductTypes[productTypeIndex] = productType;
    profileIndex = nextProfiles.length;
    nextProfiles.push(profile);
  }

  const updatedAttributeIds: string[] = [];

  for (const edit of edits) {
    updatedAttributeIds.push(edit.attributeId);
    const existingIndex = profile.attributes.findIndex(a => a.attributeId === edit.attributeId);

    if (edit.included) {
      if (existingIndex >= 0) {
        const existing = profile.attributes[existingIndex];
        profile.attributes[existingIndex] = {
          ...existing,
          required: edit.required ?? existing.required,
          cardinality: edit.cardinality ?? existing.cardinality,
        };
      } else {
        profile.attributes.push({
          attributeId: edit.attributeId,
          required: edit.required ?? false,
          cardinality: edit.cardinality ?? 'single',
          applicabilityConditions: [],
          constraints: {},
          confidenceThresholds: {},
          valueAliases: [],
        });
      }
    } else {
      if (existingIndex >= 0) {
        profile.attributes.splice(existingIndex, 1);
      }
    }
  }

  nextProfiles[profileIndex] = profile;

  // ── Rebuild the manifest and focused files ───────────────────────────────
  const bundleWithoutManifest = {
    ...bundle,
    productTypes: nextProductTypes,
    attributeProfiles: nextProfiles,
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

  // ── Fail-closed active validation before writing ────────────────────────
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
    throw new AttributeProfileEditError(
      'validation_failed',
      `Edited bundle failed active validation:\n${fatalFindings.map(f => `[${f.code}] ${f.path}: ${f.message}`).join('\n')}`,
    );
  }

  // ── Write changed files (symlink-safe) ──────────────────────────────────
  const checkedDir = checkedClassificationDirectoryForWrite(workspacePath);
  const dir = checkedDir.path;
  const files: Record<string, unknown> = {
    'product-types.json': focusedFiles['product-types.json'],
    'attribute-profiles.json': focusedFiles['attribute-profiles.json'],
    'manifest.json': canonicalJsonFileString(manifest),
  };
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  for (const [fileName, value] of Object.entries(files)) {
    const currentDir = checkedClassificationDirectory(workspacePath);
    if (currentDir.realPath !== checkedDir.realPath) {
      throw new AttributeProfileEditError(
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
        throw new AttributeProfileEditError(
          'write_error',
          `Opened classification path is not a regular file: ${filePath}`,
        );
      }
      fs.writeFileSync(descriptor, typeof value === 'string' ? value : canonicalJsonFileString(value), 'utf8');
    } catch (error) {
      if (error instanceof AttributeProfileEditError) throw error;
      throw new AttributeProfileEditError(
        'write_error',
        `Unable to write classification file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ── Derived cache sync ──────────────────────────────────────────────────
  try {
    syncConfigToCache(workspaceId, newBundle as unknown as Parameters<typeof syncConfigToCache>[1]);
  } catch (error) {
    throw new AttributeProfileEditError(
      'write_error',
      `Cache mirror sync failed after file write: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  upsertConfigSnapshot(workspaceId, newBundle, manifest.sourceCatalogCommit);

  // ── Scoped Git commit ────────────────────────────────────────────────────
  let commitHash: string | null = null;
  if (options.gitEnabled !== false) {
    try {
      commitHash = commitClassificationScope(
        workspacePath,
        options.gitMessage ?? `Update attribute profile for ${productType.name}`,
      );
    } catch (error) {
      console.warn(
        `[AttributeProfileEditor] Git commit failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    bundleHash: manifest.bundleHash,
    commitHash,
    productTypeId,
    profileId: profile.id,
    updatedAttributeIds,
  };
}

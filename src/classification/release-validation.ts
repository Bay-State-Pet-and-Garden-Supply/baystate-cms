/**
 * Taxonomy Release Validation (P2 — hard gate for the immutable release).
 *
 * The taxonomy release under `src/classification/releases/<releaseId>/` is a
 * set-in-stone artifact: a broken release must be IMPOSSIBLE to load. This
 * module is the deterministic gate. `validateTaxonomyRelease` returns a
 * structured report; `loadTaxonomyRelease` / `assertReleaseValid` fail closed
 * (throw `ReleaseValidationError`, code `release_invalid`) whenever any
 * `error`-severity finding exists.
 *
 * The runtime loader is NOT switched to the release yet (that is the next
 * phase, P3). This module is purely additive so the workspace v2 bundle
 * loader and every existing consumer keep working unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  AttributesFileV2Schema,
  AttributeProfilesFileV2Schema,
  AttributeMappingsFileV2Schema,
  DepartmentsFileV2Schema,
  GuidanceFileV2Schema,
  ProductTypesFileV2Schema,
  Sha256HexSchema,
  StrictIsoDateTimeStringSchema,
  ClassificationSlugSchema,
  ClassificationBundleOriginV2Schema,
  type AttributeProfileConfigV2,
  type ClassificationBundleOriginV2,
  type DepartmentConfigV2,
  type GuidanceConfigV2,
  type ProductAttributeConfigV2,
  type AttributeMappingConfigV2,
  type ProductTypeConfigV2,
} from '../shared/schemas/classification';

// ─── Release manifest (release-specific, not ClassificationManifestV2) ────────

export const TaxonomyReleaseManifestSchema = z.object({
  releaseId: ClassificationSlugSchema,
  revision: z.string().min(1),
  createdAt: StrictIsoDateTimeStringSchema,
  schemaVersion: z.literal(2),
  compatibilityVersion: z.literal(2),
  lifecycle: z.literal('release'),
  sourceBaseline: z.string().min(1),
  fileVersions: z.record(z.string(), Sha256HexSchema),
  counts: z.object({
    productTypes: z.number().int(),
    attributes: z.number().int(),
    attributeProfiles: z.number().int(),
    departments: z.number().int(),
    mappings: z.number().int(),
    guidance: z.number().int(),
  }),
}).strict();
export type TaxonomyReleaseManifest = z.infer<typeof TaxonomyReleaseManifestSchema>;

/** Page-assignment policy file (release-specific shape). */
export const PageAssignmentPolicyV2Schema = z.object({
  schemaVersion: z.literal(1),
  maxPagesPerProduct: z.number().int().positive(),
  preferSpecificOverShopAll: z.boolean(),
  crossSpeciesBlocked: z.boolean(),
  allowedSpecies: z.array(z.string()).min(1),
  notes: z.string().nullable().optional(),
}).strict();
export type PageAssignmentPolicyV2 = z.infer<typeof PageAssignmentPolicyV2Schema>;

// ─── Report / error types ──────────────────────────────────────────────────────

export interface ReleaseValidationFinding {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ReleaseValidationReport {
  ok: boolean;
  findings: ReleaseValidationFinding[];
  counts: {
    productTypes: number;
    attributes: number;
    attributeProfiles: number;
    departments: number;
    mappings: number;
  };
}

export class ReleaseValidationError extends Error {
  readonly code = 'release_invalid' as const;
  readonly report: ReleaseValidationReport;

  constructor(message: string, report: ReleaseValidationReport) {
    super(message);
    this.name = 'ReleaseValidationError';
    this.report = report;
  }
}

// ─── Structured release bundle ─────────────────────────────────────────────────

export interface TaxonomyReleaseBundle {
  manifest: TaxonomyReleaseManifest;
  departments: DepartmentConfigV2[];
  productTypes: ProductTypeConfigV2[];
  attributes: ProductAttributeConfigV2[];
  attributeProfiles: AttributeProfileConfigV2[];
  exportMappings: AttributeMappingConfigV2[];
  guidance: GuidanceConfigV2[];
  pageAssignmentPolicy: PageAssignmentPolicyV2;
}

// ─── Path helpers ──────────────────────────────────────────────────────────────

/**
 * True when a value is a valid taxonomy release id / revision / department id:
 * lowercase kebab-case (letters, digits, single hyphens), e.g. `bay-state-v3`.
 * Used to validate `activeTaxonomyRevision`-style identifiers before they are
 * resolved to a directory (path-traversal guard at the loader boundary).
 */
export function isValidReleaseId(id: string): boolean {
  return SLUG_RELEASE_ID_RE.test(id);
}

/**
 * Resolve a release directory name or absolute path under src/classification/releases.
 * Relative release ids are resolved inside the releases root and must NOT escape
 * it (`../` traversal is rejected). Absolute paths (temp copies used by tests,
 * or an explicit checked-in path) pass through unchanged.
 */
export function resolveReleaseDir(releaseDir: string): string {
  if (path.isAbsolute(releaseDir)) return releaseDir;
  const releasesRoot = path.resolve(__dirname, 'releases');
  const dir = path.resolve(releasesRoot, releaseDir);
  const relative = path.relative(releasesRoot, dir);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Release directory "${releaseDir}" resolves outside the releases root.`);
  }
  return dir;
}

const RELEASE_FILES = [
  'manifest.json',
  'departments.json',
  'product-types.json',
  'attributes.json',
  'attribute-profiles.json',
  'export-mappings.json',
  'guidance.json',
  'page-assignment-policy.json',
] as const;

function sha256OfFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const SLUG_RELEASE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ─── Validator ─────────────────────────────────────────────────────────────────

/**
 * Validate a taxonomy release directory. Returns a report; never throws for
 * validation problems (callers use `loadTaxonomyRelease`/`assertReleaseValid`
 * to fail closed on `error` findings). Every rule violation is an `error`.
 */
export function validateTaxonomyRelease(releaseDir: string): ReleaseValidationReport {
  const findings: ReleaseValidationFinding[] = [];
  const dir = resolveReleaseDir(releaseDir);

  const fail = (code: string, message: string) => {
    findings.push({ code, message, severity: 'error' });
  };

  // ── Read + parse every file (missing/malformed = error) ──────────────────
  const rawFiles: Record<string, unknown> = {};
  for (const fileName of RELEASE_FILES) {
    const filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath)) {
      fail('missing_release_file', `${fileName} is missing from the release.`);
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      fail('release_file_read_error', `Cannot read ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    try {
      rawFiles[fileName] = JSON.parse(text);
    } catch (err) {
      fail('release_file_parse_error', `${fileName} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Manifest ─────────────────────────────────────────────────────────────
  const manifestParsed = rawFiles['manifest.json']
    ? TaxonomyReleaseManifestSchema.safeParse(rawFiles['manifest.json'])
    : null;
  if (rawFiles['manifest.json'] && !manifestParsed?.success) {
    fail('invalid_release_manifest', `manifest.json failed schema validation: ${z.prettifyError(manifestParsed!.error)}`);
  }
  const manifest = manifestParsed?.success ? manifestParsed.data : null;

  // ── Envelope parsing through shared V2 schemas ───────────────────────────
  const parseEnvelope = <T extends { entries: unknown[]; bundleOrigin: unknown }>(
    fileName: string,
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  ): T | null => {
    if (!(fileName in rawFiles)) return null;
    const parsed = schema.safeParse(rawFiles[fileName]);
    if (!parsed.success) {
      fail('invalid_release_file', `${fileName} failed v2 schema validation.`);
      return null;
    }
    return parsed.data;
  };

  const departments = parseEnvelope('departments.json', DepartmentsFileV2Schema)?.entries ?? [];
  const productTypes = parseEnvelope('product-types.json', ProductTypesFileV2Schema)?.entries ?? [];
  const attributes = parseEnvelope('attributes.json', AttributesFileV2Schema)?.entries ?? [];
  const profiles = parseEnvelope('attribute-profiles.json', AttributeProfilesFileV2Schema)?.entries ?? [];
  const mappings = parseEnvelope('export-mappings.json', AttributeMappingsFileV2Schema)?.entries ?? [];
  const guidance = parseEnvelope('guidance.json', GuidanceFileV2Schema)?.entries ?? [];
  const pagePolicyParsed = rawFiles['page-assignment-policy.json']
    ? PageAssignmentPolicyV2Schema.safeParse(rawFiles['page-assignment-policy.json'])
    : null;
  if (rawFiles['page-assignment-policy.json'] && !pagePolicyParsed?.success) {
    fail('invalid_page_assignment_policy', 'page-assignment-policy.json failed schema validation.');
  }
  const pagePolicy = pagePolicyParsed?.success ? pagePolicyParsed.data : null;

  // ── File hash verification against manifest.fileVersions ────────────────
  if (manifest) {
    for (const [fileName, expectedHash] of Object.entries(manifest.fileVersions)) {
      const filePath = path.join(dir, fileName);
      if (!fs.existsSync(filePath)) {
        fail('manifest_hash_missing_file', `manifest.fileVersions references ${fileName} which is missing.`);
        continue;
      }
      const actualHash = sha256OfFile(filePath);
      if (actualHash !== expectedHash) {
        fail('manifest_hash_mismatch', `${fileName} sha256 (${actualHash.slice(0, 12)}…) does not match manifest (${expectedHash.slice(0, 12)}…).`);
      }
    }
  }

  // ── Rule 1: unique product-type ids + format ─────────────────────────────
  {
    const seen = new Set<string>();
    for (const pt of productTypes) {
      if (!SLUG_RELEASE_ID_RE.test(pt.id)) {
        fail('invalid_product_type_id_format', `Product type id "${pt.id}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      if (seen.has(pt.id)) {
        fail('duplicate_product_type_id', `Duplicate product type id "${pt.id}".`);
      }
      seen.add(pt.id);
    }
  }

  // ── Rule 2: unique attribute ids + format ────────────────────────────────
  {
    const seen = new Set<string>();
    for (const attr of attributes) {
      if (!SLUG_RELEASE_ID_RE.test(attr.id)) {
        fail('invalid_attribute_id_format', `Attribute id "${attr.id}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      if (seen.has(attr.id)) {
        fail('duplicate_attribute_id', `Duplicate attribute id "${attr.id}".`);
      }
      seen.add(attr.id);
    }
  }

  // ── Rule 3: departments are unique, well-formed, and every product type's
  //    departmentId resolves ────────────────────────────────────────────────
  {
    const departmentIds = new Set(departments.map(d => d.id));
    // FIX 4: department ids must be unique and match the kebab-case release-id format.
    const seenDepartments = new Set<string>();
    for (const dept of departments) {
      if (!SLUG_RELEASE_ID_RE.test(dept.id)) {
        fail('invalid_department_id_format', `Department id "${dept.id}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      if (seenDepartments.has(dept.id)) {
        fail('duplicate_department_id', `Duplicate department id "${dept.id}".`);
      }
      seenDepartments.add(dept.id);
    }
    for (const pt of productTypes) {
      if (pt.departmentId === undefined) {
        fail('missing_department_id', `Product type "${pt.id}" has no departmentId.`);
      } else if (!departmentIds.has(pt.departmentId)) {
        fail('unknown_department_id', `Product type "${pt.id}" references unknown department "${pt.departmentId}".`);
      }
    }
    // Departments' typeIds must match product-type departmentId membership.
    for (const dept of departments) {
      for (const typeId of dept.typeIds) {
        const pt = productTypes.find(p => p.id === typeId);
        if (!pt) {
          fail('department_unknown_type', `Department "${dept.id}" lists type "${typeId}" which does not exist.`);
        } else if (pt.departmentId !== dept.id) {
          fail('department_type_mismatch', `Department "${dept.id}" lists type "${typeId}" but the type declares departmentId "${pt.departmentId}".`);
        }
      }
    }
    // Reverse: every product type must appear in its department's typeIds.
    const deptTypeIds = new Map<string, string[]>();
    for (const dept of departments) deptTypeIds.set(dept.id, dept.typeIds);
    for (const pt of productTypes) {
      if (pt.departmentId === undefined) continue;
      const listed = deptTypeIds.get(pt.departmentId) ?? [];
      if (!listed.includes(pt.id)) {
        fail('department_type_not_listed', `Product type "${pt.id}" declares department "${pt.departmentId}" but is not listed in that department's typeIds.`);
      }
    }
  }

  // ── Rule 4: every product type has EXACTLY ONE profile (bijection) ───────
  {
    const typeIds = new Set(productTypes.map(pt => pt.id));
    const profileTypeIds = new Set<string>();
    const seenProfileTypes = new Set<string>();
    for (const profile of profiles) {
      if (profileTypeIds.has(profile.productTypeId)) {
        fail('duplicate_profile_for_type', `Product type "${profile.productTypeId}" has more than one attribute profile.`);
      }
      profileTypeIds.add(profile.productTypeId);
      seenProfileTypes.add(profile.productTypeId);
      if (!typeIds.has(profile.productTypeId)) {
        fail('orphan_profile', `Attribute profile "${profile.id}" references unknown product type "${profile.productTypeId}".`);
      }
    }
    for (const pt of productTypes) {
      if (!seenProfileTypes.has(pt.id)) {
        fail('missing_profile_for_type', `Product type "${pt.id}" has no attribute profile.`);
      }
    }
    // Also enforce the type's attributeProfileId points at an existing profile.
    const profileIds = new Set(profiles.map(p => p.id));
    for (const pt of productTypes) {
      if (pt.attributeProfileId !== null && pt.attributeProfileId !== undefined && !profileIds.has(pt.attributeProfileId)) {
        fail('missing_profile_pointer', `Product type "${pt.id}" points at unknown profile "${pt.attributeProfileId}".`);
      }
    }
  }

  // ── Rule 5: every profile attributeId exists in attributes.json ─────────
  {
    const attributeIds = new Set(attributes.map(a => a.id));
    for (const profile of profiles) {
      for (const pa of profile.attributes) {
        if (!attributeIds.has(pa.attributeId)) {
          fail('profile_unknown_attribute', `Profile "${profile.id}" references unknown attribute "${pa.attributeId}".`);
        }
      }
    }
  }

  // ── Rule 6: controlled allowedValues unique; valueAliases resolve ────────
  {
    for (const attr of attributes) {
      if (attr.valueMode !== 'controlled') continue;
      const seen = new Set<string>();
      for (const value of attr.allowedValues) {
        if (seen.has(value)) {
          fail('duplicate_allowed_value', `Attribute "${attr.id}" has duplicate allowed value "${value}".`);
        }
        seen.add(value);
      }
      for (const alias of attr.valueAliases) {
        if (!seen.has(alias.mapsTo)) {
          fail('unresolved_value_alias', `Attribute "${attr.id}" alias "${alias.alias}" maps to unknown value "${alias.mapsTo}".`);
        }
      }
    }
  }

  // ── Rule 7: measured attributes have canonicalUnit ───────────────────────
  {
    for (const attr of attributes) {
      if (attr.valueMode === 'measured' && (!attr.canonicalUnit || attr.canonicalUnit.trim().length === 0)) {
        fail('measured_attribute_missing_unit', `Measured attribute "${attr.id}" has no canonicalUnit.`);
      }
    }
  }

  // ── Rule 8: mappings reference known attributes; every attribute has an
  //    exportDisposition ────────────────────────────────────────────────────
  {
    const attributeIds = new Set(attributes.map(a => a.id));
    for (const mapping of mappings) {
      if (!attributeIds.has(mapping.attributeId)) {
        fail('mapping_unknown_attribute', `Export mapping "${mapping.id}" references unknown attribute "${mapping.attributeId}".`);
      }
    }
    for (const attr of attributes) {
      if (attr.exportDisposition === undefined) {
        fail('attribute_missing_export_disposition', `Attribute "${attr.id}" has no exportDisposition.`);
      } else if (attr.exportDisposition.kind === 'shopsite' && attr.exportDisposition.catalogField.trim().length === 0) {
        fail('attribute_empty_export_field', `Attribute "${attr.id}" has a shopsite disposition with an empty catalogField.`);
      }
    }
    // Mapped attributes must carry a shopsite disposition (not not_exported).
    const mappedAttributeIds = new Set(mappings.map(m => m.attributeId));
    for (const attr of attributes) {
      if (mappedAttributeIds.has(attr.id) && attr.exportDisposition?.kind === 'not_exported') {
        fail('mapped_attribute_not_exported', `Attribute "${attr.id}" has an export mapping but disposition "not_exported".`);
      }
    }
  }

  // ── Rule 8b (FIX 2): export duality SET-EQUALITY invariant ──────────────
  // export-mappings.json must equal EXACTLY the projection of attributes whose
  // exportDisposition.kind === 'shopsite' onto (attributeId, catalogField):
  //   ExpectedMappings = { (a.id, a.exportDisposition.catalogField) | a.kind == 'shopsite' }
  //   ActualMappings   = { (m.attributeId, m.catalogField) | m in exportMappings }
  //   ActualMappings == ExpectedMappings
  {
    const expectedByAttribute = new Map<string, string>();
    for (const attr of attributes) {
      if (attr.exportDisposition?.kind === 'shopsite') {
        expectedByAttribute.set(attr.id, attr.exportDisposition.catalogField);
      }
    }

    const actualByAttribute = new Map<string, string[]>();
    for (const mapping of mappings) {
      const existing = actualByAttribute.get(mapping.attributeId) ?? [];
      existing.push(mapping.catalogField);
      actualByAttribute.set(mapping.attributeId, existing);
    }

    // Every shopsite-disposition attribute must have EXACTLY ONE mapping with
    // the SAME catalogField.
    for (const [attributeId, expectedField] of expectedByAttribute) {
      const actualFields = actualByAttribute.get(attributeId);
      if (!actualFields || actualFields.length === 0) {
        fail('export_mapping_missing', `Attribute "${attributeId}" has a shopsite exportDisposition but no export mapping.`);
      } else if (actualFields.length > 1) {
        fail('duplicate_export_mapping', `Attribute "${attributeId}" has ${actualFields.length} export mappings; exactly one is required.`);
      } else if (actualFields[0] !== expectedField) {
        fail('export_mapping_mismatch', `Attribute "${attributeId}" maps to "${actualFields[0]}" but exportDisposition declares "${expectedField}".`);
      }
    }

    // Every mapping must correspond to a shopsite-disposition attribute with a
    // matching catalogField; not_exported/unknown attributes must have ZERO
    // mappings (forbidden).
    for (const [attributeId, actualFields] of actualByAttribute) {
      const attr = attributes.find(a => a.id === attributeId);
      if (!attr) continue; // unknown attributes already flagged by mapping_unknown_attribute
      if (attr.exportDisposition?.kind !== 'shopsite') {
        fail('export_mapping_forbidden', `Attribute "${attributeId}" has ${actualFields.length} export mapping(s) but disposition is "${attr.exportDisposition?.kind ?? 'missing'}".`);
        continue;
      }
      for (const field of actualFields) {
        if (field !== attr.exportDisposition.catalogField) {
          fail('export_mapping_mismatch', `Attribute "${attributeId}" maps to "${field}" but exportDisposition declares "${attr.exportDisposition.catalogField}".`);
        }
      }
    }
  }

  // ── Rule 9: guidance ids unique; structured refs known where applicable ──
  {
    const seen = new Set<string>();
    for (const g of guidance) {
      if (seen.has(g.id)) {
        fail('duplicate_guidance_id', `Duplicate guidance id "${g.id}".`);
      }
      seen.add(g.id);
      // Known reference-shaped keys in guidance.structured must resolve.
      const structured = (g.structured ?? {}) as Record<string, unknown>;
      if (typeof structured.productTypeIds === 'string') {
        fail('guidance_invalid_type_ref', `Guidance "${g.id}" productTypeIds must be an array.`);
      } else if (Array.isArray(structured.productTypeIds)) {
        const knownTypes = new Set(productTypes.map(pt => pt.id));
        for (const ref of structured.productTypeIds) {
          if (typeof ref === 'string' && !knownTypes.has(ref)) {
            fail('guidance_unknown_type_ref', `Guidance "${g.id}" references unknown product type "${ref}".`);
          }
        }
      }
      if (typeof structured.departmentIds === 'string') {
        fail('guidance_invalid_department_ref', `Guidance "${g.id}" departmentIds must be an array.`);
      } else if (Array.isArray(structured.departmentIds)) {
        const knownDepts = new Set(departments.map(d => d.id));
        for (const ref of structured.departmentIds) {
          if (typeof ref === 'string' && !knownDepts.has(ref)) {
            fail('guidance_unknown_department_ref', `Guidance "${g.id}" references unknown department "${ref}".`);
          }
        }
      }
    }
  }

  // ── Rule 10: page-assignment-policy ──────────────────────────────────────
  {
    if (pagePolicy) {
      if (!Number.isInteger(pagePolicy.maxPagesPerProduct) || pagePolicy.maxPagesPerProduct <= 0) {
        fail('invalid_max_pages', `page-assignment-policy maxPagesPerProduct must be a positive integer.`);
      }
      if (!Array.isArray(pagePolicy.allowedSpecies) || pagePolicy.allowedSpecies.length === 0) {
        fail('invalid_allowed_species', `page-assignment-policy allowedSpecies must be a non-empty array of strings.`);
      }
    }
  }

  // ── Rule 11: manifest counts match actual file contents ──────────────────
  {
    if (manifest) {
      const actual: Record<string, number> = {
        productTypes: productTypes.length,
        attributes: attributes.length,
        attributeProfiles: profiles.length,
        departments: departments.length,
        mappings: mappings.length,
        guidance: guidance.length,
      };
      const expected = manifest.counts;
      for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
        const exp = expected[key as keyof typeof expected];
        if (exp === undefined || exp !== actual[key]) {
          fail('manifest_count_mismatch', `manifest.counts.${key} is ${exp ?? 'missing'}, but the release contains ${actual[key]}.`);
        }
      }
    }
  }

  // ── Rule 12: manifest identity (releaseId/revision present; release origin) ──
  {
    if (manifest && (!manifest.releaseId || !manifest.revision)) {
      fail('invalid_release_manifest', 'manifest.json must include releaseId and revision.');
    }
    // FIX 5: release identity binding — releaseId and revision must match the
    // kebab-case id format, and the manifest releaseId must equal the basename
    // of the release directory being validated (an activeTaxonomyRevision must
    // resolve to exactly one immutable release).
    if (manifest) {
      if (!isValidReleaseId(manifest.releaseId)) {
        fail('invalid_release_id_format', `manifest.releaseId "${manifest.releaseId}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      if (!isValidReleaseId(manifest.revision)) {
        fail('invalid_release_id_format', `manifest.revision "${manifest.revision}" must match /^[a-z0-9]+(-[a-z0-9]+)*$/.`);
      }
      const dirBasename = path.basename(dir);
      if (manifest.releaseId !== dirBasename) {
        fail('release_id_mismatch', `manifest.releaseId "${manifest.releaseId}" does not match the release directory basename "${dirBasename}".`);
      }
    }
    // Envelope origin consistency: every focused file must declare the same
    // release bundle origin, matching the manifest releaseId when present.
    const originOf = (fileName: string): ClassificationBundleOriginV2 | null => {
      const raw = rawFiles[fileName];
      if (!raw || typeof raw !== 'object') return null;
      const origin = (raw as Record<string, unknown>).bundleOrigin;
      if (!origin) return null;
      const parsed = ClassificationBundleOriginV2Schema.safeParse(origin);
      return parsed.success ? parsed.data : null;
    };
    const envelopeOrigins = [
      originOf('departments.json'),
      originOf('product-types.json'),
      originOf('attributes.json'),
      originOf('attribute-profiles.json'),
      originOf('export-mappings.json'),
      originOf('guidance.json'),
    ].filter((o): o is ClassificationBundleOriginV2 => o !== null);
    if (envelopeOrigins.length > 0) {
      const firstOriginJson = JSON.stringify(envelopeOrigins[0]);
      for (const origin of envelopeOrigins) {
        if (JSON.stringify(origin) !== firstOriginJson) {
          fail('inconsistent_release_origin', 'Focused release files declare inconsistent bundle origins.');
          break;
        }
        if (origin.kind !== 'release') {
          fail('non_release_origin', `Focused file declares bundleOrigin.kind "${origin.kind}"; a taxonomy release must use kind "release".`);
          break;
        }
      }
      if (manifest && envelopeOrigins[0].kind === 'release' && envelopeOrigins[0].releaseId !== manifest.releaseId) {
        fail('release_origin_mismatch', `Focused files declare releaseId "${envelopeOrigins[0].releaseId}" but manifest declares "${manifest.releaseId}".`);
      }
    }
  }

  return {
    ok: findings.every(f => f.severity !== 'error'),
    findings,
    counts: {
      productTypes: productTypes.length,
      attributes: attributes.length,
      attributeProfiles: profiles.length,
      departments: departments.length,
      mappings: mappings.length,
    },
  };
}

// ─── Fail-closed loaders ───────────────────────────────────────────────────────

/**
 * Parse a validated taxonomy release into a structured bundle. THROWS
 * `ReleaseValidationError` (code `release_invalid`) when the release has any
 * `error`-severity finding.
 */
export function loadTaxonomyRelease(releaseDir: string): TaxonomyReleaseBundle {
  const report = validateTaxonomyRelease(releaseDir);
  if (!report.ok) {
    const messages = report.findings.filter(f => f.severity === 'error').map(f => `  [${f.code}] ${f.message}`);
    throw new ReleaseValidationError(
      `Taxonomy release "${releaseDir}" is invalid:\n${messages.join('\n')}`,
      report,
    );
  }

  const dir = resolveReleaseDir(releaseDir);
  const read = (fileName: string) => JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'));

  const manifest = TaxonomyReleaseManifestSchema.parse(read('manifest.json'));
  const departments = DepartmentsFileV2Schema.parse(read('departments.json')).entries;
  const productTypes = ProductTypesFileV2Schema.parse(read('product-types.json')).entries;
  const attributes = AttributesFileV2Schema.parse(read('attributes.json')).entries;
  const attributeProfiles = AttributeProfilesFileV2Schema.parse(read('attribute-profiles.json')).entries;
  const exportMappings = AttributeMappingsFileV2Schema.parse(read('export-mappings.json')).entries;
  const guidance = GuidanceFileV2Schema.parse(read('guidance.json')).entries;
  const pageAssignmentPolicy = PageAssignmentPolicyV2Schema.parse(read('page-assignment-policy.json'));

  return {
    manifest,
    departments,
    productTypes,
    attributes,
    attributeProfiles,
    exportMappings,
    guidance,
    pageAssignmentPolicy,
  };
}

/**
 * Assert a taxonomy release is valid. THROWS `ReleaseValidationError` on any
 * `error`-severity finding; otherwise returns the validation report.
 */
export function assertReleaseValid(releaseDir: string): ReleaseValidationReport {
  const report = validateTaxonomyRelease(releaseDir);
  if (!report.ok) {
    const messages = report.findings.filter(f => f.severity === 'error').map(f => `  [${f.code}] ${f.message}`);
    throw new ReleaseValidationError(
      `Taxonomy release "${releaseDir}" is invalid:\n${messages.join('\n')}`,
      report,
    );
  }
  return report;
}

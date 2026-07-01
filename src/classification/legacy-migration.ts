import { getDb } from '../db/connection';
import {
  saveClassificationConfig,
  hasClassificationConfig,
} from './config-loader';
import type {
  ClassificationConfig,
  ProductTypeConfig,
  ProductAttributeConfig,
  AttributeProfileConfig,
  AttributeMappingConfig,
} from '../shared/types';

/**
 * Converts a label to a classification-safe slug.
 */
function toSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128)
    .replace(/^[^a-z]/, 'attr-$&') || 'unknown';
}

/**
 * Migrates existing product_types, product_type_fields, and field_registry
 * tables into a ClassificationConfig stored under store/classification/.
 *
 * Returns a ClassificationConfig representing the inferred configuration.
 * Does NOT overwrite an existing classification config by default.
 */
export function migrateLegacyToClassificationConfig(
  workspacePath: string,
  workspaceId: string,
  overwrite = false,
): ClassificationConfig | null {
  if (!overwrite && hasClassificationConfig(workspacePath)) {
    console.log('[LegacyMigration] Classification config already exists — skipping migration.');
    return null;
  }

  const db = getDb();

  // ── Read existing product types ──────────────────────────────────────────
  const typeRows = db.query('SELECT * FROM product_types WHERE workspace_id = ? ORDER BY name').all(workspaceId) as Record<string, any>[];
  const fieldRows = db.query('SELECT * FROM product_type_fields WHERE product_type_id IN (SELECT id FROM product_types WHERE workspace_id = ?) ORDER BY xml_field').all(workspaceId) as Record<string, any>[];

  // ── Read field registry ──────────────────────────────────────────────────
  const registryRows = (() => {
    try {
      return db.query('SELECT * FROM field_registry WHERE workspace_id = ?').all(workspaceId) as Record<string, any>[];
    } catch {
      return [];
    }
  })();

  const now = new Date().toISOString();

  // ── Build product types ──────────────────────────────────────────────────
  const productTypes: ProductTypeConfig[] = [];
  const typeIds = new Map<string, string>(); // oldID → newID

  for (const row of typeRows) {
    const id = toSlug(String(row.name));
    typeIds.set(String(row.id), id);
    productTypes.push({
      id,
      name: String(row.name),
      description: null,
      attributeProfileId: null,
      oldIdAliases: [],
    });
  }

  // ── Build attributes from product_type_fields AND field_registry ─────────
  const attributes: ProductAttributeConfig[] = [];
  const seenAttrIds = new Set<string>();

  function addAttribute(label: string, xmlField: string) {
    const id = toSlug(label);
    if (seenAttrIds.has(id)) return;
    seenAttrIds.add(id);
    attributes.push({
      id,
      name: label,
      description: null,
      valueMode: 'controlled',
      canonicalUnit: null,
      allowedValues: [],
      valueAliases: [],
      visualEvidenceEligibility: 'eligible',
      isClaim: false,
      isCompositionAttribute: false,
      group: null,
    });
  }

  // Fields from product_type_fields first
  for (const row of fieldRows) {
    addAttribute(String(row.label), String(row.xml_field));
  }

  // Fields from field_registry (only custom kind)
  for (const row of registryRows) {
    const kind = String(row.kind ?? 'custom');
    if (kind === 'core') continue;
    addAttribute(String(row.label), String(row.xml_field));
  }

  // ── Build attribute profiles ─────────────────────────────────────────────
  const attributeProfiles: AttributeProfileConfig[] = [];
  const fieldMap = new Map<string, string[]>(); // typeID → [fieldID]

  for (const row of fieldRows) {
    const tid = String(row.product_type_id);
    if (!fieldMap.has(tid)) fieldMap.set(tid, []);
    fieldMap.get(tid)!.push(String(row.xml_field));
  }

  for (const row of typeRows) {
    const typeId = typeIds.get(String(row.id)) || toSlug(String(row.name));
    const fields = fieldMap.get(String(row.id)) ?? [];

    const profileAttributes = fields
      .filter(xmlField => {
        // Find matching attribute ID from our created attributes
        const attr = attributes.find(a => a.id === toSlug(String(
          (fieldRows.find(f => String(f.xml_field) === xmlField) ?? {} as any).label ?? xmlField,
        )));
        return attr != null;
      })
      .map(xmlField => ({
        attributeId: toSlug(String(
          (fieldRows.find(f => String(f.xml_field) === xmlField) ?? {} as any).label ?? xmlField,
        )),
        required: false,
        cardinality: 'single' as const,
        applicabilityConditions: [],
        constraints: {},
        confidenceThresholds: {},
        valueAliases: [],
      }));

    if (profileAttributes.length > 0) {
      const profileId = typeId + '-profile';
      attributeProfiles.push({
        id: profileId,
        productTypeId: typeId,
        name: String(row.name) + ' Profile',
        attributes: profileAttributes,
      });
      // Link product type to profile
      const pt = productTypes.find(p => p.id === typeId);
      if (pt) pt.attributeProfileId = profileId;
    }
  }

  // ── Build attribute mappings ─────────────────────────────────────────────
  const attributeMappings: AttributeMappingConfig[] = [];

  // Map fields from registry
  for (const row of registryRows) {
    const kind = String(row.kind ?? 'custom');
    if (kind === 'core') continue;
    const attrId = toSlug(String(row.label));
    if (!seenAttrIds.has(attrId)) continue;
    attributeMappings.push({
      id: attrId + '-mapping',
      attributeId: attrId,
      catalogField: String(row.xml_field),
      serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' },
      isStale: false,
    });
  }

  // Map fields from product_type_fields not already covered
  for (const row of fieldRows) {
    const attrId = toSlug(String(row.label));
    const alreadyMapped = attributeMappings.some(m => m.attributeId === attrId);
    if (!alreadyMapped) {
      attributeMappings.push({
        id: attrId + '-mapping',
        attributeId: attrId,
        catalogField: String(row.xml_field),
        serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' },
        isStale: false,
      });
    }
  }

  // ── Assemble config ──────────────────────────────────────────────────────
  const config: ClassificationConfig = {
    manifest: {
      schemaVersion: 1,
      compatibilityVersion: 1,
      createdAt: now,
      updatedAt: now,
      fileVersions: {
        'product-types.json': '1.0.0',
        'attributes.json': '1.0.0',
        'attribute-profiles.json': '1.0.0',
        'mappings.json': '1.0.0',
      },
    },
    productTypes,
    attributes,
    attributeProfiles,
    attributeMappings,
    guidance: [],
    modelPolicy: {
      defaultProvider: 'ollama',
      defaultModel: '',
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'local_only',
    },
    dataSharing: {
      imagePolicy: 'local_only',
      textPolicy: 'local_only',
      sensitiveDataFiltering: true,
      retentionDays: 90,
    },
  };

  // ── Persist ──────────────────────────────────────────────────────────────
  saveClassificationConfig(workspacePath, config);
  console.log(`[LegacyMigration] Migrated ${productTypes.length} product types, ${attributes.length} attributes, ${attributeProfiles.length} profiles, ${attributeMappings.length} mappings to store/classification/`);

  return config;
}

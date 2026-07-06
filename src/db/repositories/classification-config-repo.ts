import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type {
  ClassificationConfig,
  ClassificationManifest,
  ProductTypeConfig,
  ProductAttributeConfig,
  AttributeProfileConfig,
  AttributeMappingConfig,
  GuidanceConfig,
  ModelPolicyConfig,
  DataSharingConfig,
  BrandConfig,
} from '../../shared/types';

const now = () => new Date().toISOString();

// ─── Config File Metadata ───────────────────────────────────────────────────────

export interface ConfigFileMeta {
  workspaceId: string;
  fileName: string;
  schemaVersion: number;
  contentHash: string;
  contentJson: string;
  updatedAt: string;
}

function listConfigFiles(workspaceId: string): ConfigFileMeta[] {
  const rows = getDb()
    .query('SELECT * FROM classification_config_files WHERE workspace_id = ? ORDER BY file_name')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    workspaceId: String(r.workspace_id),
    fileName: String(r.file_name),
    schemaVersion: Number(r.schema_version),
    contentHash: String(r.content_hash),
    contentJson: String(r.content_json),
    updatedAt: String(r.updated_at),
  }));
}

function hashString(s: string): string {
  // Simple fast hash for config comparison
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return String(hash);
}

function upsertConfigFile(workspaceId: string, fileName: string, schemaVersion: number, content: unknown): void {
  const json = JSON.stringify(content);
  const hash = hashString(json);
  getDb().run(
    `INSERT INTO classification_config_files (workspace_id, file_name, schema_version, content_hash, content_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, file_name) DO UPDATE SET
       schema_version = EXCLUDED.schema_version,
       content_hash = EXCLUDED.content_hash,
       content_json = EXCLUDED.content_json,
       updated_at = EXCLUDED.updated_at`,
    [workspaceId, fileName, schemaVersion, hash, json, now()],
  );
}

// ─── Full Config Cache Sync ─────────────────────────────────────────────────────

/**
 * Mirrors a loaded ClassificationConfig into the SQLite cache tables.
 * Run after workspace load or after a config change.
 */
export function syncConfigToCache(workspaceId: string, config: ClassificationConfig): void {
  const db = getDb();

  db.transaction(() => {
    // Manifest
    upsertConfigFile(workspaceId, 'manifest.json', config.manifest.schemaVersion, config.manifest);

    // Product Types
    db.run('DELETE FROM classification_product_types WHERE workspace_id = ?', [workspaceId]);
    for (const pt of config.productTypes) {
      db.run(
        `INSERT INTO classification_product_types
         (workspace_id, id, name, description, attribute_profile_id, old_id_aliases_json, config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          pt.id,
          pt.name,
          pt.description ?? null,
          pt.attributeProfileId ?? null,
          JSON.stringify(pt.oldIdAliases),
          hashString(JSON.stringify(pt)),
          now(),
          now(),
        ],
      );
    }
    upsertConfigFile(workspaceId, 'product-types.json', 1, config.productTypes);

    // Attributes
    db.run('DELETE FROM classification_attributes WHERE workspace_id = ?', [workspaceId]);
    for (const attr of config.attributes) {
      db.run(
        `INSERT INTO classification_attributes
         (workspace_id, id, name, description, value_mode, canonical_unit, allowed_values_json,
          value_aliases_json, visual_evidence_eligibility, is_claim, is_composition_attribute,
          group_name, config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          attr.id,
          attr.name,
          attr.description ?? null,
          attr.valueMode,
          attr.canonicalUnit ?? null,
          JSON.stringify(attr.allowedValues),
          JSON.stringify(attr.valueAliases),
          attr.visualEvidenceEligibility,
          attr.isClaim ? 1 : 0,
          attr.isCompositionAttribute ? 1 : 0,
          attr.group ?? null,
          hashString(JSON.stringify(attr)),
          now(),
          now(),
        ],
      );
    }
    upsertConfigFile(workspaceId, 'attributes.json', 1, config.attributes);

    // Attribute Profiles
    db.run('DELETE FROM classification_attribute_profiles WHERE workspace_id = ?', [workspaceId]);
    for (const profile of config.attributeProfiles) {
      db.run(
        `INSERT INTO classification_attribute_profiles
         (workspace_id, id, product_type_id, name, attributes_json, config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          profile.id,
          profile.productTypeId,
          profile.name,
          JSON.stringify(profile.attributes),
          hashString(JSON.stringify(profile)),
          now(),
          now(),
        ],
      );
    }
    upsertConfigFile(workspaceId, 'attribute-profiles.json', 1, config.attributeProfiles);

    // Attribute Mappings
    db.run('DELETE FROM classification_attribute_mappings WHERE workspace_id = ?', [workspaceId]);
    for (const mapping of config.attributeMappings) {
      db.run(
        `INSERT INTO classification_attribute_mappings
         (workspace_id, id, attribute_id, catalog_field, serialization_json, is_stale,
          config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          mapping.id,
          mapping.attributeId,
          mapping.catalogField,
          JSON.stringify(mapping.serialization),
          mapping.isStale ? 1 : 0,
          hashString(JSON.stringify(mapping)),
          now(),
          now(),
        ],
      );
    }
    upsertConfigFile(workspaceId, 'mappings.json', 1, config.attributeMappings);

    // Curation targets are file-backed stage settings. They do not need a
    // dedicated cache table because stages read them from the active config,
    // but tracking the file keeps config metadata/snapshots complete.
    upsertConfigFile(workspaceId, 'curation-targets.json', 1, config.curationTargets ?? []);

    // Guidance
    db.run('DELETE FROM classification_guidance WHERE workspace_id = ?', [workspaceId]);
    for (const g of config.guidance) {
      db.run(
        `INSERT INTO classification_guidance
         (workspace_id, id, scope_type, scope_id, structured_json, free_form,
          manual_review_requirement, config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          g.id,
          g.scope,
          g.scopeId ?? null,
          JSON.stringify(g.structured),
          g.freeForm ?? null,
          g.manualReviewRequirement ? 1 : 0,
          hashString(JSON.stringify(g)),
          now(),
          now(),
        ],
      );
    }
    upsertConfigFile(workspaceId, 'guidance.json', 1, config.guidance);

    // Model Policy
    db.run(
      `INSERT INTO classification_model_policies (workspace_id, policy_json, config_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         policy_json = EXCLUDED.policy_json,
         config_hash = EXCLUDED.config_hash,
         updated_at = EXCLUDED.updated_at`,
      [workspaceId, JSON.stringify(config.modelPolicy), hashString(JSON.stringify(config.modelPolicy)), now()],
    );
    upsertConfigFile(workspaceId, 'model-policies.json', 1, config.modelPolicy);

    // Brands
    db.run('DELETE FROM classification_brands WHERE workspace_id = ?', [workspaceId]);
    for (const brand of config.brands) {
      db.run(
        `INSERT INTO classification_brands
         (workspace_id, id, name, aliases_json, old_id_aliases_json, config_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          brand.id,
          brand.name,
          JSON.stringify(brand.aliases),
          JSON.stringify(brand.oldIdAliases),
          hashString(JSON.stringify(brand)),
          now(),
          now(),
        ],
      );
    }
    upsertConfigFile(workspaceId, 'brands.json', 1, config.brands);

    // Data Sharing Policy
    db.run(
      `INSERT INTO classification_data_sharing_policies (workspace_id, policy_json, config_hash, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET
         policy_json = EXCLUDED.policy_json,
         config_hash = EXCLUDED.config_hash,
         updated_at = EXCLUDED.updated_at`,
      [workspaceId, JSON.stringify(config.dataSharing), hashString(JSON.stringify(config.dataSharing)), now()],
    );
    upsertConfigFile(workspaceId, 'data-sharing.json', 1, config.dataSharing);
  })();
}

// ─── Config Snapshot (for reproducible runs) ────────────────────────────────────

/**
 * Creates a point-in-time snapshot of the active config for use in a classification run.
 */
export function createConfigSnapshot(workspaceId: string, config: ClassificationConfig, sourceCommit?: string): string {
  const snapshotHash = hashString(JSON.stringify(config));

  // Return existing snapshot if identical config was already captured
  const existing = getDb()
    .query('SELECT id FROM classification_config_snapshots WHERE workspace_id = ? AND snapshot_hash = ?')
    .get(workspaceId, snapshotHash) as Record<string, any> | undefined;
  if (existing) return String(existing.id);

  const id = randomUUID();
  getDb().run(
    `INSERT INTO classification_config_snapshots
     (id, workspace_id, snapshot_hash, manifest_schema_version, compatibility_version,
      source_commit, config_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, workspaceId, snapshotHash, config.manifest.schemaVersion, config.manifest.compatibilityVersion, sourceCommit ?? null, JSON.stringify(config), now()],
  );
  return id;
}

// ─── Read back from cache ──────────────────────────────────────────────────────

export function getCachedProductTypes(workspaceId: string): ProductTypeConfig[] {
  const rows = getDb()
    .query('SELECT * FROM classification_product_types WHERE workspace_id = ?')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    id: String(r.id),
    name: String(r.name),
    description: r.description ? String(r.description) : null,
    attributeProfileId: r.attribute_profile_id ? String(r.attribute_profile_id) : null,
    oldIdAliases: r.old_id_aliases_json ? JSON.parse(String(r.old_id_aliases_json)) : [],
  }));
}

export function getCachedAttributes(workspaceId: string): ProductAttributeConfig[] {
  const rows = getDb()
    .query('SELECT * FROM classification_attributes WHERE workspace_id = ?')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    id: String(r.id),
    name: String(r.name),
    description: r.description ? String(r.description) : null,
    valueMode: String(r.value_mode) as ProductAttributeConfig['valueMode'],
    canonicalUnit: r.canonical_unit ? String(r.canonical_unit) : null,
    allowedValues: r.allowed_values_json ? JSON.parse(String(r.allowed_values_json)) : [],
    valueAliases: r.value_aliases_json ? JSON.parse(String(r.value_aliases_json)) : [],
    visualEvidenceEligibility: String(r.visual_evidence_eligibility) as ProductAttributeConfig['visualEvidenceEligibility'],
    isClaim: Number(r.is_claim) === 1,
    isCompositionAttribute: Number(r.is_composition_attribute) === 1,
    group: r.group_name ? String(r.group_name) : null,
  }));
}

export function getCachedAttributeProfiles(workspaceId: string): AttributeProfileConfig[] {
  const rows = getDb()
    .query('SELECT * FROM classification_attribute_profiles WHERE workspace_id = ?')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    id: String(r.id),
    productTypeId: String(r.product_type_id),
    name: String(r.name),
    attributes: r.attributes_json ? JSON.parse(String(r.attributes_json)) : [],
  }));
}

export function getCachedAttributeMappings(workspaceId: string): AttributeMappingConfig[] {
  const rows = getDb()
    .query('SELECT * FROM classification_attribute_mappings WHERE workspace_id = ?')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    id: String(r.id),
    attributeId: String(r.attribute_id),
    catalogField: String(r.catalog_field),
    serialization: r.serialization_json ? JSON.parse(String(r.serialization_json)) : { format: 'direct', separator: ', ', prefix: '', suffix: '' },
    isStale: Number(r.is_stale) === 1,
  }));
}

function getCachedGuidance(workspaceId: string): GuidanceConfig[] {
  const rows = getDb()
    .query('SELECT * FROM classification_guidance WHERE workspace_id = ?')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    id: String(r.id),
    scope: String(r.scope_type) as GuidanceConfig['scope'],
    scopeId: r.scope_id ? String(r.scope_id) : null,
    structured: r.structured_json ? JSON.parse(String(r.structured_json)) : {},
    freeForm: r.free_form ? String(r.free_form) : null,
    manualReviewRequirement: Number(r.manual_review_requirement) === 1,
  }));
}

function getCachedModelPolicy(workspaceId: string): ModelPolicyConfig | null {
  const row = getDb()
    .query('SELECT * FROM classification_model_policies WHERE workspace_id = ?')
    .get(workspaceId) as Record<string, any> | undefined;
  if (!row) return null;
  return JSON.parse(String(row.policy_json)) as ModelPolicyConfig;
}

export function getCachedBrands(workspaceId: string): BrandConfig[] {
  const rows = getDb()
    .query('SELECT * FROM classification_brands WHERE workspace_id = ?')
    .all(workspaceId) as Record<string, any>[];
  return rows.map(r => ({
    id: String(r.id),
    name: String(r.name),
    aliases: r.aliases_json ? JSON.parse(String(r.aliases_json)) : [],
    oldIdAliases: r.old_id_aliases_json ? JSON.parse(String(r.old_id_aliases_json)) : [],
  }));
}

export function getCachedDataSharingPolicy(workspaceId: string): DataSharingConfig | null {
  const row = getDb()
    .query('SELECT * FROM classification_data_sharing_policies WHERE workspace_id = ?')
    .get(workspaceId) as Record<string, any> | undefined;
  if (!row) return null;
  return JSON.parse(String(row.policy_json)) as DataSharingConfig;
}

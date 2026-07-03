import fs from 'fs';
import path from 'path';
import { ClassificationConfigSchema } from '../shared/schemas/classification';
import type { ClassificationConfig } from '../shared/types';

const CLASSIFICATION_DIR = 'classification';

/**
 * Resolves the classification directory under the workspace store/ path.
 */
function classificationDir(workspacePath: string): string {
  return path.join(workspacePath, 'store', CLASSIFICATION_DIR);
}

/**
 * Ensures the store/classification/ directory exists.
 */
function ensureClassificationDir(workspacePath: string): void {
  const dir = classificationDir(workspacePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function writeJsonFile<T>(filePath: string, data: T): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Default / Stable Seed Files ───────────────────────────────────────────────

const DEFAULT_MANIFEST: Partial<ClassificationConfig>['manifest'] = {
  schemaVersion: 1,
  compatibilityVersion: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  fileVersions: {},
};

const DEFAULT_MODEL_POLICY: Partial<ClassificationConfig>['modelPolicy'] = {
  defaultProvider: 'ollama',
  defaultModel: '',
  stageOverrides: {},
  imageDataSharing: 'local_only',
  textDataSharing: 'local_only',
};

const DEFAULT_DATA_SHARING: Partial<ClassificationConfig>['dataSharing'] = {
  imagePolicy: 'local_only',
  textPolicy: 'local_only',
  sensitiveDataFiltering: true,
  retentionDays: 90,
};

// ─── Load ──────────────────────────────────────────────────────────────────────

/**
 * Loads all files from store/classification/ and constructs a validated ClassificationConfig.
 * Missing files are replaced with empty defaults so classification can be incrementally
 * configured without requiring every file to exist from day one.
 */
export function loadClassificationConfig(workspacePath: string): ClassificationConfig {
  const dir = classificationDir(workspacePath);
  ensureClassificationDir(workspacePath);

  const manifest = readJsonFile<ClassificationConfig['manifest']>(path.join(dir, 'manifest.json'));
  const productTypes = readJsonFile<ClassificationConfig['productTypes']>(path.join(dir, 'product-types.json')) ?? [];
  const attributes = readJsonFile<ClassificationConfig['attributes']>(path.join(dir, 'attributes.json')) ?? [];
  const attributeProfiles = readJsonFile<ClassificationConfig['attributeProfiles']>(path.join(dir, 'attribute-profiles.json')) ?? [];
  const attributeMappings = readJsonFile<ClassificationConfig['attributeMappings']>(path.join(dir, 'mappings.json')) ?? [];
  const curationTargets = readJsonFile<ClassificationConfig['curationTargets']>(path.join(dir, 'curation-targets.json')) ?? [];
  const guidance = readJsonFile<ClassificationConfig['guidance']>(path.join(dir, 'guidance.json')) ?? [];
  const modelPolicy = readJsonFile<ClassificationConfig['modelPolicy']>(path.join(dir, 'model-policies.json'));
  const dataSharing = readJsonFile<ClassificationConfig['dataSharing']>(path.join(dir, 'data-sharing.json'));

  const config: ClassificationConfig = {
    manifest: manifest ?? {
      ...DEFAULT_MANIFEST,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fileVersions: {},
    } as ClassificationConfig['manifest'],
    productTypes: productTypes as ClassificationConfig['productTypes'],
    attributes: attributes as ClassificationConfig['attributes'],
    attributeProfiles: attributeProfiles as ClassificationConfig['attributeProfiles'],
    attributeMappings: attributeMappings as ClassificationConfig['attributeMappings'],
    curationTargets: curationTargets as ClassificationConfig['curationTargets'],
    guidance: guidance as ClassificationConfig['guidance'],
    modelPolicy: (modelPolicy ?? DEFAULT_MODEL_POLICY) as ClassificationConfig['modelPolicy'],
    dataSharing: (dataSharing ?? DEFAULT_DATA_SHARING) as ClassificationConfig['dataSharing'],
  };

  const parsed = ClassificationConfigSchema.safeParse(config);
  return parsed.success ? parsed.data : config;
}

// ─── Save ──────────────────────────────────────────────────────────────────────

/**
 * Persists a full ClassificationConfig into individual files under store/classification/.
 */
export function saveClassificationConfig(workspacePath: string, config: ClassificationConfig): void {
  ensureClassificationDir(workspacePath);
  const dir = classificationDir(workspacePath);

  writeJsonFile(path.join(dir, 'manifest.json'), config.manifest);
  writeJsonFile(path.join(dir, 'product-types.json'), config.productTypes);
  writeJsonFile(path.join(dir, 'attributes.json'), config.attributes);
  writeJsonFile(path.join(dir, 'attribute-profiles.json'), config.attributeProfiles);
  writeJsonFile(path.join(dir, 'mappings.json'), config.attributeMappings);
  writeJsonFile(path.join(dir, 'curation-targets.json'), config.curationTargets);
  writeJsonFile(path.join(dir, 'guidance.json'), config.guidance);
  writeJsonFile(path.join(dir, 'model-policies.json'), config.modelPolicy);
  writeJsonFile(path.join(dir, 'data-sharing.json'), config.dataSharing);
}

/**
 * Returns true if the classification directory exists and contains a manifest.json.
 */
export function hasClassificationConfig(workspacePath: string): boolean {
  return fs.existsSync(path.join(classificationDir(workspacePath), 'manifest.json'));
}

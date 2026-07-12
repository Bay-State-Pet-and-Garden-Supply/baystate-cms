import { getDb } from '../db/connection';
import { listRegistry } from '../db/repositories/field-registry-repo';
import { listPages } from '../db/repositories/page-repo';
import {
  CurationTargetConfigSchema,
  type ClassificationConfig,
  type CurationTargetConfig,
  type ProductAttributeConfig,
  type AttributeMappingConfig,
} from '../shared/schemas/classification';

export interface CurationTargetOption {
  value: string;
  label: string;
}

export interface ProductFieldCurationCandidate {
  catalogField: string;
  label: string;
  dataType: string;
  values: string[];
  target: CurationTargetConfig | null;
  attributeId: string | null;
}

export interface CurationTargetCandidates {
  productTypes: CurationTargetOption[];
  productFields: ProductFieldCurationCandidate[];
  pages: CurationTargetOption[];
}

function toClassificationSlug(input: string, fallback = 'target'): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  const safe = slug || fallback;
  return /^[a-z]/.test(safe) ? safe : `${fallback}-${safe}`;
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const raw of values) {
    const value = String(raw ?? '').trim();
    if (!value) continue;
    seen.add(value);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function parseSampleValues(sampleValuesJson: string | null): string[] {
  if (!sampleValuesJson) return [];
  try {
    const parsed = JSON.parse(sampleValuesJson);
    if (!Array.isArray(parsed)) return [];
    // ShopSite multi-select fields use | as separator. Split each sample
    // value so "Dog|Food" becomes ["Dog", "Food"].
    const result: string[] = [];
    for (const v of parsed) {
      const str = String(v);
      if (str.includes('|')) {
        result.push(...str.split('|').map(s => s.trim()).filter(Boolean));
      } else {
        result.push(str.trim());
      }
    }
    return result;
  } catch {
    // Ignore malformed legacy sample values.
  }
  return [];
}

function listCatalogFieldOptions(catalogField: string, limit = 250): string[] {
  if (!/^[a-zA-Z0-9_]+$/.test(catalogField)) return [];

  const rows = getDb()
    .query('SELECT custom_fields FROM product_index WHERE custom_fields IS NOT NULL AND custom_fields != ?')
    .all('') as Array<{ custom_fields: string | null }>;

  const values: string[] = [];
  for (const row of rows) {
    if (!row.custom_fields) continue;
    try {
      const customFields = JSON.parse(String(row.custom_fields)) as Record<string, unknown>;
      const raw = customFields[catalogField];
      if (Array.isArray(raw)) {
        for (const value of raw) values.push(String(value));
      } else if (raw !== null && raw !== undefined) {
        values.push(String(raw));
      }
    } catch {
      // Skip malformed product_index rows without failing curation settings.
    }
  }

  // ShopSite multi-select ProductFields serialize multiple selections with a
  // pipe delimiter (e.g. "Dog|Food"). Split these into individual options
  // so managers see discrete values in the curation dropdown.
  const split: string[] = [];
  for (const value of values) {
    if (value.includes('|')) {
      split.push(...value.split('|').map(v => v.trim()).filter(Boolean));
    } else {
      split.push(value.trim());
    }
  }

  return uniqueSorted(split).slice(0, limit);
}

/**
 * Discovers every custom ProductField key present in product_index.custom_fields.
 * This complements `field_registry` which may be incomplete for stores where
 * only a subset of fields were captured during sync.
 */
function listDistinctCustomFieldKeys(): string[] {
  const rows = getDb()
    .query("SELECT custom_fields FROM product_index WHERE custom_fields IS NOT NULL AND custom_fields != '' AND custom_fields != '{}'")
    .all() as Array<{ custom_fields: string | null }>;

  const keys = new Set<string>();
  for (const row of rows) {
    if (!row.custom_fields) continue;
    try {
      const customFields = JSON.parse(String(row.custom_fields)) as Record<string, unknown>;
      for (const key of Object.keys(customFields)) {
        if (key.startsWith('ProductField')) keys.add(key);
      }
    } catch {
      // Skip malformed rows.
    }
  }
  return [...keys].sort((a, b) => {
    const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
    const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
    return numA - numB || a.localeCompare(b);
  });
}

export function getExplicitCurationTargets(config: ClassificationConfig): CurationTargetConfig[] {
  return [...(config.curationTargets ?? [])]
    .filter(target => target.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

// fallow-ignore-next-line unused-export — used by tests
export function hasExplicitCurationTargets(config: ClassificationConfig): boolean {
  return (config.curationTargets ?? []).length > 0;
}

// fallow-ignore-next-line unused-export — used by tests
export function findCurationTargetForAttribute(
  config: ClassificationConfig,
  attributeId: string,
  mappings: AttributeMappingConfig[] = config.attributeMappings,
): CurationTargetConfig | null {
  const targets = getExplicitCurationTargets(config).filter(target => target.kind === 'product_field');
  const direct = targets.find(target => target.attributeId === attributeId);
  if (direct) return direct;

  const mapping = mappings.find(m => m.attributeId === attributeId);
  if (!mapping) return null;
  return targets.find(target => target.catalogField === mapping.catalogField) ?? null;
}

export function resolveAttributeAllowedValues(
  config: ClassificationConfig,
  attribute: ProductAttributeConfig,
  target: CurationTargetConfig | null,
  limit = 250,
): string[] {
  const values = [...attribute.allowedValues];
  if (target?.optionSource === 'live_store' && target.catalogField) {
    values.push(...listCatalogFieldOptions(target.catalogField, limit));
  }
  return uniqueSorted(values).slice(0, limit);
}

export function listCurationTargetCandidates(
  workspaceId: string,
  config: ClassificationConfig,
): CurationTargetCandidates {
  const productTypes = config.productTypes.map(type => ({ value: type.id, label: type.name }));
  const pages = listPages().map(page => ({ value: page.name, label: page.name }));
  const registry = listRegistry(workspaceId)
    .filter(entry => entry.kind === 'custom' || entry.xmlField.startsWith('ProductField'));

  // Build a set of fields already covered by the registry so we can discover
  // fields that exist in the live catalog but were never registered during sync.
  const registryFieldNames = new Set(registry.map(entry => entry.xmlField));
  const discoveredFieldNames = listDistinctCustomFieldKeys()
    .filter(key => !registryFieldNames.has(key));

  const productFields: ProductFieldCurationCandidate[] = [
    // Registry-backed entries (richest metadata).
    ...registry.map(entry => {
      const mapping = config.attributeMappings.find(m => m.catalogField === entry.xmlField) ?? null;
      const target = (config.curationTargets ?? []).find(t =>
        t.kind === 'product_field' && (t.catalogField === entry.xmlField || (mapping && t.attributeId === mapping.attributeId)),
      ) ?? null;
      const liveValues = listCatalogFieldOptions(entry.xmlField);
      const sampleValues = parseSampleValues(entry.sampleValuesJson);
      const configuredValues = mapping
        ? config.attributes.find(a => a.id === mapping.attributeId)?.allowedValues ?? []
        : [];

      return {
        catalogField: entry.xmlField,
        label: entry.label || entry.xmlField,
        dataType: entry.dataType,
        values: uniqueSorted([...liveValues, ...sampleValues, ...configuredValues]),
        target,
        attributeId: mapping?.attributeId ?? target?.attributeId ?? null,
      };
    }),
    // Fields discovered from live catalog data that the registry never captured.
    ...discoveredFieldNames.map(fieldName => {
      const mapping = config.attributeMappings.find(m => m.catalogField === fieldName) ?? null;
      const target = (config.curationTargets ?? []).find(t =>
        t.kind === 'product_field' && (t.catalogField === fieldName || (mapping && t.attributeId === mapping.attributeId)),
      ) ?? null;
      const liveValues = listCatalogFieldOptions(fieldName);
      const configuredValues = mapping
        ? config.attributes.find(a => a.id === mapping.attributeId)?.allowedValues ?? []
        : [];

      return {
        catalogField: fieldName,
        label: fieldName,
        dataType: 'string',
        values: uniqueSorted([...liveValues, ...configuredValues]),
        target,
        attributeId: mapping?.attributeId ?? target?.attributeId ?? null,
      };
    }),
  ];

  // Sort by numeric suffix so ProductField24 comes after ProductField5,
  // not lexicographically.
  productFields.sort((a, b) => {
    const numA = parseInt(a.catalogField.replace(/\D/g, ''), 10) || 0;
    const numB = parseInt(b.catalogField.replace(/\D/g, ''), 10) || 0;
    return numA - numB || a.catalogField.localeCompare(b.catalogField);
  });

  return { productTypes, productFields, pages };
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex(item => item.id === next.id);
  if (index === -1) return [...items, next];
  const copy = [...items];
  copy[index] = next;
  return copy;
}

export function applyCurationTargetsToConfig(
  config: ClassificationConfig,
  rawTargets: unknown[],
  workspaceId: string,
): ClassificationConfig {
  const registry = listRegistry(workspaceId);
  const now = new Date().toISOString();

  let attributes = [...config.attributes];
  let attributeMappings = [...config.attributeMappings];

  const normalizedTargets = rawTargets.map((raw, index) => {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<CurationTargetConfig>;
    const kind = input.kind ?? 'product_field';
    const fallbackId = kind === 'page'
      ? 'category-pages'
      : kind === 'product_type'
        ? 'primary-product-type'
        : toClassificationSlug(`target-${input.catalogField ?? input.label ?? index}`, 'target');
    const fallbackLabel = kind === 'page'
      ? 'Category Pages'
      : kind === 'product_type'
        ? 'Product Type'
        : String(input.label ?? input.catalogField ?? `Field ${index + 1}`);
    const parsed = CurationTargetConfigSchema.parse({
      ...input,
      id: input.id ?? fallbackId,
      label: input.label ?? fallbackLabel,
      kind,
      sortOrder: input.sortOrder ?? index,
    });

    if (parsed.kind === 'page') {
      return {
        ...parsed,
        catalogField: null,
        attributeId: null,
        optionSource: 'live_store' as const,
      };
    }
    if (parsed.kind === 'product_type') {
      return {
        ...parsed,
        catalogField: null,
        attributeId: null,
        optionSource: 'configured' as const,
        selectionMode: 'single' as const,
      };
    }

    if (!parsed.catalogField) {
      throw new Error(`Product-field curation target "${parsed.label}" is missing catalogField.`);
    }

    const registryEntry = registry.find(entry => entry.xmlField === parsed.catalogField);
    const label = parsed.label || registryEntry?.label || parsed.catalogField;
    const existingMapping = attributeMappings.find(mapping => mapping.catalogField === parsed.catalogField);
    const attributeId = parsed.attributeId || existingMapping?.attributeId || toClassificationSlug(`field-${parsed.catalogField}`, 'field');
    const existingAttribute = attributes.find(attribute => attribute.id === attributeId);
    const liveOptions = parsed.optionSource === 'live_store' ? listCatalogFieldOptions(parsed.catalogField) : [];
    const sampleOptions = parseSampleValues(registryEntry?.sampleValuesJson ?? null);
    const allowedValues = uniqueSorted([
      ...(existingAttribute?.allowedValues ?? []),
      ...sampleOptions,
      ...liveOptions,
    ]);

    const nextAttribute: ProductAttributeConfig = {
      id: attributeId,
      name: label,
      description: existingAttribute?.description ?? `Curation target for ${parsed.catalogField}`,
      valueMode: 'controlled',
      canonicalUnit: existingAttribute?.canonicalUnit ?? null,
      allowedValues,
      valueAliases: existingAttribute?.valueAliases ?? [],
      visualEvidenceEligibility: existingAttribute?.visualEvidenceEligibility ?? 'eligible',
      isClaim: existingAttribute?.isClaim ?? false,
      isCompositionAttribute: existingAttribute?.isCompositionAttribute ?? false,
      group: existingAttribute?.group ?? 'Curation',
    };
    attributes = upsertById(attributes, nextAttribute);

    const mappingId = existingMapping?.id ?? toClassificationSlug(`${attributeId}-mapping`, 'mapping');
    const nextMapping: AttributeMappingConfig = {
      id: mappingId,
      attributeId,
      catalogField: parsed.catalogField,
      serialization: existingMapping?.serialization ?? { format: 'direct', separator: ', ', prefix: '', suffix: '' },
      isStale: false,
    };
    attributeMappings = upsertById(attributeMappings, nextMapping);

    return {
      ...parsed,
      label,
      attributeId,
      catalogField: parsed.catalogField,
      optionSource: parsed.optionSource,
    };
  });

  return {
    ...config,
    manifest: {
      ...config.manifest,
      updatedAt: now,
      fileVersions: {
        ...(config.manifest.fileVersions ?? {}),
        'curation-targets.json': now,
        'attributes.json': now,
        'mappings.json': now,
      },
    },
    attributes,
    attributeMappings,
    curationTargets: normalizedTargets,
  };
}

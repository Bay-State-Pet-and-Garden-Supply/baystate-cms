import type { FieldRegistryEntry } from '../../../shared/schemas/field-registry';

// ── Client API response types for catalog schema workbench ─────────

export interface CatalogSchemaSummary {
  lastPullAt: string | null;
  productCount: number;
  categoryPageCount: number;
  catalogFieldCount: number;
  unlabeledFieldCount: number;
  unmappedAttributeCount: number;
  staleMappingCount: number;
  fieldsMissingFromLatestPull: string[];
  productsMissingRequiredMappedField: number;
}

export interface CatalogFieldSummary {
  xmlField: string;
  label: string;
  kind: 'core' | 'system' | 'custom';
  dataType: FieldRegistryEntry['dataType'];
  uiGroup: string | null;
  nonEmptyCount: number;
  distinctCount: number;
  inferredValueMode: 'controlled' | 'freeText' | 'measured' | 'unknown';
  mappedAttributeId: string | null;
  isCurationTarget: boolean;
  isStale: boolean;
  warning: string | null;
}

export interface TopValueEntry {
  value: string;
  frequency: number;
  skus: string[];
}

export interface CatalogFieldDetail extends CatalogFieldSummary {
  sampleValues: string[];
  topValues: TopValueEntry[];
  emptyCount: number;
  emptyRate: number;
  affectedExampleSkus: string[];
}

export interface CategoryPageNode {
  id: string;
  name: string;
  fileName: string | null;
  parentId: string | null;
  productCount: number;
  lastSyncedAt: string | null;
  children: CategoryPageNode[];
}

export interface AttributeMappingView {
  id: string;
  attributeId: string;
  attributeName: string;
  catalogField: string;
  serialization: { format: string; separator?: string; prefix?: string; suffix?: string };
  isStale: boolean;
  usedByProductTypes: string[];
}

export interface SchemaHealthFinding {
  id: string;
  severity: 'blocker' | 'warning' | 'info';
  code: string;
  message: string;
  fieldPath?: string | null;
  relatedTab: 'overview' | 'fields' | 'types' | 'pages' | 'health';
  relatedId?: string;
}

export interface CatalogSchemaHealthReport {
  findings: SchemaHealthFinding[];
  summary: { blockers: number; warnings: number; infos: number };
}

// ── Tab definitions ───────────────────────────────────────────────

export interface WorkbenchTab {
  id: string;
  label: string;
  badge?: number | string;
}

export const WORKBENCH_TABS: WorkbenchTab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'products', label: 'Products' },
  { id: 'fields', label: 'Catalog Fields' },
  { id: 'types', label: 'Types & Attributes' },
  { id: 'pages', label: 'Product Pages' },
  { id: 'mappings', label: 'Mappings' },
  { id: 'health', label: 'Schema Health' },
];

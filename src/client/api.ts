import type { FieldRegistryEntry } from '../shared/schemas/field-registry';

const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    const errorMsg = (data as any).error
      || (Array.isArray((data as any).errors) ? (data as any).errors.join('; ') : null)
      || (data as any).message
      || `HTTP ${res.status}`;
    throw new Error(errorMsg);
  }
  return data as T;
}

export interface Workspace {
  id: string;
  name: string;
  workspacePath: string;
  gitPath: string;
  createdAt: string;
  updatedAt: string;
  bootstrapStatus: string;
  baselineCommit: string | null;
}

export interface BootstrapResult {
  success: boolean;
  productCount: number;
  commitHash?: string;
  errors: string[];
  warnings: string[];
}

export interface ConnectionSettings {
  id?: string;
  cgiBaseUrl: string;
  merchantId: string | null;
  passwordConfigured: boolean;
  lastTestedAt?: string | null;
  lastTestStatus?: string | null;
  lastTestError?: string | null;
}

export interface ProductIndexItem {
  id: string;
  sku: string;
  filePath: string;
  title: string;
  status: string;
  price: string | null;
  inventoryQuantity: number | null;
  primaryImage: string | null;
  productHash: string;
  lastApprovedCommit: string | null;
  syncStatus: string;
  hasAdvancedBlocks: number;
  hasWarnings: number;
  createdAt: string;
  updatedAt: string;
  customFields: Record<string, string>;
}

export interface ProductDetail {
  approved: unknown;
  draft: unknown;
  product: unknown;
  hasDraft: boolean;
  changeSetId: string | null;
}

export interface ChangeSet {
  id: string;
  workspaceId: string;
  title: string;
  status: string;
  baseCommit: string;
  approvedCommit: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeSetItem {
  id: string;
  changeSetId: string;
  sku: string;
  operation: string;
  draftJson: string;
  baseJson: string | null;
  validationStatus: string;
}

export interface ValidationResult {
  total: number;
  blockers: number;
  warnings: number;
  infos: number;
  items: Array<{
    sku: string;
    operation: string;
    results: Array<{ severity: string; code: string; message: string; fieldPath: string | null }>;
  }>;
  canApprove: boolean;
}

export interface ExportResult {
  success: boolean;
  exportDir: string;
  xmlPath: string;
  manifestPath: string;
  instructionsPath: string;
  zipPath: string;
  productCount: number;
}

// Store Workspace
export function getWorkspace() { return request<{ workspace: Workspace | null }>('/workspace'); }
export function openWorkspace() { return request<{ success: boolean; workspace: Workspace }>('/workspace/open', { method: 'POST' }); }
export function closeWorkspace() { return request<{ success: boolean; message: string }>('/workspace/close', { method: 'POST' }); }
export function getRecentWorkspaces() { return Promise.resolve({ success: true, workspaces: [] }); }
export function removeRecentWorkspace(_path: string) { return Promise.resolve({ success: true }); }
export function pickDirectory() { return Promise.resolve({ success: false, error: 'unsupported' }); }
export function initWorkspace(_name: string, _path: string) { return getWorkspace().then(res => ({ success: true, workspace: res.workspace! })); }



// Connection
export function getConnection() { return request<{ connection: ConnectionSettings | null }>('/connection'); }
export function saveConnection(cgiBaseUrl: string, merchantId: string, password?: string) {
  return request<{ success: boolean; connection: ConnectionSettings }>('/connection/save', {
    method: 'POST',
    body: JSON.stringify({ cgiBaseUrl, merchantId, password }),
  });
}
export function testConnection() { return request<{ success: boolean; message: string }>('/connection/test', { method: 'POST' }); }

// Bootstrap
export function bootstrapFromXml(xml: string) { return request<BootstrapResult>('/bootstrap/xml', { method: 'POST', body: JSON.stringify({ xml }) }); }
export function bootstrapFromFile(filePath: string) { return request<BootstrapResult>('/bootstrap/file', { method: 'POST', body: JSON.stringify({ filePath }) }); }
export function bootstrapFromPull() { return request<BootstrapResult>('/bootstrap/pull', { method: 'POST' }); }
export function getBootstrapStatus() { return request<{ bootstrapStatus: string; baselineCommit: string | null; error?: string | null }>('/bootstrap/status'); }

// Products
export function listProducts(
  status?: string,
  search?: string,
  limit?: number,
  offset?: number,
  minPrice?: string,
  maxPrice?: string,
  inventoryStatus?: string,
  customFilters?: Record<string, string>,
) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (search) params.set('search', search);
  if (limit !== undefined) params.set('limit', String(limit));
  if (offset !== undefined) params.set('offset', String(offset));
  if (minPrice) params.set('minPrice', minPrice);
  if (maxPrice) params.set('maxPrice', maxPrice);
  if (inventoryStatus) params.set('inventoryStatus', inventoryStatus);
  if (customFilters) {
    for (const [key, val] of Object.entries(customFilters)) {
      if (val) {
        params.set(`cf_${key}`, val);
      }
    }
  }
  const qs = params.toString();
  return request<{ products: ProductIndexItem[]; total: number }>(`/products${qs ? '?' + qs : ''}`);
}

export function getProductFacets() {
  return request<{ facets: Record<string, { label: string; values: string[] }> }>('/products/facets');
}
export function getProduct(sku: string) { return request<ProductDetail>(`/products/${encodeURIComponent(sku)}`); }
export function saveDraft(sku: string, changes: Record<string, unknown>, operation?: string) {
  return request<{ success: boolean; changeSetId: string; draftHash: string }>(
    `/products/${encodeURIComponent(sku)}/draft`,
    { method: 'PUT', body: JSON.stringify({ changes, operation }) },
  );
}
export interface BulkImportResponse {
  success: boolean;
  changeSetId: string;
  imported: string[];
  skipped: Array<{ sku: string; reason: string }>;
}
export function bulkImportProducts(products: Array<{ sku: string; name: string; price: string | null }>) {
  return request<BulkImportResponse>('/products/bulk-import', {
    method: 'POST',
    body: JSON.stringify({ products }),
  });
}


// ─── Catalog Classification ────────────────────────────────────────────────

export interface CatalogClassificationDetail {
  run: {
    id: string;
    sourceKind: string;
    status: string;
    productSku: string;
    configSnapshotHash: string | null;
    sourceProductHash: string | null;
    startedAt: string;
    completedAt: string | null;
    errorMessage: string | null;
  } | null;
  configDrift: boolean;
  sourceDrift: boolean;
  evidence: Array<{
    id: string;
    source: string;
    sourceField: string | null;
    value: unknown;
    reliability: string;
    attributeId?: string | null;
    sourceUrl?: string | null;
    snippet?: string | null;
  }>;
  proposals: Array<{
    id: string;
    proposalType: string;
    targetId: string | null;
    proposedValue: unknown;
    revisedValue?: unknown;
    hasRevisedValue: boolean;
    revisedTargetId?: string | null;
    hasRevisedTargetId: boolean;
    currentDecisionId: string | null;
    confidence: number;
    status: string;
    evidenceIds?: string[];
    supportingEvidenceIds?: string[];
    contradictingEvidenceIds?: string[];
  }>;
  decisions: Array<{
    id: string;
    proposalId: string;
    decision: string;
    revisedFromId: string | null;
    revisedValue?: unknown;
    hasRevisedValue: boolean;
    revisedTargetId?: string | null;
    hasRevisedTargetId: boolean;
    actionToken: string | null;
    evidenceIds?: string[];
  }>;
  stageResults: Array<Record<string, unknown>>;
}

export function getCatalogClassification(sku: string) {
  return request<CatalogClassificationDetail>(`/products/${encodeURIComponent(sku)}/classification`);
}

export function runCatalogClassification(sku: string) {
  return request<{
    runId: string;
    sourceProductHash: string;
    configSnapshotHash: string;
    evidence: unknown[];
    proposals: unknown[];
    stageResults: unknown[];
  }>(`/products/${encodeURIComponent(sku)}/classification/runs`, {
    method: 'POST',
  });
}

export function submitCatalogDecisions(
  sku: string,
  runId: string,
  decisions: Array<{
    proposalId: string;
    decision: 'accepted' | 'rejected' | 'deferred';
    reviewerNote?: string | null;
    revisedValue?: unknown;
    revisedTargetId?: string | null;
    /** Evidence citations for this correction (issue #17 I). */
    evidenceIds?: string[];
    actionToken?: string;
    expectedRevisionId?: string | null;
  }>,
) {
  return request<{ ok: boolean; decisions: unknown[] }>(
    `/products/${encodeURIComponent(sku)}/classification/runs/${encodeURIComponent(runId)}/decisions`,
    { method: 'POST', body: JSON.stringify({ decisions }) },
  );
}

export function applyCatalogClassification(sku: string, runId: string) {
  return request<{
    ok: boolean;
    changeSetId: string;
    appliedFields: string[];
    appliedPages: string[];
    skipped: Array<{ proposalId: string; reason: string }>;
  }>(`/products/${encodeURIComponent(sku)}/classification/runs/${encodeURIComponent(runId)}/apply`, {
    method: 'POST',
  });
}


// Change Sets
export function listChangeSets() { return request<{ changeSets: ChangeSet[] }>('/change-sets'); }
export function getChangeSet(id: string) { return request<{ changeSet: ChangeSet; items: ChangeSetItem[] }>(`/change-sets/${id}`); }
export function validateChangeSet(id: string) { return request<ValidationResult>(`/change-sets/${id}/validate`, { method: 'POST' }); }
export function approveChangeSet(id: string) { return request<{ success: boolean; commitHash?: string; errors: string[] }>(`/change-sets/${id}/approve`, { method: 'POST' }); }
export function discardChangeSet(id: string) { return request<{ success: boolean }>(`/change-sets/${id}/discard`, { method: 'POST' }); }

// Export
export function exportChangeSet(id: string) { return request<ExportResult>(`/export/change-set/${id}`, { method: 'POST' }); }

// Repair images for a change set (re-downloads from onboarding extraction data)
export function repairChangeSetImages(id: string) {
  return request<{ success: boolean; summary: string; results: Array<{ sku: string; imagesDownloaded: number; error?: string }> }>(
    `/export/change-set/${id}/repair-images`,
    { method: 'POST' },
  );
}

// Field Registry
export function listFieldRegistry() {
  return request<{ entries: FieldRegistryEntry[] }>('/field-registry');
}
export function updateFieldRegistryEntry(id: string, payload: Record<string, unknown>) {
  return request<{ success: boolean }>(`/field-registry/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

// --- Phase 3: Sync / Push / Publish ---
export interface SyncJob {
  id: string;
  workspaceId: string;
  changeSetId: string | null;
  kind: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  productCount: number;
  errorSummary: string | null;
}

export interface SyncJobDetail {
  job: SyncJob;
  events: Array<{ id: string; level: string; message: string; createdAt: string }>;
}

export function pushPublish(changeSetId: string) {
  return request<{ success: boolean; jobId: string; productCount: number; publishCompleted: boolean; zipPath: string | null; warnings: string[] }>(
    '/sync/push-publish',
    { method: 'POST', body: JSON.stringify({ changeSetId }) },
  );
}

export function uploadOnly(changeSetId: string) {
  return request<{ success: boolean; jobId: string; productCount: number; zipPath: string | null; warning: string }>(
    '/sync/upload-only',
    { method: 'POST', body: JSON.stringify({ changeSetId }) },
  );
}

export function listSyncJobs() { return request<{ jobs: SyncJob[] }>('/sync/jobs'); }
export function getSyncJobDetail(id: string) { return request<SyncJobDetail>(`/sync/jobs/${id}`); }

// --- Drift ---
export interface DriftItem {
  id: string;
  workspaceId: string;
  sku: string;
  detectedAt: string;
  status: string;
  localProductName: string | null;
  remoteProductName: string | null;
  localPrice: string | null;
  remotePrice: string | null;
}

export interface DriftCheckResult {
  success: boolean;
  jobId: string;
  driftCount: number;
  driftSkus: Array<{ id: string; sku: string; status: string }>;
}

export function checkDrift(remoteXml?: string) {
  return request<DriftCheckResult>('/drift/check', { method: 'POST', body: JSON.stringify({ remoteXml }) });
}

export function listDrift(status?: string) {
  const qs = status ? `?status=${status}` : '';
  return request<{ drifts: DriftItem[]; openCount: number }>(`/drift${qs}`);
}

export function resolveDrift(id: string, action: 'keep_local' | 'accept_remote' | 'create_change_set') {
  return request<{ success: boolean; action: string; sku: string }>(
    `/drift/${id}/resolve`,
    { method: 'POST', body: JSON.stringify({ action }) },
  );
}

export function fullReconcile() {
  return request<{ success: boolean; jobId: string; reindexedCount: number }>(
    '/sync/full-reconcile',
    { method: 'POST' },
  );
}

// --- Pages & Categories ---
export interface Page {
  id: string;
  name: string;
  fileName: string | null;
  parentId: string | null;
  pageHash: string;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function listPages() {
  return request<{ pages: Page[] }>('/pages');
}

// fallow-ignore-next-line unused-export — used by tests
export function upsertPage(name: string, fileName?: string | null, parentId?: string | null) {
  return request<{ success: boolean; page: Page }>('/pages', {
    method: 'POST',
    body: JSON.stringify({ name, fileName, parentId }),
  });
}

// fallow-ignore-next-line unused-export — used by tests
export function deletePage(id: string) {
  return request<{ success: boolean }>(`/pages/${id}`, { method: 'DELETE' });
}

// fallow-ignore-next-line unused-export — used by tests
export function getProductPages(sku: string) {
  return request<{ pages: string[] }>(`/products/${encodeURIComponent(sku)}/pages`);
}

function saveProductPages(sku: string, pages: string[]) {
  return request<{ success: boolean; pages: string[] }>(`/products/${encodeURIComponent(sku)}/pages`, {
    method: 'POST',
    body: JSON.stringify({ pages }),
  });
}

// --- Dashboard ---
export interface DashboardMetrics {
  totalProducts: number;
  syncedProducts: number;
  notSyncedProducts: number;
  driftedProducts: number;
  draftChangeSets: number;
  openDrifts: number;
  productsWithWarnings: number;
  customFieldsCount: number;
}

export interface RecentSyncJob {
  id: string;
  changeSetId: string | null;
  kind: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  productCount: number;
  errorSummary: string | null;
}

export interface RecentActivity {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  message: string;
  detailsJson: string | null;
  createdAt: string;
}

export interface DashboardStats {
  metrics: DashboardMetrics;
  connection: {
    cgiBaseUrl: string;
    merchantId: string | null;
    lastTestedAt: string | null;
    lastTestStatus: string | null;
    lastTestError: string | null;
  } | null;
  recentSyncJobs: RecentSyncJob[];
  recentActivities: RecentActivity[];
}

export function getDashboardStats() {
  return request<DashboardStats>('/dashboard/stats');
}

export function bulkResolveDrift(action: 'accept_remote') {
  return request<{ success: boolean; resolvedCount: number; commitHash: string | null; message: string }>('/drift/bulk-resolve', {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
}

export interface CatalogHealthIssue {
  sku: string;
  title: string;
  severity: string;
  code: string;
  message: string;
  fieldPath: string | null;
}

export interface CatalogHealthReport {
  totalProducts: number;
  healthyProducts: number;
  unhealthyProducts: number;
  totalErrors: number;
  totalWarnings: number;
  issues: CatalogHealthIssue[];
}

export function runCatalogHealthCheck() {
  return request<CatalogHealthReport>('/catalog/health', { method: 'POST' });
}

export function getCatalogHealthReport() {
  return request<CatalogHealthReport>('/catalog/health');
}

export interface HealthRuleConfig {
  code: string;
  name: string;
  description: string;
  defaultSeverity: 'blocker' | 'warning' | 'info';
  severity: 'blocker' | 'warning' | 'info' | 'disabled';
}

export interface HealthConfig {
  schemaVersion: number;
  rules: HealthRuleConfig[];
}

export function getHealthConfig() {
  return request<HealthConfig>('/catalog/health/config');
}

export function saveHealthConfig(rules: HealthRuleConfig[]) {
  return request<{ success: boolean }>('/catalog/health/config', {
    method: 'POST',
    body: JSON.stringify({ rules }),
  });
}

// ── Store Manager AI Assistant APIs ──────────────────────────────────────────

export interface CatalogProposal {
  id: string;
  workspaceId: string;
  field: string;
  oldValue: string;
  newValue: string;
  affectedSkus: string[];
  reason: string;
  confidence: number;
  source: 'deterministic' | 'ai';
  status: 'proposed' | 'applied' | 'dismissed';
  changeSetId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FieldValueInfo {
  value: string;
  frequency: number;
  skus: string[];
}

export interface CasingDuplicateGroup {
  normalized: string;
  values: { value: string; frequency: number; skus: string[] }[];
}

export interface NearDuplicatePair {
  valueA: string;
  frequencyA: number;
  valueB: string;
  frequencyB: number;
  distance: number;
  type: 'levenshtein' | 'alphanumeric';
}

export interface SuspiciousValueInfo {
  value: string;
  frequency: number;
  reasons: string[];
  skus: string[];
}

export interface ProductFieldAuditReport {
  field: string;
  label: string;
  totalActiveProducts: number;
  emptyCount: number;
  emptyRate: number;
  uniqueValueCount: number;
  values: FieldValueInfo[];
  casingDuplicates: CasingDuplicateGroup[];
  nearDuplicates: NearDuplicatePair[];
  separatorInconsistencies: {
    inconsistent: boolean;
    counts: { separator: string; count: number }[];
  };
  suspiciousValues: SuspiciousValueInfo[];
}

export interface AssistantCleanupReport {
  summary: string;
  reportMarkdown: string;
}

export function getStoreManagerInsights(field: string) {
  return request<ProductFieldAuditReport>(`/store-manager/insights?field=${encodeURIComponent(field)}`);
}

export function listStoreManagerProposals(field?: string, status?: string) {
  let url = '/store-manager/proposals';
  const params: string[] = [];
  if (field) params.push(`field=${encodeURIComponent(field)}`);
  if (status) params.push(`status=${encodeURIComponent(status)}`);
  if (params.length > 0) url += `?${params.join('&')}`;

  return request<{ proposals: CatalogProposal[] }>(url);
}

export function generateStoreManagerProposals(field: string, useAi = false) {
  return request<{ success: boolean; proposals: CatalogProposal[] }>('/store-manager/proposals/generate', {
    method: 'POST',
    body: JSON.stringify({ field, useAi }),
  });
}

export function applyStoreManagerProposal(id: string) {
  return request<{ success: boolean; changeSetId: string }>(`/store-manager/proposals/${id}/apply`, {
    method: 'POST',
  });
}

export function dismissStoreManagerProposal(id: string) {
  return request<{ success: boolean }>(`/store-manager/proposals/${id}/dismiss`, {
    method: 'POST',
  });
}

export function getStoreManagerReport() {
  return request<AssistantCleanupReport>('/store-manager/report');
}

// ── Catalog Schema Workbench APIs ──────────────────────────────────

import type {
  CatalogSchemaSummary,
  CatalogFieldSummary,
  CatalogFieldDetail,
  CategoryPageNode,
  AttributeMappingView,
  CatalogSchemaHealthReport,
} from './components/catalog-workbench/types';

export function getCatalogSchemaSummary() {
  return request<CatalogSchemaSummary>('/catalog/schema-summary');
}

export function listCatalogFields() {
  return request<{ fields: CatalogFieldSummary[] }>('/catalog/fields');
}

export function getCatalogFieldDetail(xmlField: string) {
  return request<CatalogFieldDetail>(`/catalog/fields/${encodeURIComponent(xmlField)}`);
}

export function getCategoryPageTree() {
  return request<{ pages: CategoryPageNode[] }>('/catalog/pages/tree');
}

export function listAttributeMappings() {
  return request<{ mappings: AttributeMappingView[] }>('/catalog/mappings');
}

export function getCatalogSchemaHealth() {
  return request<CatalogSchemaHealthReport>('/catalog/schema-health');
}


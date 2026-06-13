const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as any).error || `HTTP ${res.status}`);
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
  productCount: number;
}

// Workspace
export function getWorkspace() { return request<{ workspace: Workspace | null }>('/workspace'); }
export function initWorkspace(name: string, path: string) { return request<{ success: boolean; workspace: Workspace }>('/workspace/init', { method: 'POST', body: JSON.stringify({ name, path }) }); }
export function openWorkspace(path: string) { return request<{ success: boolean; workspace: Workspace }>('/workspace/open', { method: 'POST', body: JSON.stringify({ path }) }); }
export function pickDirectory() { return request<{ success: boolean; path?: string; error?: string; message?: string }>('/workspace/pick-directory', { method: 'POST' }); }
export function closeWorkspace() { return request<{ success: boolean; message: string }>('/workspace/close', { method: 'POST' }); }

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


// Change Sets
export function listChangeSets() { return request<{ changeSets: ChangeSet[] }>('/change-sets'); }
export function getChangeSet(id: string) { return request<{ changeSet: ChangeSet; items: ChangeSetItem[] }>(`/change-sets/${id}`); }
export function validateChangeSet(id: string) { return request<ValidationResult>(`/change-sets/${id}/validate`, { method: 'POST' }); }
export function approveChangeSet(id: string) { return request<{ success: boolean; commitHash?: string; errors: string[] }>(`/change-sets/${id}/approve`, { method: 'POST' }); }
export function discardChangeSet(id: string) { return request<{ success: boolean }>(`/change-sets/${id}/discard`, { method: 'POST' }); }

// Export
export function exportChangeSet(id: string) { return request<ExportResult>(`/export/change-set/${id}`, { method: 'POST' }); }

// Field Registry
export function listFieldRegistry() { return request<{ entries: unknown[] }>('/field-registry'); }

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
  return request<{ success: boolean; jobId: string; productCount: number; publishCompleted: boolean; warnings: string[] }>(
    '/sync/push-publish',
    { method: 'POST', body: JSON.stringify({ changeSetId }) },
  );
}

export function uploadOnly(changeSetId: string) {
  return request<{ success: boolean; jobId: string; productCount: number; warning: string }>(
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

// --- Product Types ---
export interface ProductType {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductTypeField {
  id: string;
  productTypeId: string;
  xmlField: string;
  label: string;
  dataType: string;
  required: boolean;
  validationRulesJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductTypeDetail extends ProductType {
  fields: ProductTypeField[];
}

export function listProductTypes() {
  return request<{ types: ProductType[] }>('/product-types');
}

export function getProductType(id: string) {
  return request<{ productType: ProductTypeDetail }>(`/product-types/${id}`);
}

export function createProductType(name: string) {
  return request<{ success: boolean; productType: ProductType }>('/product-types', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function deleteProductType(id: string) {
  return request<{ success: boolean }>(`/product-types/${id}`, { method: 'DELETE' });
}

export function upsertProductTypeField(
  productTypeId: string,
  xmlField: string,
  label: string,
  dataType: string,
  required: boolean,
  validationRules?: any
) {
  return request<{ success: boolean; field: ProductTypeField }>(`/product-types/${productTypeId}/fields`, {
    method: 'POST',
    body: JSON.stringify({ xmlField, label, dataType, required, validationRulesJson: validationRules }),
  });
}

export function deleteProductTypeField(productTypeId: string, xmlField: string) {
  return request<{ success: boolean }>(`/product-types/${productTypeId}/fields/${encodeURIComponent(xmlField)}`, {
    method: 'DELETE',
  });
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

export function upsertPage(name: string, fileName?: string | null, parentId?: string | null) {
  return request<{ success: boolean; page: Page }>('/pages', {
    method: 'POST',
    body: JSON.stringify({ name, fileName, parentId }),
  });
}

export function deletePage(id: string) {
  return request<{ success: boolean }>(`/pages/${id}`, { method: 'DELETE' });
}

export function getProductPages(sku: string) {
  return request<{ pages: string[] }>(`/products/${encodeURIComponent(sku)}/pages`);
}

export function saveProductPages(sku: string, pages: string[]) {
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




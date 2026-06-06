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
export function getBootstrapStatus() { return request<{ bootstrapStatus: string; baselineCommit: string | null }>('/bootstrap/status'); }

// Products
export function listProducts(status?: string, search?: string) {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (search) params.set('search', search);
  const qs = params.toString();
  return request<{ products: ProductIndexItem[]; total: number }>(`/products${qs ? '?' + qs : ''}`);
}
export function getProduct(sku: string) { return request<ProductDetail>(`/products/${encodeURIComponent(sku)}`); }
export function saveDraft(sku: string, changes: Record<string, unknown>, operation?: string) {
  return request<{ success: boolean; changeSetId: string; draftHash: string }>(
    `/products/${encodeURIComponent(sku)}/draft`,
    { method: 'PUT', body: JSON.stringify({ changes, operation }) },
  );
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

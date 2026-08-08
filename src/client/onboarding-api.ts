import type {
  OnboardingBatch,
  OnboardingItem,
  OnboardingSource,
  ExtractionData,
  CurationData,
  ColumnMapping,
  BrandSite,
  ExtractorProfile,
  PipelineStage,
  LlmTask,
  LlmProvider,
  LlmTaskConfig,
  StructuredFeedback,
  ProfileGenerationGeneration,
  ProfileGenerationRevision,
  ProfileGenerationValidationResult,
  ProfileGenerationFieldDecision,
  DomainProfileGovernance,
  DomainDiagnosticsEntry,
  DomainDiagnosticsResponse,
  ProfileBlockedItem,
} from '../shared/schemas/onboarding';
import type {
  WorkerHealthResponse,
  SnapshotRequest,
  SnapshotResponse,
  ValidateRequest,
  ValidateResponse,
  GenerateSelectorRequest,
  GenerateSelectorResponse,

} from '../shared/schemas/extraction-worker';
import type {
  ClassificationProposalDecision,
  CurationTargetConfig,
  ProposalDecisionInput,
} from '../shared/schemas/classification';
import type {
  GenerateSelectorsResponse,
  GenerateSelectorsRequest,
  SnapshotContext,
} from '../shared/schemas/selector-generation';

const API_BASE = '/api/onboarding';

export class OnboardingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'OnboardingApiError';
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    const errorObj = (data as any).error;
    const errMsg = typeof errorObj === 'object' && errorObj && 'message' in errorObj
      ? errorObj.message
      : errorObj || `HTTP ${res.status}`;
    const code = typeof (data as any).code === 'string' ? (data as any).code : null;
    throw new OnboardingApiError(errMsg, res.status, code);
  }
  return data as T;
}

export interface UploadResponse {
  fileName: string;
  headers: string[];
  mapping: Partial<ColumnMapping>;
  rowsCount: number;
  tempRows: Record<string, string>[];
}

export async function uploadSpreadsheet(file: File): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch(`${API_BASE}/batches/upload`, {
    method: 'POST',
    body: formData,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as any).error || `HTTP ${res.status}`);
  }
  return data as UploadResponse;
}

export async function createBatch(data: {
  name: string;
  fileName: string;
  mapping: ColumnMapping;
  rows: Record<string, string>[];
  brandMappings?: Record<string, string>;
}): Promise<{ batch: OnboardingBatch; validationErrors: any[] }> {
  return request<{ batch: OnboardingBatch; validationErrors: any[] }>('/batches', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function resolveBrandDomains(brands: string[]): Promise<{ mappings: Record<string, string | null> }> {
  return request<{ mappings: Record<string, string | null> }>('/settings/brand-sites/resolve', {
    method: 'POST',
    body: JSON.stringify({ brands }),
  });
}

export async function getBatches(): Promise<{ batches: OnboardingBatch[] }> {
  return request<{ batches: OnboardingBatch[] }>('/batches');
}

export async function getBatch(id: string): Promise<{ batch: OnboardingBatch }> {
  return request<{ batch: OnboardingBatch }>(`/batches/${id}`);
}

export async function deleteBatch(id: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${id}`, {
    method: 'DELETE',
  });
}

export async function getBatchStagedItems(
  batchId: string,
): Promise<{ staged: Record<PipelineStage, OnboardingItem[]> }> {
  return request<{ staged: Record<PipelineStage, OnboardingItem[]> }>(`/batches/${batchId}/staged`);
}

export async function advanceItems(itemIds: string[]): Promise<{ advanced: number; skipped: number }> {
  return request<{ advanced: number; skipped: number }>('/items/advance', {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function resetStageItems(itemIds: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/items/reset', {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function skipStageItems(itemIds: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/items/skip-bulk', {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function moveToPreviousStage(
  itemIds: string[],
): Promise<{ success: boolean; moved: number; skipped: number }> {
  return request<{ success: boolean; moved: number; skipped: number }>('/items/move-to-previous', {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}


async function resetItemsToStage(
  itemIds: string[],
  targetStage: string,
): Promise<{ success: boolean; reset: number }> {
  return request<{ success: boolean; reset: number }>('/items/reset-to-stage', {
    method: 'POST',
    body: JSON.stringify({ itemIds, targetStage }),
  });
}

export async function completeReviewStage(itemIds: string[]): Promise<{ success: boolean; count: number; legacyCount?: number; classifiedCount?: number }> {
  return request<{ success: boolean; count: number; legacyCount?: number; classifiedCount?: number }>('/items/review-complete', {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function getBatchItems(
  batchId: string,
  status?: string,
): Promise<{ items: OnboardingItem[] }> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return request<{ items: OnboardingItem[] }>(`/batches/${batchId}/items${query}`);
}

export async function startSourceDiscovery(batchId: string, itemIds?: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/start-discovery`, {
    method: 'POST',
    body: itemIds ? JSON.stringify({ itemIds }) : undefined,
  });
}

export async function startExtraction(batchId: string, itemIds?: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/start-extraction`, {
    method: 'POST',
    body: itemIds ? JSON.stringify({ itemIds }) : undefined,
  });
}

export async function startCuration(batchId: string, itemIds?: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/start-curation`, {
    method: 'POST',
    body: itemIds ? JSON.stringify({ itemIds }) : undefined,
  });
}

export async function bulkSkipItems(batchId: string, itemIds: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/bulk-skip`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function bulkRetryItems(batchId: string, itemIds: string[]): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/bulk-retry`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function promoteBatchItems(
  batchId: string,
  itemIds: string[],
): Promise<{ changeSetId: string | null; count: number }> {
  return request<{ changeSetId: string | null; count: number }>(`/batches/${batchId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export async function bulkAssignBrand(
  batchId: string,
  itemIds: string[],
  brandHint: string | null,
  brandDomain: string | null,
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/bulk-brand`, {
    method: 'POST',
    body: JSON.stringify({ itemIds, brandHint, brandDomain }),
  });
}

export interface ConsistencyWarning {
  groupId: string;
  groupLabel: string;
  field: 'category_page' | 'primary_product_type' | 'curated_title';
  values: Record<string, string[]>;
  message: string;
}

export interface ItemDetailResponse {
  item: OnboardingItem;
  sources: OnboardingSource[];
  extraction: ExtractionData | null;
  consistencyWarnings: ConsistencyWarning[];
}

export async function getItemDetail(itemId: string): Promise<ItemDetailResponse> {
  return request<ItemDetailResponse>(`/items/${itemId}`);
}

export async function updateItem(
  itemId: string,
  data: Partial<OnboardingItem> & { 
    extraction_data?: Partial<ExtractionData>;
    curation_data?: Partial<CurationData>;
    brandHint?: string | null;
    brandDomain?: string | null;
    propagateBrandName?: boolean;
  },
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/items/${itemId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function retryItem(itemId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/items/${itemId}/retry`, {
    method: 'POST',
  });
}

export async function selectSource(itemId: string, sourceId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/items/${itemId}/select-source`, {
    method: 'POST',
    body: JSON.stringify({ sourceId }),
  });
}

export async function setItemUrl(itemId: string, url: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/items/${itemId}/set-url`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

export async function skipItem(itemId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/items/${itemId}/skip`, {
    method: 'POST',
  });
}

// Settings APIs
export interface ApiKeyDisplay {
  id: string;
  service: string;
  apiKey: string;
  baseUrl: string | null;
  model: string | null;
}

export async function getApiKeys(): Promise<{ keys: ApiKeyDisplay[] }> {
  return request<{ keys: ApiKeyDisplay[] }>('/settings/api-keys');
}

export async function updateApiKey(
  service: string,
  apiKey: string,
  baseUrl?: string | null,
  model?: string | null,
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/settings/api-keys/${service}`, {
    method: 'PUT',
    body: JSON.stringify({ apiKey, baseUrl, model }),
  });
}

export async function deleteApiKey(service: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/settings/api-keys/${service}`, {
    method: 'DELETE',
  });
}

export async function getBrandSites(): Promise<{ brandSites: BrandSite[]; catalogBrands?: string[] }> {
  return request<{ brandSites: BrandSite[]; catalogBrands?: string[] }>('/settings/brand-sites');
}

async function deleteBrandSite(id: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/settings/brand-sites/${id}`, {
    method: 'DELETE',
  });
}

export async function getOpenaiModels(apiKey?: string, baseUrl?: string): Promise<{ models: string[] }> {
  const params = new URLSearchParams();
  if (apiKey) params.set('apiKey', apiKey);
  if (baseUrl) params.set('baseUrl', baseUrl);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return request<{ models: string[] }>(`/settings/openai/models${qs}`);
}

export async function getDeepseekModels(apiKey?: string, baseUrl?: string): Promise<{ models: string[] }> {
  const params = new URLSearchParams();
  if (apiKey) params.set('apiKey', apiKey);
  if (baseUrl) params.set('baseUrl', baseUrl);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return request<{ models: string[] }>(`/settings/deepseek/models${qs}`);
}

export async function getExtractorProfiles(): Promise<{ extractorProfiles: ExtractorProfile[] }> {
  return request<{ extractorProfiles: ExtractorProfile[] }>('/settings/extractor-profiles');
}

export interface SaveExtractorProfilePayload {
  domain: string;
  titleSelector?: string | null;
  titleOptionalSelectors?: string[];
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
  customSelectors?: Record<string, string>;
  sitemapProductUrlPattern?: string | null;
  shopifyJSONPath?: boolean;
  variantSelectionStrategy?: Record<string, unknown> | null;
  customSelectorMetadata?: Record<string, unknown>;
  runtime?: 'static' | 'rendered';
}

export async function saveExtractorProfile(data: SaveExtractorProfilePayload): Promise<{ success: boolean; profile: ExtractorProfile }> {
  return request<{ success: boolean; profile: ExtractorProfile }>('/settings/extractor-profiles', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

async function deleteExtractorProfile(id: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/settings/extractor-profiles/${id}`, {
    method: 'DELETE',
  });
}

export interface DomainConfigPayload {
  titleSelector?: string | null;
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
  sitemapProductUrlPattern?: string | null;
  brands?: Array<{
    id?: string;
    brandName: string;
    urlPattern?: string | null;
    successCount?: number;
  }>;
}

// fallow-ignore-next-line unused-export — used by tests
export async function saveDomainConfig(
  domain: string,
  data: DomainConfigPayload,
): Promise<DomainDiagnosticsEntry> {
  return request<{ domain: DomainDiagnosticsEntry }>(
    `/settings/domains/${encodeURIComponent(domain)}`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    },
  ).then((r) => r.domain);
}

// fallow-ignore-next-line unused-export — used by tests
export async function getDomainDiagnostics(): Promise<DomainDiagnosticsResponse> {
  return request<DomainDiagnosticsResponse>('/settings/domain-diagnostics');
}

export interface GenerateProfileResult {
  success: boolean;
  generationId: string | null;
  existing: boolean;
  domain: string;
  anchorUrl?: string | null;
}

export async function generateProfileForDomain(
  domain: string,
  anchorUrl?: string,
): Promise<GenerateProfileResult> {
  const body = anchorUrl ? JSON.stringify({ anchorUrl }) : undefined;
  return request<GenerateProfileResult>(
    `/settings/domain-diagnostics/${encodeURIComponent(domain)}/generate-profile`,
    { method: 'POST', body },
  );
}

export interface ExtractorTestResult {
  title?: string;
  price?: string;
  description?: string;
  brand?: string;
  images?: string[];
  customFields?: Record<string, string>;
}

export interface TestExtractorProfileRequest {
  url: string;
  titleSelector?: string | null;
  titleOptionalSelectors?: string[];
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
  shopifyJSONPath?: boolean;
  variantSelectionStrategy?: any;
  customSelectors?: Record<string, string>;
}

export async function testExtractorProfile(data: TestExtractorProfileRequest): Promise<{ success: boolean; extracted: ExtractorTestResult }> {
  return request<{ success: boolean; extracted: ExtractorTestResult }>('/extractor-profiles/test', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getOllamaModels(baseUrl?: string): Promise<{ models: string[] }> {
  const params = new URLSearchParams();
  if (baseUrl) params.set('baseUrl', baseUrl);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return request<{ models: string[] }>(`/settings/ollama/models${qs}`);
}

// ─── Classification API ──────────────────────────────────────────────────────

export interface ClassificationConfigResponse {
  config: any;
}

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

export interface CurationTargetsResponse {
  targets: CurationTargetConfig[];
  candidates: CurationTargetCandidates;
}

async function classificationRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api/classification${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as any).error || `HTTP ${res.status}`);
  }
  return data as T;
}

export async function getClassificationConfig(): Promise<ClassificationConfigResponse> {
  return classificationRequest<ClassificationConfigResponse>('/config');
}

export async function getClassificationReadiness(): Promise<{
  readiness: import('../shared/schemas/classification').ClassificationReadinessReportDto;
}> {
  return classificationRequest<{
    readiness: import('../shared/schemas/classification').ClassificationReadinessReportDto;
  }>('/readiness');
}

// fallow-ignore-next-line unused-export — used by tests
export async function saveClassificationConfig(config: any): Promise<{ success: boolean; config: any }> {
  return classificationRequest<{ success: boolean; config: any }>('/config', {
    method: 'PUT',
    body: JSON.stringify({ config }),
  });
}

export async function getCurationTargets(): Promise<CurationTargetsResponse> {
  return classificationRequest<CurationTargetsResponse>('/curation-targets');
}

export async function saveCurationTargets(
  targets: CurationTargetConfig[],
): Promise<CurationTargetsResponse & { success: boolean }> {
  return classificationRequest<CurationTargetsResponse & { success: boolean }>('/curation-targets', {
    method: 'PUT',
    body: JSON.stringify({ targets }),
  });
}

async function migrateLegacyClassification(): Promise<{ success: boolean; summary: any }> {
  return classificationRequest<{ success: boolean; summary: any }>('/migrate-legacy', {
    method: 'POST',
  });
}

export type DecisionInput = ProposalDecisionInput;

export async function submitDecisions(
  itemId: string,
  decisions: DecisionInput[],
): Promise<{ success: boolean; count: number; decisions: ClassificationProposalDecision[] }> {
  return request<{ success: boolean; count: number; decisions: ClassificationProposalDecision[] }>(`/items/${itemId}/decisions`, {
    method: 'POST',
    body: JSON.stringify({ decisions }),
  });
}

// ─── Profile Governance API (Phase 3) ─────────────────────────────────────

// LLM task configs ──────────────────────────────────────────────────────────

export interface LlmTaskConfigListResponse {
  taskConfigs: LlmTaskConfig[];
  knownTasks: LlmTask[];
}

export async function getLlmTaskConfigs(): Promise<LlmTaskConfigListResponse> {
  return request<LlmTaskConfigListResponse>('/settings/llm-task-configs');
}

export async function upsertLlmTaskConfig(
  task: LlmTask,
  data: {
    provider: LlmProvider;
    model: string;
    baseUrlOverride?: string | null;
    temperature?: number | null;
    reasoningEffort?: string | null;
  },
): Promise<{ success: boolean; taskConfig: LlmTaskConfig }> {
  return request<{ success: boolean; taskConfig: LlmTaskConfig }>(
    `/settings/llm-task-configs/${task}`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    },
  );
}

export async function deleteLlmTaskConfig(task: LlmTask): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/settings/llm-task-configs/${task}`, {
    method: 'DELETE',
  });
}

// Domain profile governance ───────────────────────────────────────────────

export async function getDomainProfileGovernance(
  domain: string,
): Promise<DomainProfileGovernance> {
  return request<DomainProfileGovernance>(
    `/settings/profile-governance/${encodeURIComponent(domain)}`,
  );
}

/** Fetch the latest open (non-rejected, non-failed) proposal for a domain. */
// fallow-ignore-next-line unused-export — used by tests
export async function getLatestProposalForDomain(
  domain: string,
): Promise<ProfileGenerationGeneration | null> {
  try {
    const res = await getProfileGenerations(domain);
    const open = res.generations.filter(
      (g) => g.status !== 'rejected' && g.status !== 'failed',
    );
    if (open.length === 0) return null;
    return open.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0];
  } catch {
    return null;
  }
}

export async function deleteProfileGeneration(generationId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(
    `/settings/profile-generations/${generationId}`,
    { method: 'DELETE' },
  );
}

export async function getProfileGenerations(
  domain?: string,
  status?: ProfileGenerationGeneration['status'],
): Promise<{ generations: ProfileGenerationGeneration[] }> {
  const params = new URLSearchParams();
  if (domain) params.set('domain', domain);
  if (status) params.set('status', status);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return request<{ generations: ProfileGenerationGeneration[] }>(
    `/settings/profile-generations${qs}`,
  );
}

export interface ProfileGenerationDetailResponse {
  generation: ProfileGenerationGeneration;
  revisions: ProfileGenerationRevision[];
  fieldDecisions: ProfileGenerationFieldDecision[];
  validationResults: ProfileGenerationValidationResult[];
}

export async function getProfileGenerationDetail(
  generationId: string,
): Promise<ProfileGenerationDetailResponse> {
  return request<ProfileGenerationDetailResponse>(
    `/settings/profile-generations/${generationId}`,
  );
}

export async function createRevisionFromFeedback(
  generationId: string,
  data: {
    parentRevisionId?: string | null;
    feedback: StructuredFeedback;
    notes?: string | null;
  },
): Promise<{ success: boolean; revision: ProfileGenerationRevision }> {
  return request<{ success: boolean; revision: ProfileGenerationRevision }>(
    `/settings/profile-generations/${generationId}/revisions`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  );
}

export interface ValidationRunSummary {
  revisionId: string;
  sampleCount: number;
  passingSamples: number;
  failingSamples: number;
  warningSamples: number;
  byField: Record<
    string,
    { passing: number; failing: number; warning: number }
  >;
  samples: Array<{
    field: string;
    sampleUrl: string;
    itemId: string | null;
    expectedName: string | null;
    brandHint: string | null;
    extractedText: string | null;
    extractedImages: string[];
    warnings: string[];
    status: 'pass' | 'warning' | 'fail';
  }>;
  readyForImageApproval: boolean;
  textFieldsHaveStrongEvidence: boolean;
  textFieldsHaveLimitedEvidence: boolean;
}

export async function validateRevision(
  generationId: string,
  revisionId: string,
  data: { sampleLimit?: number; notes?: string | null } = {},
): Promise<{ success: boolean; result: ValidationRunSummary }> {
  return request<{ success: boolean; result: ValidationRunSummary }>(
    `/settings/profile-generations/${generationId}/revisions/${revisionId}/validate`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  );
}

export interface ApproveRevisionFieldsResponse {
  success: boolean;
  imageApprovalAccepted: boolean;
  promotionResult: {
    promoted: boolean;
    reason: string;
    domain: string;
    generationId: string;
    approvedFields: string[];
    rejectedFields: string[];
    approvalDecisionIds: string[];
    rejectionDecisionIds: string[];
  };
}

export async function approveRevisionFields(
  generationId: string,
  revisionId: string,
  data: {
    approvedFields: Record<string, boolean>;
    notes?: string | null;
    decidedBy?: string | null;
    imagePreviewsReviewed?: boolean;
  },
): Promise<ApproveRevisionFieldsResponse> {
  return request<ApproveRevisionFieldsResponse>(
    `/settings/profile-generations/${generationId}/revisions/${revisionId}/decisions`,
    {
      method: 'POST',
      body: JSON.stringify({ mode: 'approve', ...data }),
    },
  );
}

export interface RejectRevisionFieldsResponse {
  success: boolean;
  rejectedFields: string[];
  decisionIds: string[];
}

// fallow-ignore-next-line unused-export — used by tests
export async function rejectRevisionFields(
  generationId: string,
  revisionId: string,
  data: {
    rejectedFields: string[];
    reason?: string | null;
    notes?: string | null;
    decidedBy?: string | null;
  },
): Promise<RejectRevisionFieldsResponse> {
  return request<RejectRevisionFieldsResponse>(
    `/settings/profile-generations/${generationId}/revisions/${revisionId}/decisions`,
    {
      method: 'POST',
      body: JSON.stringify({ mode: 'reject', ...data }),
    },
  );
}

export interface RollbackFieldResponse {
  success: boolean;
  rolledBack: boolean;
  reason: string;
  domain: string;
  selectorField: string;
  decisionId: string;
  restoredSelector: string | null;
}

export async function rollbackProfileField(
  decisionId: string,
  data: { notes?: string | null; decidedBy?: string | null } = {},
): Promise<RollbackFieldResponse> {
  return request<RollbackFieldResponse>(
    `/settings/profile-field-decisions/${decisionId}/rollback`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  );
}

// ─── Extraction Worker Client (Profile Tooling) ──────────────────────────────

export async function getExtractionWorkerHealth(): Promise<WorkerHealthResponse | null> {
  return request<WorkerHealthResponse>('/settings/extraction-worker/health').catch(() => null);
}

export async function snapshotPageForBuilder(
  req: SnapshotRequest,
): Promise<{ ok: boolean; data?: SnapshotResponse; error?: string }> {
  return request('/settings/profile-tooling/snapshot', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function generateSelectorFromElement(
  req: GenerateSelectorRequest,
): Promise<{ ok: boolean; data?: GenerateSelectorResponse; error?: string }> {
  return request('/settings/profile-tooling/generate-selector', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function fetchPageHtml(
  url: string,
): Promise<{ ok: boolean; html?: string; error?: string }> {
  return request('/settings/profile-tooling/fetch-html', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}


export async function validateProfileDraft(
  req: ValidateRequest,
): Promise<{ ok: boolean; data?: ValidateResponse; error?: string }> {
  return request('/settings/profile-tooling/validate', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

async function getDomainDiagnosticsForDomain(
  domain: string,
): Promise<DomainDiagnosticsEntry> {
  return request(`/settings/domain-diagnostics/${encodeURIComponent(domain)}`);
}

export async function getProfileRetryPreview(
  domain: string,
): Promise<{ items: ProfileBlockedItem[] }> {
  return request(`/settings/profile-retry-preview/${encodeURIComponent(domain)}`);
}

export async function generateSelectors(
  req: GenerateSelectorsRequest & { signal?: AbortSignal },
): Promise<{ ok: true; data: GenerateSelectorsResponse } | { ok: false; error: { code: string; message: string; retryable: boolean } }> {
  try {
    const data = await request<GenerateSelectorsResponse>('/settings/profile-tooling/generate-selectors', {
      method: 'POST',
      body: JSON.stringify({
        htmlRef: req.htmlRef,
        sourceUrl: req.sourceUrl,
        runtime: req.runtime,
        fields: req.fields,
        snapshotContext: req.snapshotContext,
      }),
      signal: (req as any).signal,
    });
    return { ok: true, data };
  } catch (err: any) {
    return {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      },
    };
  }
}

export async function retryProfileBlockedItems(
  domain: string,
  itemIds: string[],
): Promise<{ accepted: number }> {
  return request(`/settings/profile-retry-preview/${encodeURIComponent(domain)}/retry`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export interface WeeklyReportProductItem {
  id: string;
  upc: string;
  name: string;
  brandHint: string | null;
  batchName: string;
  status: string;
  stage: string;
  stageStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyReportResponse {
  startDate: string;
  endDate: string;
  items: WeeklyReportProductItem[];
  totalCount: number;
  promotedCount: number;
}

export async function getWeeklyReport(startDate?: string, endDate?: string): Promise<WeeklyReportResponse> {
  const params = new URLSearchParams();
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);
  const q = params.toString();
  return request(`/weekly-report${q ? `?${q}` : ''}`);
}


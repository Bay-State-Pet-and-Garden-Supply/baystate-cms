import type {
  OnboardingBatch,
  OnboardingItem,
  OnboardingSource,
  ExtractionData,
  CurationData,
  ColumnMapping,
  BrandSite,
  ExtractorProfile
} from '../shared/schemas/onboarding';

const API_BASE = '/api/onboarding';

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
    throw new Error((data as any).error || `HTTP ${res.status}`);
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

export async function getBatchItems(
  batchId: string,
  status?: string,
): Promise<{ items: OnboardingItem[] }> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  return request<{ items: OnboardingItem[] }>(`/batches/${batchId}/items${query}`);
}

export async function startSourceDiscovery(batchId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/start-discovery`, {
    method: 'POST',
  });
}

export async function startExtraction(batchId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/start-extraction`, {
    method: 'POST',
  });
}

export async function startCuration(batchId: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/batches/${batchId}/start-curation`, {
    method: 'POST',
  });
}

export async function promoteBatchItems(
  batchId: string,
  itemIds: string[],
): Promise<{ changeSetId: string; count: number }> {
  return request<{ changeSetId: string; count: number }>(`/batches/${batchId}/promote`, {
    method: 'POST',
    body: JSON.stringify({ itemIds }),
  });
}

export interface ItemDetailResponse {
  item: OnboardingItem;
  sources: OnboardingSource[];
  extraction: ExtractionData | null;
}

export async function getItemDetail(itemId: string): Promise<ItemDetailResponse> {
  return request<ItemDetailResponse>(`/items/${itemId}`);
}

export async function updateItem(
  itemId: string,
  data: Partial<OnboardingItem> & { 
    extraction_data?: Partial<ExtractionData>;
    curation_data?: Partial<CurationData>;
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

export async function getBrandSites(): Promise<{ brandSites: BrandSite[] }> {
  return request<{ brandSites: BrandSite[] }>('/settings/brand-sites');
}

export async function deleteBrandSite(id: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/settings/brand-sites/${id}`, {
    method: 'DELETE',
  });
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

export async function saveExtractorProfile(data: {
  domain: string;
  titleSelector?: string | null;
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
}): Promise<{ success: boolean; profile: ExtractorProfile }> {
  return request<{ success: boolean; profile: ExtractorProfile }>('/settings/extractor-profiles', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function deleteExtractorProfile(id: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/settings/extractor-profiles/${id}`, {
    method: 'DELETE',
  });
}

export interface ExtractorTestResult {
  title?: string;
  price?: string;
  description?: string;
  brand?: string;
  images?: string[];
}

export async function testExtractorProfile(data: {
  url: string;
  titleSelector?: string | null;
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
}): Promise<{ success: boolean; extracted: ExtractorTestResult }> {
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

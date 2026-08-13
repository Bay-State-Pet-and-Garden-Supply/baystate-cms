/**
 * Store Manager API client.
 *
 * Client-side fetch wrapper for Store Manager endpoints. Wire types are
 * defined locally (mirroring the server shapes) so the client never imports
 * from src/server or src/ai (those pull bun:sqlite / node:fs and would break
 * the Vite build).
 */

export type StoreManagerModelLocality = 'local' | 'cloud';
export type StoreManagerCostBasis = 'local_zero' | 'published_rate' | 'unknown';

export interface StoreManagerModelPricingInfo {
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  costBasis: StoreManagerCostBasis;
  effectiveAt: string | null;
}

export interface StoreManagerModelDescriptor {
  id: string;
  provider: string;
  providerLabel: string;
  locality: StoreManagerModelLocality;
  capabilitySummary: string;
  pricing: StoreManagerModelPricingInfo;
  isDefault: boolean;
}

export interface StoreManagerModelsResponse {
  models: StoreManagerModelDescriptor[];
  defaultModelId: string | null;
  /** Present only when no compatible default exists. */
  setupMessage?: string;
}

/** Format a descriptor's pricing for the picker label. */
export function formatModelPricing(option: StoreManagerModelDescriptor): string {
  if (option.locality === 'local') return 'Free (Local)';
  const p = option.pricing;
  if (p.costBasis === 'published_rate' && p.inputPerMillion != null && p.outputPerMillion != null) {
    return `$${p.inputPerMillion} / 1M In · $${p.outputPerMillion} / 1M Out`;
  }
  return 'Cost unknown';
}

/**
 * Fetch the server-owned list of usable Store Manager models. The picker is
 * populated exclusively from this endpoint so the client and server cannot
 * maintain independent model catalogs.
 */
export async function fetchStoreManagerModels(): Promise<StoreManagerModelsResponse> {
  const res = await fetch('/api/store-manager/models');
  if (!res.ok) {
    let message = `Failed to load Store Manager models (${res.status}).`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data && typeof data.error === 'string') message = data.error;
    } catch {
      // keep the default message
    }
    throw new Error(message);
  }
  return (await res.json()) as StoreManagerModelsResponse;
}

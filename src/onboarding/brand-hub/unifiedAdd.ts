// story: e35s10 — unified Add Brand payload (thin view-model, no new tables, delegates to existing repos)
import { normalizeBrandHubDomain } from './normalizeDomain';

export interface UnifiedAddInput {
  rawDomain: string;
  brandName?: string | null;
  fetchNow?: boolean;
}

export interface UnifiedAddPayload {
  normalizedDomain: string;
  brandName?: string;
  fetchNow: boolean;
  shouldPersistBrandSite: boolean;
  shouldCreateProfile: boolean;
  isValid: boolean;
}

function normalizeBrandName(input: string | null | undefined): string | undefined {
  if (input == null) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return trimmed.toLowerCase();
}

export function buildUnifiedAddPayload(input: UnifiedAddInput): UnifiedAddPayload {
  const normalizedDomain = normalizeBrandHubDomain(input.rawDomain ?? '');
  const brandName = normalizeBrandName(input.brandName);
  const fetchNow = !!input.fetchNow;
  const shouldPersistBrandSite = !!brandName;
  const shouldCreateProfile = false;
  const isValid = normalizedDomain.length > 0;
  return {
    normalizedDomain,
    brandName,
    fetchNow,
    shouldPersistBrandSite,
    shouldCreateProfile,
    isValid,
  };
}

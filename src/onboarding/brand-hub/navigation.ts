// story: e35s10 — brand hub row → Profile Builder navigation (canonical normalize)
import { normalizeBrandHubDomain } from './normalizeDomain';

/**
 * Resolve the canonical domain to open in the Profile Builder.
 * Single source of domain normalization for the hub → builder hop.
 */
export function getBrandHubProfileBuilderTarget(domain: string): string {
  return normalizeBrandHubDomain(domain);
}

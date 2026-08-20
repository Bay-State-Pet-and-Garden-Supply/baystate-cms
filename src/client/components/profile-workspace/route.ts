// story: e06s01 — dedicated workspace route helper (domain-scoped, return-context preserved)
import { normalizeBrandHubDomain } from '../../../onboarding/brand-hub/normalizeDomain';

export function getProfileWorkspacePath(rawDomain: string, returnPath?: string): string {
  const domain = normalizeBrandHubDomain(rawDomain);
  const base = `/settings/domains/${encodeURIComponent(domain)}/profile`;
  if (!returnPath) return base;
  return `${base}?return=${encodeURIComponent(returnPath)}`;
}

export function parseReturnPath(search: string): string | null {
  const params = new URLSearchParams(search);
  const v = params.get('return');
  return v ? decodeURIComponent(v) : null;
}

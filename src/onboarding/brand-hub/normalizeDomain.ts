// story: e35s10 — canonical domain normalization (single source for brand hub + UI entry points)
// Mirrors normalizeDomain in brand-url-index-repo but pure and client-safe (no DB).
export function normalizeBrandHubDomain(input: string): string {
  return input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim();
}

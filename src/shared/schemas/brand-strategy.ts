import { z } from 'zod';

export const SourcingPolicySchema = z.enum(['advisory', 'preferred_then_fallback', 'preferred_only']);

export const BrandStrategySitemapSchema = z.object({
  totalUrls: z.number().int().min(0),
  freshCount: z.number().int().min(0),
  lastRefreshAt: z.string().nullable(),
  freshness: z.enum(['fresh', 'stale', 'missing']),
});

export const BrandStrategyOfficialDomainSchema = z.object({
  domain: z.string().min(1),
  sitemap: BrandStrategySitemapSchema,
});

export const BrandStrategyDiagnosticSchema = z.object({
  candidateBrand: z.string().min(1),
  reason: z.string().min(1),
});

export const BrandStrategySchema = z.object({
  brandKey: z.string().min(1),
  normalizedBrand: z.string().min(1),
  aliases: z.array(z.string()),
  preferredDistributorIds: z.array(z.string()),
  sourcingPolicy: SourcingPolicySchema,
  fallbackTier: z.array(z.string()),
  officialDomains: z.array(BrandStrategyOfficialDomainSchema),
  extractorReadiness: z.enum(['active', 'degraded', 'draft', 'needs_testing', 'not_configured', 'profile_bypass_eligible']),
  ambiguous: z.array(BrandStrategyDiagnosticSchema),
  unmatched: z.boolean(),
  possibleMatches: z.array(BrandStrategyDiagnosticSchema),
});

export type BrandStrategy = z.infer<typeof BrandStrategySchema>;
export type BrandStrategySitemap = z.infer<typeof BrandStrategySitemapSchema>;
export type BrandStrategyOfficialDomain = z.infer<typeof BrandStrategyOfficialDomainSchema>;

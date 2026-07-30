import { z } from 'zod';

// ─── Evidence Lookup Outcome ──────────────────────────────────────────────────

export const EvidenceLookupOutcomeEnum = z.enum([
  'found',
  'not_stocked',
  'source_error',
]);

export type EvidenceLookupOutcome = z.infer<typeof EvidenceLookupOutcomeEnum>;

// ─── Product Evidence Lookup Input ─────────────────────────────────────────────

export const ProductEvidenceLookupInputSchema = z.object({
  upc: z.string().min(1, 'UPC is required'),
  registerName: z.string().min(1, 'Register name is required'),
  brandHint: z.string().nullable().default(null),
  price: z.number().nullable().default(null),
});

export type ProductEvidenceLookupInput = z.infer<typeof ProductEvidenceLookupInputSchema>;

// ─── Product Identity Evidence ─────────────────────────────────────────────────

export const ProductIdentityEvidenceSchema = z.object({
  upc: z.string().optional(),
  gtin: z.string().optional(),
  distributorSku: z.string().optional(),
  manufacturerPartNumber: z.string().optional(),
  name: z.string().optional(),
  brand: z.string().optional(),
  description: z.string().optional(),
  weight: z.string().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  images: z.array(z.string()).optional(),
});

export type ProductIdentityEvidence = z.infer<typeof ProductIdentityEvidenceSchema>;

// ─── Product Evidence Lookup Result ────────────────────────────────────────────

export const ProductEvidenceLookupResultSchema = z.object({
  providerId: z.string(),
  providerType: z.literal('distributor'),
  outcome: EvidenceLookupOutcomeEnum,
  confidence: z.number().min(0).max(1),
  identity: ProductIdentityEvidenceSchema,
  evidenceUrl: z.string().nullable(),
  matchedFields: z.array(z.string()),
  warnings: z.array(z.string()),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  rawSnapshot: z.unknown().optional(),
});

export type ProductEvidenceLookupResult = z.infer<typeof ProductEvidenceLookupResultSchema>;

// ─── Product Identity Bundle ───────────────────────────────────────────────────

export const ProductIdentityBundleSchema = z.object({
  confirmedUpcs: z.array(z.string()),
  canonicalNameCandidates: z.array(z.string()),
  brandCandidates: z.array(z.string()),
  manufacturerPartNumbers: z.array(z.string()),
  variantAttributes: z.record(z.string(), z.array(z.string())),
  weightCandidates: z.array(z.string()),
  supportingEvidenceAttemptIds: z.array(z.string()),
  hasIdentifierConflict: z.boolean(),
});

export type ProductIdentityBundle = z.infer<typeof ProductIdentityBundleSchema>;

// ─── Distributor Evidence Attempt (persisted row) ──────────────────────────────

export const EvidenceAttemptSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  providerId: z.string(),
  lookupUpc: z.string(),
  outcome: EvidenceLookupOutcomeEnum,
  confidence: z.number().min(0).max(1),
  evidenceUrl: z.string().nullable(),
  matchedFields: z.array(z.string()),
  identityJson: z.string().nullable(),
  warningsJson: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
});

export type EvidenceAttempt = z.infer<typeof EvidenceAttemptSchema>;

// ─── Insert type for the repository layer ──────────────────────────────────────

export interface InsertEvidenceAttempt {
  itemId: string;
  providerId: string;
  lookupUpc: string;
  outcome: EvidenceLookupOutcome;
  confidence: number;
  evidenceUrl: string | null;
  matchedFields: string[];
  identityJson: string | null;
  warningsJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

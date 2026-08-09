import { z } from 'zod';

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

// ─── Evidence Lookup Outcome ──────────────────────────────────────────────────

export const EvidenceLookupOutcomeEnum = z.enum([
  'found',
  'not_stocked',
  'source_error',
]);

export type EvidenceLookupOutcome = z.infer<typeof EvidenceLookupOutcomeEnum>;
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

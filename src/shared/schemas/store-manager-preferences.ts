// ---------------------------------------------------------------------------
// Store Manager operational-preferences schemas (operations console, Issue 2).
//
// Operational memory is EXPLICIT versioned workspace configuration — never
// hidden conversational memory. A revision is immutable; one active revision
// exists per workspace. Values are entered/edited through reviewed Settings
// forms and validated against existing identities server-side. The model has
// no tool to write preferences, and chat text is never parsed into them.
// Unknown keys are rejected (`.strict()`) and every field is bounded.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { StoreManagerPinnedScopeSchema, STORE_MANAGER_OPERATIONS_BOUNDS } from './store-manager-operations';

export const STORE_MANAGER_PREFERENCE_BOUNDS = {
  maxFieldLabels: 200,
  maxFieldLabelKeyLength: 200,
  maxFieldLabelValueLength: 200,
  maxHealthExclusions: 500,
  maxSkuLength: STORE_MANAGER_OPERATIONS_BOUNDS.maxSkuIdLength,
  maxReviewScopeDefaults: 50,
  maxReviewScopeNameLength: 64,
  maxContentJsonBytes: 32 * 1024,
} as const;

/** Known preference keys (explicit, reviewed, bounded). */
export const STORE_MANAGER_PREFERENCE_KEYS = [
  'product_field_labels',
  'vendor_identifier_convention',
  'health_exclusions',
  'review_scope_defaults',
] as const;
export const StoreManagerPreferenceKeySchema = z.enum(STORE_MANAGER_PREFERENCE_KEYS);
export type StoreManagerPreferenceKey = z.infer<typeof StoreManagerPreferenceKeySchema>;

const ProductFieldLabelsSchema = z
  .record(
    z.string().trim().min(1).max(STORE_MANAGER_PREFERENCE_BOUNDS.maxFieldLabelKeyLength),
    z.string().trim().min(1).max(STORE_MANAGER_PREFERENCE_BOUNDS.maxFieldLabelValueLength),
  )
  .refine((v) => Object.keys(v).length <= STORE_MANAGER_PREFERENCE_BOUNDS.maxFieldLabels, {
    message: `product_field_labels exceeds ${STORE_MANAGER_PREFERENCE_BOUNDS.maxFieldLabels} entries`,
  });

/** Bounded identifier-convention vocabulary (vendor data conventions). */
export const STORE_MANAGER_VENDOR_CONVENTIONS = ['upc_a', 'upc_e', 'ean_13', 'sku', 'unknown'] as const;
const VendorIdentifierConventionSchema = z.enum(STORE_MANAGER_VENDOR_CONVENTIONS);

const HealthExclusionsSchema = z
  .array(z.string().trim().min(1).max(STORE_MANAGER_PREFERENCE_BOUNDS.maxSkuLength))
  .max(STORE_MANAGER_PREFERENCE_BOUNDS.maxHealthExclusions);

const ReviewScopeDefaultsSchema = z
  .record(
    z.string().trim().min(1).max(STORE_MANAGER_PREFERENCE_BOUNDS.maxReviewScopeNameLength),
    StoreManagerPinnedScopeSchema,
  )
  .refine((v) => Object.keys(v).length <= STORE_MANAGER_PREFERENCE_BOUNDS.maxReviewScopeDefaults, {
    message: `review_scope_defaults exceeds ${STORE_MANAGER_PREFERENCE_BOUNDS.maxReviewScopeDefaults} entries`,
  });

/** One immutable preference revision's content (all keys optional, at least
 * one present). */
export const StoreManagerPreferencesContentSchema = z
  .object({
    product_field_labels: ProductFieldLabelsSchema.optional(),
    vendor_identifier_convention: VendorIdentifierConventionSchema.optional(),
    health_exclusions: HealthExclusionsSchema.optional(),
    review_scope_defaults: ReviewScopeDefaultsSchema.optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'At least one preference key must be set.',
  });
export type StoreManagerPreferencesContent = z.infer<typeof StoreManagerPreferencesContentSchema>;

/** Durable revision row (immutable; only the active pointer changes). */
export const StoreManagerPreferenceRevisionSchema = z.object({
  id: z.string().min(1).max(64),
  workspaceId: z.string().min(1).max(200),
  version: z.number().int().positive().max(10_000),
  content: StoreManagerPreferencesContentSchema,
  /** SHA-256 hex of the canonical JSON content. */
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  actorClass: z.enum(['operator', 'system_schedule', 'system_event', 'replay', 'preview']),
  createdAt: z.string().min(1).max(64),
}).strict();
export type StoreManagerPreferenceRevision = z.infer<typeof StoreManagerPreferenceRevisionSchema>;

/** Save request wire type. */
export const StoreManagerPreferenceSaveRequestSchema = z.object({
  content: StoreManagerPreferencesContentSchema,
}).strict();
export type StoreManagerPreferenceSaveRequest = z.infer<typeof StoreManagerPreferenceSaveRequestSchema>;

/** Save response: the immutable revision plus validation diagnostics. */
export const StoreManagerPreferenceSaveResponseSchema = z.object({
  ok: z.literal(true),
  revision: StoreManagerPreferenceRevisionSchema,
  /** SKUs referenced by health_exclusions that are not in the product index. */
  unknownSkus: z.array(z.string().max(STORE_MANAGER_PREFERENCE_BOUNDS.maxSkuLength)).max(500),
}).strict();
export type StoreManagerPreferenceSaveResponse = z.infer<typeof StoreManagerPreferenceSaveResponseSchema>;

/** Active-preferences read response. */
export const StoreManagerPreferencesResponseSchema = z.object({
  active: StoreManagerPreferenceRevisionSchema.nullable(),
  revisions: z.array(StoreManagerPreferenceRevisionSchema).max(200),
}).strict();
export type StoreManagerPreferencesResponse = z.infer<typeof StoreManagerPreferencesResponseSchema>;

export class StoreManagerPreferenceValidationError extends Error {
  readonly code: 'invalid_preferences' | 'invalid_product_field' | 'invalid_identity';
  constructor(code: StoreManagerPreferenceValidationError['code'], message: string) {
    super(message);
    this.name = 'StoreManagerPreferenceValidationError';
    this.code = code;
  }
}

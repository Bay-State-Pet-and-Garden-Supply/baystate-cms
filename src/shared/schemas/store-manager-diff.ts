// ---------------------------------------------------------------------------
// Store Manager action diff + verification diff schemas (operations console,
// Issue 7 — diff-first action UX).
//
// Every persistent action is preceded by a fresh deterministic
// `StoreManagerActionDiff` (shown before approval) and followed by an
// authoritative `StoreManagerVerificationDiff` (shown after execution).
// "Unknown" is a typed value, never an omitted field. All fields are bounded
// and redacted by construction: files are workspace-relative allowlisted
// paths only, network estimates are bounded, and evidence references are
// bounded identifiers. The `diffHash` content-addresses the deterministic
// preview so an approval can bind the EXACT set the operator saw.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { hashCanonicalJson } from '../stable-id';

export const STORE_MANAGER_DIFF_BOUNDS = {
  maxDiffSkus: 200,
  maxBeforeAfterRows: 50,
  maxFilesTouched: 100,
  maxFilePathLength: 300,
  maxEvidenceRefs: 50,
  maxEvidenceRefLength: 200,
  maxStateHashKeys: 30,
  maxNetworkHosts: 20,
  maxNetworkNoteLength: 300,
  maxVerificationSkus: 200,
} as const;

// ---------------------------------------------------------------------------
// Action diff (pre-approval, deterministic preview)
// ---------------------------------------------------------------------------

const diffNetworkActivitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('none'),
  }).strict(),
  z.object({
    kind: z.literal('bounded'),
    /** Redacted host labels (origin hosts only, bounded). */
    hosts: z.array(z.string().min(1).max(200)).max(STORE_MANAGER_DIFF_BOUNDS.maxNetworkHosts),
    requestCount: z.number().int().nonnegative().max(10_000),
    note: z.string().max(STORE_MANAGER_DIFF_BOUNDS.maxNetworkNoteLength).optional(),
  }).strict(),
  z.object({
    kind: z.literal('unknown'),
    note: z.string().max(STORE_MANAGER_DIFF_BOUNDS.maxNetworkNoteLength),
  }).strict(),
]);
export type StoreManagerDiffNetworkActivity = z.infer<typeof diffNetworkActivitySchema>;

const beforeAfterRowSchema = z
  .object({
    field: z.string().min(1).max(200),
    /** Bounded SKU sample; empty for field-wide summaries. */
    sku: z.string().min(1).max(128).optional(),
    before: z.string().max(1000),
    after: z.string().max(1000),
    affectedCount: z.number().int().nonnegative().max(5000).optional(),
  })
  .strict();
export type StoreManagerBeforeAfterRow = z.infer<typeof beforeAfterRowSchema>;

const fileTouchSchema = z
  .object({
    /** Workspace-relative allowlisted path (never absolute). */
    path: z.string().min(1).max(STORE_MANAGER_DIFF_BOUNDS.maxFilePathLength),
    note: z.string().max(200).optional(),
  })
  .strict();
export type StoreManagerFileTouch = z.infer<typeof fileTouchSchema>;

const changeSetStateSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    /** Current authoritative Change Set state at preview time. */
    currentState: z.string().min(1).max(100).nullable(),
    /** The state the action requires / produces. */
    expectedState: z.string().min(1).max(100).optional(),
    itemCount: z.number().int().nonnegative().max(5000).optional(),
  })
  .strict();
export type StoreManagerDiffChangeSetState = z.infer<typeof changeSetStateSchema>;

/** Deterministic pre-approval preview for one persistent action. */
export const StoreManagerActionDiffSchema = z
  .object({
    schemaVersion: z.literal(1),
    toolName: z.string().min(1).max(200),
    toolVersion: z.number().int().positive(),
    riskClass: z.enum(['read', 'proposal_write', 'catalog_mutation', 'network_filesystem_repair']),
    workspaceId: z.string().min(1).max(200),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    affectedSkuCount: z.number().int().nonnegative().max(5000),
    /** Bounded SKU sample; `truncated` marks a larger real set. */
    affectedSkus: z.array(z.string().min(1).max(128)).max(STORE_MANAGER_DIFF_BOUNDS.maxDiffSkus),
    affectedSkusTruncated: z.boolean(),
    beforeAfter: z.array(beforeAfterRowSchema).max(STORE_MANAGER_DIFF_BOUNDS.maxBeforeAfterRows),
    filesTouched: z.array(fileTouchSchema).max(STORE_MANAGER_DIFF_BOUNDS.maxFilesTouched),
    changeSet: changeSetStateSchema.nullable(),
    networkActivity: diffNetworkActivitySchema,
    evidenceRefs: z.array(z.string().min(1).max(STORE_MANAGER_DIFF_BOUNDS.maxEvidenceRefLength)).max(STORE_MANAGER_DIFF_BOUNDS.maxEvidenceRefs),
    /** Precondition state hashes captured at preview time (catalog/change-set/source digests). */
    stateHashes: z.record(z.string().min(1).max(STORE_MANAGER_DIFF_BOUNDS.maxStateHashKeys), z.string().max(64)),
    generatedAt: z.string().min(1).max(64),
    /** SHA-256 of the canonical JSON of all fields except diffHash. */
    diffHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type StoreManagerActionDiff = z.infer<typeof StoreManagerActionDiffSchema>;

// ---------------------------------------------------------------------------
// Verification diff (post-execution, authoritative current state)
// ---------------------------------------------------------------------------

const perSkuVerificationSchema = z
  .object({
    sku: z.string().min(1).max(128),
    status: z.enum(['verified', 'skipped', 'error']),
    note: z.string().max(300).optional(),
  })
  .strict();
export type StoreManagerPerSkuVerification = z.infer<typeof perSkuVerificationSchema>;

export const StoreManagerVerificationDiffSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1).max(64),
    turnId: z.string().min(1).max(64).nullable(),
    toolName: z.string().min(1).max(200),
    toolVersion: z.number().int().positive(),
    workspaceId: z.string().min(1).max(200),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    verifiedSkuCount: z.number().int().nonnegative().max(5000),
    perSku: z.array(perSkuVerificationSchema).max(STORE_MANAGER_DIFF_BOUNDS.maxVerificationSkus),
    perSkuTruncated: z.boolean(),
    changeSet: changeSetStateSchema.nullable(),
    /** A tool's success result alone is never "verified"; this hash marks an authoritative verification diff. */
    verificationHash: z.string().regex(/^[a-f0-9]{64}$/),
    generatedAt: z.string().min(1).max(64),
  })
  .strict();
export type StoreManagerVerificationDiff = z.infer<typeof StoreManagerVerificationDiffSchema>;

/** Compute the content hash of an action diff (all fields except diffHash and the generatedAt timestamp, so checkpoint-time and dispatch-time recomputes match when state is unchanged). */
export function computeActionDiffHash(diff: Omit<StoreManagerActionDiff, 'diffHash' | 'generatedAt'>): string {
  return hashCanonicalJson(diff);
}

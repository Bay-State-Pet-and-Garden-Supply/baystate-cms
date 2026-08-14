// ---------------------------------------------------------------------------
// Store Manager pinned-scope schemas (operations console, Issue 2).
//
// The pinned scope is a strict discriminated union of bounded identifiers
// (locked in the operations-console plan, Locked Decision 5). The server
// resolves and workspace-checks it at run start; the resolved snapshot is
// what the client renders and what run history captures. Unknown keys are
// rejected; vendor scope fails closed when no workspace-owned vendor
// identity source is available.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import {
  StoreManagerPinnedScopeSchema,
  StoreManagerScopeKindSchema,
  STORE_MANAGER_OPERATIONS_BOUNDS,
} from './store-manager-operations';

export type { StoreManagerPinnedScope, StoreManagerScopeKind } from './store-manager-operations';
export { StoreManagerPinnedScopeSchema, StoreManagerScopeKindSchema } from './store-manager-operations';

/** Bounded resolved display info for a pinned scope (never raw identities
 * beyond the already-bounded identifiers in `pinnedScope`). */
export const StoreManagerResolvedScopeSchema = z.object({
  pinnedScope: StoreManagerPinnedScopeSchema,
  /** SHA-256 hex of the canonical JSON of the pinned scope. */
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  resolved: z.object({
    kind: StoreManagerScopeKindSchema,
    /** Bounded human label (e.g. field label, change-set title, batch name). */
    displayName: z.string().max(200),
    /** Bounded item count when meaningful (SKUs found, batch items). */
    itemCount: z.number().int().min(0).max(100_000).optional(),
  }).strict(),
}).strict();
export type StoreManagerResolvedScope = z.infer<typeof StoreManagerResolvedScopeSchema>;

/** Wire type for pinning / validating a scope. */
export const StoreManagerScopePinRequestSchema = z.object({
  scope: StoreManagerPinnedScopeSchema.nullable(),
}).strict();
export type StoreManagerScopePinRequest = z.infer<typeof StoreManagerScopePinRequestSchema>;

/** One scope kind a tool declares support for (server-owned adapter metadata). */
export const StoreManagerScopeSupportSchema = z.object({
  toolName: z.string().min(1).max(200),
  supportedScopes: z.array(StoreManagerScopeKindSchema),
}).strict();
export type StoreManagerScopeSupport = z.infer<typeof StoreManagerScopeSupportSchema>;

export const STORE_MANAGER_SCOPE_BOUNDS = {
  maxResolvedDisplayNameLength: 200,
  maxScopeJsonBytes: STORE_MANAGER_OPERATIONS_BOUNDS.maxScopeJsonBytes,
} as const;

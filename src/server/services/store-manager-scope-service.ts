/**
 * Store Manager pinned-scope service (operations console, Issue 2).
 *
 * Resolves and workspace-checks a pinned scope at run start and produces a
 * bounded, redacted `StoreManagerResolvedScope` snapshot (identifiers only +
 * a bounded display label + a content hash). Foreign/unknown identifiers are
 * indistinguishable from missing (fail closed, no ownership disclosure).
 * Vendor scope fails closed when no workspace-owned vendor identity source is
 * available — arbitrary text is never accepted as identity.
 */

import { hashCanonicalJson } from '../../shared/stable-id';
import {
  StoreManagerPinnedScopeSchema,
  type StoreManagerPinnedScope,
} from '../../shared/schemas/store-manager-scope';
import type { StoreManagerResolvedScope } from '../../shared/schemas/store-manager-scope';
import { listBatches } from '../../db/repositories/onboarding-batch-repo';
import { findChangeSetByWorkspaceId } from '../../db/repositories/change-set-repo';
import { listRegistry } from '../../db/repositories/field-registry-repo';
import { findProductBySku } from '../../db/repositories/product-index-repo';

export class StoreManagerScopeError extends Error {
  readonly code:
    | 'scope_invalid'
    | 'not_found'
    | 'vendor_unresolved'
    | 'cross_workspace';
  constructor(code: StoreManagerScopeError['code'], message: string) {
    super(message);
    this.name = 'StoreManagerScopeError';
    this.code = code;
  }
}

function truncate(value: string, max = 200): string {
  return value.length <= max ? value : value.slice(0, max);
}

function dedupePreservingOrder<T>(values: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Resolve + workspace-check a pinned scope. Throws `StoreManagerScopeError`
 * (fail closed) for invalid/foreign/unknown identifiers.
 */
export function resolveStoreManagerPinnedScope(
  workspaceId: string,
  scope: StoreManagerPinnedScope,
): StoreManagerResolvedScope {
  const parsed = StoreManagerPinnedScopeSchema.safeParse(scope);
  if (!parsed.success) {
    throw new StoreManagerScopeError(
      'scope_invalid',
      `Invalid pinned scope: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
    );
  }
  const s = parsed.data;

  switch (s.kind) {
    case 'onboarding_batch': {
      const batch = listBatches(workspaceId).find((b) => b.id === s.batchId);
      if (!batch) {
        throw new StoreManagerScopeError(
          'not_found',
          `Onboarding batch "${s.batchId}" was not found in this workspace.`,
        );
      }
      return {
        pinnedScope: s,
        scopeHash: hashCanonicalJson(s),
        resolved: {
          kind: 'onboarding_batch',
          displayName: truncate(batch.name || batch.id),
          itemCount: batch.totalItems ?? 0,
        },
      };
    }
    case 'change_set': {
      const changeSet = findChangeSetByWorkspaceId(workspaceId, s.changeSetId);
      if (!changeSet) {
        throw new StoreManagerScopeError(
          'not_found',
          `Change Set "${s.changeSetId}" was not found in this workspace.`,
        );
      }
      return {
        pinnedScope: s,
        scopeHash: hashCanonicalJson(s),
        resolved: {
          kind: 'change_set',
          displayName: truncate(changeSet.title || changeSet.id),
        },
      };
    }
    case 'product_field': {
      const entry = listRegistry(workspaceId).find((f) => f.xmlField === s.field);
      if (!entry) {
        throw new StoreManagerScopeError(
          'not_found',
          `ProductField "${s.field}" is not registered in this workspace.`,
        );
      }
      return {
        pinnedScope: s,
        scopeHash: hashCanonicalJson(s),
        resolved: {
          kind: 'product_field',
          displayName: truncate(entry.label || entry.xmlField),
        },
      };
    }
    case 'vendor': {
      // No workspace-owned vendor identity source exists in the committed
      // schema. Pinning fails closed rather than accepting arbitrary text.
      throw new StoreManagerScopeError(
        'vendor_unresolved',
        'No workspace-owned vendor identity source is available; vendor scope cannot be pinned.',
      );
    }
    case 'sku_set': {
      const unique = dedupePreservingOrder(s.skus);
      const found = unique.filter((sku) => findProductBySku(sku) != null);
      if (found.length === 0) {
        throw new StoreManagerScopeError(
          'not_found',
          'None of the pinned SKUs exist in the product index.',
        );
      }
      const normalized: StoreManagerPinnedScope = { kind: 'sku_set', skus: unique };
      return {
        pinnedScope: normalized,
        scopeHash: hashCanonicalJson(normalized),
        resolved: {
          kind: 'sku_set',
          displayName: `${found.length} SKU(s)`,
          itemCount: found.length,
        },
      };
    }
  }
}

/** Convenience: validate + resolve a scope payload from the client (nullable
 * clears the pin). Returns the resolved snapshot or null when cleared. */
export function resolveStoreManagerScopeRequest(
  workspaceId: string,
  scope: StoreManagerPinnedScope | null,
): StoreManagerResolvedScope | null {
  if (!scope) return null;
  return resolveStoreManagerPinnedScope(workspaceId, scope);
}

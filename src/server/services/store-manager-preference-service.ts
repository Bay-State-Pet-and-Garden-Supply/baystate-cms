/**
 * Store Manager preference service (operations console, Issue 2).
 *
 * Explicit versioned workspace configuration, written ONLY through reviewed
 * Settings routes. Values are validated against existing identities
 * server-side (registered ProductFields, bounded SKUs, enum conventions)
 * before an immutable revision is created. The model has no preference tool;
 * chat text is never parsed into preferences. Run history captures the active
 * revision's content hash via the repository.
 */

import { listRegistry } from '../../db/repositories/field-registry-repo';
import { findProductBySku } from '../../db/repositories/product-index-repo';
import {
  createPreferenceRevision,
  getActivePreferenceRevision,
  getActivePreferenceContent,
  listPreferenceRevisions,
  type StoreManagerPreferenceRow,
} from '../../db/repositories/store-manager-preference-repo';
import {
  StoreManagerPreferencesContentSchema,
  StoreManagerPreferenceValidationError,
  type StoreManagerPreferencesContent,
  type StoreManagerPreferenceRevision,
} from '../../shared/schemas/store-manager-preferences';
import { getActivePreferenceContentHash as repoActiveHash } from '../../db/repositories/store-manager-preference-repo';

export interface StoreManagerPreferenceSaveResult {
  revision: StoreManagerPreferenceRevision;
  /** Health-exclusion SKUs referenced but not present in the product index. */
  unknownSkus: string[];
}

/** Map a DB row to the shared camelCase revision shape (content parsed). */
function mapRevision(row: StoreManagerPreferenceRow): StoreManagerPreferenceRevision {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    version: row.version,
    content: JSON.parse(row.content_json) as StoreManagerPreferencesContent,
    contentHash: row.content_hash,
    actorClass: row.actor_class as StoreManagerPreferenceRevision['actorClass'],
    createdAt: row.created_at,
  };
}

/** Active revision content hash (used by the runtime policy snapshot). */
export function resolveActivePreferenceContentHash(workspaceId: string): string | null {
  return repoActiveHash(workspaceId);
}

export function getActivePreferenceRevisionRow(
  workspaceId: string,
): StoreManagerPreferenceRevision | null {
  const row = getActivePreferenceRevision(workspaceId);
  return row ? mapRevision(row) : null;
}

export function listStoreManagerPreferenceRevisions(
  workspaceId: string,
  limit = 50,
): StoreManagerPreferenceRevision[] {
  return listPreferenceRevisions(workspaceId, limit).map(mapRevision);
}

export function getActiveStoreManagerPreferenceContent(
  workspaceId: string,
): StoreManagerPreferencesContent | null {
  return getActivePreferenceContent(workspaceId);
}

/**
 * Validate + persist a new immutable preference revision. Throws
 * `StoreManagerPreferenceValidationError` (fail closed) when:
 *  - the content violates the strict bounded schema;
 *  - a product_field_labels key is not a registered ProductField.
 */
export function saveStoreManagerPreference(
  workspaceId: string,
  content: unknown,
  actorClass: 'operator' | 'system_schedule' | 'system_event' | 'replay' | 'preview' = 'operator',
): StoreManagerPreferenceSaveResult {
  const parsed = StoreManagerPreferencesContentSchema.safeParse(content);
  if (!parsed.success) {
    throw new StoreManagerPreferenceValidationError(
      'invalid_preferences',
      `Invalid preference content: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
    );
  }
  const data = parsed.data;

  const fields = listRegistry(workspaceId);
  const fieldKeys = new Set(fields.map((f) => f.xmlField));
  const labelKeys = Object.keys(data.product_field_labels ?? {});
  const invalidFields = labelKeys.filter((k) => !fieldKeys.has(k));
  if (invalidFields.length > 0) {
    throw new StoreManagerPreferenceValidationError(
      'invalid_product_field',
      `Unregistered ProductFields in product_field_labels: ${invalidFields.slice(0, 10).join(', ')}.`,
    );
  }

  const unknownSkus = (data.health_exclusions ?? []).filter((sku) => findProductBySku(sku) == null);

  const revision = mapRevision(createPreferenceRevision(workspaceId, data, actorClass));
  return { revision, unknownSkus };
}

import type { Product, CoreProduct, ShopSiteMeta, PreservedFields } from './schemas/product';
import type { FieldRegistryEntry, FieldRegistry } from './schemas/field-registry';
import type { Workspace, ShopSiteConnection } from './schemas/workspace';
import type { ChangeSet, ChangeSetItem } from './schemas/change-set';
import type { SyncJob, SyncJobEvent } from './schemas/sync';
import type { ValidationResult } from './schemas/validation';

export type {
  Product,
  CoreProduct,
  ShopSiteMeta,
  PreservedFields,
  FieldRegistryEntry,
  FieldRegistry,
  Workspace,
  ShopSiteConnection,
  ChangeSet,
  ChangeSetItem,
  SyncJob,
  SyncJobEvent,
  ValidationResult,
};

/** Syncable product status for a change set item */
export type ProductOperation = 'create' | 'update' | 'archive';

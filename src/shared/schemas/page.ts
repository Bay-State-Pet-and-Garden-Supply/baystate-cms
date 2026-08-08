// fallow-ignore-file unused-export

/**
 * ShopSite Page identity, import, and activation contracts.
 *
 * Page identity is NEVER a display name. Verified identity requires a real
 * ShopSite Pages export (an exported GUID or an exported File Name). Local
 * rows without a verified identity are `unverified_name_only` review context
 * — they can never be serialized into ProductOnPages nor resolve as
 * assignment options. Import preview has no DB effect; activation is atomic.
 */
import { z } from 'zod';
import { Sha256HexSchema, StrictIsoDateTimeStringSchema } from './classification';

export const PageIdentityKindSchema = z.enum(['exported_guid', 'exported_file_name', 'unverified_name_only']);
export type PageIdentityKind = z.infer<typeof PageIdentityKindSchema>;

export const PageIdentityStatusSchema = z.enum(['verified', 'unverified']);
export type PageIdentityStatus = z.infer<typeof PageIdentityStatusSchema>;

export const PageIdentitySchema = z.object({
  kind: PageIdentityKindSchema,
  key: z.string().min(1),
  status: PageIdentityStatusSchema,
}).strict();
export type PageIdentity = z.infer<typeof PageIdentitySchema>;

export const PageAvailabilitySchema = z.enum(['available', 'unavailable']);
export type PageAvailability = z.infer<typeof PageAvailabilitySchema>;

export const PageRecordSchema = z.object({
  identity: PageIdentitySchema,
  name: z.string().min(1),
  /** Identity key of the parent page in the same import, or null. */
  parentRef: z.string().nullable(),
  availability: PageAvailabilitySchema,
}).strict();
export type PageRecord = z.infer<typeof PageRecordSchema>;

export const PageImportStatusSchema = z.enum(['previewed', 'active', 'superseded']);
export type PageImportStatus = z.infer<typeof PageImportStatusSchema>;

export const PageImportCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
  nameOnly: z.number().int().nonnegative(),
  withParent: z.number().int().nonnegative(),
}).strict();
export type PageImportCounts = z.infer<typeof PageImportCountsSchema>;

export const PageImportSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  sourceHash: Sha256HexSchema,
  parserFormatVersion: z.string().min(1),
  status: PageImportStatusSchema,
  counts: PageImportCountsSchema,
  createdAt: StrictIsoDateTimeStringSchema,
  activatedAt: StrictIsoDateTimeStringSchema.nullable(),
  supersededAt: StrictIsoDateTimeStringSchema.nullable(),
  activatedBy: z.string().nullable(),
}).strict();
export type PageImport = z.infer<typeof PageImportSchema>;

export const ImportPreviewSchema = z.object({
  import: PageImportSchema,
  records: z.array(PageRecordSchema),
  warnings: z.array(z.string()),
}).strict();
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;

export const ImportActivationSchema = z.object({
  workspaceId: z.string().min(1),
  sourceHash: Sha256HexSchema,
  parserFormatVersion: z.string().min(1),
  records: z.array(PageRecordSchema).min(1),
  activatedBy: z.string().nullable().default(null),
}).strict();
export type ImportActivation = z.infer<typeof ImportActivationSchema>;

/** A page assignment reference whose identity is verified in the active import. */
export const VerifiedPageRefSchema = z.object({
  pageId: z.string().min(1),
  pageName: z.string().min(1),
}).strict();
export type VerifiedPageRef = z.infer<typeof VerifiedPageRefSchema>;

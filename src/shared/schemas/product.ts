import { z } from 'zod';

export const MediaSchema = z.object({
  primary: z.string().nullable().default(null),
  additional: z.array(z.string()).default(() => [] as string[]),
});

export const InventorySchema = z.object({
  quantityOnHand: z.number().int().nullable().default(null),
  lowStockThreshold: z.number().int().nullable().default(null),
  outOfStockLimit: z.number().int().nullable().default(null),
});

export const SeoSchema = z.object({
  fileName: z.string().nullable().default(null),
  searchKeywords: z.string().nullable().default(null),
  googleProductCategory: z.string().nullable().default(null),
});

export const CoreProductSchema = z.object({
  name: z.string().min(1, 'Product name is required'),
  price: z.string().nullable().default(null),
  salePrice: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  inventory: InventorySchema.default({
    quantityOnHand: null,
    lowStockThreshold: null,
    outOfStockLimit: null,
  }),
  availability: z.string().nullable().default(null),
  weight: z.string().nullable().default(null),
  taxable: z.boolean().default(true),
  media: MediaSchema.default({
    primary: null,
    additional: [],
  }),
  seo: SeoSchema.default({
    fileName: null,
    searchKeywords: null,
    googleProductCategory: null,
  }),
});

export const ProductSourceSchema = z.object({
  dbname: z.string().default('products'),
  uniqueName: z.string().default('SKU'),
});

export const PreservedFieldsSchema = z.object({
  unknownElements: z.record(z.string(), z.unknown()),
  advancedBlocks: z.record(z.string(), z.string()),
  rawAttributes: z.record(z.string(), z.string()),
});

export const ShopSiteMetaSchema = z.object({
  productId: z.string().nullable().default(null),
  productGuid: z.string().nullable().default(null),
  xmlVersion: z.string().default('15.0'),
  lastPulledAt: z.string().nullable().default(null),
  lastRemoteHash: z.string().nullable().default(null),
  lastSyncedAt: z.string().nullable().default(null),
  source: ProductSourceSchema,
  preserved: PreservedFieldsSchema,
});

export const ProductMetadataSchema = z.object({
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable().default(null),
});

export const ProductSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  sku: z.string().min(1, 'SKU is required'),
  status: z.enum(['active', 'draft', 'archived']).default('active'),
  core: CoreProductSchema,
  customFields: z.record(z.string(), z.string()),
  shopsite: ShopSiteMetaSchema,
  metadata: ProductMetadataSchema,
});

export type Product = z.infer<typeof ProductSchema>;
export type CoreProduct = z.infer<typeof CoreProductSchema>;
export type ShopSiteMeta = z.infer<typeof ShopSiteMetaSchema>;
export type PreservedFields = z.infer<typeof PreservedFieldsSchema>;

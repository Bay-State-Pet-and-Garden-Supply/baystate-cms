# Codebase Integration: Adding a New ShopSite Product Field

This guide documents the exact workflow for adding support for a new ShopSite product field to the CMS codebase. Follow these steps in order when extending the product model with additional ShopSite fields.

---

## Step 0: Identify the Field

Before writing code, determine:

1. **Field name** from the ShopSite documentation or a `db_xml.cgi` export (e.g., `Brand`, `Low Stock Threshold`)
2. **XML tag** from the export (e.g., `Brand`) or inferred from field name (e.g., `LowStockThreshold`)
3. **Type** from the [field type system](../field-type-system.md) (Text, Numeric, Checkbox, etc.)
4. **Default value** and **allowed values** from the [product field catalog](../product-field-catalog.md)
5. **Whether the field should be editable** through the CMS or preserved read-only

> **Recommendation:** Always confirm the XML tag from a real `db_xml.cgi` export before depending on it. Inferred tags (derived from field names) are highly likely correct but not guaranteed.

---

## Step 1: Add to the Zod Schema (`src/shared/schemas/product.ts`)

Add the field to the appropriate section of the `ProductSchema`. Choose the right location based on the field's category:

### For a core product field (price, weight, description, etc.):

Add to `CoreProductSchema`:

```typescript
export const CoreProductSchema = z.object({
  name: z.string().min(1, 'Product name is required'),
  price: z.string().nullable().default(null),
  // ... existing fields ...
  // NEW FIELD:
  brand: z.string().nullable().default(null),
});
```

### For an inventory field:

Add to `InventorySchema`:

```typescript
export const InventorySchema = z.object({
  quantityOnHand: z.number().int().nullable().default(null),
  lowStockThreshold: z.number().int().nullable().default(null),
  outOfStockLimit: z.number().int().nullable().default(null),
  // NEW FIELD:
  lowStockThreshold: z.number().int().nullable().default(null),
});
```

### For an SEO/meta field:

Add to `SeoSchema`:

```typescript
export const SeoSchema = z.object({
  fileName: z.string().nullable().default(null),
  searchKeywords: z.string().nullable().default(null),
  googleProductCategory: z.string().nullable().default(null),
  // NEW FIELD:
  brand: z.string().nullable().default(null),
});
```

### For a media field:

Add to `MediaSchema`:

```typescript
export const MediaSchema = z.object({
  primary: z.string().nullable().default(null),
  additional: z.array(z.string()).default(() => [] as string[]),
  // NEW FIELD (if appropriate):
  // (media fields are generally just primary + additional)
});
```

### For a custom/system field:

If the field doesn't fit core/inventory/seo/media, add it directly to `ProductSchema` or `ShopSiteMetaSchema`:

```typescript
export const ProductSchema = z.object({
  // ... existing fields ...
  // NEW FIELD at product level:
  customFields: z.record(z.string(), z.string()),
  // NEW structured field:
  googleShopping: z.object({
    brand: z.string().nullable().default(null),
    gtin: z.string().nullable().default(null),
    mpn: z.string().nullable().default(null),
    condition: z.string().default('New'),
  }).default({}),
});
```

### For a pass-through-only field:

If the field should remain preserved but not independently editable, skip the schema change. It will automatically survive round-trips in `unknownElements`.

---

## Step 2: Update the Parser (`src/shopsite/product-parser.ts`)

If the XML tag is not already in the `coreFields` set, add it:

```typescript
const coreFields = new Set([
  'SKU', 'sku', 'Name', 'name', 'Price', 'price',
  // ... existing fields ...
  // NEW FIELD:
  'Brand',
]);
```

**If the field is a block-level element** (contains child elements like `Subproducts`, `ProductOptions`, `ProductOnPages`), add it to the `blockTags` set instead:

```typescript
const blockTags = new Set([
  'Subproducts', 'subproducts',
  'ProductOptions', 'Options', 'options',
  'ProductOnPages', 'productOnPages',
  // NEW BLOCK FIELD:
  'ShippingOptions',
]);
```

> **Why this matters:** Adding a tag to `coreFields` makes it available as a simple key-value pair in `product.fields`. Adding to `blockTags` preserves its raw XML structure. Adding to neither means it still gets extracted as an unknown element but goes through both paths.

---

## Step 3: Update the Normalizer (`src/shopsite/product-normalizer.ts`)

### 3a. Extract the field value:

```typescript
const brand = fields['Brand'] ?? null;
```

### 3b. Map to the Product field:

```typescript
const product: Product = {
  // ... existing fields ...
  core: {
    // ... existing core fields ...
    brand,  // <-- NEW FIELD
  },
};
```

### 3c. Add to `knownFieldLabels` (so it appears in the field registry):

```typescript
const knownFieldLabels: Record<string, { label: string; kind: string }> = {
  // ... existing entries ...
  Brand: { label: 'Brand', kind: 'custom' },
};
```

Choose the right `kind`:
- `'core'` — standard ShopSite product field
- `'system'` — ShopSite-internal (ProductID, ProductGUID, ProductDisabled)
- `'custom'` — custom/Google/integration fields

### 3d. Optionally update `inferDataType()`:

```typescript
function inferDataType(tag: string, _value: string | null): 'string' | 'number' | 'boolean' | 'image' {
  // ... existing type mapping ...
  if (tag === 'Brand') return 'string';
}
```

---

## Step 4: Update the Denormalizer (`src/shopsite/product-denormalizer.ts`)

### 4a. Emit the field value when present:

```typescript
// Brand
if (product.core.brand) {
  lines.push(`  <Brand>${escapeXml(product.core.brand)}</Brand>`);
}
```

### 4b. For checkbox fields:

```typescript
// SomeCheckbox
lines.push(`  <SomeCheckbox>${product.core.someCheckbox ? 'checked' : 'uncheck'}</SomeCheckbox>`);
```

### 4c. For numeric fields:

```typescript
if (product.core.numericField != null) {
  lines.push(`  <NumericField>${product.core.numericField}</NumericField>`);
}
```

### 4d. For fields that should always be emitted:

```typescript
// Always emit, even when empty/default
lines.push(`  <AlwaysEmitField>${escapeXml(product.core.alwaysEmitField ?? '')}</AlwaysEmitField>`);
```

### 4e. Ensure unknown elements still round-trip:

The denormalizer already preserves unknown elements at L137-146. If the new field is replacing a previously unknown element, remove it from the unknown elements loop to avoid duplication. Add an exclusion:

```typescript
for (const [tag, rawValue] of Object.entries(preserved.unknownElements)) {
  if (tag === 'Brand') continue; // handled above
  // ... existing logic ...
}
```

---

## Step 5: Add Unit Tests (`src/tests/unit/shopsite-normalizer.test.ts`)

### 5a. Test parsing:

```typescript
it('should parse the Brand field from XML', () => {
  const customXml = `<Product>
    <SKU>BRAND-TEST</SKU>
    <Name>Brand Test</Name>
    <Brand>Acme Corp</Brand>
  </Product>`;
  const parsed = parseProductsXml(customXml).products[0];
  expect(parsed.fields['Brand']).toBe('Acme Corp');
});
```

### 5b. Test normalization:

```typescript
it('should normalize Brand to product.core.brand', () => {
  const parsed = parseProductsXml(`<Product>
    <SKU>BRAND-TEST</SKU>
    <Name>Brand Test</Name>
    <Brand>Acme Corp</Brand>
  </Product>`).products[0];
  const { product } = normalizeProduct(parsed, 'test-workspace');
  expect(product.core.brand).toBe('Acme Corp');
});
```

### 5c. Test denormalization:

```typescript
it('should emit Brand tag when brand is set', () => {
  const parsed = parseProductsXml(`<Product>
    <SKU>BRAND-TEST</SKU>
    <Name>Brand Test</Name>
    <Brand>Acme Corp</Brand>
  </Product>`).products[0];
  const { product } = normalizeProduct(parsed, 'test-workspace');
  const denorm = denormalizeProduct(product);
  expect(denorm.xml).toContain('<Brand>Acme Corp</Brand>');
});
```

### 5d. Test round-trip preservation:

```typescript
it('should round-trip Brand through normalize and denormalize', () => {
  const parsed = parseProductsXml(`<Product>
    <SKU>BRAND-TEST</SKU>
    <Name>Brand Test</Name>
    <Brand>Acme Corp</Brand>
  </Product>`).products[0];
  const { product } = normalizeProduct(parsed, 'test-workspace');
  const denorm = denormalizeProduct(product);
  // Re-parse the output
  const reParsed = parseProductsXml(denorm.xml).products[0];
  expect(reParsed.fields['Brand']).toBe('Acme Corp');
});
```

### 5e. Test default/empty behavior:

```typescript
it('should not emit Brand tag when brand is not set', () => {
  const parsed = parseProductsXml(`<Product>
    <SKU>NO-BRAND</SKU>
    <Name>No Brand</Name>
  </Product>`).products[0];
  const { product } = normalizeProduct(parsed, 'test-workspace');
  const denorm = denormalizeProduct(product);
  expect(denorm.xml).not.toContain('<Brand>');
});
```

---

## Step 6: Run Validation

```bash
# TypeScript type checking
bun run typecheck

# Run the test suite
bun run test

# Run linting
bun run lint
```

All existing tests must pass. The round-trip tests in `shopsite-xml-roundtrip.test.ts` are especially important — they verify that unknown elements and advanced blocks survive the normalize → denormalize cycle.

---

## Hard Constraints

These constraints **must not** be violated when adding new fields:

### 1. Unknown elements MUST survive round-trips

Every tag not explicitly handled in the normalizer/denormalizer must be preserved in `.shopsite.preserved.unknownElements` and re-emitted unchanged. This is ensured by:
- Parser puts unrecognized fields into `unknownElements` (product-parser.ts)
- Normalizer preserves them in `.shopsite.preserved.unknownElements` (product-normalizer.ts L102-110)
- Denormalizer re-emits everything from `.shopsite.preserved.unknownElements` (product-denormalizer.ts L137-146)

When you add a new field, you must explicitly exclude it from the unknown elements loop to avoid double-emission:

```typescript
// In denormalizer unknown elements loop:
if (tag === 'Brand') continue; // handled by explicit emit above
```

### 2. Advanced blocks MUST survive round-trips

Block-level elements (`Subproducts`, `ProductOptions`, `ProductOnPages`) are preserved as raw XML in `.shopsite.preserved.advancedBlocks`. They are re-emitted as raw XML without re-parsing.

### 3. `ProductField*` prefix convention

Any XML tag starting with `ProductField` is automatically captured into `.customFields` by the normalizer (product-normalizer.ts L44-47). The denormalizer validates that custom field names are valid XML tag names before emitting (product-denormalizer.ts L123-132). Invalid names produce a warning and the field is skipped.

### 4. DOCTYPE must reference `shopsiteproducts.dtd` v2.9

The XML output must declare:
```xml
<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">
```

This is currently handled at the `xml-builder.ts` level and should remain unchanged.

### 5. SKU is the primary key

The project uses `SKU` as `uniqueName` for product matching. The normalizer always requires a non-empty SKU (product-normalizer.ts L19). The denormalizer always emits `<SKU>` (product-denormalizer.ts L31).

### 6. CDATA content must be safely escaped

Fields like `ProductDescription`, `MoreInformationText`, and `SearchKeywords` are wrapped in CDATA sections. The `escapeCdata()` function from `multipart-upload.ts` must be used to escape `]]>` terminators inside the content.

### 7. Numeric fields with delta support

`QuantityOnHand` supports delta updates (`+5`, `-10`). If implementing similar inventory fields, respect this convention. The parsed value is an integer; the delta prefix is handled by ShopSide at upload time.

---

## Quick Reference: File Paths

| Layer | File | Key Function/Area |
|-------|------|-------------------|
| Schema | `src/shared/schemas/product.ts` | `CoreProductSchema`, `InventorySchema`, `SeoSchema`, `ProductSchema` |
| Parser | `src/shopsite/product-parser.ts` | `coreFields` Set (L45), `blockTags` Set (L59) |
| Normalizer | `src/shopsite/product-normalizer.ts` | Field extraction (L19-33), Product object construction (L112-148), `knownFieldLabels` (L62-75), `inferDataType()` (L155-165) |
| Denormalizer | `src/shopsite/product-denormalizer.ts` | XML element emission (L30-149), `extractPageNames()` (L156-195), `escapeXml()` (L197-204) |
| Tests | `src/tests/unit/shopsite-normalizer.test.ts` | All unit tests |
| Round-trip tests | `src/tests/unit/shopsite-xml-roundtrip.test.ts` | Round-trip preservation tests |
| Sample fixture | `src/tests/fixtures/shopsite-products-sample.xml` | Sample XML for tests |
| Field registry | `src/shared/schemas/field-registry.ts` | `FieldRegistryEntrySchema` |

## Command Reference

```bash
bun run typecheck    # TypeScript type checking
bun run test         # Run all tests (Vitest)
bun run lint         # ESLint code style
```

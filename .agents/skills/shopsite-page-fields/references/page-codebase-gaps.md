# Page Codebase Gaps & Build Guidance

## Current Status: Page Support is Absent

The ShopSite CMS codebase has **no page XML support**. Here is exactly what exists, what does not, and what needs to be built.

---

## What Exists

| Component | File | Status |
|-----------|------|--------|
| Page DB table | `src/db/repositories/` (implied by workspace schema) | Likely but unused; no XML round-trip |
| ProductOnPages handling | `src/shopsite/product-denormalizer.ts` L134-148 | Preserved as advanced block; page names extracted via regex |
| Sample page data | (none) | Only product samples exist |

---

## What is Missing

| Component | File (planned) | Status | Notes |
|-----------|----------------|--------|-------|
| Page XML parser | `src/shopsite/page-parser.ts` | ❌ Does not exist | Follow product-parser.ts pattern |
| Page normalizer | `src/shopsite/page-normalizer.ts` | ❌ Does not exist | Follow product-normalizer.ts pattern |
| Page Zod schema | `src/shared/schemas/page.ts` | ❌ Does not exist | Use page-field-catalog.md for field reference |
| Page denormalizer | `src/shopsite/page-denormalizer.ts` | ❌ Does not exist | Follow product-denormalizer.ts pattern |
| Page XML builder | `src/shopsite/xml-builder.ts` | Existing (product only) | Would need page-specific handling |
| Page XML tests | `src/tests/unit/shopsite-page.test.ts` | ❌ Does not exist | Follow shopsite-normalizer.test.ts pattern |
| Page XML fixture | `src/tests/fixtures/shopsite-pages-sample.xml` | ❌ Does not exist | Need real export from a store |
| Page workspace model | `src/shared/schemas/workspace.ts` | May have page fields | Schema-level page identity may exist |

---

## Current ProductToPages Handling

The `ProductOnPages` block is currently handled as a **preserved advanced block**:

### In the parser (`product-parser.ts` L59):
The tag `ProductOnPages` is in the `blockTags` set, so it is extracted as raw XML and stored in `product.advancedBlocks['ProductOnPages']`.

### In the normalizer (`product-normalizer.ts`):
`ProductOnPages` is not in `knownFieldLabels`. It is preserved in `.shopsite.preserved.advancedBlocks`.

### In the denormalizer (`product-denormalizer.ts` L134-148):
The `extractPageNames()` function (L156-195) parses page names from:
1. `unknownElements['ProductOnPages']` — may contain page names as text or XML
2. `advancedBlocks['ProductOnPages']` — raw XML from original import
3. `advancedBlocks['productOnPages']` — lowercase variant

It extracts `<Name>`, `<PageName>`, and `<PageLink>` child tags, and re-emits the block with DTD-compliant `<Name>` children:

```xml
<ProductOnPages>
  <Name>Category Page 1</Name>
  <Name>Category Page 2</Name>
</ProductOnPages>
```

**What this means:** The CMS can round-trip page assignments for products, but it cannot:
- List all pages independently
- Edit page metadata (titles, layout, colors, SEO)
- Manage page-to-product assignments from the page side
- Create new pages

---

## Build Guidance

### Phase 1: Discovery

Before writing any code:

1. **Export a real page XML sample** from the target store:
   - Log into ShopSite back office
   - Go to Utilities → Database → Upload/Download
   - Select Pages → Download → XML format → download to browser
2. **Analyze the export** to determine:
   - Root element, DOCTYPE, namespace, version attribute
   - Actual XML tag names for all 60+ fields
   - CDATA usage (fields like `Text 1` likely use CDATA for HTML content)
   - How `Product Links` and `Page Links` are encoded (pipe-delimited or block elements?)
   - Color field encoding (hex only, or named format?)
   - Any additional page-level fields not in the delimited catalog

### Phase 2: Build the Parser

Follow `src/shopsite/product-parser.ts` exactly:

```typescript
// src/shopsite/page-parser.ts
// Structure:
// - parsePagesXml(): ParsedPageList
//   - Extract version from root element
//   - Extract individual <Page> blocks with regex
//   - Use fast-xml-parser for structured parsing
//   - Core fields → page.fields
//   - Unknown fields → page.unknownElements
//   - Block elements (if any) → page.advancedBlocks
//   - Fallback regex extraction for edge cases

// Core field tags (from real export analysis)
const coreFields = new Set([
  'Name', 'FileName', 'Title', 'Graphic',
  'Text1', 'Text2', 'Text3',
  'LinkName', 'LinkGraphic', 'LinkText',
  'Template', 'Columns',
  // ... add more from real export
]);

// Block tags (if Product Links uses block format)
const blockTags = new Set([
  'ProductLinks', 'PageLinks',
]);
```

### Phase 3: Build the Zod Schema

```typescript
// src/shared/schemas/page.ts
export const CorePageSchema = z.object({
  name: z.string().min(1, 'Page name is required'),
  fileName: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  displayName: z.boolean().default(true),
  graphic: z.string().nullable().default(null),
  displayGraphic: z.boolean().default(true),
  text1: z.string().nullable().default(null),
  text2: z.string().nullable().default(null),
  text3: z.string().nullable().default(null),
  template: z.string().nullable().default(null),
  columns: z.string().default('One column'),
  pageWidth: z.string().default('100% wide'),
  // ... more fields from catalog
});

export const PageSchema = z.object({
  id: z.string(),
  // ... identity + core + shopsite meta + preserved + metadata
});
```

### Phase 4: Build the Normalizer

```typescript
// src/shopsite/page-normalizer.ts
// Map ParsedPage → typed Page object
// Unknown fields → shopsite.preserved.unknownElements
// Block elements → shopsite.preserved.advancedBlocks
// Add knownFieldLabels for field registry
```

### Phase 5: Build the Denormalizer

```typescript
// src/shopsite/page-denormalizer.ts
// Convert Page back to ShopSite page XML
// Follow the same pattern as product-denormalizer.ts:
// - Emit known fields with proper escaping
// - Preserve unknown elements and advanced blocks
// - Handle CDATA sections for HTML text fields
// - Validate XML tag names for custom fields
```

### Phase 6: Add Tests

```typescript
// src/tests/unit/shopsite-page.test.ts
// Test parsing, normalization, denormalization, and round-trips
```

### Phase 7: Update HTTP Client

If needed, update `src/shopsite/shopsite-http-client.ts` to support:
- `db_xml.cgi?dbname=pages` for page downloads
- `dbupload.cgi?dbname=pages` for page uploads

---

## Preservation Rules (Must Follow)

When building page support, follow the same preservation rules as the product layer:

1. **Unknown elements MUST survive round-trips** — every unrecognized XML tag is preserved in `unknownElements` and re-emitted unchanged
2. **Advanced blocks MUST survive round-trips** — block-level elements are preserved as raw XML
3. **`PageField*` prefix convention** — any tag starting with `PageField` should be captured as a custom field
4. **CDATA content must be safely escaped** — use `escapeCdata()` from `multipart-upload.ts`
5. **Checkbox serialization** — use `checked`/`uncheck` format consistent with product XML
6. **Invalid XML tag names** — generate warnings and skip, consistent with product-denormalizer.ts

---

## Known Unknowns

| Question | Why It's Unknown | Resolution |
|----------|-----------------|------------|
| Root element name | No official page XML example published | Export a real sample |
| DTD name and URL | Inferred from pattern | Export a real sample |
| Color field encoding | Could be hex (`#000000`), named (`Black-True (#000000)`), or XML attributes | Export a real sample |
| Relationship field format | Product Links/Page Links could be pipe-delimited strings or block elements | Export a real sample |
| Field type for display columns | Columns/alignment have limited values; encoding unknown | Export a real sample |
| Additional XML-only fields | Some fields may only appear in XML format | Export a real sample |

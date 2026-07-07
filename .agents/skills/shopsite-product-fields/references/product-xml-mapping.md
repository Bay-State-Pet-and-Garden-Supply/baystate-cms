# Product XML Mapping: Field → Tag → Codebase → Handling Status

This reference bridges the documented ShopSite product fields to their XML tags, `Product` model paths, and current handling status in the codebase with exact source line references.

---

## Legend

| Status | Meaning |
|--------|---------|
| ✅ **parsed** | Tag is explicitly recognized in `product-parser.ts` core field set |
| 🔄 **normalized** | Mapped from `ParsedProduct` to a `Product` field in `product-normalizer.ts` |
| ⬆️ **denormalized** | Emitted back to XML in `product-denormalizer.ts` |
| 📦 **preserved** | Passes through unchanged in `unknownElements` or `advancedBlocks`; not independently editable |
| ❌ **not handled** | May be discarded or not processed at all |
| ⚠️ **known divergence** | Code emits a hardcoded value regardless of parsed data |

---

## Core Identity

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| SKU | `SKU` / `sku` | ✅ 🔄 ⬆️ | `.sku` | Parser: L45. Normalizer: L19. Denormalizer: L31 |
| Name | `Name` / `name` | ✅ 🔄 ⬆️ | `.core.name` | Parser: L45. Normalizer: L20. Denormalizer: L48 |
| ProductGUID | `ProductGUID` | ✅ 🔄 ⬆️ | `.shopsite.productGuid` | Parser: core field set. Normalizer: L30. Denormalizer: passed via unknownElements |
| ProductID | `ProductID` | ✅ 🔄 | `.shopsite.productId` | Parser: core field set. Normalizer: L29 |
| FileName | `FileName` | ✅ 🔄 ⬆️ | `.core.seo.fileName` | Parser: core field set. Normalizer: `.core.seo.fileName` from `fields['FileName']`. Denormalizer: **generated from name slug** |

**Note on `FileName`:** The denormalizer **ignores** the stored `.core.seo.fileName` value and always generates a filename from the product name using `generateFileName()` (slugify + `.html`, max 80 chars). This is at `product-denormalizer.ts:12-17` and invoked at `L51`.

---

## Pricing

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Price | `Price` / `price` | ✅ 🔄 ⬆️ | `.core.price` | Parser: L45. Normalizer: L21. Denormalizer: L54-56 (optional emit) |
| Sale Amount | `SaleAmount` / `saleAmount` | ✅ 🔄 ⬆️ | `.core.salePrice` | Parser: L45. Normalizer: L22. Denormalizer: L57-59 (optional emit) |

---

## Description & Content

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Product Description | `ProductDescription` / `description` | ✅ 🔄 ⬆️ | `.core.description` | Parser: L45. Normalizer: L23. Denormalizer: L62-64 (CDATA) |
| More Information Text | `MoreInformationText` | 📦 ⬆️ | preserved → auto-synced | Parser: not in coreFields → unknownElements. Normalizer: stored in `unknownElements`. Denormalizer: L67-69 — **if not preserved, syncs from `.core.description`** |
| More Information Graphic | `MoreInformationGraphic` | ✅ 🔄 ⬆️ | `.core.media.primary` (fallback) + preserved separately | Parser: L45. Normalizer: L25 + L107-109 (preserved when different from Graphic). Denormalizer: L101-108 |
| MoreInfoImage 1–20 | `MoreInfoImage1`–`MoreInfoImage20` | ✅ 🔄 ⬆️ | `.core.media.additional[]` | Parser: not in coreFields → unknownElements. Normalizer: L93-100 (filtered from unknownElements). Denormalizer: L111-115 |
| MoreInfoImage 21–25 | `MoreInfoImage21`–`MoreInfoImage25` | 📦 | `.shopsite.preserved.unknownElements` | Parser: unknownElements. Normalizer: only up to 20 extracted; 21–25 remain in unknownElements. Denormalizer: passed through as unknown elements |
| More Information Title | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Not in any known field set; passes through |
| More Information Meta:Keywords | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Not in any known field set; passes through |
| More Information Meta:Description | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Not in any known field set; passes through |
| More Info Extra Image Size | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Not in any known field set; passes through |

---

## Media & Display

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Graphic | `Graphic` | ✅ 🔄 ⬆️ | `.core.media.primary` | Parser: L45. Normalizer: L24. Denormalizer: L97-108 |
| Product Image Size | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display Name? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display SKU? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display Price? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display Graphic? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Name Style | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Name Size | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Price Style | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Price Size | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| SKU Style | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| SKU Size | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Description Style | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Description Size | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Image Alignment | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Text Wrap | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Add to Cart Button | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| View Cart Button | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Use Add to Cart Image? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Add to Cart Image | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Use View Cart Image? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| View Cart Image | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display Order Quantity? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display Ordering Options? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |

All display/style fields are **pass-through only**. They survive round-trips in `unknownElements` but cannot be independently edited through the current `Product` model.

---

## Ordering Options & Variants

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Subproducts | `Subproducts` / `subproducts` | ✅ 📦 (block) | `.shopsite.preserved.advancedBlocks['Subproducts']` | Parser: blockTags set L59. Normalizer: preserved as advancedBlocks. Denormalizer: L125-131 preserved as raw XML |
| Option Text | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Option Menu Text | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Option Append SKU | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Option Use Multi Menus | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Option Select Default | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Customer Text Entry Box | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Customer Text Entry Header | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Customer Text Columns | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Customer Text Rows | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Advanced Options (!Menu1 rows) | — | ❌ | Not preserved in standard path | The `!Menu1`/`##`/`!!` block format is incompatible with the XML parser and may not survive |

---

## Inventory & Shipping

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Quantity On Hand | `QuantityOnHand` / `quantity_on_hand` / `Quantity` | ✅ 🔄 ⬆️ | `.core.inventory.quantityOnHand` | Parser: L45. Normalizer: L26-27. Denormalizer: L80-82 |
| Low Stock Threshold | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Out Of Stock Limit | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Weight | `Weight` / `weight` | ✅ 🔄 ⬆️ | `.core.weight` | Parser: L45. Normalizer: L28. Denormalizer: L85-87 |
| Taxable | `Taxable` | ✅ 🔄 ⬆️ | `.core.taxable` | Parser: L45. Normalizer: L34-35. Denormalizer: L73 |
| Product Type | `ProductType` | 📦 ⚠️ | preserved → hardcoded `Tangible` | Parser: unknownElements. Normalizer: stored in unknownElements. Denormalizer: L78 — **always emits `Tangible` unless `customFields['ProductType']` or `unknownElements['ProductType']` already exists** |
| Disable Product | `ProductDisabled` / `productDisabled` | ✅ 🔄 ⬆️ | `.status` (`'active'` / `'draft'`) | Parser: L45. Normalizer: L36-37. Denormalizer: L71 |
| Ground Shipping | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Second Day Shipping | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Next Day Shipping | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Shipping 3–9 | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| No Shipping Charges | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Extra Handling Charge | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Dimension Options | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Dimension Text | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Dimension Selected | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| FedEx Container | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| USPS Container | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Minimum Quantity | `MinimumQuantity` | ✅ 📦 ⚠️ | Preserved in parse; **always emits `0`** | Parser: L45. Normalizer: stored in unknownElements. Denormalizer: L75 — **always hardcoded to `0`** |

**Known divergences:**
1. `MinimumQuantity` (L75 in denormalizer) — hardcoded `'  <MinimumQuantity>0</MinimumQuantity>'`
2. `ProductType` (L78 in denormalizer) — defaults to `'Tangible'` when neither `customFields` nor `unknownElements` has it
3. `MoreInformationText` (L67-69 in denormalizer) — synced from `ProductDescription` unless `unknownElements` preserves a different value
4. `FileName` (L51 in denormalizer) — always generated from product name slug; stored value ignored

---

## Product-Page Relationship

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Product On Pages | `ProductOnPages` / `productOnPages` | 📦 ⬆️ (block) | `.shopsite.preserved.advancedBlocks` + `.shopsite.preserved.unknownElements` | Parser: blockTags set L59. Normalizer: stored in advancedBlocks. Denormalizer: L134-148 — parsed via `extractPageNames()` and re-emitted with `<Name>` children |
| Add To Pages | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Display more information page? | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Cross Sell Products | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Template | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Include In Sitemap | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Sitemap Priority | — (inferred) | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |

**`ProductOnPages` detail:** The denormalizer's `extractPageNames()` function (L156-195) extracts page names from three possible sources: (1) `unknownElements['ProductOnPages']` (set by draft-promoter), (2) `advancedBlocks['ProductOnPages']`, (3) `advancedBlocks['productOnPages']`. It handles `<Name>`, `<PageName>`, and `<PageLink>` child tags, with fallback text extraction. The output is always re-emitted as `<ProductOnPages><Name>...</Name></ProductOnPages>`.

---

## Search & SEO

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Search Keywords | `SearchKeywords` | ✅ 🔄 ⬆️ | `.core.seo.searchKeywords` | Parser: L45. Normalizer: `.core.seo.searchKeywords` from fields. Denormalizer: L118-120 (CDATA) |
| Search Make Page | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Search Dest Type | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Search Dest | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |

---

## Google Merchant Center

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Google Merchant Center | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Brand | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| GTIN (ISBN or UPC) | `GTIN` / `GoogleGTIN` / `Google_GTIN` / `GoogleGTIN` | ✅ 🔄 ⬆️ | `.customFields['GTIN']` / `.customFields['GoogleGTIN']` | Parser: L45. Normalizer: L31-33, L56-62. Denormalizer: L34-46 |
| MPN | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Google Product Category | — | 📦 | `.core.seo.googleProductCategory` (partial) | Normalizer sets based on GTIN; not independently settable |
| Availability | `Availability` | ✅ 🔄 ⬆️ | `.core.availability` | Parser: L45. Normalizer: L35. Denormalizer: L90-92 |
| Age Group | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Gender | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Include Variant Options | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Color Option | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Size Option | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Material Option | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Pattern Option | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Google Condition | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |

**GTIN handling detail:** The normalizer merges three tag variants into `customFields`: `GoogleGTIN`, `Google_GTIN`, `GTIN`. The denormalizer emits `<GTIN>` if any of these exist (or if SKU is 8–14 digits), but emits `<GoogleGTIN>` **only** when `customFields['GoogleGTIN']` is explicitly set. Priority: `GTIN` > `GoogleGTIN` > `Google_GTIN` for the `<GTIN>` tag.

---

## Integration Fields

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| QBImport | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Doba Information | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |
| Product Download Location | — | 📦 | `.shopsite.preserved.unknownElements` | Pass-through only |

---

## Quantity Pricing

All quantity pricing fields are **pass-through only**:

| Field | Status | Product Path |
|-------|--------|--------------|
| Quantity Pricing | 📦 | `.shopsite.preserved.unknownElements` |
| Qty Pricing Background Color | 📦 | `.shopsite.preserved.unknownElements` |
| Qty Pricing Price and Comment Color | 📦 | `.shopsite.preserved.unknownElements` |
| Qty Pricing On Sale Color | 📦 | `.shopsite.preserved.unknownElements` |
| Qty Pricing Comment | 📦 | `.shopsite.preserved.unknownElements` |
| Qty Pricing Number Price Breaks | 📦 | `.shopsite.preserved.unknownElements` |
| Qty Pricing Ranges | 📦 | `.shopsite.preserved.unknownElements` |
| Quantity Pricing Group | 📦 | `.shopsite.preserved.unknownElements` |
| Display Quantity Pricing? | 📦 | `.shopsite.preserved.unknownElements` |

---

## Custom Fields

| Field | XML Tag | Status | Product Path | Source Lines |
|-------|---------|--------|--------------|--------------|
| Product Field 1–25+ | `ProductField1`–`ProductFieldN` | ✅ 🔄 ⬆️ | `.customFields[tag]` | Parser: extracted as unknownElements. Normalizer: L44-47 (any tag starting with `ProductField`). Denormalizer: L123-132 (validates XML tag name, warns if invalid) |

**Important:** The normalizer captures any tag starting with `ProductField` (not limited to 1–25). Invalid XML tag names in `customFields` produce a warning during denormalization and the field is skipped.

---

## Fields NOT Present in knownFieldLabels

The `knownFieldLabels` map in `product-normalizer.ts` (L62-75) only has **19 entries**. All other fields pass through as unknown elements. This means only 19 of 100+ documented fields have explicit handling. The full list of handled labels:

```
SKU, Name, Price, SaleAmount, ProductDescription, Weight, Graphic,
MoreInformationGraphic, QuantityOnHand, Taxable, Availability,
ProductID, ProductGUID, GTIN, GoogleGTIN, Google_GTIN, FileName,
ProductDisabled
```

Everything else — display styles, shipping costs, Google Shopping fields, quantity pricing, options, integration fields — is **preserved but not independently editable**.

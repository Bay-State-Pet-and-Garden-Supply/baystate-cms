# Page XML Structure (Inferred)

> **⚠️ UNCONFIRMED:** ShopSite has not published an official page XML example. The structure below is **inferred** from the product XML pattern, the database field catalog, and the page-DTD naming convention. **Always export a page from the target store's back office** (Utilities → Database → Upload/Download → Pages → Download) to confirm the actual XML format before building production code.

---

## Inferred Root Element

Following the product XML pattern (`ShopSiteProducts` with DOCTYPE `shopsiteproducts.dtd`), the page XML likely uses:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ShopSitePages PUBLIC "-//shopsite.com//ShopSitePages DTD//EN" "http://www.shopsite.com/XML/2.9/shopsitepages.dtd">
<ShopSitePages version="15.0">
  <Pages>
    <Page>
      <!-- page fields here -->
    </Page>
  </Pages>
</ShopSitePages>
```

**Rationale:**
- Product XML uses `ShopSiteProducts` / `Products` / `Product`
- Page XML would naturally use `ShopSitePages` / `Pages` / `Page`
- DTD naming follows the pattern `shopsite{entity}s.dtd`
- Version attribute matches the product XML convention

**This is entirely inferred. A real export may differ in:**
- Root element name
- DTD name and version
- Wrapper element (`Pages` vs something else)
- Individual field XML tags

---

## Inferred Field Tag Mapping

Based on ShopSite's naming conventions in the product XML and the field names in the delimited upload format, most page fields likely map to PascalCase tag names:

| Field Name | Inferred Tag | Likely XML Format | Notes |
|---|---|---|---|
| `Name` | `Name` | `<Name>Page Name</Name>` | Most confident; product XML uses this |
| `File name` | `FileName` | `<FileName>page.html</FileName>` | Consistent with product's `FileName` |
| `Title` | `Title` | `<Title>Page Title</Title>` | Consistent convention |
| `Display Name?` | `DisplayName` | `<DisplayName>checked</DisplayName>` | Checkbox format |
| `Graphic` | `Graphic` | `<Graphic>media/banner.jpg</Graphic>` | Same as product |
| `Display Graphic?` | `DisplayGraphic` | `<DisplayGraphic>checked</DisplayGraphic>` | Checkbox |
| `Text 1` | `Text1` | `<Text1><![CDATA[...]]></Text1>` | Using CDATA for HTML content |
| `Text 2` | `Text2` | `<Text2><![CDATA[...]]></Text2>` | |
| `Text 3` | `Text3` | `<Text3><![CDATA[...]]></Text3>` | |
| `Link Name` | `LinkName` | `<LinkName>Link Text</LinkName>` | |
| `Link Graphic` | `LinkGraphic` | `<LinkGraphic>media/link.jpg</LinkGraphic>` | |
| `Link Text` | `LinkText` | `<LinkText>Description</LinkText>` | |
| `Text Wrap` | `TextWrap` | `<TextWrap>On</TextWrap>` | |
| `Template` | `Template` | `<Template>template-name</Template>` | Case-sensitive value |
| `Item Alignment` | (various) | (likely stored as coded value) | May use internal coded format |
| `Columns` | `Columns` | `<Columns>Two columns</Columns>` | Exact string match |
| `Page Link Columns` | `PageLinkColumns` | `<PageLinkColumns>One column</PageLinkColumns>` | |
| `Display column borders?` | (various) | (likely checkbox format) | |
| `Page Width` | `PageWidth` | `<PageWidth>100% wide</PageWidth>` | Exact string match |
| `Search Products` | `SearchProducts` | `<SearchProducts>checked</SearchProducts>` | |
| `Index` | `Index` | `<Index>checked</Index>` | |
| `Include In Sitemap` | `IncludeInSitemap` | `<IncludeInSitemap>checked</IncludeInSitemap>` | |
| `Sitemap Priority` | `SitemapPriority` | `<SitemapPriority>Google Default</SitemapPriority>` | |
| `Order` | `Order` | `<Order>None</Order>` | |
| `Products Sort Field` | `ProductsSortField` | `<ProductsSortField>Name</ProductsSortField>` | |
| `Pages Sort Field` | `PagesSortField` | `<PagesSortField>Name</PagesSortField>` | |
| `Products First` | `ProductsFirst` | `<ProductsFirst>checked</ProductsFirst>` | |
| `Number Products` | `NumberProducts` | `<NumberProducts>0</NumberProducts>` | |
| `Page Field 1`–`25` | `PageField1`–`PageField25` | `<PageField1>value</PageField1>` | Consistent with product's `ProductField*` |
| `Text Color` | (unknown) | Hex format `#000000` | May use hex or named format |
| `Background Color` | (unknown) | Hex format `#FFFFFF` | |
| `Background Image` | `BackgroundImage` | `<BackgroundImage>none</BackgroundImage>` | |

**Color fields** (`Text Color`, `Background Color`, `Link Color`, etc.) may use non-standard tag names because they accept both hex values and named strings with parenthetical hex codes. Their XML tag names are less predictable.

**Relationship fields** (`Page Links`, `Product Links`, `Links To Page`) could be:
- Pipe-delimited string elements: `<PageLinks>page1|page2</PageLinks>`
- Block elements: `<PageLinks><Name>page1</Name><Name>page2</Name></PageLinks>`
- Or a different format entirely

---

## ProductOnPages Relationship

Products reference pages through the `ProductOnPages` block element in product XML:

```xml
<ProductOnPages>
  <Name>Category Page 1</Name>
  <Name>Category Page 2</Name>
</ProductOnPages>
```

Conversely, pages reference products through `Product Links` in page XML. These are two views of the same relationship:
- **Product side:** `ProductOnPages` — which pages a product appears on
- **Page side:** `Product Links` — which products appear on a page

The CMS currently handles `ProductOnPages` as an advanced block in the product denormalizer. Page-side `Product Links` is not yet implemented.

---

## DTD Consideration

If the page DTD follows the product DTD pattern, it likely:
- Declares `Name` and `FileName` as required elements (no default)
- Declares `Template` with a default equal to the theme default
- Makes most other fields optional
- Declares checkboxes with `checked`/`uncheck` values
- Declares element types consistent with the field type system

**This is speculative.** Only a real page DTD or XML export can confirm.

---

## Recommendation for Build

When building page XML support:

1. **Export a real page XML sample** from the target store's back office:
   - Utilities → Database → Upload/Download → Pages → Download
   - Select XML format, download to browser
2. **Analyze the export** to determine:
   - Root element, DTD, namespace
   - Actual field tag names
   - Which fields use CDATA sections
   - How relationship fields (`Page Links`, `Product Links`) are encoded
   - Any additional fields not in the delimited catalog
3. **Build the parser** following the product-parser.ts pattern:
   - Extract blocks with regex
   - Use fast-xml-parser for structured parsing
   - Core fields go into `fields` map
   - Unknown elements go into `unknownElements`
   - Block elements go into `advancedBlocks`
4. **Build the normalizer** following product-normalizer.ts pattern
5. **Create the Page Zod schema** following product.ts pattern
6. **Build the denormalizer** following product-denormalizer.ts pattern
7. **Add round-trip tests** following shopsite-normalizer.test.ts and shopsite-xml-roundtrip.test.ts patterns

---
name: shopsite-page-fields
description: Documentation-grounded advisor for ShopSite page field modeling, page XML structure, page-parser, page-normalizer, page denormalizer, and the page database upload/download workflow. Use this skill whenever the user mentions ShopSite pages, page XML, page fields, page upload, page templates, page database, page normalizer, page parser, ShopSitePages, ProductOnPages, page layout, page display settings, or creating page support. Triggers on: "page field", "ShopSite page", "page XML", "page upload fields", "page template", "page database", "page normalizer", "page parser", "page table", "ShopSitePages", "shopSitePages.dtd", "ProductOnPages", "page layout", "page display", "page columns".
---

# ShopSite Page Fields

Use this skill to answer questions about **ShopSite page field names, types, XML structure, and building page XML support**. It bridges the documented ShopSite page field catalog with guidance for implementing page XML round-trips in the CMS.

## What this skill is for

This is a **page-field reference and build-guidance skill**. It should:
- answer what documented page fields exist, their types, defaults, and allowed values
- explain the inferred page XML structure (no official example published by ShopSite)
- document current codebase gaps for page support
- guide agents through building page XML parsing, normalization, and denormalization
- explain how `ProductOnPages` relates products to pages

This is **not** a CGI workflow skill. For `db_xml.cgi` parameters, `dbupload.cgi` flows, or `generate.cgi` publishing, use `shopsite-database`.

This is **not** a product-field skill. For product fields, XML tags, normalizer/denormalizer, use `shopsite-product-fields`.

## Read these resources first

For any substantive request, read:
- `references/page-field-catalog.md` — complete list of 60+ documented page fields
- `references/page-xml-structure.md` — inferred page XML structure (labeled as unconfirmed)
- `references/page-codebase-gaps.md` — current page-support gaps + build guidance

The `field-type-system.md` from `shopsite-product-fields` is also relevant — page fields use the same ShopSite field types.

## Core operating rules

1. **Default to evidence.**
   Treat the v15 upload.fields.html page section as authoritative for field **names**, **types**, **defaults**, and **allowed values**. Tag the evidence source clearly.

2. **Label all XML structure as inferred.**
   ShopSite has not published an official page XML example. The root element (`ShopSitePages`), DTD (`shopsitepages.dtd`), and specific tag names are inferred from the product XML pattern. Always recommend confirming against a real page export.

3. **Acknowledge current gaps honestly.**
   The CMS currently has **no page XML parser, no page normalizer, no Page Zod schema, and no page denormalizer**. `ProductOnPages` is handled via advanced blocks as a preserved-XML hack. Be clear about what does not exist yet.

4. **Route product-field questions to shopsite-product-fields.**
   If the user asks about product fields, product XML tags, or the product normalizer/denormalizer, direct them to `shopsite-product-fields`.

5. **Route CGI/workflow questions to shopsite-database.**
   If the user asks about `db_xml.cgi` page downloads, `dbupload.cgi` page uploads, or `generate.cgi`, direct them to `shopsite-database`.

## Response structure

For substantial answers, use this shape:

1. **Direct answer** — the page field name, type, default, and allowed values
2. **XML structure** — how the field likely serializes (inferred, labeled as such)
3. **Codebase status** — what exists and what is missing
4. **Build guidance** — what files to create and how to approach the implementation
5. **Caveats** — inferred structure, preservation requirements, confirmed-vs-inferred distinctions

## Final reminders

- No official page XML example exists. Always recommend exporting a page from the target store.
- The `ProductOnPages` field bridges products and pages; changes to page relationships affect product XML.
- Page field types are identical to product field types — cross-reference `field-type-system.md` from `shopsite-product-fields`.
- When building page support, follow the same pattern as products: parser → normalizer → Zod schema → denormalizer → tests, preserving unknown elements and advanced blocks.

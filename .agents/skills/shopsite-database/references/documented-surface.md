# ShopSite documented surface

Use this file for the facts the skill can state confidently.

## Source map

These are the official ShopSite page titles distilled in the deep research report:
- `Database Automated XML Upload/Download`
- `MIME Encoded XML Upload`
- `Database XML Upload/Download SDK`
- `Database Upload/Download`
- `Database Upload`
- `Database Upload - Match Upload Fields`
- `Database Upload Progress`
- `Databases Upload Results`

When you mention sources, prefer these page titles over vague references.

## Supported automated scope

The grounded automated XML workflow is documented for:
- `products`
- `pages`

Do **not** assume the same automated XML upload flow is documented for orders, associates, or every other ShopSite table.

## Core workflow

### Download flow
Use `db_xml.cgi` to download all or part of a supported database in XML.

### Upload flow
Use `dbupload.cgi` to upload XML or import an XML file that is already present in the HTML output directory.

### MIME upload completion
If the upload uses MIME multipart encoding, ShopSite documents a follow-up step with `dbmake.cgi` using the returned `return_string` exactly as returned.

### Publish flow
After import, use `generate.cgi` or the equivalent publish flow so the storefront reflects the changes.

## Endpoint matrix

| Endpoint | Purpose | Notes |
|---|---|---|
| `db_xml.cgi` | Download XML for `products` or `pages` | Docs discuss standard HTTP POST and also show query-style examples |
| `dbupload.cgi` | Upload/import XML for `products` or `pages` | Supports matching, new-record handling, deferred linking, restart |
| `dbmake.cgi` | Finalize a MIME upload | Use returned `return_string` exactly as returned |
| `generate.cgi` | Publish/regenerate store output | Needed after import so shoppers can see changes |

## Download parameters

| Parameter | Requiredness | Values / shape | Meaning |
|---|---|---|---|
| `clientApp` | Required | `1` | Interface version identifier |
| `dbname` | Required | `products`, `pages` | Target database |
| `download_shopsite_version` | Optional | `1` | Return running ShopSite version |
| `version` | Optional | `8.3` default, `8.2`, `8.1`, `8.0`, `7.1` | XML compatibility version |
| `fields` | Optional | Pipe-delimited list, e.g. `|Name|SKU|Price|` | Limit downloaded fields |
| `fieldmap` | Optional | Existing fieldmap name | Use a predefined mapping |

## Upload parameters

| Parameter | Requiredness | Values / shape | Meaning |
|---|---|---|---|
| `clientApp` | Required | `1` | Interface version identifier |
| `dbname` | Required | `products`, `pages` | Target database |
| `filename` | Optional | Filename string | Import XML already present in the HTML output directory |
| `uniqueName` | Optional | Products: `Name`, `SKU`, `(none)`; Pages: `Name`, `File+Name`, `(none)` | Match uploaded rows to existing records |
| `newRecords` | Optional | `yes` default, `no` | Add unmatched rows or ignore them |
| `defer_linking` | Optional | `no` default, `yes` | Defer linking for staged/batched uploads |
| `restart` | Optional | `1` | Resume an interrupted upload |
| `checkpoint` | Version-variable | Integer, often `500` in one official capture | Checkpoint interval for large uploads |
| `use_optimizer` | Version-variable | `yes`, `no` | Optional optimization for very large uploads |

## Publish parameters

| Parameter | Requiredness | Values / shape | Meaning |
|---|---|---|---|
| `clientApp` | Required | `1` | Interface version identifier |
| `htmlpages` | Optional | `1` | Generate HTML pages |
| `custompages` | Optional | `1` | Generate custom pages |
| `index` | Optional | `1` | Update search index |
| `regen` | Optional | `1` | Force full regenerate |
| `sitemap` | Version-variable | `1` | Generate XML sitemap |

## Matching and risk rules

- `uniqueName=(none)` disables matching and allows duplicates.
- `newRecords=no` ignores unmatched rows instead of creating them.
- Stable identifiers are safer than name-only matching when the user has a true unique key.
- For products, `SKU` is typically the safest documented matching choice when available.

## Large-upload rules

- For very large uploads, recommend splitting work into batches.
- Use `defer_linking=yes` on all but the last batch.
- `checkpoint` and `use_optimizer` should be presented as version-variable, not universal.
- After deferred linking, remind the user to finish linking and publish.

## Recovery and troubleshooting rules

- `restart=1` is the documented automated recovery path for interrupted uploads.
- In back-office/UI flows, ShopSite documents Continue Upload / Discard Upload behavior.
- An unfinished upload can block starting new uploads or downloads until it is completed or discarded.
- If the user says changes are not visible, remind them to publish/regenerate the store.

## MIME upload facts

- The crawlable MIME example is **product-oriented**.
- It shows multipart form fields such as `clientApp`, `dbname`, `uniqueName`, `newRecords`, `use_optimizer`, and `defer_linking`.
- It includes a product XML example with `ShopSiteProducts`, a `Response` block, `Products`, `Product`, and `Name`.
- The docs do **not** clearly say whether the `Response` block is required for uploads.
- The docs do **not** publish a page-side XML example in the crawlable material.

## Honest boundaries

The skill can speak confidently about:
- endpoint names
- documented parameters
- documented workflow order
- matching / duplicate / batching / restart behavior
- the need to finalize MIME uploads and publish imports

The skill must label these as unspecified or incomplete:
- canonical auth mechanism for automated CGI calls
- full product XML schema
- full page XML schema
- which XML child elements are required vs optional beyond the limited example
- a canonical machine-readable ShopSite error-code catalog

# MIME Encoded XML Upload Format

This reference documents the `multipart/form-data` structure used when uploading XML product/page data to `dbupload.cgi` via MIME encoding.

> **Source:** ShopSite's "MIME Encoded XML Upload" documentation page.
> **Note:** Page XML MIME structure is not explicitly documented; treat the page section as a labeled placeholder.

---

## Boundary Format

ShopSite MIME uploads use a custom boundary prefix:

```
------ShopSiteUpload_$
```

The full boundary string is `------ShopSiteUpload_$` followed by the boundary marker for each part.

---

## Form Data Part Order

The multipart body must contain parts in this exact order:

### Part 1: `clientApp`

```
------ShopSiteUpload_$
Content-Disposition: form-data; name="clientApp"

1
```

### Part 2: `dbname`

```
------ShopSiteUpload_$
Content-Disposition: form-data; name="dbname"

products
```
(Pages use `pages` as the value.)

### Part 3: `uniqueName`

```
------ShopSiteUpload_$
Content-Disposition: form-data; name="uniqueName"

SKU
```
| Database | Valid Values |
|----------|-------------|
| Products | `Name`, `SKU`, `(none)` |
| Pages | `Name`, `File+Name`, `(none)` |

### Part 4: `batchsize`

```
------ShopSiteUpload_$
Content-Disposition: form-data; name="batchsize"

500
```

The batch size controls how many records are processed per batch. For large databases, typical values are 500–1000.

### Part 5: `newRecords`

```
------ShopSiteUpload_$
Content-Disposition: form-data; name="newRecords"

yes
```
- `yes` (default) — unmatched records are added as new
- `no` — unmatched records are ignored

### Part 6: `defer_linking`

```
------ShopSiteUpload_$
Content-Disposition: form-data; name="defer_linking"

no
```
- `no` (default) — linking happens as part of the upload
- `yes` — defer linking until all batches are uploaded (for multi-file batches)

### Part 7: `use_optimizer`

```
------ShopSiteUpload_$
Content-Disposition: form-data; name="use_optimizer"

1
```

**Note:** This parameter is version-variable and may not be supported by all ShopSite versions. Its exact behavior is not fully documented in the crawlable help pages.

### Part 8: File Part (`Desktop`)

```
------ShopSiteUpload_$
Content-Disposition: form-data; name="Desktop"; filename="products.xml"
Content-Type: text/xml

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">
<ShopSiteProducts version="15.0">
<Products>
  <!-- product XML here -->
</Products>
</ShopSiteProducts>
```

Key details:
- Part name must be `Desktop`
- `Content-Type` should be `text/xml`
- `filename` can be any valid name (e.g., `products.xml`)
- The XML declaration and DOCTYPE are part of the file content
- For pages, use `ShopSitePages` / `Pages` (inferred; confirm from a real export)

### Part 9: `Response` (Requiredness Unspecified)

```
------ShopSiteUpload_$
Content-Disposition: form-data; name="Response"

Y
```

> **⚠️ Unspecified:** The documentation does not clarify whether the `Response` part is required, what values it accepts, or what it controls. Including it with value `Y` is common practice.

---

## Closing Boundary

```
------ShopSiteUpload_$--
```

---

## Complete Worked Example (Products)

```
------ShopSiteUpload_$
Content-Disposition: form-data; name="clientApp"

1
------ShopSiteUpload_$
Content-Disposition: form-data; name="dbname"

products
------ShopSiteUpload_$
Content-Disposition: form-data; name="uniqueName"

SKU
------ShopSiteUpload_$
Content-Disposition: form-data; name="batchsize"

500
------ShopSiteUpload_$
Content-Disposition: form-data; name="newRecords"

yes
------ShopSiteUpload_$
Content-Disposition: form-data; name="defer_linking"

no
------ShopSiteUpload_$
Content-Disposition: form-data; name="use_optimizer"

1
------ShopSiteUpload_$
Content-Disposition: form-data; name="Desktop"; filename="products.xml"
Content-Type: text/xml

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">
<ShopSiteProducts version="15.0">
<Products>
  <Product>
    <SKU>EXAMPLE-1</SKU>
    <Name>Example Product</Name>
    <Price>19.99</Price>
  </Product>
</Products>
</ShopSiteProducts>
------ShopSiteUpload_$
Content-Disposition: form-data; name="Response"

Y
------ShopSiteUpload_$--
```

---

## Page Upload Placeholder

For page uploads, follow the same structure but:
- `dbname: pages`
- `uniqueName: Name` or `File+Name`
- File uses `ShopSitePages` / `Pages` (inferred; confirm from a real export)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ShopSitePages PUBLIC "-//shopsite.com//ShopSitePages DTD//EN" "http://www.shopsite.com/XML/2.9/shopsitepages.dtd">
<ShopSitePages version="15.0">
<Pages>
  <Page>
    <Name>Example Page</Name>
    <FileName>example.html</FileName>
  </Page>
</Pages>
</ShopSitePages>
```

> **⚠️ Page XML structure is inferred from the product XML pattern. Replace DOCTYPE, root element, and wrapper/child names with values confirmed from a real page export.**

---

## `dbmake.cgi` Follow-Up

After a MIME upload completes, ShopSite returns a `return_string`. This string must be passed to `dbmake.cgi` to finalize the import:

```
http://store.example.com/cgi-path/dbmake.cgi?_return_string_
```

- Replace `_return_string_` with the exact value returned by `dbupload.cgi`
- The URL should point to the same ShopSite back-office CGI directory
- This step is **required** — the data is not committed until `dbmake.cgi` processes the return string

**Important:** Pass the return string **exactly as returned**, without URL-encoding or modifying it.

---

## Post-Upload Reminders

1. After a MIME upload + dbmake.cgi callback, the data is imported but **not yet visible to shoppers**.
2. Run `generate.cgi` (or use the back-office Publish function) to regenerate the store pages.
3. For batch uploads with `defer_linking=yes` on all but the last file, use the **Update Links** button in the back office (or equivalent linking step) after all files are uploaded.

# Scout Handoff: ProductDescription → Name / MoreInformationText → Description remap

## 1. Denormalizer — current emission (`src/shopsite/product-denormalizer.ts`)

`denormalizeProduct(product: Product): DenormalizedResult` (line 32) builds the `<Product>` XML line-by-line.

**ProductDescription** (lines 76–79):
```ts
if (product.core.description) {
  lines.push(`  <ProductDescription><![CDATA[${escapeCdata(product.core.description)}]]></ProductDescription>`);
}
```
- Source is `product.core.description`; CDATA-encoded; omitted entirely when falsy (policy `omit-empty`, see built-in-output-policy.ts:63 — `element: 'ProductDescription', encoding: 'cdata', omission: 'omit-empty'`).

**MoreInformationText** (lines 81–87):
```ts
const moreInfoText = product.customFields['MoreInformationText']
  || (product.shopsite.preserved.unknownElements['MoreInformationText'] != null
      ? String(...unknownElements['MoreInformationText'])
      : product.core.description);
if (moreInfoText) { lines.push(`  <MoreInformationText><![CDATA[...]]></MoreInformationText>`); }
```
- Fallback chain: customFields override → preserved unknownElements → **synced from `core.description`**. Policy entry at built-in-output-policy.ts:69 (cdata, omit-empty).

**unknownElements handling:** the generic preserved-unknown-elements loop (lines ~236–250) re-emits any preserved element not explicitly handled, but note it does NOT skip `ProductDescription`/`MoreInformationText`/`MoreInformationGraphic` by tag-skip like it does for GTIN — however those keys never land in unknownElements from normal import paths (normalizer routes them to core/custom fields), and MoreInformationGraphic has an explicit guard at lines ~150–160.

**Change impact inside this file:** both emission sites (lines ~76–87) must change: `<ProductDescription>` ← `product.core.name`; `<MoreInformationText>` ← customFields/preserved/description chain (keep existing fallback). Consider whether preserved-unknown loop could double-emit.

## 2. Where `product.core.description` comes from

- **Zod schema:** `src/shared/schemas/product.ts:27` — `description: z.string().nullable().default(null)` in the core object.
- **Normalizer:** `src/shopsite/product-normalizer.ts:22` — `const description = fields['ProductDescription'] ?? fields['description'] ?? null;` written to `core.description` at line 154. Field registry maps `ProductDescription` → core at line 67. ⚠️ **Round-trip asymmetry risk:** after the change, exports will contain Name in ProductDescription… wait, no — ProductDescription will hold the NAME, so re-import would set `core.description` = product name unless the normalizer is also updated to ignore/repurpose `ProductDescription`. The normalizer reads description only from `ProductDescription`/`description` fields; it does NOT read `MoreInformationText`. If we stop putting description text into `<ProductDescription>`, re-imported products lose their descriptive text entirely (it lands in `MoreInformationText`, which nothing currently reads back into core).
- **Writers of core.description:**
  - `src/onboarding/draft-promoter.ts:759–788` — draft description preference: curated Curation description → verified extraction description (official-page or verified v2 distributor); null otherwise.
  - `src/onboarding/product-curator.ts` (~496, 829, 874–911) — curation synthesis of description/search-keywords.
  - `src/product-intelligence/onboarding-import.ts` — imports Agent Lab results into onboarding items (feeds extraction_data_json, which flows into the same draft-promoter preference chain; no direct Product write of core.description found there).
  - `src/shopsite/product-parser.ts:47` lists `ProductDescription` among recognized fields during ShopSite export parsing.

## 3. Call sites / upload flow

- `src/shopsite/xml-builder.ts:9–40` — `buildProductsXml(products)` wraps `denormalizeProduct` per product (line 36); single choke point for XML generation.
- `src/server/routes/sync-routes.ts`:
  - Line 262: `const xml = buildProductsXml(products)` then line 281 `directUpload(xml, config)`.
  - `directUpload` (lines 100–125): `buildUploadMultipart(xml, { newRecords:'yes', uniqueName:'SKU' })` → POST to `dbupload.cgi`.
  - `/sync/push-publish` route (line 367): approved change-set push via dbupload → dbmake → generate.
- `src/shopsite/multipart-upload.ts` — multipart envelope builder + `escapeCdata`; no field mapping logic (safe), but exports `isValidXmlTagName`/`escapeCdata` used by denormalizer.
- `src/shopsite/export-package.ts:37` — also calls `buildProductsXml` (export ZIP path — affected too).
- `src/client/api.ts:335` calls `/sync/push-publish`.

So all ShopSite-bound product XML flows through the one denormalizer change.

## 4. Tests asserting current mapping

- `src/tests/unit/shopsite-normalizer.test.ts:181–190` — `'should include MoreInformationText when description is present'`: feeds `<ProductDescription><![CDATA[Test description here]]>` and asserts BOTH `<ProductDescription>` and `<MoreInformationText>` contain "Test description here". **Must be rewritten.**
- `src/tests/unit/built-in-output-policy.test.ts`:
  - :87 — field list includes 'ProductDescription'; :111 — asserts encoding 'cdata' for ProductDescription; :152 — asserts omission when empty (`not.toContain('<ProductDescription>')`). Policy itself likely unchanged, but the :152-style behavior test depends on which value drives emission.
- `src/tests/unit/shopsite-xml-roundtrip.test.ts:256–262` — `'should preserve explicit custom/preserved FileName and MoreInformationText'`: sets `customFields['MoreInformationText']` and asserts it wins over description sync. Still valid post-change, but add cases for the new name→ProductDescription mapping and description-only→MoreInformationText fallback.
- No integration test hits dbupload with real field assertions beyond these units (sync-routes tests not found asserting ProductDescription).

## 5. Round-trip concerns

1. **Re-import loses descriptions:** normalizer (product-normalizer.ts:22, 154) reads description ONLY from `ProductDescription`. After the change, uploaded products have description in `<MoreInformationText>`; a later db_xml.cgi export parsed by product-parser/normalizer would leave `core.description` null (or worse, set it to the NAME if `ProductDescription` still holds name). Normalizer must either read description from `MoreInformationText` as well (e.g., `fields['MoreInformationText'] ?? fields['description']`) or ignore `ProductDescription`.
2. **Name-as-description echo:** if `ProductDescription` = name and normalizer keeps reading it into `core.description`, every round trip pollutes `core.description` with the product name — check drift detection (`src/shopsite/drift.ts`) for false diffs.
3. **Existing imported rows** already have real descriptions in ShopSite's ProductDescription; first re-upload under new rules would overwrite them with the Name in ShopSite's UI — confirm that's intended (data migration/backfill question for supervisor).
4. Frontend display: no client component renders ProductDescription directly; UI shows `core.description` from DB, unaffected.

## 6. Docs / policy

- `docs/adr/0011-shopsite-built-in-output-policy.md` — freezes DTD-level emission rules (omission/default/encoding/cardinality) into immutable `SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1` (`src/shopsite/built-in-output-policy.ts:63,69`). The *value source* per element is not frozen by the policy — remapping which model value feeds each element is compatible with ADR-0011, but the denormalizer comments and any byte-compat claims should be checked; policy entries themselves need no change (both elements stay cdata/omit-empty).
- `docs/governance-17-alignment.md:36` — item J documents the built-in output policy; notes draft-promoter behaviors are "draft input behavior, not XML output policy".
- `CONTEXT.md` mentions description only in pipeline-synthesis context (lines 42, 95) — no field-mapping policy statements.
- No ADR covers the semantic mapping of description↔ProductDescription; consider recording one since this changes what merchants see in ShopSite.

## Start Here
Open `src/shopsite/product-denormalizer.ts` lines 70–90, then update `src/shopsite/product-normalizer.ts:22` for symmetric re-import, then fix the three test files listed above.

## Residual risks
- Existing live ShopSite products get their ProductDescription overwritten with Name on next push (destructive for legacy data).
- Drift detector may flag name/description divergence vs exported XML until normalizer is made symmetric.

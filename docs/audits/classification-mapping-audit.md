# Classification Mapping Coverage Audit

Generated: `2026-08-24T17:34:12.797Z`
Workspace: `5d0e7adf-9e7f-4e23-a59e-267cfd775d0b`
DB: `storage/catalog/.shopsite-cms/app.db`

One-shot read-only audit (plan section B.P2.2). Live field-registry presence is the ONLY basis for declaring a slot free (risk R7); PF31 stays reserved-until-live-verified regardless of absence.

## Summary

- Release-mapped slots: 19
- Live-occupied but release-unmapped slots: 13
- Genuinely FREE slots (absent from BOTH release mappings AND live registry): 0 — none

**Conclusion: no map-on-demand capacity exists today.** Every ProductField slot is either mapped in the release or occupied by live store data. The hybrid disposition therefore resolves fully to RETIRE-BY-DEFAULT for the audited attributes until the store frees or adds slots.

## Occupied slots (mapped in bay-state-v4)

| Slot | Attribute | In live registry | Live label / kind |
|---|---|---|---|
| ProductField8 | nutrition | yes | Ingredients & Nutritional Info / custom |
| ProductField13 | canonical-category-id | yes | ProductField13 / custom |
| ProductField14 | canonical-breadcrumb | yes | ProductField14 / custom |
| ProductField16 | brand | yes | Facet - Brand / custom |
| ProductField17 | species | yes | Facet - Pet Type / custom |
| ProductField18 | life-stage | yes | Facet - Lifestage / custom |
| ProductField19 | breed-size | yes | Facet - Pet Size / custom |
| ProductField20 | dietary-features | yes | Facet - Special Diet / custom |
| ProductField21 | health-benefits | yes | Facet - Health Feature / custom |
| ProductField22 | food-form | yes | Facet - Food Form / custom |
| ProductField23 | flavor | yes | Facet - Flavor / custom |
| ProductField24 | category | yes | Facet - Category / custom |
| ProductField25 | product-type | yes | Facet - Product Type / custom |
| ProductField26 | product-feature | yes | Facet - Product Feature / custom |
| ProductField27 | size | yes | Facet - Size / custom |
| ProductField28 | material | yes | Facet - Material / custom |
| ProductField29 | color | yes | Facet - Color / custom |
| ProductField30 | packaging-type | yes | Facet - Packaging Type / custom |
| ProductField32 | product-cross-sell | yes | Product Cross Sell / custom |

## Free slots (candidate pool for map-on-demand)

| Slot | Live registry status | Verification verdict | Notes |
|---|---|---|---|
| ProductField1 | present (Import Status / Flags) | occupied_live_only | present in live registry with label "Import Status / Flags" (custom) — NOT free |
| ProductField2 | present (Status Notes / Flags) | occupied_live_only | present in live registry with label "Status Notes / Flags" (custom) — NOT free |
| ProductField3 | present (Vendor / Legacy Code) | occupied_live_only | present in live registry with label "Vendor / Legacy Code" (custom) — NOT free |
| ProductField4 | present (Size Abbreviation (S/M/L)) | occupied_live_only | present in live registry with label "Size Abbreviation (S/M/L)" (custom) — NOT free |
| ProductField5 | present (Pricing Display Promo Text) | occupied_live_only | present in live registry with label "Pricing Display Promo Text" (custom) — NOT free |
| ProductField6 | present (Special Promo Flag) | occupied_live_only | present in live registry with label "Special Promo Flag" (custom) — NOT free |
| ProductField7 | present (Packaging Size / Weight) | occupied_live_only | present in live registry with label "Packaging Size / Weight" (custom) — NOT free |
| ProductField9 | present (Feeding Instructions) | occupied_live_only | present in live registry with label "Feeding Instructions" (custom) — NOT free |
| ProductField10 | present (Storage & Usage Instructions) | occupied_live_only | present in live registry with label "Storage & Usage Instructions" (custom) — NOT free |
| ProductField11 | present (Featured Flag) | occupied_live_only | present in live registry with label "Featured Flag" (custom) — NOT free |
| ProductField12 | present (Stock Availability Status) | occupied_live_only | present in live registry with label "Stock Availability Status" (custom) — NOT free |
| ProductField15 | present (Gift Wrap Eligible Flag) | occupied_live_only | present in live registry with label "Gift Wrap Eligible Flag" (custom) — NOT free |
| ProductField31 | present (Product Category) | occupied_live_only | present in live registry with label "Product Category" (custom) — NOT free |

## Demand signal — retired (`not_exported`, profile-less) attributes

Scanned `140` item(s) with persisted curation payloads (`0` unparseable row(s) skipped).

| Attribute | Items with curated proposal | Items with accepted value |
|---|---|---|
| btu-rating | 0 | 0 |
| fuel-type | 0 | 0 |
| hose-length | 0 | 0 |
| joule-rating | 0 | 0 |
| npk-ratio | 0 | 0 |
| protein-pct | 0 | 0 |
| safety-toe-type | 0 | 0 |
| towing-capacity-lbs | 0 | 0 |

Disposition rule (plan section D): HYBRID — these attributes stay retired by default; map-on-demand requires demonstrated demand above PLUS a live-verified free slot PLUS a new authored release granting profile membership in the same artifact.

# Taxonomy Snapshot — Bay State v2 (Effective Workspace Bundle)

**Freeze date:** 2026-08-16
**Freeze intent:** P0 freeze — effective workspace taxonomy before the immutable release migration (ChatGPT curation audit plan, "Freeze the moving target" phase).
**Snapshot id:** `bay-state-v2-effective-2026-08-16`
**Source path:** `storage/catalog/store/classification/` (workspace bundle)
**Authority:** This snapshot captures the **RUNTIME truth** — the bundle that `loadClassificationConfig()` / config-store reads when the classification pipeline runs. It is NOT the seed (`src/classification/config-seeds/bay-state-pet-garden-v1.ts`), which is only a regeneration source and was NOT used to produce this snapshot.

---

## File hashes (SHA-256)

| File | SHA-256 |
|---|---|
| attribute-profiles.json | `dd962d0aa075aa476b7b01f4e98698a0d2631b788e2a99fb30900700fc1b283c` |
| attributes.json | `fbfa40390572795749ad80c19288a69def3c7c778cb99a836fa51d830952eebe` |
| brands.json | `f2616741d0c96ec095d3d8060a25dd51ccc3acc09bd8f893f574af0f79470a70` |
| catalog-evidence.json | `e35963eecdaab08e2510243745a96c43b716cb0879d168eced3979bcd1c3d676` |
| curation-targets.json | `6b1326b9a7c219181d048dffb00184e3139d4a6a6cd020a5e8820dae07292ce1` |
| data-sharing.json | `bc05355c6377f873713ca13293be8bd7fca7729b591fae6f06ad0f0d213ae6b5` |
| guidance.json | `1427bba26f1aa4ba683a9b1b706d72204a60958be2e9d1ce3c9e78b7cc5379f3` |
| manifest.json | `a27e2e348c183020d66e9511963812d7516eec321c8232f7fcf53e018486fef7` |
| mappings.json | `483d2eca184e62399e28ecdcb8ce04388edbac9452f70cd58e41a289e80bfa2e` |
| model-policies.json | `0cfa6d830bb81913422a5fcf5657f9bc241defd491d19b2ed82b50cc4599a85d` |
| product-types.json | `390a53b9d40d0923df4008a444cc17872fdd9d953fd08f430da6b4809645adb7` |

Note: the hashes of `attribute-profiles.json`, `attributes.json`, `brands.json`, `curation-targets.json`, `data-sharing.json`, `guidance.json`, `mappings.json`, `model-policies.json`, and `product-types.json` match the `fileVersions` recorded in the source `manifest.json`, confirming the copies are byte-identical to the live bundle.

---

## Key facts discovered in the audit

- **73 product types / 25 attributes / 72 attribute profiles.** `bee-supplies` has **NO** attribute profile (the only type without one).
- **Curation targets:** 11 targets are DISABLED in this bundle that the seed enables:
  - `species-target` (Animal Species, ProductField17)
  - `life-stage-target` (Life Stage, ProductField18)
  - `breed-size-target` (Breed Size, ProductField19)
  - `food-form-target` (Food Form, ProductField22)
  - `flavor-target` (Flavor, ProductField23)
  - `packaging-type-target` (Packaging Type, ProductField30)
  - `material-target` (Material, ProductField28)
  - `color-target` (Color, ProductField29)
  - `size-target` (Size, ProductField27)
  - `product-feature-target` (Product Feature, ProductField26)
  - `product-cross-sell-target` (Product Cross Sell, ProductField32)
- **2 workspace-only targets** exist here that are NOT in the seed: `target-productfield21` ("Facet - Health Feature", ProductField21, disabled) and `target-productfield20` ("Facet - Special Diet", ProductField20, disabled).
- **guidance.json has 0 entries.** The preset at `src/classification/presets/preset-pet-and-garden.ts` (species-safety, page-assignment rules, domain keywords) is NOT wired into this bundle.
- **8 attributes have no ShopSite field mapping:** `npk-ratio`, `protein-pct`, `joule-rating`, `btu-rating`, `fuel-type`, `towing-capacity-lbs`, `safety-toe-type`, `hose-length`.
- **Manifest:** `lifecycle: active`, `activeRevision: bay-state-v2`, `schemaVersion: 2`, `compatibilityVersion: 2`, `hasUnresolvedSafetyFindings: false`, `bundleHash: 127d94cce1bad9bf80202480e2772b4236adddaa0b3944afee8baf4108680cab`, `catalogEvidenceHash: e35963eecdaab08e2510243745a96c43b716cb0879d168eced3979bcd1c3d676`, `sourceCatalogCommit: 4e7340ea7085fec5497e3e3857c02410174423d8`.
- **Catalog evidence:** 153 ShopSite pages, 33 fields, 0 parse failures.

---

## Known drift hazard (why this snapshot exists)

Before this P0 freeze, clicking **"Sync Seed Taxonomy"** in Settings called `POST /api/classification/sync-seed`, which regenerated the workspace bundle from `src/classification/config-seeds/bay-state-pet-garden-v1.ts` and **overwrote** the live files — silently reverting the 11 disabled curation targets and deleting the 2 workspace-only Facet targets above. This snapshot records the bundle as it actually ran, so the migration to the immutable release can preserve the live (operator-edited) behavior rather than the seed's.

---

## Restore instructions

If the live bundle is ever lost or corrupted before the immutable-release migration (P1+), restore it with:

```bash
cp src/classification/snapshots/bay-state-v2-effective-2026-08-16/*.json storage/catalog/store/classification/
```

Then verify hashes match the table above.

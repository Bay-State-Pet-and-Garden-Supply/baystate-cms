# Curation Field Map — curation_data_json vs Promotion Truth

> story: e04s02 — explicit mapping of what curation SETS (preview) vs what `draft-promoter` SETS (authoritative CMS truth). Includes stale/unverified-name-only skip paths and freeze discipline.

## 1. Authority model

| Layer | Writes | Authority | Source of truth |
|-------|--------|-----------|-----------------|
| **Curation** (`src/onboarding/product-curator.ts` + 7 stages in `src/classification/stages/*`) | `onboarding_items.curation_data_json` (field `CurationData`) | **Preview only** — proposes, never publishes | `RuntimeClassificationSnapshot` (`src/classification/runtime-snapshot.ts`) frozen at run creation (`snapshotHash`); stage outputs in `classification_stage_results` / `classification_proposals` / `classification_evidence` |
| **Promotion** (`src/onboarding/draft-promoter.ts` + `src/db/repositories/page-repo.ts` + `src/db/repositories/classification-config-repo.ts`) | `products/*.json` (`Product`), `product_pages` rows, ShopSite `ProductOnPages` XML (`preserved.unknownElements`) | **Authoritative** — creates Git-committed CMS draft + `change_set_items` + `product_pages` | Verified `pageId` in active Page import (`listVerifiedPageOptions`), `getCachedAttributeMappings` (staleness-gated), `deterministicStringify`/`hashJson` |

Curation never writes `products/` or `product_pages`; promotion never invents a proposal — it only applies **accepted** proposals whose identity is verified.

## 2. What curation SETS in `curation_data_json` (`CurationData` Zod schema + `product-curator.ts:650-900`)

| Field | Source stage / helper | Edge cases |
|-------|----------------------|------------|
| `curatedTitle` + `titleSource` (`web` \| `ocr` \| `llm` \| `llm_cohort` \| `cohort_fallback`) | `name_consolidation` stage → `consolidateProductTitle` → `name-consolidation.ts`; cohort mode `coordinateCohortItemsOnce` / `classification_cohort_outputs` pre-computes `preComputedTitle` (story e04s01) | `rawRegisterName` must be threaded so variant tokens (LG/SM/color) survive LLM synthesis; sibling group `size>=2` uses deterministic `formatDeterministicTitle` fallback — never silently drops variant |
| `packagingOcrTitle` | `evidence_extraction` → `packagingOcrDataToEvidence` (VLM OCR) + `name_consolidation` metadata passthrough | Null when no VLM configured or OCR abstains; display-only until PI-6 verification |
| `curatedWeight` | `convertToLbs` over extraction weight + curation weight | Stays `null` when no parsable weight; promotion prefers this but promotion gate validates `weight` is optional, not mandatory |
| `curatedDescription` + `curatedDescriptionSourceAttemptIds` | `product-curator.ts:780-810` — deterministic v2-only: `ext.description` only when `distributor_record_v2` verified (`distributorRecordProvenance.extractionMethod === 'distributor_record_v2'`); otherwise `null` | Amendment B: v1 / unverified distributor copy never reaches `curation_data_json.curatedDescription`; promotion double-checks `verifiedV2Distributor` before `draftDescription` |
| `suggestedPages` (top-5 `pageName` strings) | `category_page_proposals` stage filtered by `getPageIdentityId` + `verifiedPageIdSet` + `validatePageAssignmentsBySpecies` + `product-curator.ts` post-filter | Empty when Primary Product Type is not reviewed (`"No reviewed Primary Product Type"` abstention) or when no verified Page catalog exists — review now surfaces gating reason (e05s01), not silent empty |
| `suggestedProductType` (`targetId` single) | `primary_product_type_proposal` via `processProductTypeTarget` → `selectPrimaryProductTypeProposal` | `reviewable_abstention` when no verifiable type; disabled target → `succeeded` empty (no noise) |
| `searchKeywords` (≤250 chars) | `synthesizeSearchKeywords` (species / lifeStage / form / attributes) guarded by `assertCohortSynthesisOrdering` (PR8 DECISION-C) | Runs only after all 7 required stages completed; fails closed if any required stage produced no terminal output |
| `classificationRunId` + `classificationConfigSnapshot` | `createRun` / `ensureMemberRun` bound to `snapshotHash`; persisted via `classification_runs` | `snapshotHash` is canonical (`hashCanonicalJson`) over every stage-visible field except `createdAt`/`snapshotHash` itself — mutation fails closed on recomputed hash |
| `classificationEvidence` / `classificationProposals` / `classificationDecisions` / `classificationHistory` | `pipeline-runner.ts:runPipeline` → `persistEvidence` / `persistProposals` / `linkProposalEvidence` + `validateProposalSafety` choke-point + `reviewable_abstention` auto-emit | Evidence ↔ proposal linkage validated transactionally (union/role disjoint, run/SKU match, modelCallIds success check); `reviewable_abstention` is the abstention signal — `succeeded empty` only for truly disabled targets |
| `effectiveProductType` (cohort mode only, PR5) | `getEffectiveCurationProductType` (reviewed → execution fallback) in `attribute-applicability` stage | Determines attribute profile gating when reviewed type differs from execution prediction |

Preview field `productDraftProjection` (`projection { fieldAssignments, pageAssignments, title }`) from `draft-projection.ts` is **also preview-only** — promotion ignores it and re-derives from accepted proposals + live verified catalog.

## 3. What `draft-promoter` SETS (authoritative CMS write)

### 3.1 `Product` JSON (`products/<SKU>.json`)

| CMS field | Value | Skip condition |
|-----------|-------|----------------|
| `core.name` | `curationData.curatedTitle` (fell back: `extraction.title` / `item.name`) | Never null — mandatory gate `Missing mandatory fields: Name` fails closed |
| `core.description` | `curationData.curatedDescription` \|\| (`verifiedV2Distributor ? extraction.description : null`) | v1 / unverified distributor description stays `null` (promotion enforces — Amendment B) |
| `core.price` / `cleanPrice` | `item.price` (spreadsheet) \|\| (`isDistributorSource ? null : extraction.price`) | Distributor extraction price ignored even if present (tampered payload already rejected by distributor deep-compare gate) |
| `core.weight` | `curationData.curatedWeight` \|\| `extraction.weight` | Optional |
| `core.media.primary` + `additional` | `downloadAndProcessImages` over official `extractionData.primaryImage/additionalImages` **or** distributor `distributorImageApprovals[].imageUrl` (Amendment B) | `file://` / relative passthrough only for test fixtures; remote non-image content-type skipped; path-traversal-escaped paths skipped |
| `core.seo.searchKeywords` | `curationData.searchKeywords` \|\| `extraction.searchKeywords` | Optional |
| `customFields[*]` | **Only from accepted `field_assignment` proposals** whose `getEffectiveProposalTargetId` maps to a `getCachedAttributeMappings` entry with `!isStale && catalogField` | Stale / missing / empty-catalogField mappings are collected in `skippedFieldRefs` (e04s02) and emitted in `recordHistoryEvent.appliedFields` vs `skippedFields`; never promote |
| `customFields.ProductField1` | `newMMDDYY` for new SKUs | Only when `!existingApproved` |
| `customFields.ProductField16` (`Brand`) | `resolveBrand` over `item.brandHint` / title via cached `getCachedBrands` | `brandHint` fallback; mandatory gate fails without `Brand` |
| `shopsite.preserved.unknownElements.ProductOnPages` | `ProductOnPages` XML from **verified** `category_page` proposals (`classificationPageProposals` with `verifiedPageIdSet` match) | Unverified / name-only assignments → `skippedPageRefs` (visible, non-blocking preview of shortage); `classificationPageProposals.length === 0` after verified filter → **mandatory Pages gate fails closed** (`No verified page assignments`) |
| `metadata` / `shopsite.preserved` / `product_pages` | `deterministicStringify` + `hashJson`; `clearProductPages` + `assignProductToPageId` per verified `pageId` | Stale / unverified IDs never write |

### 3.2 `product_pages` + ShopSite `ProductOnPages`

- **Verified Page catalog is the display-name authority:** `listVerifiedPageOptions(workspaceId)` → `verifiedPageIds` Set + `verifiedNameById` Map. A verified `pageId` always resolves to `verifiedNameById.get(pageId)` — proposal `pageName` variant and raw `pageId` string are never serialized.
- **Name-only rows are review context only:** `getProductPageAssignments(item.upc)` rows whose `pageId` is null or not in `verifiedPageIds` are pushed to `skippedPageRefs` with `proposalId: db:<pageName>`; they never satisfy the mandatory gate and never reach `ProductOnPages` or `product_pages`.
- **Cross-species already filtered in curation:** `validatePageAssignmentsBySpecies` dropped incompatible page names before promotion; promotion trusts the verified filter but the review UI now surfaces `species_incompatible` provenance (e05s01).

## 4. Stale / unverified-name-only skip paths (fail-closed visibility, not silent)

| Skip path | Where skipped | How surfaced | Gate effect |
|-----------|---------------|--------------|-------------|
| **Stale attribute mapping** (`attribute_mappings.is_stale = 1`, hash mismatch vs `configSnapshotRef.hash`) | `draft-promoter.ts: getCachedAttributeMappings → mapping.isStale` check; proposal maps to `skippedFieldRefs` (`{ proposalId, attributeId, reason: 'stale_mapping' | 'missing_mapping' | 'empty_catalog_field' }`) | `recordHistoryEvent` payload `appliedFields` vs `skippedFields`; warn log `[DraftPromoter] Skipping stale field assignment`; never writes `customFields` | **Non-blocking** for the item — field is dropped, sibling fields still promote; does not fail the item |
| **Missing attribute mapping** (no `attribute_mappings` row for `targetId`) | Same field-assignment loop → `skippedFieldRefs reason: 'missing_mapping'` | Same history payload | Non-blocking |
| **Empty catalogField** | Same loop → `reason: 'empty_catalog_field'` | Same | Non-blocking |
| **Unverified category page** (`pageId` null or `!verifiedPageIds.has(pageId)`) | `category_page` proposal loop → `skippedPageRefs.push({ proposalId, pageName })` | `recordHistoryEvent.skippedPages`; gate failure message when gate is empty (`No verified page assignments exist …`) | **Blocking when mandatory gate empty:** `classificationPageProposals.length === 0` after verified filter → item `completePromotionStage(false, errMsg)` and `failures.push` — SKU does not promote |
| **Missing verifiedPageName** (verified `pageId` but no canonical name) | Same loop → pushed as `skippedPageRefs` with `[page <id> missing display name]` | History + gate failure | Blocking when it leaves gate empty |
| **VerifiedPageCatalog absent** (`state === 'no_verified_page_catalog'`) | `verifiedPageIds` is empty → every category-page proposal → `skippedPageRefs` | Gate fails closed (`No accepted product page proposals or manual page assignments exist`) | Blocking |
| **Distributor imagery pending / V1 copy** (`distributorRecordProvenance.extractionMethod !== 'distributor_record_v2'` or non-approved image URL) | `draft-promoter.ts` image phase + `materializeDistributorRecordExtraction` boundary | Fire-and-forget `verifyDistributorImageryForItem` (non-blocking verify, logged); non-approved candidate URLs never reach `downloadAndProcessImages` (Milestone E — zero-commerce-fetches for raw evidence) | Images stay display-only until PI-6 verification; v1 descriptions stay `null` |

All staleness / unverified checks are **deterministic and fail-closed**: a tampered `curation_data_json` (mutated `snapshotHash`, invented `fieldAssignment` with non-canonical controlled value per `controlled-value-identity.ts` ADR 0012) is caught either by `configHashMatches` / `validateProposalSafety` choke-point at curation or by the stale/unknown-value guard at promotion — never coerced.

## 5. Freeze discipline end-to-end (taxonomy source → snapshot → run → cohort)

```
store/classification/*.json   (SoT: product-types, attribute-profiles, curation-targets,
                               attribute-mappings) + ShopSite page_index (verified pages)
        │
        ▼  loadRuntimeConfigAuthority (config-loader.ts) — bundleHash / manifest
        ▼  buildRuntimeSnapshot (runtime-snapshot.ts)
             inputs: authority, configSnapshotRef, focusedFileHashes, catalogEvidenceHash,
                     pages (PageSnapshotState), sourceProductHash, productPageNames,
                     pageImportId/Hash, fieldOptions (pre-resolved), reviewedFacts
             freezes: productTypes, attributes, attributeProfiles, attributeMappings,
                      guidance, brands, modelPolicy, dataSharing, curationTargets,
                      fieldOptions, reviewedFacts, pages, modelExecutionPlan,
                      runtimeRuleVersions
             hash: snapshotHash() over every stage-visible field (excludes createdAt
                   + snapshotHash + ref createdAt) — canonical JSON SHA-256;
                   deepFreeze() after hash; mutation throws in strict mode
        ▼  persistRuntimeSnapshot — dedup by (workspace_id, snapshotHash), verify hash survives JSON round-trip (recomputed must === expected)
        ▼  createRun / ensureMemberRun — run row stores snapshotHash; every proposal/evidence stamped with runId + snapshotHash
        ▼  runPipeline — stages read ONLY context.snapshot (never live files/DB);
             assertRunBoundary + assertModelCallLinkage + linkProposalEvidence enforce run+snapshot linkage
        ▼ PreparedCohort (issue #30 amendment 6):
             parent computes the whole frozen execution-evidence projection ONCE (buildFrozenItem),
             freezes snapshot + cohortFrozenEvidence + coordinatedTitles/Pages;
             each member runs via ensureMemberRun against the SAME frozen projection —
             member NEVER re-reads live onboarding_items, extraction_data, or sibling list (frozen-means-frozen PR3/PR6/PR7);
             cohort FrozenEvidence path executeFrozenEvidenceExtraction hash-gates cohortFrozenEvidence input
```

- **Hash recomputation failure is fail-closed:** `buildRuntimeSnapshot` computes `snapshotHash` deterministically; `persistRuntimeSnapshot` recomputes from stored JSON and throws on mismatch; `getRuntimeSnapshotByHash` returns `null` for malformed or wrong-schema rows (visible as `snapshot_unavailable`, never 500).
- **Cohort freeze invariant:** `buildFrozenItem(memberProjection, liveItem)` copies identity from live item and every semantic field from the frozen projection (authoritative null `sourceUrl` stays null, no `...ext` spread) — post-freeze live mutations cannot leak into member execution.
- **No invented taxonomy IDs:** `validateCanonicalValue` + `canonicalForm`/`comparisonKey` in `controlled-value-identity.ts` (ADR 0012) and `config-validation.ts` (`non_canonical_controlled_value`, `ambiguous_controlled_value`); `validateProposalSafety` rejects proposals whose `fieldAssignment` value is not exact canonical ID from allowed set / alias with valid `mapsTo`. Workspace-scoped IDs are never fabricated by model or stage.

## 6. Where to read this in code

- **Curation preview:** `src/onboarding/product-curator.ts:650-900` (`CurationData` assembly), `src/classification/types.ts:40-90` (`StageDefinition` contract), `src/classification/stages/{evidence-extraction,name-consolidation,primary-product-type,attribute-applicability,attribute-proposals,category-page-proposals,draft-projection}.ts`
- **Promotion truth:** `src/onboarding/draft-promoter.ts:computePromotionGate` + `promoteItems` (this doc §3), `src/db/repositories/page-repo.ts:listVerifiedPageOptions`, `src/db/repositories/classification-config-repo.ts:getCachedAttributeMappings`
- **Snapshot freeze:** `src/classification/runtime-snapshot.ts:buildRuntimeSnapshot`, `persistRuntimeSnapshot`, `snapshotHash`, `deepFreeze`, `getRuntimeSnapshotByHash`, `runtimeSnapshotHashMatchesConfig`
- **Freeze + cohort:** `src/onboarding/cohort-curator.ts:buildFrozenItem`, `src/classification/stages/evidence-extraction.ts:executeFrozenEvidenceExtraction`
- **Taxonomy SoT:** `store/classification/*.json` + `src/classification/config-loader.ts:loadRuntimeConfigAuthority` + `src/classification/releases/bay-state-v3+v4` (frozen manifests)
- **Review explainability (e05):** `src/client/components/onboarding/review/ReviewClassificationPanel.tsx` surfaces `applicability[]`, gating reasons, species-guard provenance, and bundle/snapshot provenance without raw logs

## 7. Taxonomy SoT & edit path (e05s02)

**SoT chain (no invented IDs, ADR 0012):** `store/classification/*.json` (`product-types`, `attributes`, `attribute-profiles`, `mappings`, `curation-targets`, `brands`, `guidance`, `model-policies`, `data-sharing`) → `src/classification/config-loader.ts:loadRuntimeConfigAuthority` / `createRuntimeActivationContext` (verified `catalogFields` + `verifiedPageIds` from active import) → `src/classification/runtime-snapshot.ts:buildRuntimeSnapshot` / `persistRuntimeSnapshot` (freezes every stage-visible field + `snapshotHash`) → `createRun`/`ensureMemberRun` (stamped `snapshotHash`) → `runPipeline` stages (read only `context.snapshot`, never live files/DB; `validateProposalSafety` choke-point rejects non-canonical controlled values + unverified `category_page` ids) → `src/client/components/onboarding/review/ReviewClassificationPanel.tsx` taxonomy provenance badge (`bundleHash`/`snapshotHash`/`verifiedPageIdSet`/`attributeProfileId`) → `src/onboarding/draft-promoter.ts` promotion (verified `pageId` + `getCachedAttributeMappings` stale gate, never invents IDs).

**Safe edit path (non-technical UI deferred):** edit `store/classification/*.json` + `manifest.json` as JSON files → bump `fileVersions` + `bundleHash` via `src/classification/releases/*` / `config-store` release flow → `createRuntimeActivationContext` verifies `catalogFields` + `verifiedPageIds` before activation → new `snapshotHash` on next run. An auto-generative taxonomy UI is explicitly out of scope; a controlled bulk-import with alias `mapsTo` validated against exact allowed IDs (`controlled-value-identity.ts`) is the future extension, not free-text invention.

---
Reference for `verify: test -f specs/tech-architecture/CURATION_FIELD_MAP.md && grep -q 'curation_data_json' ...` — e04s02 task 1.
Reference for e05s02 `verify: grep -q 'store/classification' && grep -q 'RuntimeClassificationSnapshot'` — taxonomy path documented.

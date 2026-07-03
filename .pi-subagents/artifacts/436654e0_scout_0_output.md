# Classification Decisions — Code Context

## Files Retrieved

1. **`src/onboarding/product-curator.ts`** (full, 339 lines) — Main curation orchestrator; runs `classifyProduct()` for legacy LLM-based page/type classification, and `curateItemWithPipeline()` for the new modular classification pipeline.
2. **`src/onboarding/job-queue.ts`** (full, 370 lines) — Stage-based worker: polls for pending items in `discovery`, `extraction`, `curation` stages; calls `curateItem()` in the curation step.
3. **`src/onboarding/draft-promoter.ts`** (full, 195 lines) — Promotes approved items; reads `getAcceptedProposals()` and `getCachedAttributeMappings()` to apply classification decisions to product drafts and page assignments.
4. **`src/classification/config-loader.ts`** (full, 150 lines) — Loads configuration from `store/classification/*.json` files; also saves via `saveClassificationConfig()`.
5. **`src/classification/types.ts`** (full, 85 lines) — Core types: `StageDefinition`, `StageInput`, `StageOutput`, `StageContext`, `ClassificationStage`.
6. **`src/classification/stages/primary-product-type.ts`** (full, 120 lines) — Classifies products into a single "Primary Product Type" from configuration; uses keyword scoring then LLM fallback. Produces `primary_product_type` proposals.
7. **`src/classification/stages/category-page-proposals.ts`** (full, 80 lines) — Proposes category page assignments via keyword overlap matching against page names. Produces `category_page` proposals.
8. **`src/classification/stages/attribute-proposals.ts`** (full, 85 lines) — Proposes field assignments (`field_assignment`) by matching evidence text against attribute `allowedValues` and `valueAliases`.
9. **`src/classification/stages/attribute-applicability.ts`** (full, 60 lines) — Determines which attributes from the profile apply given the accepted product type.
10. **`src/classification/index.ts`** (full, 13 lines) — Stage registry, exports all 6 stages.
11. **`src/shared/schemas/classification.ts`** (full, 265 lines) — Zod schemas for `ClassificationConfig`, `ProductTypeConfig`, `ProductAttributeConfig`, `AttributeProfileConfig`, `AttributeMappingConfig`, `ClassificationProposal`, `ClassificationEvidence`, etc.
12. **`src/shared/schemas/onboarding.ts`** (full, ~470 lines) — `CurationDataSchema` with `suggestedPages`, `suggestedProductType`, and Phase 1 classification containers (`classificationRunId`, `classificationConfigSnapshot`, `classificationProposals`, etc.).
13. **`src/db/classification-migration.sql`** (full, 250 lines) — All classification tables: `classification_config_files`, `classification_config_snapshots`, `classification_product_types`, `classification_attributes`, `classification_attribute_profiles`, `classification_attribute_mappings`, `classification_guidance`, `classification_runs`, `classification_stage_results`, `classification_evidence`, `classification_proposals`, `classification_proposal_decisions`, `classification_history_events`.
14. **`src/db/repositories/classification-config-repo.ts`** (full, 370 lines) — Repository for caching config to SQLite, creating snapshots, reading back cached product types/attributes/profiles/mappings/guidance.
15. **`src/db/repositories/classification-run-repo.ts`** (full, 260 lines) — Repository for classification runs, evidence, proposals, decisions, history events.
16. **`src/db/repositories/product-type-repo.ts`** (full, 110 lines) — Legacy `product_types` / `product_type_fields` CRUD.
17. **`src/db/repositories/page-repo.ts`** (full, 115 lines) — `page_index` and `product_pages` CRUD (page-to-product assignments).
18. **`src/db/repositories/field-registry-repo.ts`** (full, 70 lines) — `field_registry` CRUD mapping XML field names to labels/kinds.
19. **`src/server/routes/classification-routes.ts`** (full, 75 lines) — `GET /api/classification/config`, `POST /api/classification/migrate-legacy`, `POST /api/classification/process-refresh-queue`.
20. **`src/server/routes/onboarding-routes.ts`** (full, ~1750 lines) — Onboarding API routes including `POST /items/:id/decisions` for recording classification proposal decisions, promotion endpoint, item update endpoint.
21. **`src/server/routes/product-type-routes.ts`** (full, 105 lines) — Legacy product type CRUD: `GET /api/product-types`, `POST /api/product-types/:id/fields`.
22. **`src/server/routes/page-routes.ts`** (full, 85 lines) — `GET /api/pages`, `POST /api/products/:sku/pages`.
23. **`src/server/routes/field-registry-routes.ts`** (full, 60 lines) — `GET /api/field-registry`, `PUT /api/field-registry/:id`.
24. **`src/client/onboarding-api.ts`** (relevant sections) — Client API: `getClassificationConfig()`, `submitDecisions()`, `getBatches()`, `updateItem()`.
25. **`src/client/components/Onboarding.tsx`** (full, ~1000 lines) — Main pipeline UI with review drawer handling `classificationProposals`, `curationFields.suggestedPages`, `curationFields.suggestedProductType`.
26. **`src/client/components/PipelineBoard.tsx`** (1718+ lines) — Kanban board with review drawer rendering AI proposals, evidence, page checkboxes, classification decisions.

## Key Code

### Curation Data Schema (how decisions are stored per item)
**`src/shared/schemas/onboarding.ts`** (lines 65-78):
```typescript
export const CurationDataSchema = z.object({
  curatedTitle: z.string().nullable().default(null),
  packagingOcrTitle: z.string().nullable().default(null),
  titleSource: z.enum(['web', 'ocr', 'llm', 'manual']).default('web'),
  suggestedPages: z.array(z.string()).default(() => []),
  suggestedProductType: z.string().nullable().default(null),
  curatedAt: z.string().nullable().default(null),
  curationMethod: z.enum(['auto', 'manual']).default('auto'),
  // Phase 1 classification containers
  classificationRunId: z.string().nullable().default(null),
  classificationConfigSnapshot: ClassificationConfigSnapshotRefSchema.nullable().default(null),
  classificationEvidence: z.array(ClassificationEvidenceSchema).default(() => []),
  classificationProposals: z.array(ClassificationProposalSchema).default(() => []),
  classificationDecisions: z.array(ClassificationProposalDecisionSchema).default(() => []),
  classificationHistory: z.array(ClassificationHistoryEventSchema).default(() => []),
});
```

### Classification Config Structure (configures the pipeline)
**`src/shared/schemas/classification.ts`** (lines 175-210):
```typescript
export const ClassificationConfigSchema = z.object({
  manifest: ClassificationManifestSchema,
  productTypes: z.array(ProductTypeConfigSchema).default(() => []),
  attributes: z.array(ProductAttributeConfigSchema).default(() => []),
  attributeProfiles: z.array(AttributeProfileConfigSchema).default(() => []),
  attributeMappings: z.array(AttributeMappingConfigSchema).default(() => []),
  guidance: z.array(GuidanceConfigSchema).default(() => []),
  modelPolicy: ModelPolicyConfigSchema.default(() => ({...})),
  dataSharing: DataSharingConfigSchema.default(() => ({...})),
});
```

### Proposal Types (what classification produces)
**`src/shared/schemas/classification.ts`** (lines 230-236):
```typescript
export const ProposalTypeEnum = z.enum([
  'primary_product_type',
  'category_page',
  'field_assignment',
  'configuration_gap',
  'reviewable_abstention',
]);
```

### Attribute Mapping (links attributes to catalog fields)
**`src/shared/schemas/classification.ts`** (lines 142-148):
```typescript
export const AttributeMappingConfigSchema = z.object({
  id: ClassificationSlugSchema,
  attributeId: ClassificationSlugSchema,
  catalogField: z.string().min(1),              // e.g. "ProductField24"
  serialization: SerializationConfigSchema.default(...),
  isStale: z.boolean().default(false),
});
```

### Promotion (how classification decisions become drafts)
**`src/onboarding/draft-promoter.ts`** (lines 90-115):
```typescript
const acceptedProposals = getAcceptedProposals(item.upc);
// ... builds classificationCustomFields from field_assignment proposals
// ... builds classificationPageNames from category_page proposals
// ... reads acceptedProductType from primary_product_type proposals
// Merges with existing custom fields and assigns pages
```

## Architecture

### Classification Decision Flow

```
store/classification/*.json
        │
        ▼
  config-loader.ts ──► loadClassificationConfig()
        │
        ▼
  classification-config-repo.ts ──► syncConfigToCache()
        │
        ▼
  product-curator.ts ──► curateItemWithPipeline()
        │
        ▼
  pipeline-runner.ts ──► runPipeline(stages, context, input)
        │
        ├──► evidence_extraction stage
        ├──► primary_product_type stage ──► Proposal: "primary_product_type"
        ├──► attribute_applicability stage
        ├──► product_attribute_proposals stage ──► Proposal: "field_assignment"
        ├──► category_page_proposals stage ──► Proposal: "category_page"
        └──► product_draft_projection stage
                │
                ▼
  classification-run-repo.ts ──► creates runs, evidence, proposals
                │
                ▼
  CurationData.classificationProposals[] stored in onboarding_items.curation_data_json
                │
                ▼
  UI (PipelineBoard.tsx) renders proposals → user accepts/rejects → POST /items/:id/decisions
                │
                ▼
  classification-run-repo.ts ──► recordDecision() updates proposal status
                │
                ▼
  draft-promoter.ts ──► promoteItems() reads getAcceptedProposals() + getCachedAttributeMappings()
                │
                ▼
  product.customFields[ProductField24] = value; product_pages[page_name] assigned
```

### Classification Configuration — File-Based Source of Truth
Config files live at `<workspace>/store/classification/`:
- `manifest.json` — Schema/compatibility versioning
- `product-types.json` — Array of `ProductTypeConfig` (id, name, description, attributeProfileId)
- `attributes.json` — Array of `ProductAttributeConfig` (id, name, valueMode, allowedValues, valueAliases)
- `attribute-profiles.json` — Array of `AttributeProfileConfig` linking product types to attributes with cardinality/required
- `mappings.json` — Array of `AttributeMappingConfig` linking attributeId to catalogField (e.g. `ProductField24`) with serialization rules
- `guidance.json` — Array of `GuidanceConfig` for LLM hints
- `model-policies.json` — Default/module-specific LLM models
- `data-sharing.json` — Data privacy settings

### Three Classification Targets

1. **Product Type** — stored in `suggestedProductType` (legacy) or as `primary_product_type` proposal (pipeline). The `ProductTypeConfig.id` is a slug. The UI renders it as a readonly badge in the review drawer.

2. **Product Field 24 (or any `ProductFieldN`)** — mapped through `AttributeMappingConfig.catalogField`. The attribute proposals (`field_assignment`) target an `attributeId`, and the mapping resolves that to `ProductField24`. At promotion time, `draft-promoter.ts` writes `product.customFields["ProductField24"] = value`.

3. **Category Pages** — stored in `suggestedPages` array (legacy) or as `category_page` proposals (pipeline). The UI renders a multi-select checkbox list from `listPages()`. At promotion time, `draft-promoter.ts` calls `clearProductPages()` then `assignProductToPage()` for each page name.

## Start Here

First file to open: **`src/shared/schemas/classification.ts`** — it defines every Zod schema used by the config files, the runtime evidence/proposal/decision structures, and the enumeration types. Everything else references these types.

## Implementation Hooks for Making Classification Fields Configurable

### 1. Product Type
| Hook | File | Line(s) | Notes |
|------|------|---------|-------|
| Config schema | `src/shared/schemas/classification.ts` | 43-49 | `ProductTypeConfigSchema` with `id`, `name`, `description`, `attributeProfileId` |
| Config storage | `<workspace>/store/classification/product-types.json` | — | Array of `ProductTypeConfig` |
| Cache repo | `src/db/repositories/classification-config-repo.ts` | 237-253 | `getCachedProductTypes(workspaceId)` |
| Stage producing proposals | `src/classification/stages/primary-product-type.ts` | 45-46 | `getCachedProductTypes()` → keyword/LLM classification |
| Proposal type enum | `src/shared/schemas/classification.ts` | 231 | `'primary_product_type'` |
| Promotion reading | `src/onboarding/draft-promoter.ts` | 117-119 | `acceptedProductType = String(proposal.targetId)` |
| UI rendering (readonly badge) | `src/client/components/PipelineBoard.tsx` | ~1478 | `curationFields.suggestedProductType` |
| Legacy API CRUD | `src/server/routes/product-type-routes.ts` | 1-105 | `GET/POST /api/product-types` |

**To make configurable**: Replace the current `llmGetLlmConfigForTask('category_classification')` call in `product-curator.ts:classifyProduct()` (lines 88-129) — which is the legacy path — or override the pipeline stage's LLM call. To support *selecting* product types from a configured list rather than free-form LLM output, the UI would need a dropdown of `getCachedProductTypes()` options in the review drawer.

### 2. Product Field 24 (Option Selection from Live Store)
| Hook | File | Line(s) | Notes |
|------|------|---------|-------|
| Attribute config schema | `src/shared/schemas/classification.ts` | 66-82 | `ProductAttributeConfigSchema` with `allowedValues`, `valueAliases` |
| Attribute config storage | `<workspace>/store/classification/attributes.json` | — | Array of `ProductAttributeConfig` |
| Attribute mapping | `src/shared/schemas/classification.ts` | 142-148 | `AttributeMappingConfigSchema.catalogField` links attribute to `ProductField24` |
| Mappings storage | `<workspace>/store/classification/mappings.json` | — | Array of `AttributeMappingConfig` |
| Cache repo | `src/db/repositories/classification-config-repo.ts` | 296-307 | `getCachedAttributeMappings(workspaceId)` |
| Stage producing field proposals | `src/classification/stages/attribute-proposals.ts` | 34-78 | Matches evidence against `allowedValues` + `valueAliases` |
| Promotion writing | `src/onboarding/draft-promoter.ts` | 102-112 | `classificationCustomFields[mapping.catalogField] = str` |
| Legacy field_registry | `src/db/repositories/field-registry-repo.ts` | 1-70 | Maps `xml_field` → label (e.g., `ProductField24` → "Product Type") |
| Field registry API | `src/server/routes/field-registry-routes.ts` | 1-60 | `GET/PUT /api/field-registry` |

**To make configurable**: The `allowedValues` array in `attributes.json` defines the selectable options for a controlled attribute. Currently the stage matches against these via substring matching. To support *selecting from live store options*, the UI would need to fetch known values (either from `attributes.json` or sync from ShopSite `db_xml.cgi`) and render a dropdown/multi-select in the review drawer. The `catalogField` in the mapping determines which `ProductFieldN` gets written.

### 3. Pages (Single/Multi-Select)
| Hook | File | Line(s) | Notes |
|------|------|---------|-------|
| Page list from DB | `src/db/repositories/page-repo.ts` | 30-33 | `listPages()` — all pages from `page_index` |
| Page API | `src/server/routes/page-routes.ts` | 6-10 | `GET /api/pages` |
| Legacy classification in curator | `src/onboarding/product-curator.ts` | 72-84 | `classifyProduct()` uses `listPages()` for LLM page suggestion |
| Pipeline stage | `src/classification/stages/category-page-proposals.ts` | 26-27 | `listPages()` for keyword overlap matching |
| Proposal type enum | `src/shared/schemas/classification.ts` | 233 | `'category_page'` |
| Promotion writing | `src/onboarding/draft-promoter.ts` | 119-123 | `clearProductPages()` + `assignProductToPage()` for each page |
| UI checkbox list | `src/client/components/PipelineBoard.tsx` | ~1764-1783 | Multi-select checkboxes from `storePages` state; writes to `curationFields.suggestedPages` |
| Pages stored in | `src/shared/schemas/onboarding.ts` | 66 | `CurationDataSchema.suggestedPages: z.array(z.string())` |
| Set pages API | `src/server/routes/page-routes.ts` | 57-73 | `POST /api/products/:sku/pages` — bulk assign |

**To make configurable**: The UI already renders a multi-select checkbox list. For single-select behavior, change the `<input type="checkbox">` to radio buttons or a `<select>`. The pages are always loaded from the `page_index` DB table which mirrors the ShopSite page tree. The `suggestedPages` from curation is a soft suggestion; the user can override in the review drawer before promotion.

### Cross-Cutting Hooks

- **Classification config load/save**: `src/classification/config-loader.ts` lines 60-130 — `loadClassificationConfig()` and `saveClassificationConfig()` read/write all JSON files under `store/classification/`.
- **Config API**: `src/server/routes/classification-routes.ts` line 12 — `GET /api/classification/config` returns the full loaded config.
- **Legacy migration**: `src/classification/legacy-migration.ts` — can migrate existing `product_types` + `product_type_fields` + `field_registry` into classification config files.
- **Sync config to cache**: `src/db/repositories/classification-config-repo.ts` lines 40-210 — `syncConfigToCache()` populates SQLite cache tables from a loaded config. Called after config changes.
- **Decisions API**: `src/server/routes/onboarding-routes.ts` line ~675 — `POST /api/onboarding/items/:id/decisions` records proposal accept/reject/defer decisions.
- **Client API**: `src/client/onboarding-api.ts` line ~572 — `submitDecisions(itemId, decisions[])`, also `getClassificationConfig()`.

### Risk / Constraint Notes
1. **Two parallel curation paths**: `curateItem()` (legacy LLM) and `curateItemWithPipeline()` (modular pipeline) both exist. The pipeline path falls back to classic if no config exists. Any configurable classification must work in both paths or force the pipeline path.
2. **Config is file-based**: Changes to `product-types.json` or `attributes.json` require a workspace reload or explicit `syncConfigToCache()` call.
3. **No config write API**: There is currently no endpoint to write config files through the API. Migration is the only write path. A new endpoint like `PUT /api/classification/config/file/:fileName` would be needed for live editing.
4. **allowedValues matching is simplistic**: The attribute proposals stage does substring matching against flattened evidence text. For controlled options with values not present in product text, LLM fallback (not yet implemented) or UI-only selection is the path.
5. **field_registry is legacy**: The `field_registry` table still exists and is used for brand field resolution. It operates in parallel with the classification attribute mappings but is not connected to the pipeline.
# Classification System Implementation Plan

## Overview

Replace the monolithic `product-curator.ts` / `draft-promoter.ts` pipeline with a
modular, configurable, reviewable classification system per the domain model in
`CONTEXT.md` and ADRs 0001–0006.

## Phases

### Phase 1: Classification Configuration Data Model

**Goal:** Durable, version-controlled classification configuration in the Git
workspace under `store/classification/`, with SQLite caching and Zod schemas.

#### 1a. JSON file schemas (`src/shared/schemas/classification-config.ts`)

Create a new shared schema file with Zod schemas for every configuration file:

| File | Schema | Key Types |
|------|--------|-----------|
| `store/classification/manifest.json` | `ClassificationManifestSchema` | `schemaVersion`, `compatibilityVersion`, `createdAt`, `updatedAt` |
| `store/classification/product-types.json` | `ProductTypeConfigSchema[]` | `id` (stable slug), `name`, `description`, `attributeProfileId` |
| `store/classification/attributes.json` | `ProductAttributeConfigSchema[]` | `id` (stable slug), `name`, `valueMode` (controlled\|freeText\|measured), `canonicalUnit`, `allowedValues`, `visualEvidenceEligibility`, `isClaim`, `isCompositionAttribute`, `group` |
| `store/classification/attribute-profiles.json` | `AttributeProfileConfigSchema[]` | `id`, `productTypeId`, `attributes[]` (with `applicabilityConditions`, `cardinality`, `constraints`, `confidenceThresholds`, `valueAliases`) |
| `store/classification/mappings.json` | `AttributeMappingConfigSchema[]` | `id`, `attributeId`, `catalogField`, `serialization` |
| `store/classification/guidance.json` | `GuidanceConfigSchema[]` | `id`, `scope` (workspace\|productType\|attribute\|page), `structured`?, `freeForm`?, `manualReviewRequirement` |
| `store/classification/model-policies.json` | `ModelPolicyConfigSchema` | `presets[]`, `stageDefaults`, `stageOverrides`, `fallbacks` |
| `store/classification/data-sharing.json` | `DataSharingConfigSchema` | `textPolicy`, `imagePolicy` |

Immutability rules: `id` fields are immutable; `name`/labels change freely; renames
are explicit migrations with `oldIdAliases` recorded.

#### 1b. SQLite cache tables (`src/db/schema.sql` additions)

```sql
-- Classification configuration cache (mirrors store/classification/ JSON)
CREATE TABLE IF NOT EXISTS classification_product_types (
  id TEXT PRIMARY KEY,        -- stable slug
  name TEXT NOT NULL,
  attribute_profile_id TEXT,
  config_hash TEXT NOT NULL,   -- SHA of source JSON for drift detection
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classification_attributes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  value_mode TEXT NOT NULL,
  group_name TEXT,
  is_claim INTEGER NOT NULL DEFAULT 0,
  is_composition_attr INTEGER NOT NULL DEFAULT 0,
  config_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classification_attribute_mappings (
  id TEXT PRIMARY KEY,
  attribute_id TEXT NOT NULL REFERENCES classification_attributes(id),
  catalog_field TEXT NOT NULL,
  is_stale INTEGER NOT NULL DEFAULT 0,
  config_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Classification History (operational/audit)
CREATE TABLE IF NOT EXISTS classification_runs (
  id TEXT PRIMARY KEY,
  product_sku TEXT NOT NULL,
  config_snapshot_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS classification_stage_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES classification_runs(id),
  stage_name TEXT NOT NULL,
  status TEXT NOT NULL,  -- success | failure | abstention
  output_json TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS classification_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES classification_runs(id),
  product_sku TEXT NOT NULL,
  proposal_type TEXT NOT NULL,  -- product_type | category_page | field_assignment
  target_id TEXT,               -- attribute_id, page_name, or 'primary_product_type'
  proposed_value TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  evidence_json TEXT,           -- [{source, snippet, reliability}]
  is_stale INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classification_decisions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES classification_proposals(id),
  decision TEXT NOT NULL,       -- accepted | rejected | deferred
  revised_from_id TEXT,         -- previous decision this revises
  reviewer_note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classification_evidence_snapshots (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES classification_proposals(id),
  evidence_json TEXT NOT NULL,
  retention_expires_at TEXT,
  created_at TEXT NOT NULL
);
```

#### 1c. Config file I/O (`src/classification/config-store.ts`)

```typescript
// Read/write store/classification/*.json files
export function readClassificationConfig(workspacePath: string): ClassificationConfig
export function writeClassificationConfigFile(workspacePath: string, file: string, data: unknown): void
export function computeConfigHash(config: ClassificationConfig): string
export function configHasDrifted(workspacePath: string, cachedHash: string): boolean
```

#### 1d. SQLite sync (`src/classification/config-cache.ts`)

```typescript
// Sync store/classification/*.json → SQLite cache tables
export function syncClassificationConfigToDb(workspacePath: string): SyncResult
export function getConfigFromDb(): CachedClassificationConfig
```

#### 1e. Zod schemas (`src/shared/schemas/classification-config.ts`)

All Zod schemas for the config files listed in 1a, plus runtime types.

#### 1f. Repository layer (`src/db/repositories/classification-repo.ts`)

```typescript
export function insertClassificationRun(...): ClassificationRun
export function insertStageResult(...): StageResult
export function insertProposal(...): ClassificationProposal
export function insertDecision(...): ClassificationDecision
export function insertEvidenceSnapshot(...): EvidenceSnapshot
export function getClassificationHistory(sku: string): ClassificationHistory
export function markProposalsStale(runId: string, stageNames: string[]): void
```

#### 1g. Migration from legacy tables

```typescript
// src/classification/legacy-migration.ts
export function migrateLegacyProductTypes(workspacePath: string): MigrationReport
// Reads product_types + product_type_fields from SQLite
// Produces initial product-types.json + attributes.json + attribute-profiles.json
// Writes Configuration Suggestions for unmappable fields
```

### Phase 2: Staged Classification Engine

**Goal:** Replace `product-curator.ts` `classifyProduct()` with composable,
dependency-managed classification stages.

#### 2a. Stage framework (`src/classification/stages/types.ts`)

```typescript
export type StageStatus = 'success' | 'failure' | 'abstention';

export interface StageInput {
  productSku: string;
  productName: string;
  extractionData: ExtractionData;
  ocrTitle: string | null;
  brandHint: string | null;
  configSnapshot: ClassificationConfig;
  priorStageResults: Map<string, StageOutput>;
}

export interface StageOutput {
  stageName: string;
  status: StageStatus;
  proposals: ClassificationProposalDraft[];
  evidence: ClassificationEvidenceDraft[];
  errorMessage?: string;
}

export interface StageDefinition {
  name: string;
  dependencies: StageDependency[];
  execute(input: StageInput): Promise<StageOutput>;
}

export interface StageDependency {
  stageName: string;
  required: boolean;
}
```

#### 2b. Stage runner (`src/classification/stages/runner.ts`)

```typescript
export async function runClassificationPipeline(
  input: StageInput,
  stages: StageDefinition[]
): Promise<ClassificationRunResult>

// Topological sort by dependencies
// Run deterministic stages before model-backed
// Record failures without failing the whole run
// Capture config snapshot hash
```

#### 2c. Stage implementations

**Evidence Extraction Stage** (`src/classification/stages/evidence-extraction.ts`):
- Produces `StructuredProductEvidence` from raw extraction data
- Runs VLM OCR if `primaryImage` exists → `VisualProductEvidence`
- Output: evidence snippets with provenance (source, reliability)

**Primary Product Type Stage** (`src/classification/stages/primary-product-type.ts`):
- Model-backed (or deterministic if structured guidance exists)
- Proposes a `product_type` or abstains → `UnknownPrimaryProductType`
- Dependencies: evidence-extraction

**Attribute Applicability Stage** (`src/classification/stages/attribute-applicability.ts`):
- Deterministic: evaluates `AttributeApplicabilityConditions` against known values
- Gate: requires known Primary Product Type (otherwise abstains)
- Output: per-attribute `applicable` | `non_applicable` | `preview` (if unreviewed)
- Dependencies: primary-product-type, evidence-extraction

**Attribute Proposal Stage** (`src/classification/stages/attribute-proposals.ts`):
- Model-backed or deterministic based on value mode
- Proposes field assignments for applicable attributes
- Respects `VisualEvidenceEligibility`, `AttributeValueAliases`
- Output: `field_assignment` proposals with evidence
- Dependencies: attribute-applicability

**Category Page Stage** (`src/classification/stages/category-pages.ts`):
- Model-backed: proposes page assignments from existing pages
- Gate: requires known Primary Product Type (abstains otherwise)
- Uses `CategoryPageAssignmentScope` per product type
- Validates by `CategoryPageIdentity`, not name alone
- Dependencies: primary-product-type, evidence-extraction

**Product Draft Projection Stage** (`src/classification/stages/draft-projection.ts`):
- Deterministic: synthesizes accepted proposals into draft field preview
- Flags `SkippedDraftAssignments`, `ConfigurationGaps`, `StaleProposals`
- Dependencies: all prior stages

#### 2d. Model-backed stage helpers (`src/classification/stages/model-helpers.ts`)

```typescript
export function buildStagePrompt(
  stage: string,
  evidence: StructuredEvidence[],
  config: ClassificationConfig,
  guidance: CatalogManagerGuidance[]
): string

export function enforceGuidanceBoundaries(
  prompt: string,
  safetyRules: SafetyRule[]
): string

export function resolveModelPolicy(
  stageName: string,
  config: ClassificationConfig
): StageModelPolicy
```

### Phase 3: Review & History

#### 3a. Classification History service (`src/classification/history.ts`)

```typescript
export function recordRun(sku: string, configSnapshot: ClassificationConfig): string
export function recordStageResult(runId: string, output: StageOutput): void
export function recordProposal(runId: string, proposal: ProposalDraft): string
export function recordDecision(proposalId: string, decision: Decision): string
export function reviseDecision(proposalId: string, newDecision: Decision): string
export function getHistory(sku: string): ClassificationHistory
export function getStaleProposals(sku: string): ClassificationProposal[]
export function markStale(stageNames: string[], sku: string): void
```

#### 3b. Proposal decision helpers (`src/classification/decisions.ts`)

```typescript
export function isBulkEligible(proposal: ClassificationProposal): boolean
export function requiresManualReview(proposal: ClassificationProposal, guidance: Guidance[]): boolean
export function previewBulkDecisions(proposals: ClassificationProposal[]): BulkPreview
export function applyBulkDecisions(proposalIds: string[], decision: 'accept' | 'reject'): void
```

### Phase 4: Refresh & Configuration Review

#### 4a. Classification Refresh (`src/classification/refresh.ts`)

```typescript
export function computeRefreshScope(
  changedConfig: string[],  // which config files changed
  skus: string[]
): RefreshScope

export function previewRefresh(scope: RefreshScope): RefreshPreview
export function queueRefresh(scope: RefreshScope, deferrals: string[]): void
export function runRefresh(sku: string, scope: RefreshScope): ClassificationRunResult
```

#### 4b. Configuration Review (`src/classification/config-review.ts`)

```typescript
export interface ConfigurationSuggestion {
  type: 'new_product_type' | 'new_attribute' | 'remap' | 'merge_legacy' | 'add_value';
  source: 'legacy_field_map' | 'approved_product' | 'starter_preset' | 'evidence';
  details: Record<string, unknown>;
}

export function generateSuggestions(workspacePath: string): ConfigurationSuggestion[]
export function applyConfigChange(change: ConfigChange, workspacePath: string): void
export function previewConfigChangeImpact(change: ConfigChange): RefreshPreview
```

### Phase 5: Integration with Existing Pipeline

#### 5a. Update `CurationData` schema (`src/shared/schemas/onboarding.ts`)

Add to `CurationDataSchema`:
```typescript
classificationRunId: z.string().nullable(),
primaryProductType: z.string().nullable(),
primaryProductTypeUnknown: z.boolean().default(false),
proposals: z.array(ClassificationProposalSchema).default([]),
decisions: z.array(ClassificationDecisionSchema).default([]),
```

Add new schemas:
```typescript
export const ClassificationProposalSchema = z.object({
  id: z.string(),
  type: z.enum(['product_type', 'category_page', 'field_assignment']),
  targetId: z.string().nullable(),
  proposedValue: z.string(),
  confidence: z.number(),
  evidence: z.array(EvidenceSnippetSchema),
  decision: z.enum(['accepted', 'rejected', 'deferred', 'pending']).default('pending'),
  isStale: z.boolean().default(false),
});

export const EvidenceSnippetSchema = z.object({
  source: z.string(),
  snippet: z.string(),
  reliability: z.enum(['high', 'medium', 'low']),
});
```

#### 5b. Update `product-curator.ts`

Replace `curateItem()` internals:
- Call `runClassificationPipeline()` instead of inline `classifyProduct()`
- Store `classificationRunId` and `proposals` in `CurationData`
- Keep `curatedTitle`, `packagingOcrTitle`, `titleSource` (these are pre-classification)

#### 5c. Update `draft-promoter.ts`

Replace ad-hoc page assignment with proposal-based promotion:
- Read `curationData.proposals` and `curationData.decisions`
- Only apply accepted `field_assignment` proposals → `customFields`
- Only apply accepted `category_page` proposals → `assignProductToPage()`
- Skip `StaleProposals`, `ConfigurationGaps`, `SkippedDraftAssignments`
- Record skipped items clearly in the change set description

#### 5d. Update `job-queue.ts`

Trigger classification run during curation phase:
```
needs_review → curating → (run classification pipeline) → curated
```

### Phase 6: API Routes

#### 6a. Classification config routes (`src/server/routes/classification-config-routes.ts`)

```
GET    /api/classification/config              → full config
GET    /api/classification/config/:file        → single config file
PUT    /api/classification/config/:file        → propose config change
POST   /api/classification/config/review       → approve/reject config change
GET    /api/classification/config/suggestions  → auto-generated suggestions
GET    /api/classification/config/preview-refresh → refresh impact preview
POST   /api/classification/config/apply-refresh  → queue refresh
```

#### 6b. Classification run routes (`src/server/routes/classification-routes.ts`)

```
POST   /api/classification/run/:sku            → trigger classification run
GET    /api/classification/run/:sku/history     → get classification history
GET    /api/classification/run/:sku/proposals   → get pending proposals
POST   /api/classification/run/:sku/decide      → submit proposal decisions
POST   /api/classification/run/:sku/decide/bulk → bulk accept safe proposals
POST   /api/classification/run/:sku/override-applicability → applicability override
```

#### 6c. Update onboarding routes

Modify `src/server/routes/onboarding-routes.ts`:
- `PATCH /api/onboarding/items/:id/curation` → accept new proposal/decision shape
- `POST /api/onboarding/items/:id/decide` → submit proposal decisions

### Phase 7: Frontend Components

#### 7a. Classification review UI (`src/client/components/ClassificationReview.tsx`)

- List proposals grouped by type (product type, attributes, pages)
- Show evidence snippets for each proposal
- Accept/reject/defer controls with confidence indicators
- Stale proposal warnings
- Non-applicable attributes section (hidden by default, expandable)
- Applicability Override button on non-applicable attributes
- Product Draft Projection preview
- Bulk accept for eligible proposals

#### 7b. Configuration review UI (`src/client/components/ClassificationConfig.tsx`)

- Product Types list (from `store/classification/product-types.json`)
- Product Attributes list with value modes, groups, claim status
- Attribute Profiles editor (drag attributes to profile, set conditions)
- Attribute Mappings (attribute → catalog field)
- Guidance editor (structured + free-form)
- Model policy presets (quality/cost/speed/locality)
- Data sharing toggles
- Configuration Suggestions panel
- Refresh Preview before applying config changes

#### 7c. Updates to `Onboarding.tsx`

- Integrate `ClassificationReview` component into the curation step
- Show classification status per item
- Link to `ClassificationConfig` for configuration issues

### Phase 8: Tests

#### 8a. Unit tests

| File | What |
|------|------|
| `src/tests/unit/classification-schemas.test.ts` | Zod schemas validation, config file parsing |
| `src/tests/unit/classification-stages.test.ts` | Each stage in isolation with mock inputs |
| `src/tests/unit/classification-applicability.test.ts` | Applicability condition evaluation |
| `src/tests/unit/classification-decisions.test.ts` | Decision logic, bulk eligibility, revisions |
| `src/tests/unit/classification-refresh.test.ts` | Scope computation, staleness marking |
| `src/tests/unit/classification-mapping.test.ts` | Attribute → catalog field mapping, serialization |
| `src/tests/unit/config-store.test.ts` | Read/write config files, hash computation |

#### 8b. Integration tests

| File | What |
|------|------|
| `src/tests/integration/classification-pipeline.test.ts` | Full pipeline: evidence → type → attributes → pages → projection |
| `src/tests/integration/classification-promotion.test.ts` | Curation → review → promotion with proposals |
| `src/tests/integration/classification-config-review.test.ts` | Config change → review → refresh |

#### 8c. Existing test updates

- `src/tests/unit/draft-promoter.test.ts`: Update for proposal-based promotion
- Any test referencing `CurationData` shape

### Phase 9: Cleanup

1. Deprecate `product_types` and `product_type_fields` SQLite tables (keep for migration)
2. Remove hardcoded pet-store examples from prompts (use config-driven guidance)
3. Audit all prompts for configurable classification behavior
4. Ensure `customFields` promotion respects attribute mappings and catalog fields

## Delivery Order (Smallest Deployable Increments)

1. **Phase 1a–1c, 1e**: Schemas + config I/O (no pipeline changes, no migration)
2. **Phase 1b, 1d, 1f**: SQLite cache + repo layer
3. **Phase 1g**: Legacy migration script (one-time, manual trigger)
4. **Phase 2a–2c**: Stage framework + evidence + primary product type (first working pipeline)
5. **Phase 3a–3b**: Classification history + decisions
6. **Phase 5a–5d**: Integrate with existing onboarding (now reviewable!)
7. **Phase 2c (remaining stages)**: Attributes, pages, projection
8. **Phase 4a–4b**: Refresh + config review
9. **Phase 6**: API routes
10. **Phase 7**: Frontend
11. **Phase 8**: Tests (write alongside each phase, not after)
12. **Phase 9**: Cleanup

Each increment should ship with its own tests and not break existing functionality.

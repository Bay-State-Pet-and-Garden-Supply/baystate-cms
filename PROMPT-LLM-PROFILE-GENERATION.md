# One-Shot LLM Profile Generation for Profile Builder

## Context

We have a React + TypeScript Profile Builder component (`ProfileBuilder.tsx`) that lets operators manually build domain extractor profiles by entering CSS selectors. The builder sits in Onboarding Settings. It has a `FieldCard` per field (title, brand, description, images, plus arbitrary custom fields).

We want to add a **"Generate Selectors"** button that feeds the snapshot page HTML to an LLM in one call and returns selectors for ALL fields at once. This populates the FieldCards, which the operator can then tweak/validate/save.

## Existing Architecture

### Profile Builder (already built)
- `src/client/components/profile-builder/ProfileBuilder.tsx` — entrypoint
- `FieldCard.tsx` — per-field editor + status badge + extracted preview
- `SnapshotPanel.tsx` — captures the page via existing `snapshotPageForBuilder` API which returns page HTML, JSON-LD, image candidates, page structure signals
- `profileBuilderReducer.ts` — state management
- `profileBuilderTypes.ts` — types (ProfileDraft, FieldStatus, etc.)
- `fieldCatalog.ts` — CORE_FIELDS + STANDARD_CUSTOM_FIELDS definitions

### Available APIs (existing)
- `POST /api/onboarding/settings/profile-tooling/snapshot` — captures a page and returns `{ htmlRef, jsonLd[], embeddedProductData[], imageCandidates[], pageStructureSignals[], warnings[] }`
- `POST /api/onboarding/settings/extractor-profiles` — saves a profile (domain, selectors, runtime, etc.)
- `POST /api/onboarding/extractor-profiles/test` — tests a profile against a URL

### The OLD approach (DO NOT REUSE)
There's already a `POST /api/onboarding/settings/domain-diagnostics/:domain/generate-profile` endpoint that uses an LLM to propose selectors, but it:
1. Stores proposals in `profile_generations` table
2. Has a full governance pipeline (revisions, approval queues, field decisions, rollbacks)
3. Requires `SHOPSITE_CMS_PROFILE_GENERATION_ENABLED` flag
4. Uses dedicated `llm_task_configs` rows
5. Returns a `generationId` not the actual selectors

We want something simpler — no persistence, no governance, no approval queues.

### LLM Routing (existing)
The project has `llm_task_configs` table that maps tasks (`profile_generation`, `product_name_consolidation`, etc.) to providers/models. The existing `profile_generation` task config could be reused, or we could add a simpler direct-LLM approach.

## What We Want

### UI
One button in the Profile Builder workspace — **"Generate Selectors"** — that:
1. Requires a captured snapshot (page HTML is available)
2. Shows loading state per-field ("generating...")
3. On success, fills ALL field cards with proposed selectors
4. Each field still shows its status badge (now "assigned" with the proposed selector)
5. Operator reviews, tweaks, validates, and saves as normal

No separate review screen, no approval drawer, no governance pipeline. The proposed selectors go directly into the existing FieldCards.

### LLM Call
One call to an LLM with:
- The page HTML (from snapshot)
- The list of ALL standard fields (core + custom) from `fieldCatalog.ts`
- Instructions to return a JSON object mapping field keys to CSS selectors
- The LLM should also suggest **new custom fields** it discovers (e.g., ingredient list, weight, flavor) that aren't in the standard catalog

### Response Shape
```json
{
  "selectors": {
    "titleSelector": "h1.product-title",
    "brandSelector": ".brand-name a",
    "descriptionSelector": "#product-description",
    "imagesSelector": ".gallery img",
    "weightSelector": ".product-weight",
    "flavorSelector": ".flavor-name"
  },
  "customFields": [
    { "key": "ingredientListSelector", "label": "Ingredients", "selector": ".ingredients" }
  ],
  "reasoning": "Title found in h1 with class product-title..."
}
```

### Cost/Performance
- One call per domain, not per field
- DeepSeek caching will be used (prefix caching). If we do one-shot, shared HTML prefix is cached
- ~10-30 seconds expected (snapshot + LLM)
- LLM config uses existing `llm_task_configs` or a simple environment variable-based config

### Constraints
- No new database tables
- No proposal/revision/field-decision rows
- No approval queues
- No changes to the extraction worker
- Uses existing `ProfileDraft` state model — proposed selectors go directly into `state.draft`
- Must handle partial failure (some fields succeed, some don't)
- Must produce a warning list when selectors look suspicious (e.g., too generic)
- Must support both `static` and `rendered` runtime modes

## Design Questions

1. **API shape**: Should this be a new endpoint (`POST /api/onboarding/settings/profile-tooling/generate-selectors`) or reuse/extend an existing one?

2. **LLM provider**: Can we use the existing `llm_task_configs` table for the `profile_generation` task, or should we add a simpler config (e.g., a new task `one_shot_selector_generation`)?

3. **Prompt engineering**: What goes in the system prompt? The page HTML alone could be large. Should we also include JSON-LD, meta tags, and page structure signals?

4. **Custom field detection**: How should the LLM decide what custom fields to propose? Based on visible page content (ingredient lists, flavor selectors, weight displays)?

5. **Validation**: Should the LLM provide a confidence score per selector? Should we auto-test each proposed selector against the page before showing it?

6. **Security**: How to handle pages behind login walls, or pages that return error pages despite 200 status?

7. **Fallback**: If the LLM call fails (timeout, rate limit, etc.), should we fall back to a simpler heuristic approach (e.g., look for common class names like "product-title")?

## Deliverable

An architecture design document covering:

1. **API design** — new endpoint or extend existing, request/response shapes, error handling
2. **Component changes** — where the "Generate Selectors" button lives, how it integrates with the existing reducer (new action types, new request state), loading states per field
3. **Prompt design** — what goes into the system prompt, how we handle large HTML, what signals to include
4. **Custom field proposal** — how the LLM discovers and returns new custom field selectors
5. **LLM routing** — how we pick the model, reuse caching, handle failures
6. **Security considerations**
7. **Implementation sequence** — what to build in what order

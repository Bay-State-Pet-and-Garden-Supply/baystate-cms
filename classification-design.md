# Classification System Design Summary

## Core Architecture

Classification is a **staged modular pipeline** composed of **Classification Stages** — replaceable modules that consume evidence and produce **Classification Proposals** (reviewable suggestions) or **Classification Evidence** (facts supporting proposals). VLMs act as **Evidence Extraction Stages** (extracting **Visual Product Evidence**), not final decision-makers.

### Key Domain Concepts

| Term | Definition |
|------|-----------|
| **Product Type** | Reusable local CMS classification; only exported to ShopSite if explicitly mapped |
| **Primary Product Type** | The single gating type selecting an Attribute Profile; may be Unknown |
| **Product Attribute** | Store-configured merchandisable fact (flavor, color, size, material, etc.) |
| **Attribute Profile** | Set of Product Attributes expected for a Product Type |
| **Attribute Mapping** | Links a Product Attribute to a Catalog Field (live-ShopSite-XML-only) |
| **Classification Proposal** | Reviewable AI-suggested Product Type, Category Page, or Field Assignment |
| **Classification History** | Local CMS operational/audit record — not exported to ShopSite |
| **Catalog Manager Guidance** | Manager-authored instructions (structured or free-form) shaping classification behavior |
| **Classification Safety Rule** | Non-overridable constraints (live Catalog Field matching, review-before-final, direct-evidence for claims) |

### Stage Pipeline

1. **Evidence Extraction** → VLM for images, web scraping for text → produces **Structured Product Evidence**
2. **Primary Product Type Proposal** → classifies into configured Product Types
3. **Attribute Applicability** → determines which attributes apply based on accepted type
4. **Product Attribute Proposals** → proposes attribute values with evidence and confidence
5. **Category Page Proposals** → assigns to existing store pages
6. **Product Draft Projection** → previews final field values before product draft creation

**Deterministic stages** (rule-based, using aliases, allowed values, regex) run **before model-backed stages** (LLM/VLM). Each stage can **abstain** (no proposal) instead of guessing.

### Configuration

Classification Configuration lives in `store/classification/` (workspace-versioned in Git with SQLite as index/cache):
- `product-types.json`, `attributes.json`, `attribute-profiles.json`, `mappings.json`, `guidance.json`, `model-policies.json`, `data-sharing.json`
- Stable human-readable IDs/slugs; immutable after creation
- A `manifest.json` with overall version + per-file `schemaVersion`

### Data Flow

1. Products import via spreadsheet → onboarding items
2. **Baseline Classification** runs automatically (evidence extraction, basics)
3. **Configured Classification** runs when Classification Configuration exists
4. Proposals go to **Product Review** (per-proposal decisions: accept/reject/defer)
5. **Bulk Proposal Acceptance** available for safe unambiguous proposals
6. Accepted decisions become **Product Draft Projection** (preview only)
7. **Product Draft Creation** writes final fields and page assignments using current active Classification Configuration

### Change Management

- **Classification Refresh**: re-runs affected stages when evidence or config changes
- **Configuration-Driven Classification Refresh**: queued after Configuration Review applies config changes
- **Configuration Snapshot Drift**: if config changed between review and promotion, affected proposals become stale
- **Refresh Scope**: runs only affected stages when dependencies are known; falls back to full run
- **Refresh Deferral**: managers can exclude specific products from refresh queues
- **Proposal Decision Revisions**: decisions can be reversed without erasing history

### Safety Rules

- **Untrusted Product Evidence**: scraped pages/spreadsheets are facts only, cannot issue instructions
- **No Absence-Based Claims**: free-from/allergen claims require explicit evidence
- **Product Claims** require **Direct Claim Evidence** (no inference)
- **Product Composition Attributes**: ingredients/nutrients require strict evidence
- **Third-Party Evidence**: retailer pages allowed for ordinary attributes only, not claims/composition
- **Evidence Snapshots**: bounded retained copies of structured evidence, sufficient to explain decisions
- **Sensitive Store Data** (credentials, merchant IDs, API keys) never sent to model providers
- **Image Data Sharing Policy**: raw product images stay local by default
- **Stage Model Fallback**: no silent fallback from local-only to cloud

### Implementation Notes

- Replace the current monolithic `product-curator.ts` with modular stages
- Extend `CurationData` to hold proposals, evidence, decisions, and history
- Classification History stored in SQLite as operational/audit state
- Classification Configuration versioned in workspace Git (under `store/classification/`)
- Use existing `api_keys` table for model providers
- Existing `product_types` and `product_type_fields` tables become a **Legacy Field Map** that can seed configuration
- VLM and LLM clients already exist in `src/onboarding/vlm-client.ts` and `src/onboarding/llm-client.ts`
- Job queue already exists in `src/onboarding/job-queue.ts`
- Draft promotion already exists in `src/onboarding/draft-promoter.ts`

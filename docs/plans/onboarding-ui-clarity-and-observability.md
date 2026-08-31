# Handoff Specification: Onboarding UI Clarity & Real-Time Pipeline Observability

**Status**: Proposed / Ready for Implementation  
**Related Epics/ADRs**: ADR 0013 (Cohort-Centric Curation), ADR 0016 (Onboarding Operating Model), Epic #46 (Needs Attention & Batch Workspace)  
**Target Area**: `src/client/components/onboarding/*`, `src/onboarding/onboarding-work-state.ts`, `src/server/routes/onboarding-routes.ts`

---

## 1. Problem Statement & User Experience Gaps

During live onboarding execution of batch catalog items, operators currently encounter low-visibility states in the UI:
1. **Opaque "Processing" State**: When an item or family is in the Curation stage, the UI renders a single generic label (`Curating product family` or `Processing`). If the background worker encounters a family-level invariant conflict during cohort freeze (e.g., `cohort_product_type_conflict` where 1 sibling inferred a different product type), items remain in `processing` or `pending` without real-time telemetry indicating *which* sub-stage is running (OCR, type resolution, title coordination, page assignment) or *why* progress halted.
2. **Ambiguous "Curation Conflict" Labeling**: Items blocked by semantic validation (e.g., `semantic_validation_blocked`) are grouped under the chip label `"Curation conflict"` in the Needs Attention queue without immediately presenting:
   - The specific invariant violated (e.g., `family_brand`, `coordinated_page`, `member_attribute_applicability`).
   - The human-readable reason (e.g., "Brand evidence tied between 'Lazy Dog Cookies' and 'The Lazy Dog Cookie'", or "Certification badge 'Blue Standard' detected alongside brand 'BetterBone'").
   - A direct, 1-click resolution action in the UI.
3. **Lack of Live Pipeline Stage Telemetry**: Operators cannot see the active execution step of background jobs (e.g., `Fast Cloud OCR (1/1 images complete)` → `Product Type Agreement (22/22 toys)` → `Title Coordination` → `Category Page Assignment`).

---

## 2. Proposed Architecture & Solutions

### A. Server-Side Work-State Telemetry (`src/onboarding/onboarding-work-state.ts`)
1. **Granular Activity States**:
   Extend `WorkActivity` with detailed sub-activities:
   - `packaging_ocr`: Fast Cloud/Local packaging OCR running on primary image.
   - `cohort_freezing`: Resolving family product type agreement and capturing snapshots.
   - `title_coordination`: Generating / validating synchronized family titles across siblings.
   - `page_coordination`: Assigning verified store category pages.
   - `attribute_curation`: Executing member attribute rules and value extraction.
   - `semantic_validation`: Validating family consistency and profile applicability.
2. **Structured Attention Details**:
   Enrich `attentionReason: 'semantic_validation_blocked'` with structured finding payloads:
   - `findingCode`: `'family_brand' | 'cohort_type_split' | 'coordinated_page' | 'attribute_applicability'`.
   - `findingSummary`: Clear sentence explaining the exact conflict.
   - `conflictingValues`: Array of competing values/options.
   - `suggestedAction`: Suggested action (`'accept_majority'`, `'choose_canonical_brand'`, `'split_cohort'`).

### B. Frontend UI Enhancements

#### 1. Real-Time Pipeline Progress Indicator
- In `BatchWorkspace.tsx` and `OnboardingTable.tsx`, replace the static spinner with an informative status badge:
  - `[OCR] Packaging text extraction (1/1)`
  - `[Titles] Coordinating 22 sibling titles...`
  - `[Pages] Assigning store category pages...`
  - `[Curation] Curating variant attributes (18/22 complete)`

#### 2. Enhanced "Needs Attention" Conflict Cards
- When an item lands in `Needs Attention` due to a curation or semantic conflict:
  - Display a dedicated **Conflict Inspector** card.
  - Show the competing evidence (e.g., *Detected Brand Mentions: "BetterBone" (22 items) vs "Blue Standard" (packaging badge)*).
  - Provide inline quick-actions:
    - **"Confirm Brand: BetterBone"** (resolves brand tie immediately).
    - **"Align Product Type to Dog Toys"** (resolves type split).
    - **"Edit Title Sibling"** (opens title editor).

#### 3. Family / Cohort Inspector Drawer
- Clicking any item in a multi-item family opens a **Cohort Family View**:
  - Lists all siblings in the family.
  - Shows each sibling's extracted title, packaging OCR status, assigned category pages, and curated attributes side-by-side.
  - Visualizes family invariants (shared brand, shared product type, coordinated title skeleton).

---

## 3. Implementation Tasks & Acceptance Criteria

### Task 1: Work-State Activity & Finding Serialization
- **Files**: `src/shared/schemas/onboarding-work-state.ts`, `src/onboarding/onboarding-work-state.ts`
- **Work**: Add `findingCode`, `findingSummary`, and `conflictingValues` to `OnboardingWorkState`. Ensure `getBatchWorkState` populates these from `curationData.semanticValidation.findings`.
- **Acceptance**: Batch work state API returns structured conflict reasons for any blocked item.

### Task 2: Pipeline Activity Badges in UI
- **Files**: `src/client/components/onboarding/OnboardingTable.tsx`, `src/client/components/onboarding/attention/attention-logic.ts`
- **Work**: Render distinct badges and tooltip progress for active curation sub-stages (`OCR`, `Titles`, `Pages`, `Attributes`).
- **Acceptance**: Operators can immediately tell what phase of curation an item or family is currently executing.

### Task 3: Conflict Inspector & 1-Click Remediation
- **Files**: `src/client/components/onboarding/attention/NeedsAttentionWorkspace.tsx`, `src/client/components/onboarding/attention/SemanticConflictPanel.tsx`
- **Work**: Build `SemanticConflictPanel` with clear explanations and 1-click action buttons to resolve brand ties, type splits, and title lint mismatches.
- **Acceptance**: An operator can resolve a `family_brand` or `cohort_type_split` finding directly from the Needs Attention queue without manually modifying database rows.

### Task 4: Unit & Acceptance Tests
- **Files**: `src/tests/unit/onboarding-work-state.test.ts`, `src/tests/unit/attention-logic.test.ts`
- **Work**: Add unit tests verifying serialization of granular activities and semantic conflict resolutions.

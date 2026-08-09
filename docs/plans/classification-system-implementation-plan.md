# Implementation Plan

## Goal

Recover Bay State’s classification subsystem into a fail-closed, reproducible, workspace-configured system; activate the approved 21-type pet-and-garden taxonomy; preserve review safety; quarantine unreliable corpus data; and keep ML features disabled until they pass the approved benchmark gate.

## Scope and Approved Decisions

- Patch the dirty worktree in place with one sequential writer per milestone.
- Never reset, clean, stash, revert, or broadly stage existing changes.
- Leave all outer-repository application changes unstaged.
- Permit one exact-path commit in the nested `storage/catalog` repository containing only `store/classification/**`.
- Use `storage/catalog/store/classification/` as the sole runtime configuration authority.
- Activate the 13 historically committed Product Types plus the approved eight-type expansion.
- Treat all current Page UUIDs and ProductOnPages names as unverified.
- Implement Page import storage and service seams now, but defer real ShopSite XML parsing and Page activation until a real export is available.
- Run no network, paid crawl, model download, or live embedding request.
- Keep retrieval, reranking, calibration, and production embeddings disabled.
- Require at least 200 holdout examples, 20 per evaluated class, 80% coverage, zero safety violations, and statistically supported paired improvement before qualification.
- Qualification never auto-enables a feature or auto-accepts a proposal.

## Cross-Cutting Seam Contracts

### Canonical configuration

- Every non-manifest file uses a strict versioned envelope:
  - arrays: `{ "schemaVersion": 2, "entries": [...] }`
  - policies: `{ "schemaVersion": 2, "policy": {...} }`
- `manifest.json` records SHA-256 hashes for every non-manifest focused file.
- `bundleHash` hashes canonical manifest metadata and the ordered file-hash map. It must not hash itself.
- Files record the pre-activation catalog commit. The resulting activation commit is stored in the activation audit and runtime snapshots, avoiding a self-referential commit hash.
- SQLite is a derived cache and audit store, never an alternate configuration authority.

### Runtime snapshot

Every run consumes one deeply frozen, persisted snapshot containing:

- validated configuration and focused-file hashes;
- activated catalog commit;
- catalog-evidence hash;
- exact Product Type, attribute, field-value, and verified Page candidates;
- resolved guidance, model, data-sharing, and feature policies;
- reviewed facts and their source decision IDs;
- source product/evidence hash;
- Page import ID/hash, or an explicit “no verified page catalog” state.

Stages may use runtime services such as an LLM client, but may not rediscover configuration, candidates, Pages, or model policy from mutable files or tables.

### Review and dependent classification

- Immutable prediction fields remain distinct from revised reviewer values.
- Final applicability uses accepted/reviewed facts only.
- A pending Product Type may be displayed as preview information but cannot unlock type-gated proposals.
- Accepting or revising a Primary Product Type queues a dependent refresh.
- The refresh snapshot carries the prior accepted type as a reviewed fact, with decision/run/config/source provenance.
- Config or source drift invalidates carried-forward facts rather than silently reusing them.

### Page identity

- Name-only observations are review context, not live Page identities.
- Verified identity requires a real ShopSite Pages export.
- Prefer a real immutable exported GUID if present; otherwise permit a unique, non-empty exported File Name only after the real export proves that contract.
- No Page name fallback is allowed during promotion or catalog application.
- An unavailable Page creates a visible skipped assignment without blocking creation of the rest of a product draft.

### Benchmark and ML policy

- Gold labels and prediction bundles are immutable, content-addressed artifacts.
- Evaluation reads frozen inputs and submitted predictions only; it never reads the latest operational run as a prediction.
- Page evaluation and Page reranking remain ineligible until verified Page identity exists.
- Confidence calibration can alter abstention or review priority only.
- Feature qualification and explicit feature activation are separate audited actions.

## Tasks

1. **Milestone 0 — Freeze the safety boundary**
   - Files: no project files.
   - Changes:
     - Capture binary diffs, status, untracked-file manifests, target-file hashes, HEADs, and staged paths for both repositories.
     - Preserve the existing external baseline snapshot.
     - Define the recovery allowlist before each writer starts.
     - Record unrelated catalog dirt, including the deleted `.gitignore` and untracked `.shopsite-cms/`, exports, and brand mappings.
     - Verify sufficient free space and an available SQLite backup method before any live DB migration.
   - Acceptance:
     - Outer index is empty.
     - Nested catalog index is empty.
     - Existing unrelated paths are byte-identical.
     - No database or catalog product file was mutated.
   - Checkpoint:
     - Every later writer reports changed files, tests, status delta, and whether any allowlist expansion was required.
     - Stop rather than using Git reset/restore if rollback is needed.

2. **Milestone 1 — Repair onboarding proposal decisions and UI state**
   - Files:
     - `src/shared/schemas/classification.ts`
     - `src/db/classification-migration.sql`
     - `src/db/migrations.ts`
     - `src/db/repositories/classification-run-repo.ts`
     - `src/classification/proposal-review-service.ts`
     - `src/server/routes/onboarding-routes.ts`
     - `src/client/onboarding-api.ts`
     - `src/client/components/PipelineBoard.tsx`
     - `src/onboarding/draft-promoter.ts`
   - New file:
     - `src/client/pipeline-decision-state.ts`
   - Changes:
     - Reuse one strict decision-input schema for catalog and onboarding routes.
     - Preserve explicit-null revised values and targets.
     - Hydrate both proposals and evidence from the active run.
     - Prevent generic item updates from persisting client copies of canonical proposal/evidence arrays.
     - Extract effective-value, effective-target, semantic-equality, request-building, and queue logic from `PipelineBoard`.
     - Keep original prediction fields immutable.
     - Submit only the changed proposal.
     - Separate ordinary item autosave from proposal-decision submission.
     - Snapshot action tokens, predecessor IDs, and payloads at enqueue time.
     - Reuse a token only for an exact retry.
     - Propagate failed/conflicted drains so final approval cannot continue.
     - On HTTP 409, refresh canonical state and require the reviewer to reapply the edit.
     - Guard drawer/SSE updates by item ID and request generation.
   - Tests:
     - Add `src/tests/unit/pipeline-decision-state.test.ts`.
     - Add `src/tests/unit/onboarding-decision-routes.test.ts`.
     - Extend `catalog-classification-db.test.ts`, `classification-schema.test.ts`, `onboarding-repos.test.ts`, and `draft-promoter.test.ts`.
   - Acceptance:
     - Reopened corrections display revised values, including explicit null.
     - Accept-only actions do not manufacture corrections.
     - Unrelated autosaves create no decision rows.
     - Final approval does not resubmit decided proposals.
     - Conflict or failed autosave blocks approval.
     - `PipelineBoard.tsx` has no TypeScript errors.
     - Existing append-only revision and idempotency tests continue passing.

3. **Milestone 2 — Add deterministic hashing and strict configuration v2**
   - Files:
     - `src/shared/schemas/classification.ts`
     - `src/shared/types.ts`
     - `src/classification/config-loader.ts`
     - `src/db/repositories/classification-config-repo.ts`
     - `src/git/deterministic-json.ts`
   - New files:
     - `src/shared/stable-id.ts`
     - `src/classification/config-validation.ts`
     - `src/classification/config-migrate-v1.ts`
   - Changes:
     - Add canonical JSON and SHA-256 utilities.
     - Replace permissive ISO strings with validated timestamps where persisted input requires them.
     - Define strict v2 focused-file envelopes and manifest semantics.
     - Add `isUniversal`, typed applicability conditions, strict serialization variants, evidence-directness policies, claim/composition policies, and ML feature policy.
     - Replace free-form serialization with `scalar`, `delimited`, and `measured` variants.
     - Make configuration reads pure: no directory creation, defaults, swallowed JSON errors, or return of unvalidated data.
     - Make the v1 reader migration-only and preserve existing IDs without inventing aliases or semantics.
     - Validate cross-file references, uniqueness, mappings, profiles, policies, cardinality, claims, and catalog-field existence.
   - Tests:
     - Add `classification-config-loader.test.ts`.
     - Add `classification-config-validation.test.ts`.
     - Add stable-ID/canonical-hash tests.
   - Acceptance:
     - Missing, malformed, unsupported, hash-mismatched, or semantically inconsistent config fails closed.
     - Reading config changes no filesystem metadata.
     - Canonically equivalent JSON produces the same SHA-256.
     - v1 migration is deterministic and does not activate anything.
     - Runtime static checks pass before proceeding.

4. **Milestone 3 — Implement the sole configuration writer and catalog evidence generator**
   - Files:
     - `src/classification/config-loader.ts`
     - `src/classification/legacy-migration.ts`
     - `src/server/routes/classification-routes.ts`
     - `src/server/services/workspace-service.ts`
     - `src/db/repositories/classification-config-repo.ts`
   - New files:
     - `src/classification/config-store.ts`
     - `src/classification/catalog-evidence.ts`
     - `src/classification/config-generator.ts`
     - `src/classification/config-seeds/bay-state-pet-garden-v1.ts`
   - Changes:
     - Make `config-store` the only mutation seam.
     - Implement preview and compare-and-swap activation using `expectedActiveHash`.
     - Serialize writes with an in-process queue and an OS lock under `.shopsite-cms/locks/`.
     - Write a complete sibling staging directory, fsync it, and atomically replace the active directory.
     - Update the derived SQLite cache transactionally only after file validation.
     - Roll back files/cache if exact-path Git staging or commit fails.
     - Never stage anything outside `store/classification/**`.
     - Remove cache synchronization from `getCurrentWorkspace()`.
     - Make legacy migration produce a candidate only.
     - Scan canonical product JSON and `store/field-registry.json` to produce deterministic field counts, distinct-value hashes, delimiter evidence, parse failures, source tree/commit hashes, and name-only Page observations.
     - Generate candidates from reviewed seed data plus catalog evidence; never infer field semantics merely from value frequency.
     - Test Git behavior using a temporary nested repository, not the live catalog.
   - Approved seed Product Types:
     - Historical: `dog-toys`, `cat-toys`, `grooming`, `dog-waste-bags`, `dog-food-dry`, `dog-food-wet`, `dog-treats`, `cat-food-dry`, `cat-food-wet`, `cat-treats`, `cat-litter`, `supplements`, `collars-leashes`.
     - Expansion: `flea-tick-treatment`, `bird-food`, `lawn-fertilizer`, `grass-seed`, `weed-control`, `insect-control`, `potting-soil`, `hand-tools`.
   - Tests:
     - Add `classification-config-store.test.ts`.
     - Add `catalog-evidence.test.ts`.
     - Add candidate-generation determinism and seed-reference tests.
   - Acceptance:
     - Concurrent activation attempts serialize or receive 409.
     - Partial write/cache/Git failures restore the prior active bundle.
     - Unrelated nested-repository dirt is unchanged.
     - Two evidence/generation runs over identical inputs are byte-identical.
     - No live configuration is activated during this milestone.

5. **Milestone 4 — Make runs consume an immutable runtime snapshot**
   - Files:
     - `src/classification/types.ts`
     - `src/classification/pipeline-runner.ts`
     - `src/classification/catalog-product-classifier.ts`
     - `src/classification/catalog-product-source.ts`
     - `src/onboarding/product-curator.ts`
     - `src/classification/curation-target-resolver.ts`
     - `src/classification/product-evidence-extractor.ts`
     - `src/classification/stages/*.ts`
     - `src/db/repositories/classification-config-repo.ts`
   - New files:
     - `src/classification/runtime-snapshot.ts`
     - `src/classification/reviewed-facts.ts`
   - Changes:
     - Add the immutable snapshot directly to `StageContext`.
     - Build and persist it once before run creation.
     - Deep-freeze it in memory and verify its hash before stage persistence.
     - Resolve Product Types, attributes, model policy, guidance, field values, reviewed facts, and verified Page records before the pipeline starts.
     - Convert the target resolver into a pure function over the snapshot.
     - Remove stage-facing cached-config and mutable Page reads.
     - Include the complete source evidence hash, including search keywords and actual product-side Page names.
     - Fix catalog classification so a product receives only its own ProductOnPages observations—not every store Page.
     - Mark Page context low reliability and prohibit it from supporting claims or composition.
     - Verify proposal/evidence run IDs and snapshot hashes before persistence.
   - Tests:
     - Add `classification-runtime-snapshot.test.ts`.
     - Extend catalog-source tests for per-product Page evidence and source-hash drift.
   - Acceptance:
     - Mutating config, cache, Page rows, or model settings during a run does not change stage output.
     - Replaying the same deterministic snapshot produces the same candidates.
     - Every persisted proposal points to the run snapshot hash.
     - No stage reloads workspace classification files or queries candidate caches.

6. **Milestone 5 — Enforce type gating, applicability, claim safety, and one serializer**
   - Files:
     - `src/classification/proposal-selection.ts`
     - `src/classification/stages/attribute-applicability.ts`
     - `src/classification/stages/attribute-proposals.ts`
     - `src/classification/stages/category-page-proposals.ts`
     - `src/classification/curation-target-processor.ts`
     - `src/classification/curation-target-proposal.ts`
     - `src/classification/assignment-projection.ts`
     - `src/classification/stages/draft-projection.ts`
     - `src/classification/catalog-product-application.ts`
     - `src/classification/review-completion-gate.ts`
     - `src/classification/proposal-review-service.ts`
     - `src/classification/refresh-queue-processor.ts`
     - `src/onboarding/draft-promoter.ts`
     - `src/db/classification-migration.sql`
     - `src/db/migrations.ts`
   - New file:
     - `src/classification/proposal-safety.ts`
   - Changes:
     - Split accepted Primary Product Type from UI-only preview selection.
     - Add explicit applicability states and deterministic condition evaluation.
     - Let universal attributes proceed without a Product Type.
     - Require a reviewed Product Type for profile attributes.
     - Require both a reviewed Product Type and verified Page catalog for Page proposals.
     - Add a central candidate safety validator.
     - Claims require linked direct evidence; absence, inference, and Page context are rejected.
     - Composition requires an explicitly permitted provenance/source policy.
     - Use one projection/serialization function in preview, onboarding promotion, and catalog application.
     - Validate cardinality, aliases, controlled membership, measured units, delimiters, and explicit clear semantics.
     - Never treat confidence as permission to bypass review.
     - Queue a dependent refresh when a Primary Product Type decision changes.
     - Carry compatible accepted type decisions into the next snapshot as reviewed facts; preserve provenance and reject drift.
   - Tests:
     - Add `attribute-applicability.test.ts`.
     - Add `classification-claim-safety.test.ts`.
     - Add `catalog-field-serialization.test.ts`.
     - Reverse provisional-gating expectations in `classification-pipeline.test.ts`.
     - Extend promoter/application/review-gate tests.
   - Acceptance:
     - Pending type guesses produce no decision-eligible type-gated attribute or Page proposal.
     - Type acceptance causes a refresh whose snapshot cites the accepted decision.
     - Claims cannot arise from absence, Page context, inference, or an unapproved source.
     - ShopSite multi-values use validated field-specific delimiters.
     - Skipped assignments remain visible but do not prevent the rest of the draft.

7. **Milestone 6 — Demote synthetic Pages and implement the safe import architecture**
   - Files:
     - `src/db/schema.sql`
     - `src/db/migrations.ts`
     - `src/db/repositories/page-repo.ts`
     - `src/server/routes/page-routes.ts`
     - `src/classification/curation-target-proposal.ts`
     - `src/classification/assignment-projection.ts`
     - `src/classification/catalog-product-application.ts`
     - `src/onboarding/draft-promoter.ts`
   - New files:
     - `src/shared/schemas/page.ts`
     - `src/db/repositories/page-import-repo.ts`
     - `src/shopsite/page-candidate-importer.ts`
     - `src/shopsite/page-import-service.ts`
   - Changes required now:
     - Add `page_imports` with source hash, parser/format version, status, counts, and timestamps.
     - Add workspace/import provenance, identity kind/key/status, source hash, availability, and review status to `page_index`.
     - Preserve local row IDs across imports by verified identity key.
     - Permit duplicate names; never make name the identity key.
     - Mark existing 152 rows `unverified_name_only`.
     - Clear inferred `product_pages.page_id` references while preserving Page names and assignment history.
     - Mark proposals referring to inferred IDs stale/unavailable without deleting decisions.
     - Scan local ProductOnPages fragments into deterministic provisional candidates with counts, sample SKUs, and source hashes.
     - Separate provisional candidate routes from authoritative Page option routes.
     - Replace unrestricted authoritative Page upsert/delete with preview/activation services.
     - Implement preview/activation over normalized Page records and a parser-adapter contract.
     - Leave no ShopSite XML parser registered until a real fixture exists.
     - Refuse Page serialization unless identity is verified in the currently active import.
   - Tests:
     - Add `page-candidate-importer.test.ts`.
     - Add `page-import-service.test.ts` using a fake normalized adapter.
     - Add `page-identity-migration.test.ts`.
     - Update Page assignment, application, promoter, and route tests.
   - Acceptance:
     - Migration preserves all observed names/history but no current synthetic UUID is considered live.
     - Provisional names never enter verified Page options.
     - Page target resolution returns unavailable while no active verified import exists.
     - Name-only accepted data cannot be serialized into ProductOnPages.
     - Import preview has no DB effect; normalized activation is atomic.
   - Explicitly deferred until a real export:
     - `src/shopsite/page-parser.ts`
     - a real redacted ShopSite Pages fixture;
     - XML root/tag/relationship parsing;
     - `fetchPagesXml()` activation;
     - verified Page activation, reconciliation, hierarchy, Page benchmark labels, and Page reranker qualification.

8. **Milestone 7 — Generate and activate Bay State configuration v2**
   - Files in nested catalog repository:
     - `storage/catalog/store/classification/manifest.json`
     - `product-types.json`
     - `attributes.json`
     - `attribute-profiles.json`
     - `mappings.json`
     - `curation-targets.json`
     - `guidance.json`
     - `brands.json`
     - `model-policies.json`
     - `data-sharing.json`
     - new `catalog-evidence.json`
   - Changes:
     - Run the catalog evidence scan twice and verify identical bytes/hash.
     - Generate a candidate from the approved 21-type seed.
     - Create conservative profiles:
       - pet food/treat/bird-food profiles contain only applicable pet-food fields;
       - pet accessory profiles contain only identity/material/color/size fields that apply;
       - garden profiles contain Department, Category, packaging, and applicable material fields, never pet attributes;
       - claims/composition fields remain inactive.
     - Make Brand universal and manual-reviewable; do not pretend the current short allowed-value list is complete.
     - Preserve reviewed mappings:
       - Brand → `ProductField16`
       - Species → `ProductField17`
       - Life Stage → `ProductField18`
       - Breed Size → `ProductField19`
       - Dietary Features → `ProductField20`
       - Health Benefits → `ProductField21`
       - Food Form → `ProductField22`
       - Flavor → `ProductField23`
       - Department → `ProductField24`
       - Category → `ProductField25`
       - plus the existing reviewed packaging/material/color/nutrition mappings.
     - Never map Product Type directly to ProductField24 or ProductField25.
     - Enable Product Type and safe non-claim field targets.
     - Disable claims/composition targets until their policies are explicitly satisfied.
     - Set the Page target to `enabled:false`, `mandatory:false`, `required:false`.
     - Set all ML production features disabled.
     - Include the approved conservative benchmark thresholds in policy.
     - Preview against the expected active hash.
     - Activate atomically and create exactly one nested catalog commit containing only `store/classification/**`.
   - Acceptance:
     - Semantic validation has zero blockers.
     - Repeated generation is byte-identical.
     - Runtime loads the committed v2 bundle and its cache hash matches.
     - The nested commit contains no `.gitignore`, exports, `.shopsite-cms`, brand mapping, or product changes.
     - The outer repository remains completely unstaged.
     - A local fixture classification proposes Product Type/Brand safely and abstains from Pages.
   - Rollback:
     - Reactivate the prior immutable bundle through `config-store`; do not use filesystem copying or Git reset.
     - Rollback creates a new audit record/hash and invalidates dependent proposals.

9. **Milestone 8 — Rebuild the offline corpus and Silver pipeline**
   - Files:
     - `src/crawler/corpus-schema.ts`
     - `src/crawler/base-crawler.ts`
     - `src/crawler/dataset-exporter.ts`
     - `src/crawler/sites/chewy.ts`
     - `src/crawler/sites/tractor-supply.ts`
     - `src/crawler/sites/burpee.ts`
     - `src/crawler/sites/ace-hardware.ts`
     - `src/crawler/importers/open-pet-food-facts.ts`
     - `src/crawler/importers/icecat.ts`
     - `src/crawler/importers/brightdata-scraper.ts`
     - `scripts/crawl-corpus.ts`
     - `scripts/consolidate-datasets.ts`
     - `scripts/import-open-data.ts`
     - `scripts/import-pet-food-only.ts`
     - `scripts/run-brightdata-crawl.ts`
     - `src/classification/datasets/silver-builder.ts`
     - `src/classification/taxonomy/**`
     - `src/classification/presets/preset-pet-and-garden.ts`
   - New files:
     - `src/crawler/url-policy.ts`
     - `src/crawler/corpus-validator.ts`
     - `src/crawler/corpus-manifest.ts`
     - `src/classification/datasets/weak-label-rules.ts`
   - Changes:
     - Replace prefix-derived IDs with source-scoped SHA-256 entity and observation IDs.
     - Centralize URL/hostname/redirect validation.
     - Reject credentials, IP/private targets, deceptive suffixes, malformed hosts, and unsupported schemes/ports.
     - Require positive product-page evidence before a record is accepted.
     - Add strict provenance, acquisition mode, parser version, payload hash, raw URL, validation state, quality flags, license status, and GTIN validation.
     - Preserve every Bronze observation; select deterministic representatives only for Silver.
     - Report invalid JSON, rejected records, and duplicate groups instead of silently discarding them.
     - Write atomic, immutable, content-addressed manifests.
     - Require explicit operator flags for any network or paid script; do not execute them.
     - Remove the static taxonomy registry from executable authority.
     - Resolve weak-label target IDs against the activated canonical config.
     - Use joint species/form rules; never label from absence.
     - Emit no guessed Pages and no Product Type → ProductField24 assignment.
     - Preserve `silver-v1.jsonl` unchanged.
     - Audit all 73 existing lines and produce local normalized Bronze and `silver-v2-<digest>.jsonl` artifacts.
   - Tests:
     - Add `corpus-schema.test.ts`.
     - Add `crawler-url-policy.test.ts`.
     - Add `corpus-pipeline.test.ts`.
     - Replace static taxonomy tests with canonical-config-backed weak-label tests.
   - Acceptance:
     - Every one of the 73 legacy rows is accounted for as accepted, rejected, or duplicate.
     - No two distinct source locators collide.
     - Category/interstitial/blocked pages are rejected.
     - Repeated offline regeneration is byte-identical.
     - Silver v2 has provenance and abstains where evidence is insufficient.
     - No network or paid provider was contacted.

10. **Milestone 9 — Replace mutable benchmarks with frozen Gold and prediction contracts**
    - Files:
      - `src/shared/schemas/classification.ts`
      - `src/db/schema.sql`
      - `src/db/migrations.ts`
      - `src/db/repositories/benchmark-repo.ts`
      - `src/classification/benchmark-exporter.ts`
      - `src/classification/benchmark-evaluator.ts`
      - `src/classification/confidence-calibrator.ts`
      - `src/server/routes/benchmark-routes.ts`
    - New files:
      - `src/classification/benchmark-prediction.ts`
      - `src/classification/benchmark-qualification.ts`
      - `src/classification/feature-policy.ts`
    - Changes:
      - Add draft/frozen/retired datasets, immutable examples, hashes, family grouping, splits, reviewer/adjudication provenance, and source hashes.
      - Export the exact reviewed run and effective revised decisions; never qualify on one run and export another.
      - Exclude stale/config-drift/source-drift records.
      - Exclude Page labels until verified Page identity exists.
      - Require family grouping review before freeze.
      - Persist complete prediction bundles before evaluation.
      - Make the evaluator pure over frozen Gold plus a prediction bundle.
      - Correct Product Type and field metrics, denominators, abstentions, coverage, calibration, confusion matrices, and paired regressions.
      - Use a deterministic 95% paired bootstrap interval seeded from the dataset/candidate digests.
      - Encode the approved gate:
        - holdout ≥ 200;
        - support ≥ 20 per evaluated class;
        - coverage ≥ 0.80;
        - zero cross-species, claim-safety, and controlled-value violations;
        - lower 95% confidence bound for the predeclared paired primary-metric delta above zero;
        - task-specific non-regression floors.
      - Replace auto-accept semantics with abstention/review-tier semantics.
      - Make qualification necessary but not sufficient for activation.
    - Tests:
      - Add benchmark freeze, prediction, metric, paired-bootstrap, feature-policy, and workspace-ownership tests.
    - Acceptance:
      - Evaluations are repeatable and do not query current runs/decisions.
      - Missing/duplicate/wrong-digest predictions fail closed.
      - Frozen examples cannot be modified.
      - The current limited reviewed population reports `insufficient_sample`; it cannot qualify production ML.
      - Page reranking reports `blocked_missing_verified_page_gold`.

11. **Milestone 10 — Repair embeddings, retrieval, reranking, calibration, and routes in evaluation-only mode**
    - Files:
      - `src/classification/embedding-client.ts`
      - `src/classification/embedding-maintenance.ts`
      - `src/classification/product-retrieval.ts`
      - `src/classification/page-reranker.ts`
      - `src/classification/confidence-calibrator.ts`
      - `src/db/repositories/embedding-repo.ts`
      - `src/server/routes/embedding-routes.ts`
      - `src/server/routes/benchmark-routes.ts`
      - `src/server/app.ts`
    - New file:
      - `src/classification/retrieval-index.ts`
    - Changes:
      - Version canonical embedding documents and bind them to source/config/decision hashes.
      - Store model/provider fingerprint, dimension, schema version, namespace, timestamps, and failure status.
      - Implement desired-set maintenance with no-op, upsert, stale/tombstone/delete, corrupt-vector, and wrong-model handling.
      - Add one maintenance lock and bounded resumable batches.
      - Validate finite values and dimensions.
      - Isolate exact cosine search behind a replaceable retrieval-index interface.
      - Build benchmark indexes from train-only examples and exclude query SKU/family and holdout labels.
      - Return stable IDs and full reviewed-run provenance.
      - Disable Page hierarchy/reranking without verified Page identity.
      - Fit calibration from example-level development predictions only.
      - Mount benchmark routes once under `/api`.
      - Change local route paths to `/benchmark/...` and `/embeddings/...`; remove the doubled `/api`.
      - Scope every lookup to the current workspace.
      - Make production embedding/retrieval requests return a policy-disabled response.
      - Permit evaluation namespace maintenance only with an explicit valid request and feature policy.
      - Use mocked HTTP in tests; perform no live model request.
    - Tests:
      - Add embedding-client, maintenance, retrieval leakage, namespace, reranker, calibration, and route tests.
    - Acceptance:
      - Rebuild reaches real maintenance rather than returning a stub message.
      - Production namespaces remain disabled.
      - Corrupt/wrong-dimension vectors are errors, not zero-similarity results.
      - Evaluation indexes cannot leak holdout or same-family examples.
      - No ML path inserts a Proposal Decision.
      - No Page reranking executes without verified Page data.

12. **Milestone 11 — Integrate canonical validation and perform independent review**
    - Files:
      - `package.json`
      - `vitest.config.ts`
      - touched tests/configuration only.
    - Changes:
      - Make `test:db` include every DB-backed suite delivered by these milestones.
      - Make `test` compose `vitest run && bun run test:db`.
      - Remove nonexistent exclusions or add the corresponding delivered suite.
      - Keep Bun/SQLite suites out of Vitest.
      - Do not change dependencies merely to add a DOM harness; pure state tests are sufficient for this recovery.
      - Run focused static checks after every milestone, then the full validation ladder.
      - Run fresh-context review passes for:
        - runtime correctness and data safety;
        - migrations/config activation/rollback;
        - UI concurrency and review preservation;
        - corpus/benchmark leakage;
        - repository hygiene and scope.
      - Send accepted review findings through one final sequential fix worker.
    - Final commands:
      - `bun run typecheck`
      - `bun run build`
      - `bun run test`
      - focused ESLint over all recovery files
      - `bun run lint`, with unrelated pre-existing failures separately proven if any remain
      - `git diff --check`
      - repeated config generation and SHA-256 comparison
      - repeated corpus regeneration and SHA-256 comparison
      - repeated deterministic benchmark evaluation
      - status/staged-path inspection in both repositories
    - Acceptance:
      - All recovery tests and static checks pass.
      - No relevant suite is excluded from the canonical command.
      - Outer repository has no staged files.
      - Nested repository contains exactly one scoped classification activation commit and no staged files.
      - Unrelated baseline paths remain unchanged.
      - No product JSON, workspace export, credential, paid-crawl artifact, or generated session file is committed.
      - Residual Page and sample-size blockers are explicitly visible in API/config state rather than hidden.

## Files to Modify

### Runtime, configuration, and classification

- `src/shared/schemas/classification.ts`
- `src/shared/types.ts`
- `src/classification/config-loader.ts`
- `src/classification/legacy-migration.ts`
- `src/classification/types.ts`
- `src/classification/pipeline-runner.ts`
- `src/classification/catalog-product-classifier.ts`
- `src/classification/catalog-product-source.ts`
- `src/classification/curation-target-resolver.ts`
- `src/classification/product-evidence-extractor.ts`
- `src/classification/proposal-selection.ts`
- `src/classification/curation-target-processor.ts`
- `src/classification/curation-target-proposal.ts`
- `src/classification/assignment-projection.ts`
- `src/classification/review-completion-gate.ts`
- `src/classification/proposal-review-service.ts`
- `src/classification/refresh-queue-processor.ts`
- `src/classification/catalog-product-application.ts`
- `src/classification/stages/*.ts`
- `src/classification/datasets/silver-builder.ts`
- `src/classification/presets/preset-pet-and-garden.ts`
- `src/classification/taxonomy/**` — remove from executable authority.

### Review UI and onboarding

- `src/client/components/PipelineBoard.tsx`
- `src/client/onboarding-api.ts`
- `src/server/routes/onboarding-routes.ts`
- `src/onboarding/product-curator.ts`
- `src/onboarding/draft-promoter.ts`

### Database and repositories

- `src/db/schema.sql`
- `src/db/classification-migration.sql`
- `src/db/migrations.ts`
- `src/db/repositories/classification-config-repo.ts`
- `src/db/repositories/classification-run-repo.ts`
- `src/db/repositories/page-repo.ts`
- `src/db/repositories/benchmark-repo.ts`
- `src/db/repositories/embedding-repo.ts`

### Crawler and datasets

- `src/crawler/corpus-schema.ts`
- `src/crawler/base-crawler.ts`
- `src/crawler/dataset-exporter.ts`
- `src/crawler/sites/chewy.ts`
- `src/crawler/sites/tractor-supply.ts`
- `src/crawler/sites/burpee.ts`
- `src/crawler/sites/ace-hardware.ts`
- `src/crawler/importers/open-pet-food-facts.ts`
- `src/crawler/importers/icecat.ts`
- `src/crawler/importers/brightdata-scraper.ts`
- `scripts/crawl-corpus.ts`
- `scripts/consolidate-datasets.ts`
- `scripts/import-open-data.ts`
- `scripts/import-pet-food-only.ts`
- `scripts/run-brightdata-crawl.ts`

### Benchmark, retrieval, and routes

- `src/classification/benchmark-exporter.ts`
- `src/classification/benchmark-evaluator.ts`
- `src/classification/embedding-client.ts`
- `src/classification/embedding-maintenance.ts`
- `src/classification/product-retrieval.ts`
- `src/classification/page-reranker.ts`
- `src/classification/confidence-calibrator.ts`
- `src/server/routes/classification-routes.ts`
- `src/server/routes/page-routes.ts`
- `src/server/routes/benchmark-routes.ts`
- `src/server/routes/embedding-routes.ts`
- `src/server/services/workspace-service.ts`
- `src/server/app.ts`

### Tooling and canonical configuration

- `package.json`
- `vitest.config.ts`
- `src/git/deterministic-json.ts`
- `storage/catalog/store/classification/*.json`

## New Files

- `src/shared/stable-id.ts` — canonical JSON and SHA-256 identities.
- `src/shared/schemas/page.ts` — Page import, provenance, and identity contracts.
- `src/client/pipeline-decision-state.ts` — pure review-draft and transport state.
- `src/classification/config-validation.ts` — structural and semantic validation.
- `src/classification/config-migrate-v1.ts` — deterministic migration-only v1 reader.
- `src/classification/config-store.ts` — sole preview/activation writer.
- `src/classification/catalog-evidence.ts` — deterministic catalog scan.
- `src/classification/config-generator.ts` — candidate generator.
- `src/classification/config-seeds/bay-state-pet-garden-v1.ts` — approved 21-type seed.
- `src/classification/runtime-snapshot.ts` — immutable run snapshot builder.
- `src/classification/reviewed-facts.ts` — compatible accepted-decision facts.
- `src/classification/proposal-safety.ts` — claims/composition evidence enforcement.
- `src/classification/feature-policy.ts` — fail-closed ML policy evaluation.
- `src/classification/benchmark-prediction.ts` — immutable prediction bundles.
- `src/classification/benchmark-qualification.ts` — conservative qualification receipts.
- `src/classification/retrieval-index.ts` — replaceable vector-index interface.
- `src/classification/datasets/weak-label-rules.ts` — versioned, config-bound weak rules.
- `src/crawler/url-policy.ts` — canonical safe URL/hostname policy.
- `src/crawler/corpus-validator.ts` — product-page and provenance validation.
- `src/crawler/corpus-manifest.ts` — immutable content-addressed manifests.
- `src/db/repositories/page-import-repo.ts` — Page import persistence.
- `src/shopsite/page-candidate-importer.ts` — provisional ProductOnPages evidence.
- `src/shopsite/page-import-service.ts` — normalized preview/activation seam.
- Targeted test files named in each milestone.
- `storage/catalog/store/classification/catalog-evidence.json` — compact committed evidence attestation.

### Deferred New Files

- `src/shopsite/page-parser.ts`
- `src/tests/fixtures/shopsite-pages-bay-state-redacted.xml`

These must not be created from guessed XML.

## Dependencies

- Milestone 1 is independent and should land first to protect reviewer corrections.
- Milestone 2 is required by every later hash, config, corpus, and benchmark artifact.
- Milestone 3 depends on Milestone 2.
- Milestone 4 depends on validated configuration contracts from Milestones 2–3.
- Milestone 5 depends on immutable snapshots from Milestone 4.
- Milestone 6 depends on the safety/projection seams from Milestone 5.
- Milestone 7 requires Milestones 2–6 and is the only milestone permitted to commit in `storage/catalog`.
- Milestone 8 requires the activated configuration digest from Milestone 7.
- Milestone 9 requires stable config/runtime identities and decision fixes from Milestones 1, 4, 5, and 7.
- Milestone 10 requires the feature policy and frozen prediction contracts from Milestone 9.
- Milestone 11 depends on all implementation milestones.
- Actual Page XML parsing, verified Page activation, Page Gold labels, and Page reranker qualification remain blocked on a real export regardless of code completion.
- Production ML remains blocked until the dataset meets the approved qualification policy; the current reviewed population is insufficient.

## Risks

- **Missing Page export:** Live Page identity, hierarchy, Page assignment, Page evaluation, and Page reranking cannot be completed safely.
- **Insufficient Gold volume:** Existing reviewed data cannot meet the approved 200-item/20-per-class gate, so production ML will remain disabled.
- **Dirty repositories:** Mixed existing hunks make accidental overwrite or staging the largest operational risk. Every milestone needs baseline/hash comparison.
- **Live SQLite size and locking:** The approximately 1.7 GB DB may require downtime and substantial backup space. Migrations must not begin without a verified backup.
- **Taxonomy vocabulary quality:** The 21 Product Types are approved, but allowed values and aliases remain evidence-driven. Ambiguous values must stay inactive/manual rather than be guessed.
- **Licensing:** Open Pet Food Facts, Icecat, and provider data remain local until redistribution rights are reviewed.
- **Config migration compatibility:** v2 activation must occur only after every runtime loader/consumer supports the new envelopes.
- **Nested Git activation:** A commit failure must restore files/cache and must not leave a partially active uncommitted bundle.
- **No live model validation:** Embedding and model client behavior will be covered with mocks only in this pass.
- **Existing lint debt:** Broad unrelated failures must be separated with before/after evidence rather than hidden through new exclusions.
- **Refresh semantics:** Accepted reviewed facts must be source/config compatible; careless carry-forward could reintroduce stale classifications.
- **Corpus shrinkage:** Strict validation may reject most of the current 73 records. That is expected and safer than retaining contaminated examples.
## Post-recovery addendum (issue #17, 2026-08-09)

The issue-17 remediation plan (`docs/plans/` + governance doc) executed passes
A–M after the M0–M11 recovery: local-only model boundary (A), accepted-only
promotion (B/K), verified Page snapshot + readiness (D1/L), model-call
provenance (E), target evidence + citations (H/I), integrity tooling (C1),
production telemetry (F), controlled-value identity (G), built-in output
policy (J), live integrity repair (C2), and the user-reviewed config-store
activation enabling the Category Page target (D2). See
`docs/governance-17-alignment.md` for the evidence-backed registry with
commit IDs, hashes, and operational results. M0–M11 decisions above remain
authoritative.

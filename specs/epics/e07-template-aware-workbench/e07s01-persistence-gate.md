<!-- story: e07s01 -->

# e07s01 — Fix persistence + evidence-gated activation — transactional immutable versions and MatrixResult-bound testsPass

## Story

As an operator who activates a domain extractor profile, I want versions to be truly immutable and activation to be gated on persisted runner evidence (not a transient flag) so that a restart never loses history and a degraded profile cannot be mistaken for healthy.

## Context

e06 shipped the workspace, suite, LLM build, and matrix as Maps and derived state (profile-version-repo.ts in-memory, ProfileWorkspacePage:55 testsPass = active+3). The spike confirmed this loses versions on restart and lets active+3 masquerade as passing. This tracer-bullet hardens the seam before the workbench is reworked — no UI rewrite yet, just the transactional foundation the other stories depend on.

Depends on: e06 done (231f...). Provides: version persistence and evidence contract for e07s02-s04.

## Business Narrative

Operator builds a draft against 3 confirmed products, runs the full-width matrix via the production static/rendered runner, and activates. Later after a deploy/restart, the history still shows the same immutable version, active pointer unchanged, and any edit/drift correctly re-derives readiness from evidence rather than a cached boolean. Attempting to activate when one sample fails or evidence is missing is hard-blocked with an expanded reason.

## Requirements

### MODIFIED: profile-version-repo persistence — transactional immutable versions

- Replace in-memory Maps (versionsById, versionsByDomain, activePointer) with SQLite tables created by migration:
```sql
CREATE TABLE profile_versions (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  version INTEGER NOT NULL,
  selectors TEXT NOT NULL, -- JSON: {field: recipe} including template routes when present
  runtime TEXT NOT NULL,
  sample_ids TEXT NOT NULL, -- JSON array
  artifact_hashes TEXT NOT NULL, -- JSON array bound to capture hashes
  validation_summary TEXT NOT NULL, -- JSON
  provenance TEXT NOT NULL, -- JSON {provider, model, configId, promptHash}
  approver TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(domain, version)
);
CREATE TABLE profile_active (
  domain TEXT PRIMARY KEY,
  active_version_id TEXT REFERENCES profile_versions(id)
);
```
- Operations run in a single transaction: INSERT version → UPSERT active pointer (activate/rollback). rollback moves pointer atomically and retains prior rows. getActiveVersion/getVersionById read through SQLite, not Maps.
- Migration seeds existing extractor_profiles single-row (if any) as version 1 with artifact_hashes = [] and provenance = {provider:"legacy", model:"unknown", configId:"legacy"} so history is not lost. e06's Map behavior becomes the migration source, then deleted.

### ADDED: MatrixResult-bound evidence contract

- profile-test-matrix remains in-memory Map<domain::version, MatrixResult> but the runner writes a persisted binding: for each version, store validation_summary.artifactHashes = sorted artifact hashes produced by the runner. A version is activatable only when artifactHashes exactly matches the hashes of the captures used in the matrix run (no silent substitution).
- No file or version is considered passing without a MatrixResult whose rows cover every confirmed sample in domain_representative_suite at matrix-run time.

### MODIFIED: Derive testsPass/readiness from persisted evidence (fix high drift)

- In ProfileWorkspacePage and profile-readiness.ts, replace testsPass = isActive && confirmed>=3 with:
  testsPass = hasPersistedVersion && hasMatrixResultForActiveVersion && everyRowPassed(matrix, requiredFields) && artifactHashesMatch
- Readiness state machine (deriveReadinessState) adds a check: if isActive && !testsPass → Degraded (not Active). Needs testing/Ready for approval likewise require a passing MatrixResult, not just hasDraft.
- Hono GET /api/domains/:domain/profile-state includes testsPassEvidence: { versionId, artifactHashes, validatedAt } so the client is not left to recompute.

### ADDED: Fail-closed activation gate on evidence

- profile-activation-gate.ts:evaluateGate receives the persisted MatrixResult; missing MatrixResult or artifact mismatch → not activatable with reason codes `missing_matrix` / `artifact_mismatch`. Existing codes wrong_product / wrong_variant / imageRuleOk / needs_waiver remain and are still required.
- Activating without evidence returns 409 with expanded payload: { reason, expectedArtifacts, actual, provenance, actionableNextStep: "Revise" } — never auto-activates on drift, only hard-blocks.

### MODIFIED: No grandfathering after migration

- After migration, any pre-existing active extractor_profiles that lack a passing MatrixResult for that version are immediately derived as Degraded/Needs testing (not Active) and extraction remains parked as setup_required_profile until a new matrix pass. This matches e06s04's no-grandfather decision, now enforced by evidence.

## Acceptance Criteria (Gherkin — §17)

```gherkin
Feature: Immutable versions and evidence-gated activation

  Scenario: Restart retains history
    Given domain "example.com" has active version "v3" with 3 samples
    When the server restarts and GET /api/domains/example.com/profile-state is called
    Then profile_versions still contains v1..v3
    And profile_active points at v3
    And readiness is Active (not Not configured) before any new matrix run

  Scenario: Evidence gates Active vs Degraded
    Given domain "example.com" has active version "v5" with no MatrixResult
    When GET /api/domains/example.com/profile-state is called
    Then readiness is Degraded
    And testsPass is false
    And POST /api/domains/example.com/profile/activate for v5 without matrix returns 409 missing_matrix

  Scenario: Artifact binding blocks substitution
    Given version "v6" was validated against captures [h1,h2,h3]
    And a new capture set [h1,h2,h4] is produced (one sample replaced)
    When POST /api/domains/example.com/profile/activate for v6 with mismatched hashes is attempted
    Then response is 409 artifact_mismatch with expected vs actual hashes
    And a Revise action is required, not auto-activation

  Scenario: Matrix must cover every confirmed sample
    Given domain has 4 confirmed reps
    And MatrixResult covers only 3 of 4
    When evaluateGate is called for that version
    Then result is not activatable (needs full coverage)
    And workspace shows Needs testing with the missing sample highlighted
```

## Solution (§5) — Steps

### Story e07s01: Persistence + evidence gate — Implementation Steps

1. Write migration SQL (profile_versions, profile_active) and add it to the SQLite migrator; make initDb run it idempotently.
2. Rewrite src/db/repositories/profile-version-repo.ts to use SQLite (remove Maps, add txn helpers, export same API + new listVersions(domain) for history).
3. Wire seed path: on first boot if extractor_profiles has a row and profile_versions is empty for that domain, create version 1 from it.
4. Extend profile-test-matrix binding: after runMatrix, persist validation_summary.artifactHashes into the draft version row (or a pending version if not yet created) and expose getMatrixForVersion.
5. Patch profile-readiness.ts deriveReadinessState to accept evidence input; update ProfileWorkspacePage fetchState to consume testsPassEvidence from Hono.
6. Add GET /api/domains/:domain/profile-state evidence field and POST activate fail-closed checks (missing_matrix / artifact_mismatch) with expanded 409 payload.
7. Add unit tests for repo txn/rollback, readiness degradation, and gate mismatch.

## Verification Script (Step-by-Step)

1. `bun run typecheck` passes.
2. `bunx vitest run src/tests/unit/profile-version-repo.test.ts` — txn create/activate/rollback + restart simulation (re-initDb, rows persist).
3. `bunx vitest run src/tests/unit/profile-activation-gate.test.ts` — missing_matrix and artifact_mismatch cases.
4. `bunx vitest run src/tests/unit/profile-workspace.test.ts` — Active collapses to Degraded when evidence missing.
5. `bun run test:db` — migration runs, legacy row seeded, no Map loss.
6. Manual: restart dev server, GET /api/domains/:domain/profile-state for a seeded domain, assert versions still listed.

## Out of Scope (§18)

- Clustering, capture, or workbench UI changes — e07s02-s04.
- Sourcing/Discovery redesign or distributor_record changes.
- Open-ended chatbot or live-iframe editing.

## Constraints (§6)

- Single capture hash shape already defined (dom+runtime→sha256 12-char) by spike; artifactHashes stored sorted for stable comparison.
- Transactions must be WAL-safe (busy_timeout 5000, foreign_keys ON already in initDb).
- No changes to product_pages or SKU→page mapping.

## Risks

- Large artifactHashes array on domains with many samples — cap suite at 10 (existing invariant) so array stays small.
- Legacy seed must not overwrite a domain that already has versions — check emptiness per domain.

## Traceability

- SCOPE: e07s01 — Fix persistence + evidence-gated activation
- planning-context key_decision: Fix testsPass and immutable-version persistence debt now (Q4)
- spike: profile-version-repo Map drift + ProfileWorkspacePage:55
- files: src/db/repositories/profile-version-repo.ts, src/db/repositories/extractor-profile-repo.ts, src/onboarding/profile-test-matrix.ts, src/onboarding/profile-readiness.ts, src/client/components/profile-workspace/ProfileWorkspacePage.tsx, src/onboarding/profile-activation-gate.ts

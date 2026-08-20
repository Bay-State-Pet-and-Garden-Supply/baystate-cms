# e01s01 — Create/augment onboarding item from verified SpecialistWorkflowResult with preserved provenance

## Story
- **ID:** e01s01
- **Epic:** e01
- **Status:** planned
- **BCPs:** 8

## Narrative
As a merchant, I want a verified Agent Lab v2 specialist workflow result to create or augment an onboarding item so that human review can happen in the existing onboarding pipeline with full provenance.

## Requirements

#### ADDED: Verified handoff creates or augments onboarding item
Creates a new onboarding batch/item when no target exists, or augments an existing item when one is supplied; the operation is atomic with an import record (`product_intelligence_imports`) linking workflow/run/capability/artifact hashes.

#### ADDED: Provenance is preserved
Persist links to workflowId, runId, capability invocationIds, final artifact versions/hashes, selected identity/source evidence, field-level evidence refs, VerificationReport/version, importer/reviewer and timestamp, excluded/overridden fields.

#### ADDED: Server route is gated
Only workflows in allowed terminal/review states may be handed off; workspace ownership enforced (404 cross-workspace).

## Acceptance Criteria (17.)
- Given a `SpecialistWorkflowResult` in `needs_review`/`completed` with a passing `VerificationReport`, when `importRunToOnboarding` is called, then a new onboarding item/batch is created (or supplied item is augmented) and an import record is persisted with workflowId, runId, artifact hashes and evidence refs.
- Given an augmented item, when manual/reviewed values exist, then they are not silently preserved (explicit test in e01s02) — this story does not regress the happy path.
- Given the server route, when a run belongs to another workspace, then the request returns 404.

## Verification Script
1. Run `bun run typecheck`
2. Run `bunx vitest run src/tests/unit/product-intelligence-import.test.ts`
3. Run `bun run test:db --run src/tests/db/product-intelligence-import`
4. Observe: import creates/augments with provenance, cross-workspace is 404.

## Out of Scope
- Stale-hash, idempotency and anti-replacement guards (e01s02)
- UI surfacing (e02)

## Risks
- Reusing PI-8 pattern incorrectly could lose provenance — mitigate by reusing transaction boundary and adding hash checks.

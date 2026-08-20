<!-- story: e07s04 -->

# e07s04 — Workbench consolidation + hard-block release — single inline surface, Advanced CSS, park/release, delete deprecated

## Story

As an operator triaging "Build profile" tasks, I want one canonical workspace that hard-blocks extraction until a template-aware profile passes every sample and lets me activate to release queued items without confusion about which builder to use.

## Context

After e07s01-s03 land, the deprecated ProfileBuilderWorkspace overlay, modal callers in Onboarding.tsx/OnboardingSettings.tsx, and the paste-HTML path are still present as dead code and alternate surfaces. This final slice consolidates to one surface, confirms the hard-block release seam, and deletes the diverged paths. Depends on e07s01-s03; closes the epic.

## Business Narrative

From Needs Attention, PipelineBoard blocker, brand checklist, or domain inventory, every entry navigates via getProfileWorkspacePath to /settings/domains/:domain/profile. The workspace shows header (domain, brands, active version, freshness, blocked count), readiness rail (6 steps), cluster-aware suite with suggested reps, and the capture-corrected build canvas (value previews + Select on page + Advanced). Attempting to activate without passing every sample and every cluster is hard-blocked with an expanded reason and Revise action. On activation, parked official_page items (setup_required_profile) advance deterministically; distributor_record items are never parked.

## Requirements

### MODIFIED: Single inline workbench

- Route /settings/domains/:domain/profile is the only surface. ProfileWorkspacePage 12-col layout (2-7-3) stays: ReadinessRail, SuitePanel with clusters (e07s02), BuildCanvas with ValuePreviewGrid + capture replay (e07s03), EvidenceRail + HistoryShell (now evidence-bound via e07s01).
- Build canvas defaults to value previews + "Select on page"; raw SelectorInput lives only in Advanced collapsible per field.

### ADDED: Delete deprecated surfaces

- Delete src/client/components/ProfileBuilderWorkspace.tsx (overlay variant), src/client/components/profile-builder/components/GenerateSelectorPopover.tsx, and modal mode callers (OnboardingSettings.tsx:837, Onboarding.tsx:831 embedded ProfileBuilder mode="modal"). Remove related state/types. Keep ProfileBuilder mode="inline" only as the composer used by ProfileWorkspacePage.
- Deletion is guarded by grep checks in verify scripts; any leftover import fails typecheck.

### ADDED: Hard-block release seam (template-aware)

- Park contract: official_page items without a passing active profile park at Discovery→Extraction as setup_required_profile with domain task "Build profile for example.com — unblocks N products" (existing). Distributor_record items bypass (profile-blockers.ts).
- Activation gate now requires every confirmed sample AND every included cluster to pass via persisted MatrixResult (e07s01 evidence + e07s02 coverage). Image rule (two-sample + preview attestation) preserved. On activation, onboarding-work-api release advances parked items deterministically.

### MODIFIED: Navigation and readiness are server-derived

- Readiness derives from persisted testsPassEvidence (e07s01) and cluster coverage; not from transient hasDraft/hasProfile alone. HistoryShell shows immutable versions with actor/model/config, artifact hashes, diffs, and rollback events.

## Acceptance Criteria

```gherkin
Feature: Consolidated workbench and hard-block release

  Scenario: One canonical surface
    Given the app has routes /settings/domains/:domain/profile and legacy /settings profiles table
    When the user opens any entry point (Needs Attention task, pipeline ⚠ badge, brand checklist, inventory)
    Then navigation lands on /settings/domains/:domain/profile
    And no modal or overlay builder is reachable

  Scenario: Hard-block until every sample and cluster passes
    Given 3 confirmed reps (covering 2 clusters) and candidate passes 2/3 but fails the third
    When POST /api/domains/:domain/profile/activate is called
    Then response is 409 with per-field expanded reason (expected vs actual, provenance, artifact) and Revise
    And parked setup_required_profile items are not released

  Scenario: Activation releases parked items
    Given the same domain now has a passing matrix covering all 3 and both clusters
    When POST /api/domains/:domain/profile/activate succeeds for that version
    Then N parked official_page items advance from Discovery→Extraction to extracted
    And distributor_record items were never parked
```

## Solution — Steps

1. Update routing (profile-workspace/route.ts) as the only canonical path; add redirect from any legacy overlay path to the canonical page.
2. Delete deprecated files + callers; update imports; remove GenerateSelectorPopover and modal types.
3. Wire readiness rail to testsPassEvidence; HistoryShell to listVersions and profile_active.
4. Wire release seam to e07s01 evidence: activate only after gate passes, then call existing release path.

## Verification Script

1. `bun run typecheck` — deletions do not leave dangling imports.
2. `grep -r ProfileBuilderWorkspace src | wc -l | grep -q '^0$' && grep -r GenerateSelectorPopover src | wc -l | grep -q '^0$' && echo deletions ok`
3. `bunx vitest run src/tests/unit/profile-activation-gate.test.ts src/tests/unit/onboarding-work-state.test.ts`
4. Manual: park 2 official_page items, activate profile covering all reps, assert items advance; create distributor_record item, assert it is not parked.

## Out of Scope

- Sourcing heuristics or downstream Curation/Review changes.
- New LLM models or prompts beyond e07s01-s03 ranking.

## Traceability

- SCOPE: e07s04 — Workbench consolidation + hard-block release
- planning-context: single workspace surface + delete decisions + distributor bypass
- spike: capture + clustering leaves single surface as the only correct one
- files: src/client/components/profile-workspace/ProfileWorkspacePage.tsx, src/client/components/profile-workspace/route.ts, src/client/components/ProfileBuilderWorkspace.tsx (delete), src/client/components/profile-builder/components/GenerateSelectorPopover.tsx (delete), src/onboarding/profile-activation-gate.ts, src/onboarding/profile-blockers.ts

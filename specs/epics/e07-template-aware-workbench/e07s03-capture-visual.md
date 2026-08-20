<!-- story: e07s03 -->

# e07s03 — Single capture artifact + visual correction — click-to-ranked recipes with value previews across all samples

## Story

As an operator fixing a profile field that fails on one template, I want to click the desired value on a captured page snapshot and see that recipe ranked and tested across every confirmed sample so that I never write CSS by hand.

## Context

The selector authoring loop is currently selector-first (SelectorInput + paste outerHTML + advisory DOMParser) and does a two-hop capture (snapshotPageForBuilder + fetchPageHtml) that can race. The spike proved a single capture (DOM + screenshot + runtime + hash) suffices and that recipe ranking JSON-LD > [data-testid] > shopify > semantic > generic matches selector-utils. Depends on e07s01 (evidence) and e07s02 (cluster coverage); provides the corrected recipes for the consolidated workbench in e07s04.

## Business Narrative

In the build canvas, each field shows extracted VALUES previewed per sample (one row per confirmed product, columns: expected VALUE + status). The operator clicks "Select on page" → the capture replay appears (screenshot + DOM overlay) → clicks the desired value → system ranks candidate recipes (structured data preferred) and instantly highlights/tests the new recipe across all confirmed samples. Raw CSS is visible only under an Advanced disclosure.

## Requirements

### ADDED: Single capture artifact

- Per sample, one Playwright capture: serialized DOM (post networkidle+1s) + screenshot + runtime (static vs rendered) + sha256 12-char hash. Replaces the two-hop path. Artifact is stored server-side and referenced by hash in profile_versions.artifact_hashes binding from e07s01.
- Replay uses sanitized DOM + screenshot; no live remote iframe (CSP/auth). Capture is the only source for click→element mapping.

### ADDED: Click→ranked recipes with value previews

- On click, map x,y → element path → candidate recipes via selector-utils hierarchy (6-tier): unique id (if stable) → [data-testid] → semantic class/id → tag+class → nth-of-type fallback (low). If JSON-LD / Shopify payload contains the same value, the structured recipe is ranked highest.
- Value previews: for each field, show the extracted value per sample using the candidate recipe; failed/missing cells are highlighted red with reason (e.g., "no match on /product cluster"). Ranking is deterministic and recomputes cross-sample.

### ADDED: Instant highlight/test across all samples

- Applying a candidate immediately re-evaluates it against every confirmed sample in-memory (local eval as instant feedback) and then enqueues a production runner matrix run for evidence (ground truth). Local eval is labeled "instant preview — not evidence" and never satisfies testsPass.

### MODIFIED: Delete paste-HTML paths

- Remove GenerateSelectorPopover (paste outerHTML textarea) and the independent HTML-fetch hop in useProfileBuilderController. Remove call sites. Local DOMParser eval stays only as labeled instant preview, never as MatrixResult.

### ADDED: Advanced disclosure for raw CSS

- Each field card has an Advanced section (collapsed by default) showing the generated selector, stability (high/medium/low), and an editable SelectorInput for power users. Editing there still re-ranks and re-tests everywhere.

## Acceptance Criteria

```gherkin
Feature: Visual correction on capture

  Scenario: Click ranks and previews
    Given 3 confirmed products (one per cluster) and field "title"
    When operator clicks the product title on the capture replay for sample 1
    Then candidate "jsonld:Product.name" is ranked top if present, else "[data-testid] ..."
    And the VALUE preview for title shows the clicked value for sample 1 and the correctly extracted titles for samples 2..3

  Scenario: Cross-sample highlight
    Given a CSS candidate matches samples 1..2 but not sample 3
    When the candidate is applied
    Then sample 3 cell shows failed (no match) in VALUE preview
    And activation remains hard-blocked until a candidate passes all 3

  Scenario: Raw CSS only in Advanced
    Given the workspace is open
    Then no monospace SelectorInput is visible until operator expands Advanced for a field
    And GenerateSelectorPopover does not exist in the client bundle
```

## Solution — Steps

1. Add capture service src/onboarding/profile-capture.ts (Playwright, single run, returns artifact) and wire it into the profile controller replacing the two-hop path.
2. Implement click→candidates helpers using selector-utils (reuse buildStableSelector + structured discovery) and value-preview component src/client/components/profile-builder/ValuePreviewGrid.tsx.
3. Wire instant local eval (DOMParser) as preview + enqueue runner matrix for evidence.
4. Add Advanced disclosure per field; remove GenerateSelectorPopover and HTML-fetch code.
5. Unit tests for capture shape, ranking, preview grid, and deletion guards.

## Verification Script

1. `bun run typecheck && bunx vitest run src/tests/unit/profile-runner-client.test.ts`
2. `bunx vitest run src/tests/unit/selector-utils.test.ts src/tests/unit/profile-builder-mapping.test.ts`
3. `grep -r GenerateSelectorPopover src/client | wc -l | grep -q '^0$' && echo ok` — deletion guard
4. Manual: open capture replay, click a value, verify preview across 3 samples updates in <1s (instant) and runner matrix later turns green.

## Out of Scope

- Clustering or persistence work (e07s01-s02).
- Final workspace consolidation/deletions beyond GenerateSelectorPopover (e07s04).

## Traceability

- SCOPE: e07s03 — Single capture artifact + visual correction
- oracle: recipe = path hint + DOM fingerprint + field recipes (structured preferred)
- spike: single capture eliminates race + ranking hierarchy proved
- files: src/onboarding/profile-capture.ts, src/shared/selector-utils.ts, src/onboarding/profile-runner-client.ts, src/client/components/profile-builder/hooks/useProfileBuilderController.ts, src/client/components/profile-builder/components/*

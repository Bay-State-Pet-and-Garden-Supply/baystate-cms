# ADR 0027: Verifier Specialist for Independent QA, Identity Verification, and Structured Retry Requests

**Status update (2026-08): SUPERSEDED operationally by ADR-0030 (Agent Lab decommission); paths below are deleted/historical.**

- Status: Accepted
- Date: 2026-08-18
- Issue: #55 (epic #47)

## Context

Following catalog draft synthesis by the Curator specialist (ADR 0026), drafts must undergo independent verification before being accepted for promotion to the CMS onboarding pipeline. The verification step must ensure identity accuracy (catching wrong variant PDPs or parent-product-only pages), check that all draft claims are grounded in verified evidence, verify that taxonomy choices comply strictly with active CMS configuration, and ensure that conflicting facts are not promoted.

## Decision

Implement a provider-neutral `VerifierSpecialist` behind the #48 typed specialist boundary:

1. **Independent Verification Contract**: Consumes the original `ProductSeed`, `ResolvedFactSet`, and `CuratedProductDraft` alongside `ClassificationContext`. Produces a versioned `VerificationReport` artifact.
2. **Deterministic QA Checks**: Runs structured checks covering identity resolution, title quality, claim grounding, conflict omission, and taxonomy boundaries.
3. **Structured Verdicts**: Emits one of five machine-routable verdicts: `pass`, `retry_curator`, `retry_resolver`, `retry_discovery`, or `human_review`.
4. **Structured Retry Requests**: When a failure is detected, produces a typed `retryRequest` indicating the exact `targetSpecialist`, `conflictingFields`, `reason`, and `suggestedAction`.
5. **Non-Mutating Boundary**: The Verifier is purely evaluative: it never silently rewrites draft fields, never invokes other specialists directly, and never writes catalog state.

## Consequences

- The Orchestrator (#56) can interpret deterministic verification verdicts to execute structured retry loops or route items to human review.
- Low-confidence, ungrounded, or conflicting drafts are caught before entering onboarding or promotion.

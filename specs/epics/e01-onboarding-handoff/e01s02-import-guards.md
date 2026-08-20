# e01s02 — Fail-closed guards — manual preservation, conflict visibility, idempotency, stale-hash handling

## Story
- **ID:** e01s02
- **Epic:** e01
- **Status:** planned
- **BCPs:** 5

## Narrative
As a reviewer, I want onboarding import to fail closed on stale hashes, stay idempotent, and never silently overwrite my reviewed values so that trust in imported evidence is preserved.

## Requirements

#### ADDED: Manual/reviewed values never silently overwritten
Differing manual values are recorded as excluded with both sides; identical values dedupe; conflicts remain visible after import; needs_human_review stays unresolved until human resolves.

#### ADDED: Idempotency and anti-replacement
Same run import is idempotent; newer workflows never silently replace an earlier imported result; stale/mismatched artifact hashes fail closed.

#### ADDED: Image and promotion guards
Rejected/non-commerce-approved images are excluded; verification never directly creates approved catalog truth; promotion/export remains owned by normal onboarding.

## Acceptance Criteria (17.)
- Given an onboarding item with a reviewed name differing from the imported draft, when import runs, then the reviewed value is kept and the import record marks the field excluded with both values.
- Given the same run imported twice, when the second call arrives, then it returns the existing import without duplicating onboarding rows.
- Given stale/mismatched artifact hashes, when import is attempted, then it fails closed with no onboarding mutation.
- Given an image without commerce approval, when import runs, then the image is excluded.

## Verification Script
1. Run `bun run typecheck`
2. Run `bunx vitest run src/tests/unit/product-intelligence-import.test.ts -t 'idempotent|stale|hash'`
3. Run `bunx vitest run src/tests/unit/product-intelligence-import.test.ts -t 'manual|conflict'`
4. Observe: guards pass, no approved catalog truth created directly.

## Out of Scope
- Happy-path creation (e01s01)

## Risks
- Missing guard could silently corrupt reviewed data — cover with explicit differing-value tests.

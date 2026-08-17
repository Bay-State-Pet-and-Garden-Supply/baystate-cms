# ADR 0023: Profile Engineer proposals remain governed artifacts

- **Status:** Accepted
- **Date:** 2026-08-20
- **Scope:** Epic #47, issue #51

## Decision

Domain extraction profile engineering is a provider-neutral proposal and
validation capability. It consumes deterministic representative-page evidence
from the existing `PageExtractionContract` / extraction worker seam and emits a
versioned typed artifact. The artifact records every tested URL, retained page
artifact reference, per-field coverage, and per-field failure reason.

The engineer uses the existing extraction ladder in order (JSON-LD, public
platform representations such as Shopify/WooCommerce, embedded application
state, then selectors). A current profile is probed deterministically first.
When all representative pages pass, the current profile is reused and the
engineer is not routed. Missing, incompatible, changed-markup, and
wrong-variant evidence can create one domain workflow, protected by a durable
same-domain lease.

The output is always `proposal_only` and `manual_review_required`. The
specialist cannot call `upsertProfile`, `promoteGeneratedProfile`, release
blocked onboarding items, or write approved catalog/ShopSite state. Profile
Builder and the existing profile governance/promoter remain the activation
authority. A failed validation is still retained as a typed, inspectable
artifact; it is never treated as an active profile.

## Consequences

- A successful domain proposal can be reviewed once and then used to release
  all blocked products on that domain through the existing domain-release path.
- Concurrent blocked products share a durable domain workflow rather than
  starting duplicate generation or validation calls. Failed workflows can be
  retried; completed proposals are reused until governance acts.
- Selector candidates must survive representative samples. A selector found on
  only one page is omitted, and changed-markup or wrong-variant samples fail
  validation rather than being hidden by aggregate confidence.
- Persistence of a proposal, revision, or validation record must use the
  existing profile generation/revision repositories. This ADR intentionally
  does not add an extraction runner (#52) or orchestrator (#56).

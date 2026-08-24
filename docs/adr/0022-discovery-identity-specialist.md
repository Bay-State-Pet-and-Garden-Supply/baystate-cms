# ADR 0022: Bounded Discovery / Identity specialist

> **Status update (2026-08): SUPERSEDED by ADR-0030 (Agent Lab decommission) — content below references the deleted `src/product-intelligence/**` Agent Lab surface and is preserved as a historical record only.**

- Status: Accepted
- Date: 2026-08-10
- Issue: #49 (epic #47)

## Context

Onboarding starts with a `ProductSeed` containing a SKU, supplied name, and
price. A GTIN may be absent, and a supplier SKU is not a GTIN or a manufacturer
part number. Search results are leads, while page extraction can distinguish an
exact product page, a parent/family page, and a wrong variant. Discovery needs
to preserve those distinctions without making a catalog decision.

## Decision

Implement a provider-neutral `DiscoverySpecialist` behind the #48 typed
specialist boundary. The input is versioned and accepts a `ProductSeed`, an
optional discovered GTIN, bounded `BatchContext`, and replayable source leads.
The search provider and the existing `PageExtractionContract` are injected
seams. The specialist calls at most the configured search and verification
budgets, additionally bounded by the immutable Product Intelligence policy's
`maxToolCalls`.

Each output is a versioned typed artifact containing:

- deterministically ranked source candidates;
- a ranking-only score and structured signals/rationale codes;
- explicit source reference, method, URL, and evidence ids;
- page identity (`exact_pdp`, `parent_family_page`, `wrong_variant`, or an
  unresolved/probable lead);
- a disposition (`ranked`, targeted evidence requested, or human review);
- an explicit `authority: none` marker and budget accounting.

Exact identity requires the existing extraction contract's identity result (or
an explicit seed-SKU corroboration for a probable PDP); names, prices, batch
hints, and supplier identifiers only affect ranking. Ambiguous brands are held
for human review. Missing or exhausted evidence may produce a valid structured
abstention; no candidate is forced into a match.

## Consequences

The artifact is suitable for a later Resolver or orchestrator but cannot write
catalog, onboarding, or ShopSite state. Page extraction remains provider-neutral
and can later be replaced without changing this specialist contract. Search
and verification limits are visible in the artifact, making budget behavior
replayable and reviewable. Profile Engineer, extraction runner, Resolver, and
orchestration remain separate follow-up capabilities.

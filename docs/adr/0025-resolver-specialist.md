# ADR 0025: Resolver Specialist for Deterministic Identity and Field Reconciliation

- Status: Accepted
- Date: 2026-08-18
- Issue: #53 (epic #47)

## Context

Discovery candidates (ADR 0022) and deterministic extraction evidence bundles (ADR 0024) provide candidate URLs, page classifications, and field-level observations across multiple sources (manufacturer, supplier, distributor, retailer, marketplace). Prior to curation, disparate observations must be reconciled into a canonical fact set. Challenges include unit equivalence (e.g. 5 lb vs 2.27 kg), true conflicts, identifier scoping (conflating 14-digit case GTINs with consumer UPCs), dimension scoping (promoting case/shipping dimensions to product dimensions), and keeping identity confidence decoupled from field completeness.

## Decision

Implement a provider-neutral, pure deterministic `ResolverSpecialist` behind the #48 typed specialist boundary:

1. **Typed Artifact Output (`ResolvedFactSet`)**: Reconciles discovery candidates and extraction evidence into versioned canonical facts (`title`, `brand`, `gtin`, `weight`, `size`, `dimensions`, `caseGtin`, `innerPackGtin`, `sku`, `packCount`, `caseDimensions`, `shippingDimensions`).
2. **Identifier & Dimension Scoping**: 
   - Identifier scope (`consumer_unit`, `case`, `inner`, `unknown`) is strictly derived from digit length (8/12/13 digits vs 14 digits) and expected identity. 14-digit case identifiers are never promoted to consumer GTINs.
   - Dimension scopes (`product`, `case`, `shipping`) are preserved. Case and shipping dimensions are never promoted to product dimensions.
3. **Unit & Quantity Reconciliation**: Weight, volume, and length quantities are parsed and canonicalized (lb, fl oz, in) with a 1.5% tolerance window. Equivalent representations resolve into one canonical fact with all supporting evidence references retained; genuine differences remain explicit conflicts.
4. **Config-Driven Source Authority**: Source authority ranking is driven by configuration policy (`ranking: SourceKind[]`) and captured as a deterministic `configId` hash, avoiding hardcoded source priorities.
5. **Decoupled Identity Confidence**: Identity resolution confidence is evaluated from candidate decision status and GTIN matching independently of field completeness or per-field confidence.
6. **Structured Abstention & Fail-Closed Behavior**: Missing required facts or unparseable values produce `needs_more_evidence` or structured abstentions rather than hallucinated or forced values.

## Consequences

- Downstream specialists (Curator #54, Verifier #55) and the Orchestrator (#56) consume a typed, grounded `ResolvedFactSet` with full evidence lineage and conflict preservation.
- The Resolver is a pure deterministic function with no network I/O, no LLM calls, and no mutating catalog side effects.

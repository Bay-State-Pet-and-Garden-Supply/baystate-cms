# ADR 0026: Curator Specialist for Deterministic Catalog Drafting and Evidence Grounding

- Status: Accepted
- Date: 2026-08-18
- Issue: #54 (epic #47)

## Context

Following field and identity reconciliation by the Resolver specialist (ADR 0025), products require store-ready catalog representations: a clean title, structured product descriptions, CMS taxonomy/category assignments, normalized attributes, and verified imagery. Prior monolithic implementations risked hallucinations, invented taxonomy IDs, or ungrounded marketing claims.

## Decision

Implement a provider-neutral, bounded `CuratorSpecialist` behind the #48 typed specialist boundary:

1. **Grounded Catalog Titles & Descriptions**: Synthesizes clean catalog titles (`{brand} {name} {size}`) while removing redundant brand prefix duplication. Descriptions and bullet points are constructed exclusively from resolved facts; unsupported or unverified claims are omitted.
2. **Distinct Title Semantics**: Retains source title (`ProductSeed.name`), resolved identity name (from manufacturer/official evidence), and catalog draft title as separate fields.
3. **Strict Classification Governance**: Product type and category proposals select strictly from active CMS configuration options passed in context. When no matching category or product type exists, the specialist abstains rather than inventing new taxonomy identifiers.
4. **Claim Grounding & Provenance**: Every generated attribute and description claim cites supporting resolved fact fields and underlying evidence IDs in a structured `grounding` array.
5. **Conflict & Uncertainty Handling**: Facts in `conflict` or `needs_more_evidence` state are omitted from draft claims and recorded as structured abstentions.
6. **Verified Asset Curation**: Selected product images are filtered to meet exact variant identity match and commerce approval criteria (PI-6).

## Consequences

- The Verifier specialist (#55) and Onboarding integration (#58) receive structured `CuratedProductDraft` artifacts with verifiable claim-to-evidence links.
- The Curator specialist is deterministic, performs no direct network I/O, and does not write catalog state directly.

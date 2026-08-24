# ADR 0021: Deterministic, non-authoritative batch intelligence

> **Status update (2026-08): SUPERSEDED by ADR-0030 (Agent Lab decommission) — content below references the deleted `src/product-intelligence/**` Agent Lab surface and is preserved as a historical record only.**

## Status

Accepted for Product Intelligence issue #57.

## Decision

A supplier spreadsheet batch is analyzed once per `(batchId, batchVersion)` and
emitted as the typed `batch_context` specialist artifact. The analysis consumes
only bounded `ProductSeed` rows and is provider-neutral: token normalization,
family overlap, size/pack differences, abbreviation cues, SKU sequences,
and repeated-price patterns are deterministic code, not model output.

The artifact is content-addressed and replayable. Its payload retains the
canonical input hash, all duplicate/near-duplicate/likely-variant relationships,
and batch signals for inspection. Each row also receives a bounded projection
containing only the strongest related row ids and hints. A row projection carries
the artifact content hash and schema version in its workflow `BatchContext`, so
retries can prove which batch context was used.

## Non-authority boundary

Batch signals are search hypotheses only. A repeated leading token is not a
confirmed brand, an abbreviation is not a resolved family, SKU sequencing is
not a GTIN/MPN, a price pattern is not identity or variant evidence, and a
relationship is not a duplicate catalog record. No Discovery implementation is
included here. Product workflows must verify hypotheses using their own
source-backed evidence and may not receive unrelated rows through the bounded
projection.

## Consequences

- Derivation can be replayed without a provider or network and identical input
  produces the same input and artifact content hashes.
- Operators can inspect relationships and warnings without exposing the entire
  batch to each row workflow.
- A future Discovery specialist may consume the row projection, but it must keep
  source provenance and deterministic identity gates authoritative.
- Batch versions are caller-supplied; changing a version or seed set creates a
  new context rather than silently mutating prior workflow provenance.

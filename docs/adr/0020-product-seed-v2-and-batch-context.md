# ADR 0020: ProductSeed v2 and non-authoritative batch context

## Status

Accepted for Product Intelligence issue #50.

## Decision

New Product Intelligence launches use a `ProductSeed` containing only the
immutable `sku`, `name`, and `price`. A GTIN/UPC is not a seed requirement; it
is discovered evidence and must be supported by source provenance. A
supplier SKU is never copied into an MPN or GTIN field, even when it is
numeric-looking. Price is weak evidence unless source semantics explicitly
identify what the value means.

`BatchContext` is a bounded, versioned hint (`schemaVersion: 1`) and is
explicitly non-authoritative. It may contain batch labels, sibling SKUs, and
operator hints, but cannot change a seed or create an identity/classification
decision. The original seed and context are persisted in separate run columns
for inspection and replay.

## Compatibility

The historical GTIN-first input contract remains readable and replayable. A
small compatibility adapter supplies the legacy executor shape with an empty
GTIN sentinel for v2 runs; it never substitutes the SKU. Existing raw and
normalized identity evidence may be attached as evidence without expanding the
minimal seed contract.

## Consequences

- Research and terminal validation must tolerate a missing seed GTIN.
- Existing v1 bundles and run records retain their GTIN equality checks.
- Discovery and batch intelligence remain separate follow-up capabilities;
  this ADR defines their input boundary only.

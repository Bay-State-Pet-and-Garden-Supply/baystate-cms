# Treat ShopSite built-in output behavior as an immutable adapter-owned policy

The product denormalizer emits ShopSite DTD elements (`Name`, `Price`, `SaleAmount`, `ProductDescription`, `MinimumQuantity`, `ProductType`, `Weight`, `Graphic`, `SearchKeywords`, `MoreInfoImage1–20`, `MoreInformationText`, `MoreInformationGraphic`) with subtle omission, default, encoding, and cardinality rules that were previously scattered across the denormalizer body. These rules are now frozen into one versioned, immutable policy (`src/shopsite/built-in-output-policy.ts`) that the denormalizer consumes.

**Status**: accepted

**Considered Options**:
- Immutable adapter-owned policy (chosen) — `SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1` enumerates every governed built-in field with its omission/default/encoding/cardinality rule; the denormalizer consults the policy (defaults come from `builtInDefaultValue`, custom-field emission skips governed built-ins) while emitting byte-identical XML.
- Make built-in behavior workspace-configurable — rejected. Required ShopSite defaults (`MinimumQuantity=0`, `ProductType=Tangible`, `Graphic=none`), XML validity (CDATA for description/keywords, escaped text elsewhere), and round-trip preservation depend on the ShopSite DTD, not on a store's classification config. Delegating DTD-level behavior to config would let a store break XML validity or round-trip fidelity with no fail-closed recovery.
- Keep the rules inline in the denormalizer — rejected. Unversioned scattered rules cannot be traced to a run's runtime rule-versions and drift silently.

**Consequences**:
- `product-denormalizer.ts` consumes the policy without changing emitted bytes (verified by byte-diff and the existing round-trip suites).
- Custom `ProductField*` values are NOT built-ins: they continue through classification mapping/serialization, and the policy-coverage test proves no `ProductField` element is governed by the built-in policy.
- The draft promoter's construction of `Name`, `Price`, and new-date `ProductField1` is documented as draft INPUT behavior, never XML output policy.
- `src/classification/model-operation-registry.ts` records the output-policy version (`shopsite-built-in-output-policy-v1`, single-sourced from the policy module) into the runtime rule-versions set frozen into run snapshots, so a run's provenance traces to the exact output-policy version in effect.
- Unknown built-in policy keys fail closed: they have no rule and are never emitted through a generic configurable path.

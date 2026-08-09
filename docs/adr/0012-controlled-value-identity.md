# Make controlled-value string identity explicit and canonical

A controlled value ID is exactly its stored canonical string after required NFC normalization and trimming; labels equal IDs by the documented v2 policy. Before this ADR, callers canonicalized controlled values ad hoc (inline `.toLowerCase()` comparisons, case-insensitive `includes` against `valueAliases`) so a proposal, decision, or serialized field could carry a non-canonical variant of a controlled value, and config could store ambiguous near-duplicate values (`Dog`/`dog`) that silently activated.

**Status**: accepted

**Considered Options**:
- Central identity helpers with config-time rejection (chosen) — `src/classification/controlled-value-identity.ts` provides comparison keys (NFC + trim + case fold), canonical-form validation, alias resolution to exact allowed IDs, and the `{value: id, label: id}` option builder. Config validation rejects empty/control-character values, non-NFC/non-trimmed values, exact duplicates, normalized/case-fold collision pairs, and aliases whose `mapsTo` is not an exact allowed ID. The matcher, detail enrichment, serialization validation, and option resolvers consume the helpers instead of ad hoc case-insensitive canonicalization.
- Keep per-caller case-insensitive normalization — rejected. It lets near-match display labels guess canonical IDs, breaks identity on rename, and makes an ambiguous value set activate silently.
- Store display label separately from ID and map at runtime — rejected. It contradicts the v2 policy that label equals ID and reintroduces silent rewriting when display text changes.

**Consequences**:
- Proposals, decisions, reviewed facts, applicability conditions, serialization validation, and conflict detection carry the exact canonical ID.
- Renaming a value is an identity change: the old ID remains resolvable only through a reviewed alias/migration, never silently rewritten.
- `config-validation.ts` adds `non_canonical_controlled_value` and `ambiguous_controlled_value` errors; `config-generator.ts` canonicalizes (NFC + trim) and validates seed allowed-values/aliases at generation time and fails generation on ambiguity.
- Serialization validation (`validateSerializableValue`) resolves aliases to exact allowed IDs and rejects unknown/near-match values (`controlled_membership`) — an alias whose `mapsTo` points outside the allowed set can never serialize.
- Matching evidence text to an allowed ID remains case-tolerant (comparison key), but the emitted value is always the exact canonical ID from the allowed set; ambiguity fails closed (null).
- Schema-v2 string compatibility is preserved: `shared/schemas/classification.ts` gains documentation/type aliases only — no runtime shape change.

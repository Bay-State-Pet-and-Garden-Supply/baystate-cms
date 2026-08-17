# ADR 0024: Versioned deterministic extraction evidence

## Status

Accepted for issue #52 (epic #47).

## Decision

Official product-page extraction uses the existing deterministic extraction
ladder and approved profile/browser seams. The evidence runner disables model
and managed fallbacks, and emits a versioned `ExtractionEvidenceBundle`.
Every accepted field, identifier, and image observation is retained with its
method, exact source path (or an explicit method-only marker), source/final URL,
content hash, artifact reference, and profile id/version when a profile was
selected.

Failures are structured with stable machine-routable codes. A retained page
artifact may be replayed through the same parser without another network fetch;
artifact integrity and response-size limits are checked before parsing.
Replay is intentionally limited to retained artifact types and does not invent
variant identity, image rights, or missing fields.

Network policy/SSRF enforcement remains the responsibility of the injected
policy-gateway transport and optional preflight gate; the runner does not add a
second network implementation. The runner does not mutate catalog or
ShopSite state and does not select a Resolver/orchestrator.

## Consequences

- JSON-LD, embedded state, platform representations, and profile selectors have
  one durable provenance shape instead of unrelated field maps.
- Profile updates are visible in every bundle and can be compared without
  treating a newer profile as evidence for an older extraction.
- Blocked pages, missing fields, parent pages, and wrong variants can be routed
  without parsing user-facing error strings.
- Artifact retention is bounded and fail-closed; pages whose bytes were not
  retained must be researched again rather than silently reinterpreted.

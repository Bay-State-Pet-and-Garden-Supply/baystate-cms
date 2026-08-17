# ADR 0018 — Specialist Capability Registry and Typed Workflow Artifacts

- **Status:** Accepted
- **Relates to:** ADR 0010 (Product Intelligence execution boundary), ADR 0004 (composable classification stages), epic #47 (specialist capabilities), ADR 0005/0012/0017 (deterministic authority patterns)
- **Implementation surface:** `src/product-intelligence/specialists/` (`contracts.ts`, `artifacts.ts`, `registry.ts`, `policies.ts`), `src/tests/unit/product-intelligence/specialist-registry.test.ts`

## Context

Product Intelligence today is one bounded research agent (PI-1) behind the CMS: the agent researches and proposes; deterministic CMS code validates, reviews, promotes, and publishes (`src/product-intelligence/contracts.ts`, ADR 0010). Classification already proves the value of decomposition: focused **Classification Stages** (ADR 0004) each own one responsibility, declare dependencies, and produce evidence/proposals/abstentions that a deterministic pipeline composes.

Epic #47 takes the same decomposition step for Product Intelligence: future research work will run as focused **specialist capabilities** (identity verification, extraction, classification, …) selected and sequenced by an orchestrator rather than one monolithic agent session. Before any specialist exists, the reusable substrate must be pinned:

- a provider-neutral capability contract (the boundary between the orchestrator and any specialist, regardless of runtime: deterministic, local model, or hosted agent);
- typed, versioned workflow artifacts as the only durable handoff (specialist prose is never authoritative — the same rule the terminal-submission contract already enforces for PI runs);
- a capability registry that exposes specialist metadata and configuration without becoming an execution router;
- per-specialist governance that reuses the existing Product Intelligence policy machinery rather than inventing a parallel one.

## Decision

Issue #48 establishes the contracts, artifact validation, and registry. The following boundaries are architectural commitments, not implementation details:

### 1. Only the orchestrator routes work

A specialist is selected and sequenced exclusively by the orchestrator (which lands in a later issue). The registry (`SpecialistRegistry`) is metadata/configuration exposure only: `resolveSpecialist(name)` is a lookup, there is no execute/dispatch surface, and a specialist definition carries no factory that could self-invoke. Specialist provenance stamps `invokedBy: 'orchestrator'` by default, and a specialist never dispatches another specialist. Any future code path that wants to run a specialist must go through the orchestrator.

### 2. Prose is never a durable handoff

Every specialist input and output is schema-validated. A specialist result (`SpecialistResultSchema`) either:

- `succeeded` with at least one typed artifact envelope (or an array of them);
- `failed` with failure details and **no** artifact output (no handoff on failure); or
- `abstained` with a reason and **no** artifact output (stage-style abstention, CONTEXT.md).

`validateSpecialistResult` is the deterministic gate before any result may become durable state: the result must parse, match the capability contract (name, output artifact type, version compatibility), and every produced envelope must carry a self-consistent content hash plus a payload that validates against the registered typed schema for its artifact type. Free-form text smuggled through the output slot fails the envelope schema; there is no prose handoff path.

### 3. Typed artifacts are versioned and carry lineage + provenance

Artifacts are canonical-JSON envelopes (`specialistArtifactEnvelopeSchema`):

- `schemaVersion` is semver; **same-major = compatible**, different major = rejected at parse time (`isSchemaVersionCompatible`). Schema `2.0.0` output is never read as `1.0.0`.
- `lineage` records `inputArtifactIds`, `parentArtifactIds`, the orchestrating run id, and an optional workflow reference — a downstream artifact always names the inputs it consumed.
- `provenance` records specialist, specialist version, executor, invoker, CMS code commit, the immutable policy snapshot id, duration, and creation time.
- `contentHash` (SHA-256 over `{ artifactType, schemaVersion, payload, lineage }`) makes payload or lineage tampering detectable at read time.

The envelope is persistence-compatible: it round-trips through canonical JSON serialization with no loss of lineage or provenance, so durable rows for artifacts can land with specialist implementations without reshaping the contract.

### 4. Registry exposes metadata and configuration only

`SpecialistRegistry` holds capability definitions (name/version/kind/input/output contracts) and per-specialist configuration descriptors with registry-validated values. Duplicate registrations and invalid configuration (including bad defaults) fail closed at registration time.

### 5. Per-specialist policies reuse Product Intelligence governance

There is no new policy model. `SpecialistPolicyAssignmentSchema` binds an existing immutable `ProductIntelligencePolicy` (PI-5, ADR 0010) to a specialist by name, and `verifySpecialistPolicy` reuses `verifyPolicySnapshot` (configId content self-check). Enforcement remains in the existing `PolicyGateway` and executors; a specialist can never invent its own governance.

### 6. Historical Product Intelligence runs remain readable

Issue #48 is additive: nothing in the run service, the terminal contracts, `parseLegacySubmission`/`HistoricalTerminalSubmission`, or the persisted-result parsing changes. Legacy and PI-4 run rows continue to parse exactly as before; the specialist modules are new imports that existing code paths never touch.

## Consequences

- Future specialist implementations have a fixed contract to implement against: declare capability + typed schema, produce envelope artifacts, fail or abstain explicitly, and be routed only by the orchestrator.
- Artifact validation is fail-closed: unregistered artifact types, major-incompatible schema versions, content-hash mismatches, and schema-violating payloads are all rejected with explicit issue lists — never coerced, never reinterpreted.
- The registry is a safe metadata surface for future policy/UI tooling without becoming an execution seam.

### Non-goals (deferred to later issues in epic #47)

- Specialist implementations (identity, extraction, classification specialists) and their durable DB rows.
- The orchestrator itself (the component that routes work and sequences specialists).
- Any user-facing UI for specialists.
- Wiring specialist policies into the `PolicyGateway` audit stream (reuses the existing machinery unchanged for now).

## Related decisions

- ADR 0010: the agent researches/proposes; deterministic CMS code validates — specialists inherit this boundary.
- ADR 0004: focused stages with explicit abstention/failure — specialist outcomes mirror stage outcomes.
- PI-5 (`src/product-intelligence/policy`): the single policy gateway and snapshot verification every specialist policy reuses.
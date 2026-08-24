# ADR 0028: Supervised Specialist Orchestrator and Lifecycle Management

**Status update (2026-08): SUPERSEDED operationally by ADR-0030 (Agent Lab decommission); paths below are deleted/historical.**

- Status: Accepted
- Date: 2026-08-18
- Issue: #56 (epic #47)

## Context

Replacing the monolithic product intelligence research agent requires an authoritative orchestrator to supervise and coordinate individual specialists (Discovery #49, Profile Engineer #51, Extraction Evidence Runner #52, Resolver #53, Curator #54, Verifier #55). Invariants established across Epic #47 require that specialists never invoke each other directly, that inter-specialist data flows are strictly typed artifacts, that loops terminate deterministically at retry/step bounds, and that cancellation and deadlines propagate reliably.

## Decision

Implement `SpecialistOrchestrator` under `src/product-intelligence/workflow/orchestrator.ts`:

1. **Deterministic State Machine**: Dispatches specialists sequentially in governed stages:
   `ProductSeed` → Discovery → [Profile Engineer if needed] → Extraction Runner → Resolver → Curator → Verifier.
2. **Structured Retry Routing**: Translates Verifier QA verdicts into targeted retries:
   - `retry_curator` re-runs Curator → Verifier.
   - `retry_resolver` re-runs Resolver → Curator → Verifier.
   - `retry_discovery` re-runs Discovery → pipeline.
   - All retry loops terminate at `maxRetries` (default 3) or `maxSteps` (default 20), holding in `needs_review` upon exhaustion.
3. **Terminal State Set**: Maps executions to exactly one of six terminal outcomes: `completed`, `needs_review`, `abstained`, `budget_exceeded`, `cancelled`, or `failed`.
4. **Cancellation & Budgets**: Rechecks `AbortSignal` and wall-clock deadlines between all specialist transitions, immediately transitioning to `cancelled` or `budget_exceeded`.
5. **Auditable Event Log**: Stretches an immutable step log (`events`) recording the start time, duration, status, and rationale for every specialist execution and retry decision.

## Consequences

- The specialist workflow operates as a deterministic, inspectable pipeline with clear provenance.
- Onboarding integration (#58) and the Agent Lab UI (#59) receive a complete `SpecialistWorkflowResult` containing all intermediate specialist artifact envelopes and step logs.

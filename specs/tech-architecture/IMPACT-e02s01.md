# Impact — e02s01 Specialist stage workspace

> Lightweight impact for build_epic e02s01. Change is client-side rendering only; no server route or DB migration in this story (server handoff deferred to e02s02).

## Touched surfaces
- `src/client/components/agent-lab/*` (AgentRunInspector, AgentLab, AgentRunTimeline, EvidenceInspector, ProductFieldEvidence, ConflictReviewPanel, VersionLineage)
- `src/client/agent-lab/logic.ts` (allowlist, field-status derivation, presentation)
- `src/client/hooks/useProductIntelligenceEvents.ts` (read-only event stream)
- `src/product-intelligence/workflow/bundle.ts`, `src/product-intelligence/specialists/*`, `src/product-intelligence/contracts.ts` (read-only artifact shapes)

## Dependents
- Server `src/server/routes/product-intelligence.ts` unchanged in s01 (read APIs already exist — workspace-scoped GET).
- Existing Agent Lab consumers (Agent Lab tab `?view=agentlab`) — no breaking API change; additive UI only.
- Evaluation/rollout (e03) will consume same artifact shapes; no schema change here.

## Risk
Low. No new network, no PolicyGateway bypass, no budget handling. Primary risk is display-layer XSS / chain-of-thought leakage — mitigated by allowlist in logic.ts and escaping.

## Tests
- `src/tests/unit/agent-lab-logic.test.ts` (40 tests)
- `src/tests/unit/agent-lab-components.test.tsx` (8)
- `src/tests/unit/agent-lab-events.test.tsx` (7)
- `src/tests/unit/agent-lab-training-ui.test.tsx` (7)
- `bun run typecheck` (hard gate), `bunx vitest run src/tests/unit/agent-lab` (filter matches above), `bunx vitest run src/tests/unit/product-intelligence-workflow.test.ts` for artifact shape regression (excluded from vitest default, run via test:db chain if needed).

## Gate
If risk score exceeds 7, require grill-me. Score here: 2/10 — proceed without grill-me.

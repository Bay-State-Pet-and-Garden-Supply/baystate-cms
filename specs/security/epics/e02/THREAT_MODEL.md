# Threat Model — e02 Agent Lab workspace — specialist workflow investigation UI (#59)

> Step 0 — security-review for build_epic e02 (e02s01+e02s02). e02s01 is client-side investigation UI; e02s02 adds server-authoritative mutation surface (retry/cancel/handoff) + SSE reconnect.

## Scope
- Epic e02: Specialist stage workspace — renders ProductSeed, Discovery, Extraction, Resolver, Curator, Verifier artifacts from typed contracts; per-field provenance, profile/version/method/path inspection, conflicts/unresolved surfacing, read-only policy/capability display; verification first-class with retry routing, server-authoritative retry/cancel/handoff, SSE reconnect, batch filters.
- Story e02s01: extends `src/client/components/agent-lab/*`, `src/client/agent-lab/logic.ts`, `src/client/hooks/useProductIntelligenceEvents.ts` (done at 862d130).
- Story e02s02: adds Verifier identity/data verdict controls, server-authoritative POST /api/product-intelligence/* (retry/cancel/handoff), cursor-based SSE reconnect, batch filters + deep links (current story).

## Surface Area
| Surface | Details | Trust boundary |
|---------|---------|----------------|
| Agent Lab UI rendering | Reads `PiRunRow`, `PiRunProjection`, artifacts via `src/product-intelligence-api.ts` (workspace-scoped GET). Renders operational events only; must NOT surface raw model chain-of-thought | Untrusted model prose → allowlisted `logic.ts` event presentation |
| Product seed / identity | Immutable `ProductSeed` displayed verbatim; candidate vs resolved identity distinction | Seed is operator input; display only |
| Evidence inspector | Source page URL, extraction method, content hash, artifact links | Server-provided provenance; no fetch from client |
| Profile/version/method/path | ExtractionEvidenceBundle metadata inspectable; read-only | Deterministic extraction provenance |
| Conflicts/unresolved panel | Resolver `conflicts` + unresolved fields; Verifier verdicts | Must not leak raw logs/tool stderr |
| Config/policy display | Feature flags, per-run `ProductIntelligencePolicy` snapshots, capability versions — read-only | Server owns policy; client never mutates |
| Verifier verdicts + retry routing | Verifier identity (`exact_match`/`parent_product_only`/`wrong_variant`/… ) and product-data verdicts with evidence citations; structured retry requests `retry_discovery`/`retry_curator`/`retry_resolver`/`human_review` | Verifier is deterministic specialist; UI only renders server verdict, never computes pass |
| Mutation controls (retry/cancel/handoff) | POST /api/product-intelligence/runs/:id/cancel, retry, handoff (Open workflow / Compare / Import verified / Retry) — server-authoritative, orchestrator routes, idempotent | Client must not route directly; server checks workspace ownership + BAYSTATE_CMS_API_TOKEN + run state; orchestrator is single authority |
| SSE reconnect | `useProductIntelligenceEvents` cursor `after` param, capped backoff [1s,2s,4s,8s], terminal-event stop, stale-run guard (runId mismatch) | Client reconnect must not DoS server; server rehydrates from workflow persistence, not from client state |
| Batch filters + deep links | Runs list filters `blocked`/`profile`/`identity`/`review-ready`; deep link `?view=agentlab&run=<id>`; onboarding badge `🤖 Agent result available` → Agent Lab | Filters are client-side presentation over server list; deep link must enforce workspace authz (404 cross-workspace) |

## Vulnerability Categories
- **XSS / injection via untrusted tool output**: Artifact fields (titles, evidence quotes, URLs) are untrusted data. Must be escaped; never interpolated into instructions or `dangerouslySetInnerHTML` without sanitization. (PI contracts already validate shapes.)
- **Information leakage**: Private chain-of-thought, raw tool errors, or prompt text must never render in timeline. Only allowlisted keys (`toolName`, `isError`, `field`, `severity`, `reasons`, `sourceUrl`, `rightsStatus`, `schemaVersion`, `code`) per `logic.ts:ALLOWED_PAYLOAD_KEYS`. Verifier retry reasons are structured codes, not raw logs.
- **Authorization bypass**: Run inspector + deep link `?view=agentlab&run=<id>` must enforce workspace ownership (server returns 404 cross-workspace). Client must not cache/share across workspaces. Handoff badges must not leak runs cross-workspace.
- **Mutation of policy**: UI must be read-only for flags/policy/capability versions; any write attempted from client is a blocker. Retry/cancel/handoff are the only POST surfaces, all server-authoritative.
- **CSRF / authz on mutation**: POST /api/product-intelligence/runs/:id/* requires `BAYSTATE_CMS_API_TOKEN` (server middleware) + workspace ownership check; idempotency key on retry to prevent double-spend; stale-run guards reject mismatched runId/sequence cursor.
- **SSE DoS / backoff abuse**: Reconnect uses capped backoff [1s,2s,4s,8s]; terminal-event stops reconnect; `after` cursor is validated as integer sequence; server rate-limits stream polls (`pollMs`).
- **State confusion / TOCTOU**: Orchestrator owns routing; client never sets provider/route; retry after completion must fail closed (409); cancellation requires active execution handle.

## Risk Level
**Medium-Low** — no new network egress or model invocation beyond existing PI runtime; mutation surface is narrow POST + SSE cursor. Risk remains display + controlled mutation, bounded by server authz/idempotency.

## Mitigations
- Reuse `src/client/agent-lab/logic.ts` strict allowlist for timeline rendering; Verifier retry requests are enum codes (`retry_discovery`/`retry_curator`/`retry_resolver`/`human_review`), not free prose.
- Escape all artifact string fields before render; URLs are hrefs with `rel=noopener noreferrer`; Verifier evidence citations link to evidence IDs, not raw URLs from untrusted extraction.
- Workspace-scoped fetch via existing `product-intelligence-api` (already 404 on cross-workspace); deep link handler validates run belongs to workspace before opening inspector.
- Read-only policy panel (no PUT/POST from client except narrowed POST /api/product-intelligence/runs/:id/{cancel,retry,handoff} with token + ownership checks); server is sole orchestrator router.
- SSE resilience: `useProductIntelligenceEvents` uses cursor `after` param, capped backoff 1/2/4/8s, terminal-event stop, stale-run guard (runId mismatch closes stream); state rehydrated from `workflow/persistence`, not client cache.
- Idempotency + state guards on retry: reject if run already terminal or already retrying (409); cancel requires active handle; handoff (import/compare) checks verified + workspace.
- Add unit tests in `src/client/agent-lab/logic.test.ts` to prove allowlist holds and XSS payloads are escaped; add `verifier-specialist`, `product-intelligence-workflow`, `product-intelligence-sse` unit coverage for retry mapping, SSE cursor, and deep-link filters.

## Verification
- e02s01: `bun run typecheck && bunx vitest run src/client/agent-lab/logic.test.ts` + `src/tests/unit/agent-lab` — PASS (done)
- e02s02 Task 1: `bun run typecheck && bunx vitest run src/tests/unit/verifier-specialist.test.ts` — specialist Verifier identity/data verdicts
- e02s02 Task 2: `bun run typecheck && bunx vitest run src/tests/unit/product-intelligence-workflow.test.ts` — server-authoritative retry/cancel/handoff (orchestrator authority)
- e02s02 Task 3: `bun run typecheck && bunx vitest run src/tests/unit/product-intelligence-sse.test.ts` — SSE cursor/backoff/terminal guard
- e02s02 Task 4: `bun run typecheck` + `bun run test:db --run src/tests/db/agent-lab` — batch filters + deep link + badge (if no dedicated test, `src/tests/unit/product-intelligence-workflow.test.ts` covers handoff idempotency)
- Manual: inspector with mock run containing chain-of-thought candidate shows no leakage; retry after terminal returns 409; SSE reconnect after refresh rehydrates cursor without duplicate events.

## Residual
- e02s02 mutation is narrow POST + SSE cursor; no new model/network/budget authority. Follow-up e03 adds evals/shadow with read-only metrics; no new threat there.
- Onboarding badge deep link (`?view=agentlab&run=<id>`) must remain 404 cross-workspace — verify via `product-intelligence-routes.test.ts` if feasible.
- Kill-switch (`BAYSTATE_CMS_PI_KILL_SWITCH`) and allowlisted policy gateway remain unchanged; retry must respect kill-switch (fail-closed).

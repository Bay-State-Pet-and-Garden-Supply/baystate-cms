# Threat Model — e02 Agent Lab workspace — specialist workflow investigation UI (#59)

> Step 0 — security-review for build_epic e02s01. e02 is client-side investigation UI; no new network/policy/budget authority.

## Scope
- Epic e02: Specialist stage workspace — renders ProductSeed, Discovery, Extraction, Resolver, Curator, Verifier artifacts from typed contracts; per-field provenance, profile/version/method/path inspection, conflicts/unresolved surfacing, read-only policy/capability display.
- Story e02s01: extends `src/client/components/agent-lab/*`, `src/client/agent-lab/logic.ts`, `src/client/hooks/useProductIntelligenceEvents.ts`.

## Surface Area
| Surface | Details | Trust boundary |
|---------|---------|----------------|
| Agent Lab UI rendering | Reads `PiRunRow`, `PiRunProjection`, artifacts via `src/product-intelligence-api.ts` (workspace-scoped GET). Renders operational events only; must NOT surface raw model chain-of-thought | Untrusted model prose → allowlisted `logic.ts` event presentation |
| Product seed / identity | Immutable `ProductSeed` displayed verbatim; candidate vs resolved identity distinction | Seed is operator input; display only |
| Evidence inspector | Source page URL, extraction method, content hash, artifact links | Server-provided provenance; no fetch from client |
| Profile/version/method/path | ExtractionEvidenceBundle metadata inspectable; read-only | Deterministic extraction provenance |
| Conflicts/unresolved panel | Resolver `conflicts` + unresolved fields; Verifier verdicts | Must not leak raw logs/tool stderr |
| Config/policy display | Feature flags, per-run `ProductIntelligencePolicy` snapshots, capability versions — read-only | Server owns policy; client never mutates |

## Vulnerability Categories
- **XSS / injection via untrusted tool output**: Artifact fields (titles, evidence quotes, URLs) are untrusted data. Must be escaped; never interpolated into instructions or `dangerouslySetInnerHTML` without sanitization. (PI contracts already validate shapes.)
- **Information leakage**: Private chain-of-thought, raw tool errors, or prompt text must never render in timeline. Only allowlisted keys (`toolName`, `isError`, `field`, `severity`, `reasons`, `sourceUrl`, `rightsStatus`, `schemaVersion`, `code`) per `logic.ts:ALLOWED_PAYLOAD_KEYS`.
- **Authorization bypass**: Run inspector must enforce workspace ownership (server returns 404 cross-workspace). Client must not cache/share across workspaces.
- **Mutation of policy**: UI must be read-only for flags/policy/capability versions; any write attempted from client is a blocker.

## Risk Level
**Medium-Low** — no new network egress, no model invocation, no budget gateway changes. Risk is display-layer only.

## Mitigations
- Reuse `src/client/agent-lab/logic.ts` strict allowlist for timeline rendering.
- Escape all artifact string fields before render; URLs are hrefs with `rel=noopener noreferrer`.
- Workspace-scoped fetch via existing `product-intelligence-api` (already 404 on cross-workspace).
- Read-only policy panel (no PUT/POST from this story; server-authoritative controls deferred to e02s02).
- Add unit tests in `src/client/agent-lab/logic.test.ts` to prove allowlist holds and XSS payloads are escaped.

## Verification
- `bun run typecheck && bunx vitest run src/client/agent-lab/logic.test.ts`
- `bun run typecheck && bunx vitest run src/tests/unit/agent-lab`
- Manual: inspector with mock run containing chain-of-thought candidate shows no leakage.

## Residual
- e02s02 will add retry/cancel/handoff server APIs — separate threat model update required then (mutation surface).

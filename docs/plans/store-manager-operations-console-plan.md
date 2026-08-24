# Store Manager Operations Console Plan (Epic Number TBD, After #42)

> **Status update (2026-08): SUPERSEDED by ADR-0030 (Agent Lab decommission) — content below references the deleted `src/product-intelligence/**` Agent Lab surface and is preserved as a historical record only.**

## Context

Epic #42 established the bounded Store Manager runtime in `src/store-manager/runtime/`: the executor resolves one model route, creates a per-turn immutable policy, validates messages, builds the static prompt and bounded context, dispatches versioned tools through the registry, applies the signed consumed-approval gate, enforces the whole-turn deadline and composed `AbortSignal`, emits redacted events, and links every terminal turn to `ai_model_calls`. Issues #36 and #40 are satisfied prerequisites; this plan does not reopen their implementation.

The next epic changes the product surface from “chat with tools” into an operations console. It adds explicit commands, a Manager Inbox, scheduled and event-driven read-only runs, versioned playbooks, diff-first review, scoped context, explicit operational memory, inspectable/replayable history, bounded natural-language history questions, deterministic bulk review, preview-only planning, and threshold notifications.

The governing vocabulary remains `CONTEXT.md`: a **Product SKU** is a store-facing key, an **Onboarding Batch** is only a view/aggregation lens, each Onboarding Item independently has a **Pipeline Stage** and **Stage Status**, a stored proposal is not a staged or approved change, and a Change Set draft/reviewing/approved/pushed state is not synonymous with imported/published/synced. Catalog operations may stage only into a Change Set; this epic does not grant direct catalog, Git, or ShopSite authority.

### Architectural invariant: many entrypoints, one authority

Every executable entrypoint must produce a strict `StoreManagerExecutionRequest` and call one exported runtime runner in `src/store-manager/runtime/executor.ts`:

```text
chat route ───────────────┐
slash-command registry ───┤
schedule dispatcher ──────┤
event-trigger dispatcher ─┼─> runStoreManagerExecution(request)
playbook step runner ──────┤       ├─ create immutable policy snapshot
history replay ────────────┤       ├─ StoreManagerToolRegistry dispatch
/plan preview ─────────────┘       ├─ risk + approval + ownership gates
                                  ├─ deadline/budget/cancellation
                                  └─ durable events + ai_model_calls telemetry
```

`runStoreManagerTurn` becomes a compatibility wrapper for the interactive-chat request kind; it must not remain a second orchestration implementation. Commands compile to a structured objective/tool hint, not direct service calls. Schedules and triggers use a policy mode whose allowlist is derived from adapter risk metadata and contains only `riskClass = 'read'` tools. A playbook step invokes the runner again under a fresh immutable execution policy; approval checkpoints pause the playbook and never synthesize approval messages. Replay creates a new run against current state and never reuses approval IDs, outputs, or an old mutable policy. Preview mode uses the same registered contracts and policy compiler but dispatches zero tools.

## Goals

1. Make common Store Manager workflows explicit and one-keystroke through a server-owned slash-command registry and command palette.
2. Make the Manager Inbox the single bounded triage queue for authoritative operational findings and review work.
3. Run scheduled and event-triggered investigations safely, with read-only execution enforced by the runtime rather than by prompt wording.
4. Store and execute immutable, versioned, governed playbooks made from registered steps.
5. Put scope, affected SKUs, before/after values, files, Change Set state, estimated network activity, and verification diffs ahead of approval.
6. Make workspace preferences explicit, versioned operational configuration—not hidden conversational memory.
7. Make every run inspectable, replayable against current state, comparable to prior runs, and queryable through a bounded deterministic history-query library.
8. Allow homogeneous deterministic fixes to be reviewed in bulk without losing per-proposal or per-SKU auditability.
9. Emit threshold notifications from deterministic state transitions rather than model-generated chatter.
10. Preserve all #42 fail-closed, workspace-ownership, approval, telemetry, cancellation, redaction, and no-fallback guarantees across every new entrypoint.

## Non-Goals and Boundaries

- No automatic staging, Change Set approval, Git commit, export, ShopSite upload, publish, sync, or image repair from a schedule or event trigger. The only durable outputs allowed from unattended runs are console reports, immutable candidate-proposal artifacts, Inbox items, and notifications. Candidate-proposal artifacts are review evidence, not `catalog_health_proposals` rows and not staging authority. Converting one into a stored proposal remains an interactive approval-gated `proposal_write`. The Phase B runtime is strictly read/report/propose-artifact-only.
- No agent-generated SQL, arbitrary SQL endpoint, unrestricted full-text model access to raw event payloads, or model-selected repository query. Natural-language history questions resolve to a finite server-owned query ID and typed parameters.
- No direct command-to-service switch. Slash commands never invoke `generateStoreManagerReport`, proposal services, image repair, sync, or repositories outside the runtime.
- No “trusted macro” bypass. A playbook does not inherit authority from its author, version, schedule, or previous successful execution.
- No bulk approval of semantic/typo proposals, mixed rules, mixed fields, evidence conflicts, manual-review-required items, stale proposals, cross-workspace items, or image/network repairs.
- No hidden conversational memory, embedding/vector-memory subsystem, prompt scraping, or automatic preference extraction from chat. Operational memory is explicit workspace configuration edited through reviewed forms/routes.
- No email, SMS, push-provider, Slack, webhook, or browser-notification integration in this epic. Notifications are durable in-app rows delivered by Store Manager SSE with polling fallback.
- No generic workflow engine for onboarding/classification/Product Intelligence. Playbooks are Store Manager-specific and call only Store Manager runtime contracts.
- No new Product Intelligence run/session tables and no routing Store Manager through PI. PI flag/router and SSE code are patterns only.
- No change to Product Type, Product Attribute, Category Page, classification configuration, or catalog-classification authority.
- No editing the sourcing-stage work listed under “Protected dirty-worktree paths.” Event integration observes existing state through new read adapters/polling; it does not patch those sources.
- No network/model/ShopSite calls during implementation or tests. Fakes, deterministic scripts, injected clocks, injected model transports, and disposable DBs only.
- No live-database write or live migration during implementation. A later activation/repair path requires a verified backup and explicit sanction.

## Locked Decisions

### 1. Unified execution request and immutable policy snapshot

Add a discriminated `StoreManagerExecutionRequest` with server-generated `runId`, `workspaceId`, `workspacePath`, optional `threadId`, `entrypoint` (`chat | command | schedule | event | playbook | replay | plan_preview`), `objective`, typed pinned scope, optional command/playbook/schedule/trigger lineage, selected model route, caller signal, and server-owned policy profile. Request-derived input may narrow scope but never widen tools, risk classes, budgets, deadline, or model/data-sharing policy.

Persist the complete redacted immutable policy snapshot (not only its hash) for new runs. On read, recompute and compare the hash; mismatch makes replay/inspection fail closed with `policy_snapshot_invalid`. Policy versions are append-only. Existing #42 session/turn rows remain readable.

### 2. Run identity and history substrate

Treat one `store_manager_sessions` row as one **run**, while retaining `sessionId` for compatibility. Extend it through a new additive migration/self-heal with `objective`, `entrypoint`, redacted scope JSON/hash, policy snapshot JSON, prompt version, command/playbook/schedule/trigger/replay lineage, and terminal summary fields. Continue linking model work to existing `ai_model_calls`; do not duplicate provider/model/token/cost columns.

Run events remain redacted structured facts. Add monotonic per-run `sequence` for cursor pagination/SSE and event types for compiled command, plan preview, checkpoint, schedule/trigger lineage, artifact/report creation, verification diff, and notification linkage. Never persist chain of thought, raw system/user prompts, secrets, signatures, absolute paths, raw catalog bodies, or raw network payloads.

### 3. Slash-command resolution is server-owned

The client may lex input only to show completion UI. The authoritative parser/compiler lives in a new server-neutral Store Manager command registry shared by routes/runtime tests. Each command has a stable name/version, aliases, strict Zod argument schema, description, scope requirements, a declarative objective, expected registered tool names/versions, and approval/network preview metadata. Unknown commands/arguments fail before model or tool execution.

Initial mapping:

| Command | Compiled objective / expected tools | Contract |
| --- | --- | --- |
| `/audit ProductField24` | audit field via `getProductFieldAudit` | validates a registered ProductField; read-only |
| `/health` | current health via `getCatalogHealthReport` + bounded issue listing | read-only |
| `/duplicates` | duplicate-focused audit in pinned/default ProductField scope | refuses ambiguous all-field scans without explicit bounded scope |
| `/explain SKU123` | exact SKU search plus evidence-backed explanation | scope pins one Product SKU; read-only |
| `/proposals` | `listStoredProposals` | read-only |
| `/changeset <id>` | new workspace-scoped Change Set detail/diff read adapter | read-only |
| `/report` | new runtime report adapter over deterministic evidence assembly | read-only by default; narrative only through configured model policy |
| `/repair-images <id>` | inspection first, then existing `repair_approved_change_set_images` | explicit approval and approved Change Set state still required |
| `/plan <objective-or-command>` | compile and validate only | zero model/tool/service dispatch; no DB write except the bounded preview audit row if enabled |

A command tool hint constrains expected behavior; the runner still exposes only the policy-derived registry allowlist and dispatches through the registry. The compiler must reject references to unregistered tool/version pairs.

### 4. Manager Inbox is a hybrid: materialized lifecycle rows, deterministic collectors

Use a workspace-scoped `store_manager_inbox_items` table for durable lifecycle (`open | acknowledged | resolved | superseded`) and deduplication. Do not cache mutable counts as the authority. A deterministic collector derives authoritative candidate facts from repository/service reads, then upserts a row with stable `{workspace, kind, source identity, rule version}` dedupe key, severity, current count, bounded title/summary, scope, source references, `firstSeenAt`, `lastSeenAt`, and resolved/superseded state.

Initial kinds: high-severity catalog issues, proposals awaiting review, failed sync jobs, image repairs recommended, and stalled Curation items/batches. “Curation batch stalled” is display shorthand only; the stored scope identifies Onboarding Items in Curation with stale `in_progress` or failed Stage Status and their Onboarding Batch lens. No batch lifecycle status is invented.

Inbox reads are materialized for stable acknowledgement/history; clicking an item re-reads current authority and labels stale/resolved rows. Inbox collectors and routes access DB only through repositories.

### 5. Scoped conversational context is explicit and server-resolved

A pinned scope is a strict discriminated union: `onboarding_batch`, `change_set`, `product_field`, `vendor`, or `sku_set`. It stores bounded identifiers only. The server resolves and workspace-checks it at run start and creates a redacted snapshot/hash. All read adapters receive the resolved scope and must either honor it or return `scope_unsupported`; they cannot silently fall back to the whole catalog. Scope changes start a new run/turn context and do not mutate prior history.

Vendor scope initially uses existing authoritative catalog/import evidence; if no workspace-owned vendor identifier can be resolved, pinning fails closed rather than accepting arbitrary text as identity.

### 6. Operational memory is explicit versioned workspace configuration

Create `store_manager_preferences` with immutable revisions and one active revision per workspace. The cross-boundary Zod schema supports reviewed keys such as ProductField semantic labels, vendor identifier conventions (for example UPC-A), health exclusions (for example discontinued Product SKUs), and named review-scope defaults. Values are entered/edited explicitly in Settings and validated against existing field/vendor/status identities. Never derive or update them from chat/model text.

Each execution records the active preference revision/hash in its policy/context snapshot. Historical runs render with their captured revision; replay defaults to current preferences and clearly records both source and replay revision hashes.

### 7. Scheduled identity, lease, and approval model

A schedule is a workspace-owned definition with stable ID, version, enabled flag, IANA timezone, constrained recurrence preset (daily/nightly/weekly; no arbitrary executable code), objective template, scope, model route, read-only policy profile, next/last run timestamps, and audit metadata. The scheduler has one sequential writer/dispatcher with an atomic lease/claim and a unique occurrence key so a restart cannot double-run an occurrence.

Scheduled identity is `actorType = system_schedule` plus schedule ID/version; it has no human approval authority. Runtime policy derives `allowedToolNames` from read-risk adapters only and `approvalPolicy = deny_persistent`. Any proposal-write, catalog-mutation, or network/filesystem-repair dispatch returns `policy_denied` before side effects. Missing/explicitly unavailable model routes produce an inspectable `unavailable` run; no fallback for explicitly selected models.

Initial templates: daily catalog-health scan, weekly cleanup report, nightly anomalies-since-yesterday, failed-sync digest, and stale-proposal review. They produce immutable report and candidate-proposal artifacts and may upsert Inbox/notification rows after deterministic validation. Candidate proposals remain artifacts until an interactive, approval-gated action stores them.

### 8. Event triggers use a durable outbox/cursor and the same read-only runtime

Do not invoke the Manager from inside a domain transaction. Add a Store Manager event-ingestion service with durable source cursors/dedupe keys. For event sources that already have a durable row (`sync_jobs`, Change Sets, onboarding items/batches), a poller observes committed state and enqueues a normalized trigger occurrence. This avoids touching protected sourcing/onboarding files and avoids losing in-memory SSE events across restart.

Initial triggers:

- after an import/Onboarding Batch reaches the defined completed-import observation → audit its Product SKUs;
- after a Change Set becomes approved → create a verification offer/read-only verification run, never auto-push;
- after a sync job fails → investigate recorded, redacted failure evidence and prepare a remediation report;
- after ProductField drift exceeds a deterministic configured delta → generate a review set/report.

Trigger identity is `actorType = system_event`, with no approval authority and the same read-only runtime profile as schedules. At-least-once observation plus idempotent occurrence keys is locked; exact-once execution is not claimed.

### 9. Notifications are durable facts + SSE, with polling fallback

Persist workspace-scoped notification rows, separate from Inbox lifecycle rows but linkable to them. A deterministic rule engine evaluates report snapshots/inbox transitions against explicit thresholds. It emits only on threshold crossing or a new source identity, not on every scan. Initial rules: critical issue count increased, sync failures appeared, image integrity dropped, proposal backlog exceeded `N`, and scheduled report found a new fingerprint.

Use cursor-based SSE with monotonically increasing sequence, workspace ownership checks, capped reconnect backoff, stale-workspace guards, and a bounded polling fallback. Reuse the behavioral pattern from `useProductIntelligenceEvents.ts`; do not couple wire types or endpoints to PI. Notification text is template-generated from validated counts and references, never free-form model chatter.

### 10. Playbook storage and versioning

Store a logical playbook plus immutable `store_manager_playbook_versions`. Editing creates a new draft version; activation is an explicit reviewed operation. Runs always capture version ID/hash and cannot observe later edits. Definitions use a strict DSL, not TypeScript/JavaScript or free-form tool names:

- `read`: one registered read tool plus validated input template;
- `summarize`: deterministic artifact summary or bounded model summary over prior structured outputs;
- `propose`: transient preview by default; persistent stored proposal only if a future version explicitly declares the proposal-write risk and reaches approval;
- `approval_checkpoint`: pauses with a diff bundle; it never approves;
- `execute`: one exact registered persistent tool call, only after a valid checkpoint approval bound to its input/scope/diff hash;
- `verify`: one or more registered read tools and a verification-diff artifact.

The playbook validator resolves every tool/version against the runtime registry, rejects cycles, unbounded fan-out, missing verification, mutation without immediately preceding approval, approval without a diff, scope widening, unknown variables, and steps exceeding runtime limits. The engine executes one step at a time by calling `runStoreManagerExecution`; it does not call adapter `.execute` directly.

Starter templates: weekly taxonomy cleanup, new vendor import review, image integrity pass, and launch readiness check. Templates are inactive examples until copied/activated for a workspace.

### 11. Diff-first action UX and verification

Every persistent adapter must support a deterministic preview contract, either via a paired read adapter or adapter `preview` metadata. The canonical `StoreManagerActionDiff` includes risk/tool/version, workspace and pinned scope hash, affected Product SKU count/list (bounded with truncation), before/after values, files expected to be touched (workspace-relative allowlisted paths only), current/expected Change Set state, estimated network activity (`none` or bounded request/host/count estimate), evidence references, generated-at state hashes, and staleness token.

Approval signs/binds the exact tool input plus diff hash and authoritative precondition hashes. Dispatch re-runs or validates the preview immediately before execution; drift/mismatch returns `stale_preview` and consumes no mutation authority. After success, the verify phase emits a `StoreManagerVerificationDiff` against authoritative current state. “Unknown” is displayed explicitly; the model cannot estimate file/network effects.

### 12. Replay and comparison semantics

Replay always creates a new run with `entrypoint = replay`, `replayOfRunId`, current catalog/context/preferences, current registered tool versions, and a newly computed policy snapshot. It never resumes the old session, copies model messages as authority, reuses approvals, or silently substitutes a missing model. The UI offers “same configured model” only if still available; otherwise the user explicitly selects another route and lineage records the change.

Comparison uses immutable normalized artifacts (health report, audit, diff, outcome), not assistant prose. Compare is allowed only for compatible artifact schema/kind/scope; incompatible versions return a clear non-comparable result unless a reviewed deterministic migration exists.

### 13. Natural-language history questions use a deterministic query library

The agent may choose only among a finite set of read tools backed by repository methods and strict parameters; it never emits SQL. Initial query IDs answer:

- what got worse between two compatible report periods;
- recurring issue fingerprints and recurrence counts;
- proposals rejected/dismissed more than once (requiring durable review-decision events introduced with bulk review);
- ProductFields ranked by cleanup proposal/review work.

The UI shows the selected query ID, scope, time window, result counts, and source run IDs. All rows are workspace-scoped, bounded, redacted, and pagination/cursor limited. If the question does not map to a supported query, return supported examples—never broaden to arbitrary DB access.

### 14. Bulk review model

A bulk group is a transient server-derived selection over individually persisted proposals, keyed by deterministic rule version, ProductField, normalization kind, exact mapping/evidence class, workspace, and current row hashes. No group-level row replaces proposal rows. A preview persists an immutable `store_manager_bulk_review_batches` header plus item snapshots/digests so the approval can bind the exact set.

Eligibility is fail closed: only deterministic casing/whitespace and audit-proven separator fixes; homogeneous field/rule/evidence; no semantic/typo/conflict/manual-review/stale/already-decided item; bounded count; exact workspace ownership. Approval writes one decision row per proposal/item in one transaction and stages through the existing Change Set service/tool contract. On any stale/mismatched item, the whole group refuses and requires a refreshed preview; no partial hidden approval. Per-item events reference the batch ID, actor, diff hash, decision, and resulting Change Set item.

### 15. Feature flags and rollout

Add Store Manager console flags, all default OFF except the already-shipped chat/runtime surface: `operationsConsoleEnabled`, `schedulesEnabled`, `eventTriggersEnabled`, `playbooksEnabled`, `bulkReviewEnabled`, and `notificationsEnabled`, plus `killSwitch`. Environment names use `BAYSTATE_CMS_STORE_MANAGER_*`. The kill switch disables new command/schedule/event/playbook/replay execution and scheduler polling, leaves history/inbox read access available, and never changes normal catalog/onboarding behavior. No legacy execution fallback is permitted for a disabled console entrypoint; return `not_configured`/`policy_denied` visibly.

## Release Gates and Dependency Order

```text
Foundation: Issue 1 unified execution contract + run artifacts/policy snapshots
                         │
Phase A: Issue 2 commands + /plan + scope/preferences
                         ├──> Issue 3 Manager Inbox + notifications shell
                         │
Phase B: Issue 4 scheduler/read-only jobs
                         └──> Issue 5 event-driven read-only jobs
                                      │
Phase C: Issue 6 playbook schema/versioning
                         └──> Issue 7 playbook runner + diff-first/replay/history queries
                                      │
Phase D: Issue 8 homogeneous bulk review
                         └──> Issue 9 operations-console integration and rollout
```

- Issue 1 is the **one-authority gate**. No new entrypoint ships until tests prove it calls `runStoreManagerExecution` and cannot dispatch an adapter outside registry/policy.
- Phase A follows the user’s binding order and ships slash commands plus the Manager Inbox before unattended automation.
- Phase B is read-only by runtime construction. Schedules and triggers remain disabled until lease/idempotency, kill-switch, and restart tests pass.
- Phase C stores/validates playbooks before any playbook can run. Mutation steps remain unavailable until diff/checkpoint/revalidation lands.
- Phase D bulk review depends on diff binding, durable decisions, Change Set staging, and replay/history audit.
- Each issue is reviewed and committed separately to `main` by the orchestrator. Workers do not commit or stage. Use one sequential writer; never parallelize issues sharing runtime contracts, schemas, routes, migrations, or `StoreManagerAssistant.tsx`.

## Cross-Cutting Fail-Closed Contracts

1. **Authority:** only `StoreManagerToolRegistry` adapters execute tools. No route, command, worker, trigger, scheduler, playbook, replay, or bulk action may call adapter `.execute` or persistent Store Manager services directly.
2. **Unattended mode:** policy contains an explicit execution mode and deny-persistent rule. Filtering tool descriptions/prompts is insufficient; registry dispatch denies non-read risk classes before approval or side effects.
3. **Approvals:** scheduled/event identity cannot approve. Playbook versions cannot preapprove. Replay cannot reuse approval. Bulk approval binds workspace, exact item digests, exact diff, exact transition, actor, and one execution context; consumed approval remains single-use.
4. **Workspace:** every identifier is resolved by workspace-scoped repository methods. Cross-workspace/unknown IDs are externally indistinguishable and mutate nothing.
5. **Scope:** a tool that cannot honor the pinned scope returns `scope_unsupported`; it never scans broader data silently.
6. **State freshness:** preview/checkpoint/action preconditions are re-read immediately before mutation. Any stale row/hash/status returns `stale_preview`; no best-effort subset.
7. **Bounds:** commands, objectives, scopes, schedules, occurrences, event payloads, artifacts, inbox rows, notifications, playbook steps/variables, history windows, comparisons, and bulk groups have strict count/string/byte/time bounds.
8. **Telemetry:** model calls continue in `ai_model_calls`. Run tables reference the row and policy/prompt/preference versions. No duplicate token/cost/provider columns.
9. **Model routing:** explicit selection never falls back. Unavailable unattended runs terminalize visibly and generate a bounded operational failure item without retry storms.
10. **No prose authority:** assistant summaries, model confidence, and narrative reports do not create findings, decisions, scopes, proposal safety, approvals, or verification success.
11. **Redaction:** no raw credentials, authorization headers, approval secrets/signatures, absolute paths, raw HTML/network bodies, raw ShopSite responses, raw prompts, or chain of thought in artifacts/events/inbox/notifications/logs.
12. **Persistence:** all DB reads/writes go through `src/db/repositories`; all cross-boundary payloads use strict Zod schemas in `src/shared/schemas`.
13. **Concurrency:** SQLite has one sequential scheduling/event/playbook writer. Claims use transactions/leases and unique occurrence keys. Crashed leases become retryable; active duplicate execution is refused.
14. **Catalog authority:** only existing Change Set staging/approval paths touch catalog drafts/canonical Git. No live DB or catalog activation in tests.

## Protected Dirty-Worktree Paths

The current worktree contains unrelated sourcing-stage work. Every worker records baseline hashes/status and must exclude these paths from its edit/stage/commit allowlist:

- `.gitignore`, `AGENTS.md`, `CONTEXT.md`
- `src/db/migrations.ts`
- `src/db/repositories/onboarding-item-repo.ts`
- `src/db/repositories/onboarding-evidence-repo.ts`
- `src/db/repositories/distributor-repo.ts`
- `src/db/repositories/onboarding-acceptance-repo.ts`
- `src/db/repositories/onboarding-conflict-repo.ts`
- `src/server/routes/onboarding-routes.ts`
- `src/client/components/Onboarding.tsx`
- `src/client/components/PipelineBoard.tsx`
- `src/client/onboarding-api.ts`
- `src/client/store-manager-logic.ts`
- `src/client/components/pipeline-drawer/*`
- `src/shared/schemas/onboarding.ts`
- `src/shared/schemas/distributor-evidence.ts`
- `src/product-intelligence/onboarding-import.ts`
- `src/onboarding/flags.ts`
- `src/onboarding/sourcing/*`
- `src/tests/unit/db-migration.test.ts`
- `src/tests/unit/onboarding-*.test.ts`
- `src/tests/unit/sourcing-*.test.ts`
- `src/tests/unit/distributor-*.test.ts`
- `src/tests/unit/conflict-*.test.ts`
- `src/tests/unit/acceptance-*.test.ts`
- `src/tests/unit/product-intelligence-import.test.ts`
- `src/tests/unit/store-manager-agent-contract.test.ts`
- `src/tests/unit/store-manager-client-logic.test.ts`
- `docs/adr/0007*`, `docs/adr/0014*`, `docs/plans/sourcing-*`

New Store Manager schema work therefore uses a **new migration module**, for example `src/db/store-manager-operations-migration.ts`, imported/called only after the sourcing work owner clears the integration point or by the orchestrator in a separately reconciled, exact edit. Implementers must not edit existing migration text in the dirty `src/db/migrations.ts`. The final orchestrator—not a worker—owns any minimal wiring reconciliation. Tests for the new migration go in new Store Manager-specific DB suites, not the protected `db-migration.test.ts`. `src/db/schema.sql` may be updated only if clean at issue start; otherwise the new idempotent migration/self-heal is the authority and schema snapshot reconciliation waits for the orchestrator.

## Implementation Phases and Issues

### Foundation — Issue 1: Generalize the #42 turn executor into the sole multi-entrypoint run boundary

#### Files

Modify:

- `src/store-manager/runtime/contracts.ts`
- `src/store-manager/runtime/policy.ts`
- `src/store-manager/runtime/tool-registry.ts`
- `src/store-manager/runtime/executor.ts`
- `src/store-manager/runtime/events.ts`
- `src/db/repositories/store-manager-session-repo.ts`
- `src/server/services/store-manager-telemetry.ts` (only task/lineage helpers; no new telemetry columns)
- `src/server/routes/store-manager-routes.ts`
- `src/shared/schemas/store-manager.ts`
- `src/tests/unit/store-manager-runtime.test.ts`
- `src/tests/unit/store-manager-tool-registry.test.ts`
- `src/tests/unit/store-manager-message-schema.test.ts`

Create:

- `src/shared/schemas/store-manager-operations.ts`
- `src/store-manager/runtime/execution-request.ts`
- `src/store-manager/runtime/artifacts.ts`
- `src/db/store-manager-operations-migration.ts`
- `src/tests/unit/store-manager-operations-migration.test.ts`
- `src/tests/unit/store-manager-execution-boundary.test.ts`
- `src/tests/fixtures/store-manager-operations.ts`

#### Work

1. Introduce the strict execution request, entrypoint, actor, objective, pinned-scope, lineage, execution-mode, artifact, and terminal-outcome schemas. Bound and redact every field.
2. Refactor `runStoreManagerTurn` into a wrapper around `runStoreManagerExecution`. Preserve current chat streaming and approval continuation behavior exactly.
3. Extend policy to version 2 with execution mode (`interactive | unattended_read_only | preview`), allowed tool **name+version** pairs, prompt/preferences hashes, actor class, and explicit persistent-risk rule. All server overrides narrow defaults only.
4. Add a non-chat objective path that uses the same model resolver/prompt/registry/event/telemetry/deadline machinery. Do not create a direct deterministic executor for commands/schedules/playbooks; deterministic preflight and artifact validation may run around the common runner.
5. Add preview compilation that resolves registered contracts, scope, risks, expected approvals, likely output kinds, file/network metadata, and budgets without model invocation or tool dispatch.
6. Add additive operations tables/columns via the new migration module and idempotent self-heal: run metadata/policy snapshot, monotonic event sequence, immutable artifacts, source lineage, and indexes. Verify hash on load.
7. Add workspace-scoped run/artifact/event listing and detail repository methods with cursor pagination and hard limits.
8. Preserve `deadline_exceeded`, caller cancellation, `AbortSignal.any`, single terminalization, event flush, and exact `ai_model_calls` linkage on every entrypoint.
9. Add a source-level transitive guard: routes/workers under this epic may import the executor/facade, never proposal/image-repair adapter execution or persistent services.

#### Acceptance tests

- `store-manager-execution-boundary.test.ts`: chat, command-shaped, schedule-shaped, event-shaped, playbook-shaped, replay, and preview requests all enter one injected runner seam; no alternate adapter dispatch; `runStoreManagerTurn` is compatibility-only.
- `store-manager-runtime.test.ts`: every entrypoint has a fresh session/run ID and immutable policy snapshot; explicit model no-fallback; deadline/caller abort; unavailable; terminal event exactly once; model call linked; preview causes zero model/tool calls.
- `store-manager-tool-registry.test.ts`: unattended mode denies all three persistent risk classes even with forged/valid-looking approval parts; name+version allowlist; scope unsupported; no side effect before denial.
- `store-manager-operations-migration.test.ts` (`bun test`): clean create, upgrade from #42 tables, repeat idempotency, missing-index/table self-heal, policy/artifact constraints, unique event sequence, disposable DB only.
- `store-manager-message-schema.test.ts`: strict objective/scope/lineage bounds and unknown-key rejection before model conversion.

#### Acceptance criteria

- There is exactly one runtime runner and one registry dispatch authority for every future entrypoint.
- Existing chat still streams and approves through the #42 contracts.
- An unattended or preview execution cannot persist a proposal, mutate catalog state, or invoke network/filesystem repair, even if model/message content requests it.
- Every run is inspectable from a hash-verified policy snapshot and redacted artifacts, with no duplicate telemetry columns.

---

### Phase A — Issue 2: Add slash commands, command palette, `/plan`, pinned scope, and explicit preferences

#### Files

Modify:

- `src/store-manager/runtime/contracts.ts`
- `src/store-manager/runtime/executor.ts`
- `src/store-manager/runtime/tool-registry.ts`
- `src/store-manager/tools/catalog-tools.ts`
- `src/server/services/store-manager-context.ts`
- `src/server/services/store-manager-prompt-builder.ts` (version bump and bounded scope/preferences rules only)
- `src/server/services/store-manager-tool-policy.ts`
- `src/server/routes/store-manager-routes.ts`
- `src/db/repositories/store-manager-session-repo.ts`
- `src/db/repositories/change-set-repo.ts` (workspace-scoped read helpers only)
- `src/db/store-manager-operations-migration.ts`
- `src/tests/unit/store-manager-operations-migration.test.ts`
- `src/client/store-manager-api.ts`
- `src/client/components/StoreManagerAssistant.tsx`
- `src/tests/unit/store-manager-runtime.test.ts`
- `src/tests/unit/store-manager-tool-registry.test.ts`
- `src/tests/unit/store-manager-context.test.ts`
- `src/tests/unit/store-manager-tools.test.ts`

Create:

- `src/shared/schemas/store-manager-command.ts`
- `src/shared/schemas/store-manager-scope.ts`
- `src/shared/schemas/store-manager-preferences.ts`
- `src/store-manager/commands/registry.ts`
- `src/store-manager/commands/compiler.ts`
- `src/store-manager/tools/change-set-read-tools.ts`
- `src/store-manager/tools/report-tools.ts`
- `src/db/repositories/store-manager-preference-repo.ts`
- `src/server/services/store-manager-scope-service.ts`
- `src/server/services/store-manager-preference-service.ts`
- `src/client/store-manager-command-logic.ts`
- `src/client/components/store-manager/CommandPalette.tsx`
- `src/client/components/store-manager/ScopePin.tsx`
- `src/client/components/store-manager/PlanPreview.tsx`
- `src/client/components/store-manager/PreferencesPanel.tsx`
- `src/tests/unit/store-manager-command-registry.test.ts`
- `src/tests/unit/store-manager-command-compiler.test.ts`
- `src/tests/unit/store-manager-scope.test.ts`
- `src/tests/unit/store-manager-preferences.test.ts`
- `src/tests/unit/store-manager-command-ui.test.tsx`

#### Work

1. Implement the stable server-owned registry and mappings in Locked Decision 3. Client palette descriptors come from a read endpoint generated from this registry; the client never maintains a second command catalog.
2. Route `POST /store-manager/commands/compile` and execution through `runStoreManagerExecution`. Reject unknown commands, trailing arguments, ambiguous duplicate scope, unregistered ProductFields, malformed IDs, and tool/version drift before model/adapter execution.
3. Implement `/plan` as compile/resolve/policy-preview only. It shows expected registered tools, pinned scope, risk classes, approval checkpoints, estimated network activity, and likely artifact kinds. It executes nothing—including reads—and labels estimates as contract-derived, not current facts.
4. Add Change Set detail/diff and deterministic report adapters to the normal registry. `/repair-images` compiles to inspection plus the existing approved repair tool; it does not call repair directly or imply preapproval.
5. Implement strict pinned-scope resolution and inject only bounded structured context below the system prompt. Update each affected read adapter to accept/honor scope explicitly or return `scope_unsupported`.
6. Add immutable preference revisions and active pointer repository/service. Validate ProductField/vendor/status identities server-side; capture active revision/hash on every new run. Add explicit Settings UI—never parse chat into preferences.
7. Keep `StoreManagerAssistant.tsx` orchestration-thin: compose new subcomponents; do not expand its monolithic tool-specific branching for every command.
8. Because `src/client/store-manager-logic.ts` is protected/dirty, put all new pure client derivation in `store-manager-command-logic.ts`.

#### Acceptance tests

- `store-manager-command-registry.test.ts`: exact required commands, stable versions/descriptors, aliases, strict schemas, no duplicate names, all tool hints resolve to registry name+version.
- `store-manager-command-compiler.test.ts`: each required command compiles to the expected objective/scope/tool hints; unknown/malformed/ambiguous commands fail before runner; no direct service imports; `/plan` dispatch/model counters remain zero.
- `store-manager-scope.test.ts`: all five scope types, ownership, bounds/dedupe, vendor unresolved, unsupported-tool refusal, scope snapshot hash, no whole-catalog widening.
- `store-manager-preferences.test.ts` (`bun test` where DB-backed): immutable revisions, one active revision, invalid ProductField/vendor/status, workspace isolation, replay captures old/new hash lineage, no chat-write API.
- `store-manager-tools.test.ts`: Change Set reads are workspace-scoped; report adapter uses bounded deterministic evidence; repair remains approval/state gated.
- `store-manager-command-ui.test.tsx`: keyboard palette, completions from server descriptors, accessible selection, scope chip, `/plan` preview, error display, and no client-side command execution.

#### Acceptance criteria

- All listed slash commands work through the common runtime contracts and cannot bypass policy/approval.
- `/plan` executes no model, tool, repository collector, network, or mutation; it is a contract preview only.
- “Find the weird ones” is bounded to a visible pinned scope or refuses unsupported ambiguity.
- Preferences are explicit, versioned, workspace-owned configuration captured in run history.

---

### Phase A — Issue 3: Build the Manager Inbox and deterministic in-app notification shell

#### Files

Modify:

- `src/server/routes/store-manager-routes.ts`
- `src/db/repositories/catalog-health-proposal-repo.ts` (bounded workspace-scoped aggregate/read helpers only)
- `src/db/repositories/sync-job-repo.ts` (workspace-scoped failure/read helpers only)
- `src/db/repositories/change-set-repo.ts` (image-repair recommendation read helpers only)
- `src/db/store-manager-operations-migration.ts`
- `src/tests/unit/store-manager-operations-migration.test.ts`
- `src/client/store-manager-api.ts`
- `src/client/components/StoreManagerAssistant.tsx`

Create:

- `src/shared/schemas/store-manager-inbox.ts`
- `src/shared/schemas/store-manager-notification.ts`
- `src/db/repositories/store-manager-inbox-repo.ts`
- `src/db/repositories/store-manager-notification-repo.ts`
- `src/server/services/store-manager-inbox-service.ts`
- `src/server/services/store-manager-inbox-collectors.ts`
- `src/server/services/store-manager-notification-service.ts`
- `src/server/routes/store-manager-events-routes.ts`
- `src/client/store-manager-inbox-logic.ts`
- `src/client/hooks/useStoreManagerEvents.ts`
- `src/client/components/store-manager/ManagerInbox.tsx`
- `src/client/components/store-manager/NotificationCenter.tsx`
- `src/tests/unit/store-manager-inbox-repo.test.ts`
- `src/tests/unit/store-manager-inbox.test.ts`
- `src/tests/unit/store-manager-notifications.test.ts`
- `src/tests/unit/store-manager-events-sse.test.ts`
- `src/tests/unit/store-manager-inbox-ui.test.tsx`

#### Work

1. Add inbox/notification tables in the operations migration with workspace indexes, stable dedupe fingerprints, source references, lifecycle, threshold state, sequence/cursor, and bounded payload constraints.
2. Implement deterministic collectors for the five required inbox categories. Collectors return typed candidates; one reconciliation transaction upserts new/changed rows, retains acknowledgement where appropriate, and resolves disappeared findings.
3. Define Curation stalls from item Stage Status and age thresholds; never use or create a controlling Onboarding Batch status.
4. Revalidate source authority when opening an Inbox item. A stale item remains auditable but cannot be treated as current or used to approve work.
5. Add acknowledge/resolve mutations with API-token auth, workspace predicates, and no catalog effect. The model has no tool to self-acknowledge or hide Inbox items.
6. Implement notification rule rows and in-app SSE/poll delivery. Phase A enables proposal backlog and critical/failure transition rules when collector snapshots change; Phase B adds scheduled-report rules.
7. Implement cursor sequence, `Last-Event-ID`/`after`, heartbeat, bounded batch size, workspace-change teardown, capped reconnect, dedupe, and polling fallback. Never reuse PI endpoints/types.
8. UI groups by severity/kind, shows authoritative count/source age/scope, and offers deterministic deep links/command prefill—not automatic action.

#### Acceptance tests

- `store-manager-inbox-repo.test.ts` (`bun test`): stable dedupe, lifecycle, acknowledgement retention, re-open on new fingerprint, workspace isolation, cursor ordering, bounds, idempotent reconciliation.
- `store-manager-inbox.test.ts` (`bun test`): exact five collector classes, Curation terminology/status logic, current-source revalidation, stale resolution, no onboarding mutation, no model/network.
- `store-manager-notifications.test.ts`: threshold crossing only, no duplicate chatter, deterministic templates, link to Inbox/source, acknowledgement separate from source resolution.
- `store-manager-events-sse.test.ts`: ownership, cursor replay, reconnect/dedupe, heartbeat, limit, malformed cursor, workspace swap, cleanup.
- `store-manager-inbox-ui.test.tsx`: counts, severity ordering, empty/loading/stale states, accessible acknowledgement, deep-link/prefill, no action-on-click.

#### Acceptance criteria

- The Manager Inbox is one stable triage queue with durable lifecycle and authoritative source revalidation.
- Required counts do not become stale cached authority; current source state is visible.
- Notifications are deterministic in-app threshold facts, not model prose.
- Inbox/notification actions cannot stage, publish, repair, or alter onboarding state.

---

### Phase B — Issue 4: Add leased scheduled read-only runs and report snapshots

#### Files

Modify:

- `src/store-manager/runtime/contracts.ts`
- `src/store-manager/runtime/policy.ts`
- `src/store-manager/runtime/executor.ts`
- `src/server/routes/store-manager-routes.ts`
- `src/server/index.ts` (start/stop wiring only, if clean and isolated)
- `src/db/store-manager-operations-migration.ts`
- `src/tests/unit/store-manager-operations-migration.test.ts`
- `src/client/store-manager-api.ts`
- `src/client/components/StoreManagerAssistant.tsx`

Create:

- `src/shared/schemas/store-manager-schedule.ts`
- `src/db/repositories/store-manager-schedule-repo.ts`
- `src/server/services/store-manager-schedule-service.ts`
- `src/server/services/store-manager-scheduler.ts`
- `src/store-manager/schedules/templates.ts`
- `src/store-manager/flags.ts`
- `src/client/store-manager-schedule-logic.ts`
- `src/client/components/store-manager/SchedulesPanel.tsx`
- `src/tests/unit/store-manager-flags.test.ts`
- `src/tests/unit/store-manager-schedule-repo.test.ts`
- `src/tests/unit/store-manager-scheduler.test.ts`
- `src/tests/unit/store-manager-scheduled-runtime.test.ts`
- `src/tests/unit/store-manager-schedules-ui.test.tsx`

#### Work

1. Add schedule/version/occurrence/lease tables and report artifacts through the operations migration. Store timezone, recurrence preset, next/last occurrence, model selection, scope, policy profile, definition hash, enable audit, and unique occurrence key.
2. Add flags mirroring the PI runtime flag pattern but Store Manager-local. All new automation defaults OFF; kill switch dominates execution and stops new claims.
3. Implement deterministic recurrence calculation with injected clock and IANA timezone. Define DST behavior: one occurrence per local schedule label; spring gaps advance to next valid instant, repeated fall hour uses the first instant and occurrence key prevents duplication.
4. Build the five initial templates. Daily/nightly/weekly semantics are explicit in UI, not hidden cron. Users may change supported time/day/timezone/scope/thresholds only.
5. Implement one poller/dispatcher with transactional claim, owner, lease expiry, heartbeat, max catch-up window, bounded concurrency of one writer, and idempotent occurrence finalization.
6. Each occurrence calls `runStoreManagerExecution` with unattended identity and read-only policy. Any persistent adapter is absent/denied at dispatch. Store immutable normalized report and candidate-proposal artifacts and reconcile Inbox/notifications after artifact validation; storing a candidate into `catalog_health_proposals` remains a separate interactive approval.
7. On failure/unavailable/deadline, terminalize once, release/expire lease safely, apply capped retry/backoff, and create one deduped operational item—no tight retry loop.
8. UI supports enable/disable/edit/run-now-read-only, next/last status, and linked history. “Run now” still uses system read-only policy; it is not an approval shortcut.

#### Acceptance tests

- `store-manager-flags.test.ts`: defaults OFF, env parsing fail-closed, override/reset, kill switch dominance.
- `store-manager-schedule-repo.test.ts` (`bun test`): versions, unique occurrence, atomic claim, competing worker, lease expiry, heartbeat, workspace isolation, disabled/kill switch, idempotent completion.
- `store-manager-scheduler.test.ts`: daily/nightly/weekly calculations, timezone/DST, downtime catch-up bound, retry/backoff, one writer, graceful stop, injected clock.
- `store-manager-scheduled-runtime.test.ts`: all five templates enter the common runner; read tools only; forged persistent call denied before side effect; model unavailable has no fallback; artifacts/inbox/notifications validated and linked.
- `store-manager-schedules-ui.test.tsx`: explicit timezone/next run/read-only badge, disabled default, run-now semantics, failure visibility.

#### Acceptance criteria

- Scheduled runs inspect and report without any staging, approval, publish, sync, or repair authority.
- Restarts and competing polls cannot duplicate a schedule occurrence.
- Every occurrence has a run, policy snapshot, artifact or terminal reason, and exact telemetry linkage.
- Automation remains inert when flags are off or kill switch is on.

---

### Phase B — Issue 5: Add durable event-triggered read-only runs

#### Files

Modify:

- `src/db/repositories/change-set-repo.ts` (workspace-scoped transition observation helpers)
- `src/db/repositories/sync-job-repo.ts` (workspace-scoped terminal observation helpers)
- `src/db/store-manager-operations-migration.ts`
- `src/tests/unit/store-manager-operations-migration.test.ts`
- `src/server/routes/store-manager-routes.ts`
- `src/server/index.ts` (shared worker lifecycle wiring only)
- `src/client/store-manager-api.ts`

Create:

- `src/shared/schemas/store-manager-trigger.ts`
- `src/db/repositories/store-manager-trigger-repo.ts`
- `src/db/repositories/store-manager-source-observer-repo.ts`
- `src/server/services/store-manager-trigger-service.ts`
- `src/server/services/store-manager-event-worker.ts`
- `src/store-manager/events/trigger-registry.ts`
- `src/client/components/store-manager/TriggersPanel.tsx`
- `src/tests/unit/store-manager-trigger-repo.test.ts`
- `src/tests/unit/store-manager-event-worker.test.ts`
- `src/tests/unit/store-manager-event-runtime.test.ts`
- `src/tests/unit/store-manager-triggers-ui.test.tsx`

#### Work

1. Add trigger definitions, source cursors, and occurrence/outbox rows with stable source kind/id/version/status fingerprint and workspace ownership.
2. Implement the four locked trigger definitions and deterministic enabling thresholds. ProductField drift compares compatible artifact counts under an explicit preference/trigger threshold.
3. Observe only committed durable state through repositories. Polling records a cursor after occurrence insert in one transaction. In-memory onboarding SSE may prompt an earlier poll but is never the durable source.
4. Define import-finished conservatively from current schema and vocabulary: an occurrence is emitted only when the configured import observation is terminal and all selected Product SKUs are known. If that cannot be proven, emit no run and create a diagnostic—not a guessed completion.
5. Dispatch each occurrence through the same unattended read-only runtime policy as schedules. Change Set approved produces a verification **offer/report**, never a push; sync failure uses redacted stored error evidence only.
6. Dedupe at least-once observations, handle out-of-order source changes, ignore foreign workspace rows, cap source scan/catch-up, and prevent trigger loops from Store Manager’s own Inbox/report rows.
7. Add enable/disable/threshold UI and linked occurrence history. All trigger flags default OFF.

#### Acceptance tests

- `store-manager-trigger-repo.test.ts` (`bun test`): occurrence dedupe, source cursor atomicity, out-of-order update, replay after crash, workspace isolation, bounded catch-up.
- `store-manager-event-worker.test.ts`: four exact triggers, conservative import terminality, Change Set transition, failed sync transition, ProductField delta, no self-trigger loop, graceful stop/lease recovery.
- `store-manager-event-runtime.test.ts`: every occurrence enters the common runner with event lineage/read-only policy; attempts to store/stage/repair/push are denied before side effects; reports/inbox links are idempotent.
- `store-manager-triggers-ui.test.tsx`: off by default, scope/threshold visibility, occurrence source link, no “auto fix” wording.

#### Acceptance criteria

- All four event workflows are durable, idempotent, inspectable, and read-only.
- No protected onboarding/sourcing source is modified to add hooks.
- A Change Set approval or sync failure never causes automatic remote/catalog action.
- Missing/ambiguous source evidence produces no guessed trigger run.

---

### Phase C — Issue 6: Add immutable saved-playbook definitions and validation

#### Files

Modify:

- `src/store-manager/runtime/contracts.ts`
- `src/store-manager/runtime/tool-registry.ts`
- `src/server/routes/store-manager-routes.ts`
- `src/db/store-manager-operations-migration.ts`
- `src/tests/unit/store-manager-operations-migration.test.ts`
- `src/client/store-manager-api.ts`
- `src/client/components/StoreManagerAssistant.tsx`

Create:

- `src/shared/schemas/store-manager-playbook.ts`
- `src/db/repositories/store-manager-playbook-repo.ts`
- `src/store-manager/playbooks/contracts.ts`
- `src/store-manager/playbooks/validator.ts`
- `src/store-manager/playbooks/templates.ts`
- `src/server/services/store-manager-playbook-service.ts`
- `src/client/store-manager-playbook-logic.ts`
- `src/client/components/store-manager/PlaybooksPanel.tsx`
- `src/client/components/store-manager/PlaybookEditor.tsx`
- `src/tests/unit/store-manager-playbook-repo.test.ts`
- `src/tests/unit/store-manager-playbook-validator.test.ts`
- `src/tests/unit/store-manager-playbook-templates.test.ts`
- `src/tests/unit/store-manager-playbook-ui.test.tsx`

#### Work

1. Add logical playbook/version/activation tables. Versions are immutable and content-addressed; draft editing creates a new version. Activation records actor/time/hash.
2. Implement the strict bounded DSL and registry-aware validator in Locked Decision 10. No loops, code, arbitrary prompt/tool name, dynamic imports, unrestricted branching, or unbounded SKU fan-out.
3. Compute static risk and expected approval/diff/verification shape from registered adapter metadata. Reject definitions whose stored metadata disagrees with current registry.
4. Require scope input contracts and variable types. A narrower child scope is allowed; widening from a pinned parent scope is rejected.
5. Seed the four starter templates as inert code-owned descriptors; copying creates a workspace draft. Weekly taxonomy cleanup uses Store Manager ProductField cleanup terminology and must not mutate classification configuration.
6. Add preview/editor UI with version history, active hash, risk badges, step contracts, expected network/files, and activation review. Do not add a “trust this playbook” toggle.

#### Acceptance tests

- `store-manager-playbook-repo.test.ts` (`bun test`): immutable versions, hash, one active version/workspace, copy-on-edit, activation audit, cross-workspace 404, tamper detection.
- `store-manager-playbook-validator.test.ts`: valid read→summarize→propose→approval→execute→verify; reject unknown/version drift, cycle, scope widening, unbounded fan-out, missing diff/checkpoint/verify, mutation before approval, mixed exact tools, unknown variables, forged risk downgrade.
- `store-manager-playbook-templates.test.ts`: all four templates validate against current registry and are inactive/read-safe by default.
- `store-manager-playbook-ui.test.tsx`: version/risk/activation visibility, no implicit activation, inaccessible invalid run action.

#### Acceptance criteria

- Playbooks are versioned data, not executable code or trusted prompts.
- A playbook cannot grant authority or hide a registered tool’s risk.
- Every active version is content-addressed, workspace-owned, registry-valid, and reviewable.
- Starter templates do nothing until explicitly copied/activated and run.

---

### Phase C — Issue 7: Execute playbooks with diff-first checkpoints; add run history, replay, comparison, and bounded NL history queries

#### Files

Modify:

- `src/store-manager/runtime/contracts.ts`
- `src/store-manager/runtime/policy.ts`
- `src/store-manager/runtime/tool-registry.ts`
- `src/store-manager/runtime/executor.ts`
- `src/store-manager/runtime/events.ts`
- `src/server/services/store-manager-tools.ts`
- `src/server/services/store-manager-tool-policy.ts`
- `src/db/repositories/store-manager-session-repo.ts`
- `src/db/repositories/ai-model-call-repo.ts` (read joins/helpers only)
- `src/db/repositories/change-set-repo.ts`
- `src/db/repositories/catalog-health-proposal-repo.ts`
- `src/db/store-manager-operations-migration.ts`
- `src/tests/unit/store-manager-operations-migration.test.ts`
- `src/store-manager/tools/proposal-tools.ts`
- `src/store-manager/tools/image-repair-tool.ts`
- `src/server/routes/store-manager-routes.ts`
- `src/client/store-manager-api.ts`
- `src/client/components/StoreManagerAssistant.tsx`
- `src/tests/unit/store-manager-approval.test.ts`
- `src/tests/unit/store-manager-runtime.test.ts`
- `src/tests/unit/store-manager-tool-registry.test.ts`

Create:

- `src/shared/schemas/store-manager-diff.ts`
- `src/shared/schemas/store-manager-history.ts`
- `src/db/repositories/store-manager-playbook-run-repo.ts`
- `src/db/repositories/store-manager-history-repo.ts`
- `src/store-manager/runtime/action-preview.ts`
- `src/store-manager/playbooks/runner.ts`
- `src/store-manager/history/query-registry.ts`
- `src/store-manager/tools/history-tools.ts`
- `src/server/services/store-manager-replay-service.ts`
- `src/server/services/store-manager-comparison-service.ts`
- `src/server/services/store-manager-history-query-service.ts`
- `src/client/store-manager-history-logic.ts`
- `src/client/components/store-manager/ActionDiffReview.tsx`
- `src/client/components/store-manager/VerificationDiff.tsx`
- `src/client/components/store-manager/RunHistory.tsx`
- `src/client/components/store-manager/RunInspector.tsx`
- `src/client/components/store-manager/RunComparison.tsx`
- `src/tests/unit/store-manager-action-diff.test.ts`
- `src/tests/unit/store-manager-playbook-runner.test.ts`
- `src/tests/unit/store-manager-history.test.ts`
- `src/tests/unit/store-manager-replay.test.ts`
- `src/tests/unit/store-manager-history-query.test.ts`
- `src/tests/unit/store-manager-run-ui.test.tsx`

#### Work

1. Add strict diff/verification schemas and preview providers for every persistent adapter. For proposal storage/staging and image repair, derive exact count/before-after/relative files/state/network metadata from authoritative services. “Unknown” is a typed value, not omitted.
2. Bind approval to tool/version/input, workspace, pinned scope hash, preview/diff hash, precondition hashes, policy/run ID, and expiry. Dispatch revalidates ownership/state/hash before consuming mutation authority; stale preview denies with no side effect.
3. Persist checkpoint and playbook-run/step state. Runner claims one step, calls `runStoreManagerExecution`, persists typed output/artifact, and pauses at approval. Resume creates a fresh step execution with exact checkpoint lineage; it never calls adapters directly.
4. After mutation, force declared verification reads through the registry and store a verification diff. A tool’s success result alone is not displayed as verified.
5. Add history list/detail that joins run/session/event/artifact and existing `ai_model_calls` telemetry. Show objective, entrypoint, tools/versions/statuses, approvals, evidence/artifacts, terminal outcome, model/cost, policy/prompt/preferences versions, and lineage—never chain of thought.
6. Implement replay as a new current-state run under current policy/tool/preferences. Refuse invalid source policy snapshots, unavailable explicit model, missing tool version without a reviewed migration, foreign run, or incompatible scope.
7. Implement artifact comparison with compatibility checks and deterministic deltas. Reports compare counts/fingerprints; action/verification diffs compare typed fields.
8. Implement finite history query registry/read adapters for the four required questions. Model maps text to query ID/params only; repository SQL is fixed and workspace-scoped. Unsupported questions return supported IDs.
9. Add cursor-based live run updates using the Store Manager SSE hook from Issue 3.

#### Acceptance tests

- `store-manager-action-diff.test.ts` (`bun test` as needed): exact affected SKU count/list/truncation, before/after, relative files, Change Set state, network estimate, evidence, deterministic hash, stale state denial, no absolute paths/secrets.
- `store-manager-approval.test.ts`: approval exact diff binding, one-use, altered group/scope/input, stale preview, cross-run/workspace, expiry, schedule/event identity cannot approve.
- `store-manager-playbook-runner.test.ts` (`bun test`): each step invokes common runner, pause/resume, crash recovery/lease, failed step, approval denial, verify mandatory, version immutable mid-run, no adapter direct execution.
- `store-manager-history.test.ts`: workspace/cursor/bounds, exact telemetry join, event ordering, redaction, policy hash verification, no chain-of-thought/raw prompt.
- `store-manager-replay.test.ts`: new ID/current state/current preferences, source lineage, no approval reuse, explicit model no-fallback, incompatible/missing version refusal, deterministic comparison.
- `store-manager-history-query.test.ts`: four query IDs, fixed parameter schemas, unsupported query, time/scope bounds, no SQL/model text accepted, recurring/rejected/field-work counts trace to source run/proposal decision IDs.
- `store-manager-run-ui.test.tsx`: PR-like diff before approval, verification after action, objective/tools/approval/evidence/outcome/cost/policy display, replay and compare warnings, no publish button.

#### Acceptance criteria

- Every persistent action is preceded by a fresh deterministic diff and followed by an authoritative verification diff.
- Playbooks pause rather than bypass approval and call only the common runner.
- Every run is inspectable and replay creates a separate current-state run with honest lineage.
- Natural-language history access cannot generate or execute SQL and always exposes the deterministic query selected.

---

### Phase D — Issue 8: Add homogeneous deterministic bulk review with per-item audit

#### Files

Modify:

- `src/shared/schemas/catalog-health-proposal.ts`
- `src/db/repositories/catalog-health-proposal-repo.ts`
- `src/db/store-manager-operations-migration.ts`
- `src/tests/unit/store-manager-operations-migration.test.ts`
- `src/store-manager/tools/proposal-tools.ts`
- `src/server/services/store-manager-tool-policy.ts`
- `src/server/services/product-field-refactor-service.ts`
- `src/server/routes/store-manager-routes.ts`
- `src/client/store-manager-api.ts`
- `src/client/components/StoreManagerAssistant.tsx`
- `src/tests/unit/store-manager-ai-proposals.test.ts`
- `src/tests/unit/store-manager-approval.test.ts`
- `src/tests/unit/store-manager-tools.test.ts`

Create:

- `src/shared/schemas/store-manager-bulk-review.ts`
- `src/db/repositories/store-manager-bulk-review-repo.ts`
- `src/server/services/store-manager-bulk-review-service.ts`
- `src/store-manager/tools/bulk-review-tools.ts`
- `src/client/store-manager-bulk-review-logic.ts`
- `src/client/components/store-manager/BulkReviewPanel.tsx`
- `src/tests/unit/store-manager-bulk-review-repo.test.ts`
- `src/tests/unit/store-manager-bulk-review.test.ts`
- `src/tests/unit/store-manager-bulk-review-tools.test.ts`
- `src/tests/unit/store-manager-bulk-review-ui.test.tsx`

#### Work

1. Add explicit normalization kind/rule version/evidence key/current digest/manual-review eligibility to new proposal records without reclassifying old AI rows as safe. Legacy/unknown rows default ineligible.
2. Derive homogeneous groups server-side under Locked Decision 14. Grouping is a read/preview operation; selection uses stable proposal IDs plus row digests and a hard item/SKU cap.
3. Persist immutable batch preview header/items/diff. Show total proposals, total distinct Product SKUs, exact mapping/rule/evidence, before/after samples, expected Change Set files/state, exclusions with reason, and truncation.
4. Add one approval-required bulk stage adapter to the standard registry/policy. It calls a transaction-aware service, revalidates every proposal/affected Product SKU/current value/Change Set state, and refuses the full batch on any mismatch.
5. Preserve one proposal status transition, one decision/audit record, one Change Set item/result reference, and runtime event per item. The batch ID is correlation only.
6. Verify every affected Product SKU after staging and store one aggregate plus per-item verification diff. Never claim catalog approval/publish/sync.
7. UI supports select homogeneous group, inspect exclusions, approve/deny exact batch, and drill into each item. No “select all proposals” across groups.

#### Acceptance tests

- `store-manager-bulk-review.test.ts` (`bun test`): only casing/whitespace/audit-proven separator; semantic/typo/AI/manual/conflict/stale/mixed field/rule/evidence rejected; deterministic grouping/order/hash; bounded counts.
- `store-manager-bulk-review-repo.test.ts` (`bun test`): immutable preview/items, workspace isolation, per-item decision rows, correlation, idempotency, rollback on one stale item.
- `store-manager-bulk-review-tools.test.ts`: normal registry/policy/approval/diff path, exact batch binding, no direct route mutation, transaction rollback, Change Set staging only, per-SKU verification.
- Existing proposal tests: legacy rows remain ineligible; confidence never grants bulk safety; unknown fields/identities fail closed.
- `store-manager-bulk-review-ui.test.tsx`: homogeneous grouping/exclusions/diff, per-item drill-down, deny/stale refresh, no partial-success masking, no approved/published wording.

#### Acceptance criteria

- A homogeneous set such as 80 deterministic casing fixes can be approved once while retaining per-item decisions/events/Change Set audit.
- One stale or ineligible item blocks the whole submitted batch; no silent subset applies.
- Semantic/AI-confidence-based proposals never enter bulk eligibility.
- Bulk execution stages a Change Set only and displays verification without implying approval, publish, or sync.

---

### Phase D — Issue 9: Integrate the operations console, harden rollout, and close the epic

#### Files

Modify:

- `src/client/components/StoreManagerAssistant.tsx`
- `src/client/store-manager-api.ts`
- `src/server/routes/store-manager-routes.ts`
- `src/server/routes/store-manager-events-routes.ts`
- `src/server/index.ts`
- `src/store-manager/flags.ts`
- `src/db/store-manager-operations-migration.ts`
- `src/tests/unit/store-manager-operations-migration.test.ts`
- `src/tests/unit/store-manager-runtime.test.ts`
- `src/tests/unit/store-manager-tool-registry.test.ts`

Create:

- `src/client/components/store-manager/OperationsConsole.tsx`
- `src/client/components/store-manager/OperationsNav.tsx`
- `src/client/components/store-manager/OperationsEmptyState.tsx`
- `src/tests/unit/store-manager-operations-console.test.tsx`
- `src/tests/unit/store-manager-operations-acceptance.test.ts`
- `docs/adr/0015-store-manager-operations-console-entrypoints.md`

#### Work

1. Compose Inbox, command palette/chat, scopes, schedules/triggers, playbooks, history, notifications, and bulk review into an operations-console navigation. Preserve focused URLs/deep links and accessible keyboard/focus behavior.
2. Document the one-authority architecture, unattended read-only identity, playbook/checkpoint authority, explicit operational memory, and accepted local single-operator residual in ADR 0015. Do not edit protected ADRs/CONTEXT.
3. Add feature-flag and kill-switch states to routes and UI. Reads/history remain available during kill switch; new runs/claims/resumes refuse. Active mutation checkpoints become invalid and require a fresh preview after re-enable.
4. Add retention policy for run events/artifacts/inbox/notifications that preserves decision/audit lineage. Pruning is workspace-scoped, bounded, transactional, and never deletes `ai_model_calls` rows still referenced by retained runs.
5. Add transitive architecture checks for forbidden imports/direct calls and a complete entrypoint matrix acceptance fixture.
6. Perform fake-only manual acceptance: palette, inbox triage, scope, preference revision, scheduled/event report, playbook pause/diff/approve/verify, run replay/compare/history query, bulk group, threshold notification, kill switch.
7. Orchestrator performs the per-issue commits. Workers leave changes unstaged and report exact files/tests. No catalog commit is sanctioned by this epic.

#### Acceptance tests

- `store-manager-operations-acceptance.test.ts`: every entrypoint matrix row reaches the same runner/policy/registry; unattended mutation denial; approval binding; workspace isolation; kill switch; terminal history/telemetry; no live network/model/ShopSite.
- `store-manager-operations-console.test.tsx`: keyboard navigation, deep links, error/empty/offline/reconnecting/flagged-off/kill-switch states, accessible diffs and approval controls, no automatic action.
- Architecture guard scans new route/worker/playbook/command files for direct imports of persistent services, adapter `.execute`, raw `getDb`, raw `fetch`, filesystem writes, or ShopSite modules.
- Retention tests: referenced audit/decision lineage preserved, stale artifacts pruned, cross-workspace untouched, interruption rolls back.

#### Acceptance criteria

- Store Manager is an operating console with all requested surfaces integrated and feature-gated.
- All seven entrypoint kinds share the #42 runtime authority model with no bypass.
- Kill switch stops new execution and worker claims without destroying inspectable history.
- Reviewer can trace every operational claim/action from objective through tools, policy, approval, evidence, outcome, cost, and verification.

## Worker Guidance

1. **Before issue work:** record `git status --short`, `git diff --cached --name-only`, and `git diff -- <issue allowlist>`. Hash protected dirty paths if concurrent work is active. Stop if an allowed target unexpectedly changes during the issue.
2. **Exact allowlists:** touch only the files listed for that issue. If a necessary file is protected/dirty or absent from the list, stop and escalate; do not opportunistically fix it.
3. **One sequential writer:** no parallel workers on runtime contracts, operations schemas/migration, routes, repositories, Store Manager UI, or shared tests.
4. **No worker commits:** workers do not stage or commit. The orchestrator reviews focused diffs/tests and makes one commit per issue to `main`. There is no sanctioned nested-catalog commit path in this epic.
5. **Migration discipline:** use `src/db/store-manager-operations-migration.ts` with new version keys/numbered blocks and idempotent self-heals. Do not edit the existing dirty migration text. Use only disposable temp DBs and clean up DB/WAL/SHM files.
6. **Repository discipline:** no `getDb()` outside repositories/migration code. Routes and runtime adapters call services/repositories; adapters contain no raw SQL, `fetch`, or filesystem writes.
7. **Schema discipline:** strict Zod at every server/client/worker boundary; bound counts, strings, JSON bytes, cursors, recurrences, step counts, scopes, artifacts, and history windows. Unknown keys fail.
8. **Test isolation:** inject clock, UUID, model resolver/transport, runner, event source, and network transport. Tests must not contact a provider, ShopSite, DNS, or filesystem outside temp roots.
9. **Review discipline:** review schema/repository before service, service before route/worker, runtime before UI. Re-run earlier phase guards after any registry/policy/approval change.
10. **Terminology:** never call an Onboarding Batch “completed” as a lifecycle state, a stored proposal “applied” in UI, staged work approved, or an approved Change Set published/synced.
11. **No unrelated cleanup:** do not reformat or fix sourcing/onboarding, migrations, lint baselines, test config, package scripts, or broad raw-SQL debt under this epic.
12. **End-of-issue evidence:** report changed files, focused tests, commands/results, diff/check output, residual risks, and prove `git diff --cached --name-only` is empty.

## Test Conventions and Validation

### Runner conventions

- Pure unit/UI logic may run through the repository’s normal unit runner when compatible.
- Any suite importing `bun:sqlite`, repositories backed by the active DB singleton, or the operations migration runs explicitly with `bun test` and belongs under the `test:db` convention; it must be excluded from Vitest collection when the orchestrator safely reconciles `vitest.config.ts`/`package.json` after the dirty sourcing work.
- Do not edit the currently dirty `vitest.config.ts` or `package.json` from an issue worker. Until integration is reconciled, invoke each new DB-backed file explicitly with `bun test <file>`.
- `bun run typecheck` must remain clean. Use `bun run lint` only after focused tests/typecheck; document unrelated baseline failures without fixing them.
- No test calls a live model, network, DNS, ShopSite, crawler, or live workspace DB/catalog. Use fakes and temp directories/DBs.

### Per-issue checkpoint

```bash
git status --short
git diff --cached --name-only
git diff -- <issue allowlist paths>
# focused pure tests or explicitly DB-backed Bun tests from the issue
git diff --check -- <issue allowlist paths>
bun run typecheck
```

### Phase A validation

```bash
bun test src/tests/unit/store-manager-execution-boundary.test.ts \
  src/tests/unit/store-manager-command-registry.test.ts \
  src/tests/unit/store-manager-command-compiler.test.ts \
  src/tests/unit/store-manager-scope.test.ts \
  src/tests/unit/store-manager-command-ui.test.tsx \
  src/tests/unit/store-manager-inbox-ui.test.tsx
bun test src/tests/unit/store-manager-operations-migration.test.ts \
  src/tests/unit/store-manager-preferences.test.ts \
  src/tests/unit/store-manager-inbox-repo.test.ts \
  src/tests/unit/store-manager-inbox.test.ts \
  src/tests/unit/store-manager-notifications.test.ts \
  src/tests/unit/store-manager-events-sse.test.ts
bun test src/tests/unit/store-manager-runtime.test.ts \
  src/tests/unit/store-manager-tool-registry.test.ts \
  src/tests/unit/store-manager-message-schema.test.ts \
  src/tests/unit/store-manager-context.test.ts \
  src/tests/unit/store-manager-tools.test.ts
bun run typecheck
```

### Phase B validation

```bash
bun test src/tests/unit/store-manager-flags.test.ts \
  src/tests/unit/store-manager-schedules-ui.test.tsx \
  src/tests/unit/store-manager-triggers-ui.test.tsx
bun test src/tests/unit/store-manager-schedule-repo.test.ts \
  src/tests/unit/store-manager-scheduler.test.ts \
  src/tests/unit/store-manager-scheduled-runtime.test.ts \
  src/tests/unit/store-manager-trigger-repo.test.ts \
  src/tests/unit/store-manager-event-worker.test.ts \
  src/tests/unit/store-manager-event-runtime.test.ts
bun test src/tests/unit/store-manager-runtime.test.ts \
  src/tests/unit/store-manager-tool-registry.test.ts
bun run typecheck
```

### Phase C validation

```bash
bun test src/tests/unit/store-manager-playbook-validator.test.ts \
  src/tests/unit/store-manager-playbook-templates.test.ts \
  src/tests/unit/store-manager-playbook-ui.test.tsx \
  src/tests/unit/store-manager-run-ui.test.tsx
bun test src/tests/unit/store-manager-playbook-repo.test.ts \
  src/tests/unit/store-manager-action-diff.test.ts \
  src/tests/unit/store-manager-playbook-runner.test.ts \
  src/tests/unit/store-manager-history.test.ts \
  src/tests/unit/store-manager-replay.test.ts \
  src/tests/unit/store-manager-history-query.test.ts
bun test src/tests/unit/store-manager-approval.test.ts \
  src/tests/unit/store-manager-runtime.test.ts \
  src/tests/unit/store-manager-tool-registry.test.ts
bun run typecheck
```

### Phase D and final validation

```bash
bun test src/tests/unit/store-manager-bulk-review-ui.test.tsx \
  src/tests/unit/store-manager-operations-console.test.tsx
bun test src/tests/unit/store-manager-bulk-review-repo.test.ts \
  src/tests/unit/store-manager-bulk-review.test.ts \
  src/tests/unit/store-manager-bulk-review-tools.test.ts \
  src/tests/unit/store-manager-operations-acceptance.test.ts
bun test src/tests/unit/store-manager-ai-proposals.test.ts \
  src/tests/unit/store-manager-approval.test.ts \
  src/tests/unit/store-manager-tools.test.ts \
  src/tests/unit/store-manager-runtime.test.ts \
  src/tests/unit/store-manager-tool-registry.test.ts
bun run test
bun run typecheck
bun run lint
git diff --check
git diff --cached --name-only
git status --short
git diff --stat
```

If repository-wide test/lint failures are pre-existing, capture the baseline before the issue and prove focused suites plus typecheck for touched files pass. Never fix unrelated sourcing-stage failures. Final acceptance requires no staged files, no unexpected paths, no nested-catalog modifications, and no DB/WAL/SHM/temp artifact residue.

## Decisions Requiring Escalation

The design questions supplied for planning are locked above: hybrid Inbox materialization, system unattended identity with runtime-enforced read-only policy, immutable versioned playbooks, durable notification rows over SSE with polling fallback, server-owned slash compilation, replay as a new current-state run, deterministic NL history query library (no agent SQL), and transient homogeneous bulk grouping with immutable preview/per-item decisions.

Escalate rather than invent policy if any of the following is requested or discovered:

1. Scheduled/event runs are expected to create `catalog_health_proposals` rows automatically. This plan permits only immutable candidate-proposal artifacts plus report/Inbox/notification outputs; converting an artifact into a stored proposal is interactive and approval-gated. Unattended proposal writes need a product decision, separate risk profile, explicit provenance/quotas, and still no automatic staging.
2. “After import finishes” lacks a durable, authoritative terminal observation in the reconciled onboarding schema. Do not infer completion from an in-memory SSE event or batch aggregate; escalate the source contract.
3. A deployment is multi-tenant or needs a compliance-grade external identity/approval audit. The inherited ADR 0010 single-operator in-process residual is insufficient.
4. Notifications must leave the app (email/SMS/Slack/webhook/browser push). Transport credentials, delivery policy, retries, redaction, and SSRF controls require a separate design.
5. Playbooks need branching/loops, arbitrary code, dynamic tool names, cross-workspace execution, or approval inheritance. These conflict with the locked bounded DSL/authority model.
6. A command must bypass the model and call a service directly for speed. It must instead use the common runner/registry; any deterministic runner mode must be designed inside that boundary and reviewed as an authority change.
7. `/plan` is expected to read live data or produce authoritative counts. The locked preview is contract-only and zero-execution; live plans are normal read-only runs and must be labeled accordingly.
8. Bulk review must partially apply, include semantic/AI proposals, or use confidence as eligibility. All conflict with homogeneous fail-closed review.
9. Run comparison needs model-generated judgments over incompatible/raw historical payloads. Add a reviewed deterministic compatibility transform or refuse comparison.
10. Operational preferences need to change canonical classification configuration, ProductField mapping, or vendor master data. Route those through their existing configuration review authorities, not Store Manager memory.
11. Schedule catch-up, retention periods, default thresholds, or timezone/DST semantics require materially different product behavior than the locked conservative defaults.
12. A migration must touch the dirty `src/db/migrations.ts`, protected tests/config, or a live DB before sourcing work is reconciled. Stop for orchestrator sequencing and require a verified backup for any live operation.
13. Any direct catalog Git commit, ShopSite request, image repair, publish, or sync is proposed outside the existing approved Change Set/repair path.
14. Shared PI code extraction would change PI contracts/behavior or couple Store Manager rows to Product Intelligence. Keep Store Manager-local unless separately approved.

## Risk Register

| ID | Risk | Mitigation | Residual risk |
| --- | --- | --- | --- |
| R1 | New entrypoints accidentally create parallel authority paths | one execution request/runner; compatibility wrapper only; transitive import/direct-dispatch guards; entrypoint matrix tests | Future code can bypass by regression; architecture test and review remain required |
| R2 | Unattended model invokes a persistent tool | immutable unattended policy derives read-only name+version allowlist and denies persistent risk at registry dispatch before side effects | A misclassified adapter could be exposed; registry/policy drift and risk-metadata review tests are mandatory |
| R3 | Scheduler duplicates or misses work across restart/DST | transactional lease, unique occurrence key, injected clock/DST tests, bounded catch-up, one writer | SQLite/process downtime beyond catch-up window yields a visible skipped occurrence, not silent backfill |
| R4 | Event polling misses or duplicates transitions | committed durable sources, cursor+outbox transaction, stable fingerprints, idempotent occurrences | At-least-once observation is claimed; latency equals polling interval |
| R5 | Inbox rows become stale or misleading | hybrid materialization, source timestamps/fingerprints, open-time revalidation, deterministic resolution | Historical rows can describe past state; UI must keep “current” vs “resolved/stale” explicit |
| R6 | Notification flood or AI chatter | threshold-crossing dedupe, deterministic templates, cooldown/fingerprint, no model text | Poorly chosen thresholds may still be noisy; explicit preferences and per-rule disable remain needed |
| R7 | Pinned scope silently widens | strict union, server ownership resolution, adapter scope support declaration, `scope_unsupported` | Some existing reads may initially support fewer scope kinds and correctly abstain |
| R8 | Explicit preferences become a shadow source of canonical configuration | limited schema, immutable revisions, identity validation, capture hash; canonical changes remain under existing review | Preference semantics can drift from catalog configuration; run snapshot makes drift inspectable |
| R9 | Playbook version is treated as preauthorization | immutable DSL, static risk validation, fresh per-step runtime policy, exact diff checkpoint, no inherited approval | Long-running playbooks may require frequent re-preview/reapproval after drift |
| R10 | Diff becomes stale between review and action | hash/precondition binding and immediate dispatch-time revalidation; all-or-nothing refusal | Highly active catalogs may produce repeated stale-preview retries |
| R11 | History stores sensitive/model reasoning data | allowlisted event/artifact schemas, bounded redaction, no raw prompt/CoT, source-level tests | Model/provider telemetry remains upstream-estimated and local DB access remains privileged |
| R12 | Replay is mistaken for reproduction | new current-state run with explicit lineage and current hashes; compatible artifact comparison only | Model nondeterminism can change narrative; only structured artifacts are compared authoritatively |
| R13 | NL history query enables arbitrary DB access | finite query registry, strict params, fixed repository SQL, bounded windows/results, query ID visible | Unsupported questions abstain rather than answering freely |
| R14 | Bulk group hides heterogeneous or stale items | exact rule/evidence/field/digest grouping, immutable preview, full-batch revalidation/rollback, per-item decisions | Very large groups need caps/pagination and may require multiple explicit approvals |
| R15 | SSE disconnect loses notifications | durable sequence/cursor, replay, capped reconnect, polling fallback, workspace guard | Delivery is in-app only and not guaranteed while the CMS is never opened |
| R16 | Explicit model unavailable causes unattended retry storm | no fallback, terminal unavailable outcome, deduped Inbox item, capped backoff/disable threshold | Scheduled reports remain absent until operator fixes routing |
| R17 | Dirty sourcing work is overwritten or accidentally committed | protected path list, exact issue allowlists, baseline hashes, one writer, no worker staging/commits | Orchestrator must reconcile the one migration/test-config integration point after sourcing work stabilizes |
| R18 | Migration/self-heal corrupts a live DB | new idempotent module, disposable DB tests, no live application during implementation; verified backup required later | SQLite migration interruption still requires tested transaction/self-heal behavior |
| R19 | In-process tools share server DB/filesystem/secrets | #42 registry/repository/approval/redaction boundaries, no host tools, least privilege, local single-operator constraint | ADR 0010 residual remains; this is not multi-tenant isolation |
| R20 | Existing Change Set/sync repositories have unscoped legacy helpers | new operations paths use workspace-scoped helpers and hide foreign IDs; focused ownership tests | Untouched legacy routes remain outside this epic and should be separately hardened if exposed |

## Epic Acceptance Checklist

- [ ] Issue 1: chat/command/schedule/event/playbook/replay/preview all use one execution runner, immutable policy, registry, approval gate, deadline/cancellation, events, and telemetry.
- [ ] Issue 2: all required commands and `/plan` compile server-side; pinned scope/preferences are explicit and versioned.
- [ ] Issue 3: Manager Inbox includes the five requested triage classes; notifications are durable deterministic in-app facts.
- [ ] Issue 4: five scheduled templates run read-only with leases/idempotency/kill switch and immutable reports.
- [ ] Issue 5: four event triggers observe durable committed state and run read-only without touching protected onboarding sources.
- [ ] Issue 6: four saved playbook templates use immutable registry-validated DSL versions and grant no authority.
- [ ] Issue 7: actions are diff-first, approvals bind fresh previews, verification diffs follow execution, and run history/replay/comparison/bounded history queries are inspectable.
- [ ] Issue 8: homogeneous deterministic bulk review preserves per-item audit and stages only to a Change Set.
- [ ] Issue 9: integrated operations console, feature flags/kill switch, retention, ADR, architecture guards, and fake-only acceptance pass.
- [ ] No schedule/event run can write `catalog_health_proposals`, stage, approve, publish, sync, or repair automatically; candidate-proposal artifacts remain non-authoritative review evidence.
- [ ] No model- or network-backed test, ShopSite call, live DB write, live migration, or catalog activation occurred.
- [ ] All DB access uses repositories; cross-boundary payloads use strict Zod; explicit model selections never fall back.
- [ ] Focused tests, `bun run typecheck`, final `bun run test`, and lint pass or unrelated baseline failures are documented.
- [ ] Dirty sourcing work remains byte-preserved, no unexpected path changed, no files are staged, and workers made no commits.

## Concise Implementation Summary

**Locked decisions:** server-owned command compiler; hybrid materialized Inbox with deterministic current-state collectors; immutable explicit preference revisions; read-only scheduled/event identities enforced by runtime policy; durable notification rows over Store Manager SSE plus polling fallback; immutable registry-validated playbook DSL; deterministic diff/checkpoint/revalidation; replay as a new current-state run; finite NL history query library with no generated SQL; transient homogeneous bulk grouping with immutable batch preview and per-item decisions.

**Escalated decisions:** none are blocking this implementation plan. The fourteen conditions in “Decisions Requiring Escalation” are stop conditions if product scope changes—especially automatic scheduled proposal creation, ambiguous import terminality, outbound notification transports, arbitrary playbook code, live-data `/plan`, partial/semantic bulk approval, or dirty/live migration requirements.

**Issue order:** 1) unified execution/history foundation; 2) slash commands, `/plan`, scope, preferences; 3) Inbox/notification shell; 4) scheduled read-only runs; 5) event-driven read-only runs; 6) playbook storage/validation; 7) playbook execution, diff UX, history/replay/query; 8) bulk review; 9) console integration/rollout.

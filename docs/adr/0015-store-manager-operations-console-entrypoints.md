# ADR 0015 — Store Manager Operations Console Entrypoints

- **Status:** Accepted
- **Epic:** Store Manager Operations Console (post-#42 epic, Issues 1–9)
- **Relates to:** ADR 0010 (local single-operator in-process model), Epic #42 hardening plan, `docs/plans/store-manager-operations-console-plan.md`

## Context

Epic #42 bounded the Store Manager AI behind a single runtime: one model
resolution, one immutable per-run policy, one registry-managed tool dispatch,
an approval gate, whole-run deadlines, redacted events, and exact
`ai_model_calls` telemetry. The operations-console epic adds many entrypoints:
interactive chat, slash commands, `/plan` previews, pinned scopes, an inbox,
scheduled runs, event-triggered runs, versioned playbooks, replay, bulk
review, and notifications. Without a guardrail, each new entrypoint could
become its own parallel authority path — a command that calls a service
directly, a schedule that stages changes, a playbook that inherits trust from
its author.

## Decision

**Many entrypoints, one authority.** Every executable entrypoint produces a
strict `StoreManagerExecutionRequest` and calls the single exported runner
`runStoreManagerExecution` in `src/store-manager/runtime/executor.ts`. The
runtime owns the immutable policy snapshot, the registry (the only tool
dispatch authority), the risk/approval/ownership gates, the deadline and
cancellation machinery, event emission, and telemetry linkage. `runStoreManagerTurn`
is a compatibility wrapper for interactive chat only.

Specific commitments:

1. **Commands compile, they do not bypass.** Slash commands are parsed and
   compiled by a server-owned registry/compiler into an objective + expected
   tool hints. No command calls a service, repository, or adapter `.execute`
   directly; the runner still exposes only the policy-derived registry
   allowlist. `/plan` is a zero-execution contract preview (no model, no tool,
   no read, no mutation).
2. **Unattended identity is read-only by construction.** Schedules and event
   triggers run as `actorClass = system_schedule | system_event` with an
   `unattended_read_only` execution mode. The policy derives an allowlist
   containing only read-risk adapters, and registry dispatch denies any
   persistent risk class before approval or side effects. Scheduled/event
   identity has no approval authority and no fallback for explicitly selected
   models. Their only durable outputs are immutable report/candidate-proposal
   artifacts, Inbox items, and notifications; converting a candidate artifact
   into a stored proposal is an interactive, approval-gated action.
3. **Playbooks are data, not authority.** Playbooks are immutable,
   content-addressed versions of a strict DSL (read / summarize / propose /
   approval_checkpoint / execute / verify). A playbook grants no authority:
   every step is its own bounded run under a fresh immutable policy, mutation
   requires an immediately preceding operator approval bound to an exact diff
   hash, and verification is mandatory after any mutation. No playbook inherits
   trust from its author, version, schedule, or prior success.
4. **Replay is a new run.** Replay creates a fresh current-state run with
   honest lineage; it never reuses approvals, copies model messages as
   authority, or silently substitutes a missing model.
5. **Operational memory is explicit configuration.** Workspace preferences are
   immutable, versioned, identity-validated revisions captured into each run's
   policy snapshot. There is no hidden conversational memory and no
   prompt-scraped preference extraction.
6. **Kill switch.** A global kill switch stops new runs, claims, and resumes
   (and pauses retention pruning) while keeping history, Inbox, and reads
   available. Feature flags gate every new surface and all default OFF.
7. **Retention preserves lineage.** Pruning removes only derived rows (run
   events/artifacts for terminal runs past the window, resolved Inbox items,
   notifications). Sessions/turns (the audit lineage), decision rows, and
   `ai_model_calls` rows referenced by retained runs are never pruned.

## Consequences

- **Positive:** new entrypoints share the #42 fail-closed guarantees (workspace
  ownership, approval binding, telemetry, redaction, no-fallback, deadlines);
  scheduled automation cannot accidentally bypass approval; every run is
  traceable from objective through tools, policy, approvals, evidence,
  outcome, and cost.
- **Cost:** unattended runs are deliberately limited (read/report/propose-
  artifact only), which may require future product work for safe unattended
  proposal storage; commands that "feel slow" because they route through the
  model are by design — a deterministic runner mode would be an authority
  change requiring a reviewed design inside the same boundary.
- **Residual:** the local single-operator in-process model from ADR 0010
  remains: store-manager tooling shares the server's DB/filesystem/secrets and
  is not a multi-tenant isolation boundary. This is accepted for this
  standalone local CMS.

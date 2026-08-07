# PI Live-Smoke Findings (store products)

Findings from the live smoke against real store catalog products
(`Feline Wormeze Liquid 4oz` → completed/submitted, `Cadet Peanut Rawhide
Sticks 100 CT` → deadline-exceeded), with the fix each produced.

## P0 — fixed

1. **CRITICAL: custom tools were invisible to the model.** The SDK treats
   `tools: []` as an allowlist that filters out every tool — custom research
   and terminal tools included — so sessions started, models thought, and
   ended with zero tool calls (`missing_submission`). Fixed in
   `pi-session-factory.ts`: `tools: undefined` + explicit `excludeTools` for
   ungranted builtins. Regression test asserts the contract.
   Commit `3ebd56a`.

2. **Evidence persistence.** Completed bundles persisted zero
   sources/evidence rows even though the model verified/extracted real pages,
   so the run inspector lied about what the agent did (and onboarding-import
   was starved). Fixed: tool-result evidence now relays through
   `tool_execution_end.result.details` (SDK relay verified live) into the
   sink, which persists source rows (deduped by URL per run) + evidence rows
   keyed by `metadata.toolEvidenceId` at tool completion — so even
   failed/deadline runs leave a durable trail. Terminal submissions get a
   citation reconciliation that reports gaps honestly. Deterministic replays
   clone the evidence rows (PI-10 consistency).

3. **Submission failures were silent.** The model retried invalid payloads
   twice before succeeding; the actual schema error never reached the model
   or the tool-call row. Fixed: terminal tools return error text as result
   objects (SDK relays it verbatim), schema feedback includes the first three
   zod issues + expected-shape hint (≤400 chars), and `tool_calls.error_json`
   now carries the real message.

## P1 — fixed

4. **Unknown tool names** (the model called `extract_products_page`): now
   marked `denied` with `unknown_tool: <name>` via the executor's known-tool
   set.

5. **Deadline awareness.** The research prompt now states the remaining
   minutes and timeboxes submission ("an honest partial submission or
   abstention beats none"). Cost/tokens are deliberately NOT surfaced —
   enforced server-side by the policy gateway.

6. **Field completion + abstention guidance** (prompt-only): the workflow
   rules now prefer a complete bundle and explicitly allow abstention when
   identity is unresolved. Schemas untouched.

## Known, by design

- **Search degradation without Serper**: `search_upc`/`search_product_name`
  return noResult without a configured search API key; runs degrade
  gracefully via lookups, sitemap, and direct extraction (run 1 succeeded
  without search). Configure `SERPER_API_KEY` (or an equivalent search
  provider) for full search coverage.
- **SDK error-text relay** is best-effort: some SDK failure results carry no
  readable message; those still record `isError` + a generic fallback.

# Task for reviewer

Review the new extraction worker implementation. This is a Node.js HTTP sidecar for browser-heavy profile tooling that runs alongside the main Bun API server.

## Files to review

Read every file:
- `src/extraction-worker/server.ts` — HTTP server, routing, auth
- `src/extraction-worker/auth.ts` — bearer token auth
- `src/extraction-worker/artifacts.ts` — artifact file writing
- `src/extraction-worker/routes/health.ts` — health endpoint
- `src/extraction-worker/routes/snapshot.ts` — POST /profile-tooling/snapshot (static + Playwright page capture)
- `src/extraction-worker/routes/validate.ts` — POST /profile-tooling/validate (multi-sample validation sweeps)
- `src/extraction-worker/routes/extract.ts` — POST /profile-runner/extract (trusted deterministic extraction)
- `src/server/extraction-worker-client.ts` — Bun-side typed HTTP client
- `src/shared/schemas/extraction-worker.ts` — Zod schemas for all worker types
- `docs/plans/domain-extractor-profile-worker-plan.md` — the full implementation plan
- `docs/adr/0009-run-browser-profile-tooling-in-a-separate-worker.md` — the ADR
- `scripts/dev.ts` — updated to spawn worker in dev mode
- `package.json` — worker scripts
- `src/server/routes/onboarding-routes.ts` — check the health route was added correctly

## Review angles

1. **Security** — are there any paths where auth could be bypassed? Is the worker token handled safely? Are there any secrets or credentials being exposed?

2. **Correctness** — do the extraction implementations handle edge cases (empty pages, blocked pages, malformed HTML, network errors, timeout conditions)? Does the extraction path properly fail closed when selectors don't match?

3. **Architecture** — does the code follow the invariant from the ADR plan (worker never reads/writes SQLite, no LLM in trusted extraction, all outputs validated through Zod)? Are there any violations?

4. **Error handling** — does every route handler properly catch and surface errors in warnings instead of throwing? Are there uncaught promise rejections?

5. **Type safety** — run `npx tsc --noEmit --skipLibCheck` and report any issues found.

6. **Consistency** — does the design match the plan? Are all the API endpoints shaped like the plan says they should be?

Return concise evidence-backed findings with file/line references. Do NOT modify any files.

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```
# Task for worker

Implement Phase 2 of the extraction worker plan (worker shell).

Read the full plan first: `docs/plans/domain-extractor-profile-worker-plan.md`

Phase 2 scope:

Create these files:

1. `src/extraction-worker/server.ts` — a Node-friendly HTTP server using Node's built-in `http` module (not Hono — keep it zero-dependency for the worker process). Must:
   - Read `SHOPSITE_CMS_WORKER_HOST`, `SHOPSITE_CMS_WORKER_PORT`, `SHOPSITE_CMS_WORKER_TOKEN` from env.
   - Default to `127.0.0.1:3032`.
   - Reject requests without a valid `Authorization: Bearer <token>` if a token is configured.
   - Mount health route at `/health`.
   - Return 404 for unknown paths.
   - Log startup to stdout.

2. `src/extraction-worker/routes/health.ts` — a health handler that returns:
   ```json
   {"ok":true,"capabilities":{"playwright":true,"crawlee":false,"stagehand":false},"version":"0.1.0"}
   ```
   Use raw JSON stringify.

3. `src/extraction-worker/auth.ts` — a helper that reads the worker token from env and checks it against the request's Authorization header. Return `{ authorized: true }` or `{ authorized: false, message: "..." }`.

4. Add worker scripts to `package.json`:
   ```json
   "worker:dev": "node --import tsx src/extraction-worker/server.ts",
   "worker:start": "node dist/extraction-worker/server.js"
   ```

Technical notes:
- The worker must be ESM (`"type": "module"` already set in package.json).
- Use `import { createServer } from 'node:http'` — no external dependencies.
- Use `.ts` extension but keep the worker simple enough that `tsx` can run it directly in dev mode.
- `SHOPSITE_CMS_WORKER_TOKEN` should be optional; if not set, skip auth checks and log a warning.
- The tsconfig has `noEmit: true`, so for production build we'd need a separate tsconfig. Only add the dev script for now.

Also update `docs/plans/domain-extractor-profile-worker-plan.md` to mark Phase 2 as implemented.

## Validation
After creating the files, run: `node --import tsx src/extraction-worker/server.ts &` and then `curl -s http://127.0.0.1:3032/health` to verify the worker starts and returns the expected health response. Kill the background process when done.

## Handoff
Report all files created/changed, your validation commands and their output, and any surprises or decisions that need parent approval.

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
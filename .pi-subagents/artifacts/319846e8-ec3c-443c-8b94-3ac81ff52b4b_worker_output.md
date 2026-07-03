All clean. Here is the structured acceptance report.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "All five changes scoped to the task (new Function→JSON.parse, auth fail-closed, dead code removed, double browser.close fixed, npx→node --import) were implemented without touching files outside the listed scope."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Changed files, grep verification, TypeScript compilation output, auth fail-closed logic, and full git status are provided below."
    }
  ],
  "changedFiles": [
    "src/extraction-worker/routes/snapshot.ts",
    "src/extraction-worker/auth.ts",
    "src/extraction-worker/server.ts",
    "src/extraction-worker/routes/extract.ts",
    "scripts/dev.ts"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "npx tsc --noEmit --skipLibCheck",
      "result": "passed",
      "summary": "Zero errors (no output)"
    },
    {
      "command": "grep -rn 'new Function\\|Function(' src/extraction-worker/",
      "result": "passed",
      "summary": "No matches — new Function completely eliminated from extraction worker code"
    },
    {
      "command": "grep -rn 'makePlaywrightImageCollector' src/",
      "result": "passed",
      "summary": "No matches — dead function removed"
    },
    {
      "command": "git diff --cached --stat | wc -l",
      "result": "passed",
      "summary": "0 — no staged files"
    },
    {
      "command": "grep -n 'browser.close' src/extraction-worker/routes/extract.ts",
      "result": "passed",
      "summary": "Only 1 match at line 882 in finally block — early close removed"
    }
  ],
  "validationOutput": [
    "TypeScript tsc --noEmit --skipLibCheck passes with zero errors",
    "No instances of `new Function` or `Function(` exist in src/extraction-worker/",
    "No instances of `makePlaywrightImageCollector` exist in src/",
    "auth.ts returns { authorized: false } when SHOPSITE_CMS_WORKER_TOKEN is unset — no warned variable, no open-access path",
    "dev.ts spawns worker with `node --import tsx` instead of `npx tsx`",
    "extract.ts has exactly one browser.close() call (line 882 in finally block)"
  ],
  "residualRisks": [
    "The JSON.parse fallback with trailing-comma stripping handles the most common non-JSON pattern (trailing commas), but does not handle JS comments, single-quoted keys, or other JS-specific syntax. If the embedded HTML data contains those, parsing silently skips the block. This matches the previous behavior where such blocks would also throw and be skipped, so risk is equivalent or slightly lower.",
    "Extraction worker files are untracked in git (new files). No existing commit history to regress against.",
    "No tests were added or modified for these changes. The auth behavioral change (fail-closed) could break callers that relied on the disabled-auth warning mode in development."
  ],
  "noStagedFiles": true,
  "diffSummary": "snapshot.ts: replaced `new Function` with `JSON.parse` + trailing-comma recovery; auth.ts: removed open-access path, always rejects with 401 when no token; server.ts: updated comments/log messages; extract.ts: removed dead makePlaywrightImageCollector(), removed early browser.close() before return; dev.ts: changed `npx tsx` to `node --import tsx`",
  "reviewFindings": [
    "blocker: snapshot.ts ~line 154 — new Function on untrusted HTML fixed",
    "auth: auth.ts ~line 32 — fail-closed implemented (returns 401 when no token)",
    "quality: extract.ts — makePlaywrightImageCollector removed (unused dead code)",
    "quality: extract.ts — double browser.close() fixed (early close removed, finally handles it)",
    "quality: scripts/dev.ts — invocation changed from npx tsx to node --import tsx"
  ],
  "manualNotes": "The auth change (fail-closed) is a behavioral breaking change: development setups without SHOPSITE_CMS_WORKER_TOKEN will now get 401 responses. The dev.ts script generates a random worker token, so the default dev experience is unaffected."
}
```

**Summary of changes:**

| File | Fix |
|---|---|
| `src/extraction-worker/routes/snapshot.ts` | Replaced `new Function(…)()` on untrusted HTML with `JSON.parse()` + trailing-comma recovery. |
| `src/extraction-worker/auth.ts` | Fail closed: when `SHOPSITE_CMS_WORKER_TOKEN` is unset, all requests are rejected with 401. Removed the `warned` variable and open-access bypass. |
| `src/extraction-worker/server.ts` | Updated comments and startup log to reflect auth-is-required behavior. |
| `src/extraction-worker/routes/extract.ts` | Removed dead `makePlaywrightImageCollector()` function. Removed early `await browser.close()` before the early return in `doRenderedExtract` (the `finally` block handles it). |
| `scripts/dev.ts` | Changed worker spawn from `npx tsx` to `node --import tsx` for consistency with `package.json`'s `worker:dev` script. |
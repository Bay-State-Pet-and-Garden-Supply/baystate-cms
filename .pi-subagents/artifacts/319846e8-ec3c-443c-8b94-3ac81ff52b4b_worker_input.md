# Task for worker

Fix security and quality issues in the extraction worker found by code review. Read all affected files before editing.

## BLOCKER fix

### `snapshot.ts` line ~154 — `new Function` on untrusted HTML → use `JSON.parse` only

In `src/extraction-worker/routes/snapshot.ts`, the function `extractEmbeddedProductDataFromHtml` uses:
```js
const obj = new Function(`return (${html.substring(braceStart, braceEnd + 1)})`)();
```
This evaluates attacker-controlled page content as JavaScript in the Node.js process. Replace this with `JSON.parse`.

The function currently searches for patterns like `window.productJSON = { ... }` in raw HTML, then attempts to parse the brace-balanced object literal. Change the logic to:
1. Find the pattern (same brace matching approach)
2. Try `JSON.parse` on the substring
3. If `JSON.parse` fails, skip that block — do NOT use `eval`/`new Function`/`vm`
4. Also try `JSON.parse` on the substring with trailing commas stripped (a simple regex `,\s*}` → `}` before parsing)

This matches what the Playwright/rendered path already does (reads `window.productJSON` directly from the browser context, which is safe because Playwright's `page.evaluate` runs in the browser's isolated DOM environment).

## Auth fix

### `auth.ts` line ~38 — fail closed when no token configured

Change the auth logic: if `SHOPSITE_CMS_WORKER_TOKEN` is not set, reject ALL requests with 401. Remove the "auth disabled" warning and the open-access behavior.

## Quality fixes

### `extract.ts` — remove dead code

Find the function `makePlaywrightImageCollector()` — it's defined but never used (rendered image collection uses an inline IIFE string instead). Remove it.

### `extract.ts` — fix double browser.close()

In the rendered path, there's an early `await browser.close(); return buildFailedResult(...)` inside the try block that's followed by a `finally { browser.close() }`. Change the pattern to set a flag or use `finally` properly:
- Move the early return path out of try/finally
- Or just remove the early `browser.close()` and let `finally` handle it

Simplest fix: remove the early `browser.close()` call before the early return, since `finally` will handle it.

### `dev.ts` — fix invocation consistency

`scripts/dev.ts` currently uses `npx tsx` but `package.json` uses `node --import tsx`. Align dev.ts to use `node --import tsx` instead of `npx tsx` for consistency. `npx` adds unnecessary overhead.

## Validation

After all changes:
1. Run `npx tsc --noEmit --skipLibCheck` — must pass clean
2. Report every file changed and what was fixed
3. Do NOT modify any files outside the scope listed above

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
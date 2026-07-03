# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Apply the reviewer's fixes for the paste-element-to-selector flow.

## Blocker 1: CSS.escape not available in Node.js

File: `src/extraction-worker/routes/generate-selector.ts`

At line 124, replace:
```javascript
const byId = $(`#${CSS.escape(id)}`);
```
with the same regex-based escape used in `selector-utils.ts`:
```javascript
const safeId = id.replace(/(["'\\\s\[\]:.])/g, '\\$1');
const byId = $(`#${safeId}`);
```

## Blocker 2: sourcePageUrl not passed by parent components

### Fix A: ProfileProposalDrawer.tsx

In `src/client/components/ProfileProposalDrawer.tsx`, find where `ProfileRevisionFeedbackForm` is rendered and add `sourcePageUrl={previewUrl}` to the props. The `previewUrl` state already exists and is initialized from `proposal.sourceUrl`.

Look for the line that renders:
```tsx
<ProfileRevisionFeedbackForm
  field={field as SelectorField}
  ...
/>
```
and add `sourcePageUrl={previewUrl}`.

### Fix B: ProfileGenerationReview.tsx

In `src/client/components/ProfileGenerationReview.tsx`, find where `ProfileRevisionFeedbackForm` is rendered and add `sourcePageUrl={generation?.sourceUrl ?? ''}`. The `generation` state already exists and has a `sourceUrl` field.

## Note: SSRF protection for fetch-html route

File: `src/server/routes/onboarding-routes.ts`

In the fetch-html route handler, add a basic URL validation before fetching to block private IP ranges (consistent with localhost-only development pattern). Add after the url check:

```typescript
// Block private/internal IP ranges (SSRF protection)
try {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('172.') || hostname === '[::1]') {
    return c.json({ ok: false, error: 'URL points to a private network address' }, 400);
  }
} catch {
  return c.json({ ok: false, error: 'Invalid URL' }, 400);
}
```

## Note: Lint warnings

In `src/extraction-worker/routes/generate-selector.ts`, fix the unused `let matchCount = 0` assignment by initializing it as `let matchCount: number;` instead. The catch block sets it to `1`.

## What to verify

- `bun run typecheck` passes
- The paste-element section in ProfileRevisionFeedbackForm will now be visible because `sourcePageUrl` is passed from parents
- CSS.escape is no longer used in the worker route

## What NOT to do
- Don't modify test files
- Don't add Phase 3 code
- Don't change the governance service (already reviewed as acceptable)

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

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
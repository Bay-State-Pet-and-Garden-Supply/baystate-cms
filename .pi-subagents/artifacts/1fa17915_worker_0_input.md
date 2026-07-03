# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Implement Phase 2 backend plumbing for the paste-element-to-selector flow.

## Context

The project is ShopSite CMS. We've just extracted `buildStableSelector` into `src/shared/selector-utils.ts` and created a new worker route `src/extraction-worker/routes/generate-selector.ts` (registered in `src/extraction-worker/server.ts`). Zod schemas for `GenerateSelectorRequest`/`GenerateSelectorResponse` are in `src/shared/schemas/extraction-worker.ts`.

## What to implement

### Task A: Add worker client function in extraction-worker-client.ts

File: `src/server/extraction-worker-client.ts`

Add:
```typescript
import {
  GenerateSelectorResponseSchema,
  type GenerateSelectorRequest,
  type GenerateSelectorResponse,
} from '../shared/schemas/extraction-worker';

export async function generateSelectorFromElement(
  request: GenerateSelectorRequest,
): Promise<{ ok: true; data: GenerateSelectorResponse } | { ok: false; error: string }> {
  return workerFetch(GenerateSelectorResponseSchema, {
    method: 'POST',
    path: '/profile-tooling/generate-selector',
    body: request,
    timeoutMs: 15_000,
  });
}
```

Find the pattern of `workerFetch` calls in the existing file to match it exactly.

### Task B: Add Bun proxy route for generate-selector

File: `src/server/routes/onboarding-routes.ts`

Add a new route after the snapshot proxy route:
```typescript
/**
 * POST /api/onboarding/settings/profile-tooling/generate-selector
 * Proxies to the extraction worker's generate-selector endpoint.
 */
route.post('/onboarding/settings/profile-tooling/generate-selector', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }
  const parsed = GenerateSelectorRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'Invalid request body', details: parsed.error.flatten() }, 400);
  }
  const result = await generateSelectorFromElement(parsed.data);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error });
  }
  return c.json({ ok: true, data: result.data });
});
```

Import `GenerateSelectorRequestSchema` from `../../shared/schemas/extraction-worker` and `generateSelectorFromElement` from `../extraction-worker-client`. Find the existing snapshot proxy route pattern and follow it exactly.

### Task C: Add server-side HTML fetch route

File: `src/server/routes/onboarding-routes.ts`

Add a new route (near the generate-selector route):
```typescript
/**
 * POST /api/onboarding/settings/profile-tooling/fetch-html
 * Fetches raw HTML from a URL server-side (avoids CORS issues).
 */
route.post('/onboarding/settings/profile-tooling/fetch-html', async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }
  const url = (body as any)?.url;
  if (!url || typeof url !== 'string') {
    return c.json({ ok: false, error: 'url is required' }, 400);
  }
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return c.json({ ok: false, error: `HTTP ${response.status}` });
    }
    const html = await response.text();
    return c.json({ ok: true, html });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
```

### Task D: Add client API functions

File: `src/client/onboarding-api.ts`

Find the pattern of API calls in this file and add:
```typescript
export async function generateSelectorFromElement(
  req: GenerateSelectorRequest,
): Promise<{ ok: boolean; data?: GenerateSelectorResponse; error?: string }> {
  return request('/settings/profile-tooling/generate-selector', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export async function fetchPageHtml(
  url: string,
): Promise<{ ok: boolean; html?: string; error?: string }> {
  return request('/settings/profile-tooling/fetch-html', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}
```

Import `GenerateSelectorRequest` and `GenerateSelectorResponse` from `../shared/schemas/extraction-worker`.

## Files to read for context
- `src/server/extraction-worker-client.ts` — to match the existing workerFetch pattern
- `src/server/routes/onboarding-routes.ts` — to find the snapshot proxy route and match its pattern
- `src/client/onboarding-api.ts` — to match the existing request() call pattern

## What NOT to do
- Do NOT modify test files
- Do NOT add Phase 3 (visual picker) code
- Do NOT modify the generate-selector worker route (already done)
- Do NOT modify ProfileRevisionFeedbackForm.tsx (separate task)

After implementing, verify with `bun run typecheck`.

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
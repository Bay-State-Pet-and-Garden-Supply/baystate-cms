# Task for worker

Implement Phase 3 of the extraction worker plan: snapshot tooling.

Read the full plan first: `docs/plans/domain-extractor-profile-worker-plan.md`

## What already exists

The worker shell is live at `src/extraction-worker/`:
- `src/extraction-worker/server.ts` — routes requests to handlers
- `src/extraction-worker/auth.ts` — bearer token auth
- `src/extraction-worker/routes/health.ts` — health endpoint
- Starts with `npx tsx src/extraction-worker/server.ts` on port 3032

The shared schemas are at `src/shared/schemas/extraction-worker.ts`:
- `SnapshotRequestSchema` — { url, runtime: 'static'|'rendered', captureScreenshot, captureNetwork }
- `SnapshotResponseSchema` — { url, finalUrl, htmlRef, screenshotRef, networkRef, jsonLd[], embeddedProductData[], imageCandidates[], pageStructureSignals[], warnings[] }

The Bun-side client is at `src/server/extraction-worker-client.ts`:
- `snapshotPage()` — calls POST /profile-tooling/snapshot

The existing page extractor has reference code at `src/onboarding/page-extractor.ts`:
- Playwright browser launch/context/page setup
- Route blocking for images/fonts/styles/trackers
- JSON-LD extraction from script tags
- Meta tag extraction
- Shopify productJSON extraction from window scope
- Image extraction from img tags with srcset/data-src handling
- HTML heuristics (title from h1, description, weight, bullet points)
- Microdata extraction
- HTTP user agents and headers

## What you need to implement

### 1. Create `src/extraction-worker/routes/snapshot.ts`

A POST handler at `/profile-tooling/snapshot` that:

**Input:** `{ url, runtime: 'static'|'rendered', captureScreenshot, captureNetwork }`

**Static runtime:**
- Use `fetch(url, { headers: HTTP_EXTRACTION_HEADERS, signal: AbortSignal.timeout(15000) })` to get the HTML
- Extract: JSON-LD from `<script type="application/ld+json">`
- Extract: meta tags (og:title, og:image, og:description, product:brand, product:price:amount, description)
- Extract: embedded Shopify `productJSON` (look for `window.productJSON` or `var productJSON` patterns in script text)
- Extract: image candidates (src/srcset/data-src/data-original on `<img>` tags; filter SVGs, data: URIs, tiny files)
- Collect: page structure signals (presence of `.product`, `[data-product]`, Shopify scripts, JSON-LD Product types, etc.)
- Write the raw HTML to an artifact file

**Rendered runtime:**
- Launch headless Playwright Chromium
- Block images, fonts, styles, media, and tracking pixels via `page.route()`
- Navigate to URL with `waitUntil: 'domcontentloaded'`, timeout 25s
- Wait 2s for dynamic content
- Capture full-page HTML via `page.content()`
- Capture screenshot via `page.screenshot({ fullPage: true })` if `captureScreenshot` is true
- Extract JSON-LD via `page.evaluate()` looking at `<script type="application/ld+json">`
- Extract embedded product data via `page.evaluate()` looking at `window.productJSON`, `window.ShopifyAnalytics`, `window.__INITIAL_STATE__` patterns
- Extract image candidates from `img` elements in DOM (use src, currentSrc, data-src, srcset)
- Collect page structure signals from DOM
- Write artifacts: page.html, page.min.html (remove style/svg/noscript/header/footer/nav/script), screenshot.png, network.json (if captureNetwork — but skip for now until CDP tracing is added)

**Common:**
- Parse all responses through the Zod `SnapshotResponseSchema` before returning
- All artifact files go under: `<cwd>/.shopsite-cms/artifacts/profile-builder/<domain>/<job-id>/`
- The domain is extracted from the URL
- The job-id is generated as `snapshot-<timestamp>-<random(4)>`
- Return artifact references as relative paths from the project root
- Catch and surface errors in the `warnings` array
- Never throw uncaught errors — always return a valid SnapshotResponse

### 2. Register the route in `src/extraction-worker/server.ts`

Add the snapshot route:

```typescript
if (method === 'POST' && url === '/profile-tooling/snapshot') {
  handleSnapshot(req, res);
  return;
}
```

### 3. Create artifact helpers in `src/extraction-worker/artifacts.ts`

```typescript
// resolveArtifactDir(domain: string, jobId: string): string
// Returns absolute path to the artifact directory, creating parents.

// writeArtifact(dir: string, name: string, content: string | Buffer): string
// Writes file and returns relative path from project root.
```

### 4. Update the plan

Add the files created under Phase 3 in `docs/plans/domain-extractor-profile-worker-plan.md`.

## Constraints

- Use `import { chromium } from 'playwright'` for the rendered path
- Reuse constants from `src/onboarding/page-extractor.ts` where possible (HTTP_EXTRACTION_HEADERS, user agents, block patterns). Import them or copy them.
- The worker uses Node.js built-in `http` module — no Hono, no Express
- Parse request body manually: `const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => ...)`
- Write artifact directories recursively (use `fs.mkdirSync(dir, { recursive: true })`)
- All file paths must be cross-platform safe
- Log to stderr for diagnostics: `process.stderr.write(...)`

## Validation

After creating the files:
1. Start the worker: `npx tsx src/extraction-worker/server.ts &`
2. Sleep 3 seconds
3. POST a snapshot request: `node -e "const http=require('http');const body=JSON.stringify({url:'https://example.com',runtime:'static',captureScreenshot:false,captureNetwork:false});const req=http.request({hostname:'127.0.0.1',port:3032,path:'/profile-tooling/snapshot',method:'POST',headers:{'Content-Type':'application/json'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))});req.write(body);req.end()"`
4. Verify the response contains url, finalUrl, htmlRef, jsonLd, etc.
5. Verify artifact files were written under .shopsite-cms/artifacts/
6. Kill the worker

## Handoff

Report all files created/changed, validation command output, any surprises, and decisions needing parent approval.

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
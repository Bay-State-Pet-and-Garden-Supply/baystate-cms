# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Implement Phase 3 backend for the click-to-select visual picker.

## Context

This is a local CMS tool (ShopSite CMS). The extraction worker is a separate Node.js HTTP server that uses Playwright. The worker already has a `rendered` runtime in the snapshot route that launches headless Chromium.

The visual picker will launch a **headful** Chromium, inject an overlay, let the user click on an element, and return the generated CSS selector.

## Task 14: Create worker route

Create `src/extraction-worker/routes/pick-element.ts`.

This route:
1. Accepts `PickElementRequest` (`{ url, field, allowParentContainer }`)
2. Launches a **headful** Playwright Chromium (`headless: false`)
3. Navigates to the URL
4. Injects a JavaScript overlay that highlights elements on hover and captures clicks
5. On click, extracts the element's outerHTML, generates a stable selector via `buildStableSelector`
6. Takes a screenshot
7. Returns `PickElementResponse`

The route handler pattern must match the existing `handleSnapshot` pattern exactly:
- Collect POST body chunks
- Parse + validate with `PickElementRequestSchema`
- Call the core logic
- Return response or fallback on error

Here's the implementation:

```typescript
/**
 * Pick Element route — POST /profile-tooling/pick-element
 *
 * Launches a headful Playwright Chromium, injects a click-to-select
 * overlay, and generates a stable CSS selector for the element the
 * user clicks on.
 *
 * This enables the "visual picker" flow where an operator can
 * visually select product title, description, or image elements
 * directly from the live page.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import {
  PickElementRequestSchema,
  PickElementResponseSchema,
} from '../../shared/schemas/extraction-worker';
import type { PickElementResponse } from '../../shared/schemas/extraction-worker';
import {
  buildStableSelector,
  isSupportedSelectorSyntax,
} from '../../shared/selector-utils';
import { resolveArtifactDir, writeArtifact, generateJobId, extractDomainFromUrl } from '../artifacts';

// ─── Image source helpers (inlined — same as generate-selector.ts) ────────────

function isUsableImageSource(src: string | null | undefined): src is string {
  if (!src) return false;
  const trimmed = src.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:')) return false;
  if (trimmed.startsWith('blob:')) return false;
  if (trimmed.endsWith('.svg')) return false;
  return true;
}

function collectImageSourcesFromHtml(html: string): string[] {
  const sources: string[] = [];
  const imgRegex = /<img[^>]*src=["']([^"']*)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(html)) !== null) {
    if (isUsableImageSource(match[1])) sources.push(match[1]);
  }
  const dataSrcRegex = /<img[^>]*data-src=["']([^"']*)["']/gi;
  while ((match = dataSrcRegex.exec(html)) !== null) {
    if (isUsableImageSource(match[1]) && !sources.includes(match[1])) sources.push(match[1]);
  }
  return sources;
}

// ─── Injected overlay JavaScript ───────────────────────────────────────────────

function buildOverlayScript(fieldLabel: string): string {
  return `
(function() {
  // Avoid double-injection
  if (window.__elementPickerInjected) return;
  window.__elementPickerInjected = true;

  let highlightedEl = null;
  const highlightStyle = document.createElement('style');
  highlightStyle.textContent = \`
    .__ep-highlight {
      outline: 3px solid #2563eb !important;
      outline-offset: 2px !important;
      background: rgba(37, 99, 235, 0.08) !important;
      cursor: crosshair !important;
    }
    .__ep-bar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 2147483647;
      background: #1e293b;
      color: #fff;
      padding: 10px 16px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    .__ep-bar button {
      background: #ef4444;
      color: #fff;
      border: none;
      border-radius: 4px;
      padding: 4px 12px;
      font-size: 12px;
      cursor: pointer;
      font-weight: 600;
    }
    .__ep-bar button:hover { background: #dc2626; }
  \`;
  document.head.appendChild(highlightStyle);

  // Overlay bar
  const bar = document.createElement('div');
  bar.className = '__ep-bar';
  bar.innerHTML = '<span><strong>Click on the ' + JSON.stringify(fieldLabel) + ' element</strong> — hover to highlight, click to select. Cancel to abort.</span><button id="__ep-cancel">Cancel</button>';
  document.body.prepend(bar);

  // Offset for the bar height
  const BAR_HEIGHT = 46;

  document.addEventListener('mouseover', function(e) {
    const el = e.target;
    if (el.closest('.__ep-bar')) return;
    if (highlightedEl) highlightedEl.classList.remove('__ep-highlight');
    highlightedEl = el;
    highlightedEl.classList.add('__ep-highlight');
  }, true);

  document.addEventListener('mouseout', function(e) {
    const el = e.target;
    if (el.closest('.__ep-bar')) return;
    if (highlightedEl) {
      highlightedEl.classList.remove('__ep-highlight');
      highlightedEl = null;
    }
  }, true);

  document.addEventListener('click', function(e) {
    if (e.target.closest('.__ep-bar')) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el = e.target;
    const outerHTML = el.outerHTML;
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim();
    const attributes = {};
    for (const attr of el.attributes) {
      attributes[attr.name] = attr.value;
    }
    const rect = el.getBoundingClientRect();

    // Clean up
    if (highlightedEl) highlightedEl.classList.remove('__ep-highlight');
    document.querySelectorAll('.__ep-bar, .__ep-highlight').forEach(function(n) { n.remove(); });
    document.querySelector('style').remove();

    // Send result via window callback
    window.__elementPicked({
      outerHTML: outerHTML,
      tag: tag,
      text: text.slice(0, 500),
      attributes: attributes,
      boundingRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    });
  }, true);

  document.getElementById('__ep-cancel').addEventListener('click', function() {
    if (highlightedEl) highlightedEl.classList.remove('__ep-highlight');
    document.querySelectorAll('.__ep-bar, .__ep-highlight').forEach(function(n) { n.remove(); });
    document.querySelector('style').remove();
    window.__elementPicked(null);
  });
})();
`;
}

// ─── Core logic ────────────────────────────────────────────────────────────────

async function pickElement(
  url: string,
  field: string,
  allowParentContainer: boolean,
  domain: string,
  jobId: string,
): Promise<PickElementResponse> {
  const warnings: string[] = [];
  const artifactDir = resolveArtifactDir(domain, jobId);
  let browser;
  let screenshotRef: string | null = null;

  try {
    browser = await chromium.launch({
      headless: false, // headful — user needs to see and click
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // Set up the callback BEFORE navigating
    let pickResult: unknown = undefined;
    let pickResolve: (value: unknown) => void;
    const pickPromise = new Promise<unknown>((resolve) => {
      pickResolve = resolve;
    });

    await page.exposeFunction('__elementPicked', (data: unknown) => {
      pickResult = data;
      pickResolve(data);
    });

    // Navigate
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: 25_000,
    });

    // Dwell for dynamic content to load
    await page.waitForTimeout(2000);

    // Inject the overlay
    const fieldLabel = field === 'title' ? 'product title' : field === 'description' ? 'description' : 'product image(s)';
    await page.evaluate(buildOverlayScript(fieldLabel));

    // Wait for the user to pick an element (120s timeout)
    const timeoutMs = 120_000;
    const raceResult = await Promise.race([
      pickPromise,
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for user to pick an element after 120s')), timeoutMs)
      ),
    ]);

    if (raceResult === null || raceResult === undefined) {
      // Cancelled
      return {
        selector: '',
        stability: 'low',
        extractedText: null,
        extractedImages: [],
        matchCount: 0,
        outerHTML: null,
        screenshotRef: null,
        warnings: ['User cancelled the element picker'],
      };
    }

    const picked = raceResult as Record<string, unknown>;
    const outerHTML = (picked.outerHTML as string) ?? '';

    // Take screenshot for confirmation
    try {
      const screenshotBuffer = await page.screenshot({ type: 'png' });
      const screenshotPath = `${artifactDir}/picker-screenshot.png`;
      await writeArtifact(screenshotPath, screenshotBuffer);
      screenshotRef = screenshotPath;
    } catch {
      warnings.push('Failed to capture screenshot');
    }

    // Get full page HTML for selector generation
    const pageHtml = await page.content();
    const $ = cheerio.load(pageHtml);

    // Find the clicked element in the Cheerio DOM
    let matchedEl: cheerio.Element | null = null;

    // Strategy: match by id
    const attrs = picked.attributes as Record<string, string> || {};
    if (attrs.id && !attrs.id.startsWith('_')) {
      const byId = $(`#${attrs.id.replace(/(["'\\\s\[\]:.])/g, '\\$1')}`);
      if (byId.length === 1) matchedEl = byId.get(0);
    }

    // Strategy 2: match by data-* attributes
    if (!matchedEl) {
      const stableAttrs = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'itemprop'];
      for (const attr of stableAttrs) {
        const value = attrs[attr];
        if (!value) continue;
        const sel = `${picked.tag as string}[${attr}="${value.replace(/"/g, '\\"')}"]`;
        const matches = $(sel);
        if (matches.length === 1) { matchedEl = matches.get(0); break; }
      }
    }

    // Handle the image gallery case
    if (!matchedEl && field === 'images' && allowParentContainer) {
      // If user clicked an <img>, try finding its parent container
      if (picked.tag === 'img' && attrs.src) {
        // TODO: parent matching in Cheerio is complex; fall back to generating
        // a selector from the outerHTML alone with a stability warning
        warnings.push('Could not match clicked image in full DOM; selector generated from element alone');
      }
    }

    // Fallback: generate from outerHTML alone
    if (!matchedEl) {
      const el$ = cheerio.load(outerHTML);
      const root = el$.root().contents().first().get(0);
      if (root) {
        const fallbackResult = buildStableSelector(el$, root);
        const text = el$(root).text().replace(/\s+/g, ' ').trim();
        const images = collectImageSourcesFromHtml(outerHTML);
        warnings.push('Selector generated from picked element alone — uniqueness not verified against full DOM');

        return {
          selector: fallbackResult.selector,
          stability: 'low',
          extractedText: text || null,
          extractedImages: images,
          matchCount: 1,
          outerHTML,
          screenshotRef,
          warnings,
        };
      }

      return {
        selector: '',
        stability: 'low',
        extractedText: null,
        extractedImages: [],
        matchCount: 0,
        outerHTML: null,
        screenshotRef: null,
        warnings: ['Could not process the picked element'],
      };
    }

    // Generate stable selector from the matched element
    const result = buildStableSelector($, matchedEl);

    // Validate syntax
    if (!isSupportedSelectorSyntax(result.selector)) {
      warnings.push(`Generated selector "${result.selector}" uses unsupported syntax`);
    }

    // Count matches
    let matchCount = 0;
    try {
      matchCount = $(result.selector).length;
      if (matchCount > 1) {
        warnings.push(`Selector matches ${matchCount} elements — may not be unique`);
      }
    } catch {
      matchCount = 1;
    }

    // Extract text
    const text = $(result.selector).first().text().replace(/\s+/g, ' ').trim();

    // Extract images
    const images: string[] = [];
    $(result.selector).find('img').each((_, el) => {
      const src = $(el).attr('src');
      if (isUsableImageSource(src)) images.push(src);
    });

    return {
      selector: result.selector,
      stability: result.stability,
      extractedText: text || null,
      extractedImages: images,
      matchCount,
      outerHTML,
      screenshotRef,
      warnings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Pick element failed: ${msg}`);
    return {
      selector: '',
      stability: 'low',
      extractedText: null,
      extractedImages: [],
      matchCount: 0,
      outerHTML: null,
      screenshotRef,
      warnings,
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

// ─── Route handler ─────────────────────────────────────────────────────────────

export function handlePickElement(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];

  req.on('data', (c: Buffer) => {
    chunks.push(c);
  });

  req.on('end', async () => {
    try {
      const rawBody = Buffer.concat(chunks).toString();
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
        return;
      }

      const validation = PickElementRequestSchema.safeParse(parsed);
      if (!validation.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'Invalid request',
            details: validation.error.issues.map((i) => ({
              path: i.path.map((p) => String(p)).join('.'),
              message: i.message,
            })),
          }),
        );
        return;
      }

      const request = validation.data;
      const domain = extractDomainFromUrl(request.url);
      const jobId = generateJobId();
      const result = await pickElement(
        request.url,
        request.field,
        request.allowParentContainer,
        domain,
        jobId,
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[pick-element] Uncaught error: ${msg}\n`);
      const fallback = PickElementResponseSchema.parse({
        selector: '',
        stability: 'low',
        extractedText: null,
        extractedImages: [],
        matchCount: 0,
        outerHTML: null,
        screenshotRef: null,
        warnings: [`Uncaught error: ${msg}`],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fallback));
    }
  });
}
```

## Task 15: Register the route in server.ts

File: `src/extraction-worker/server.ts`

Add import:
```typescript
import { handlePickElement } from './routes/pick-element';
```

Add route (after the generate-selector route):
```typescript
  // ── Pick Element (Visual Picker) ────────────────────────────────────
  if (method === 'POST' && url === '/profile-tooling/pick-element') {
    handlePickElement(req, res);
    return;
  }
```

## Task 16: Add worker client function

File: `src/server/extraction-worker-client.ts`

Add import:
```typescript
import type {
  PickElementRequest,
  PickElementResponse,
} from '../shared/schemas/extraction-worker';
```
(Add to the existing import block)

Add function:
```typescript
export async function pickElement(
  request: PickElementRequest,
): Promise<{ ok: true; data: PickElementResponse } | { ok: false; error: string }> {
  return workerFetch(PickElementResponseSchema, {
    method: 'POST',
    path: '/profile-tooling/pick-element',
    body: request,
    timeoutMs: 120_000, // user is interacting — long timeout
  });
}
```

Also add the schema import (find the existing schema imports and add PickElementResponseSchema/PickElementRequestSchema):
```typescript
import {
  WorkerHealthResponseSchema,
  SnapshotResponseSchema,
  ProfileProposalResponseSchema,
  ValidateResponseSchema,
  ExtractResponseSchema,
  WorkerJobResultSchema,
  GenerateSelectorResponseSchema,
  PickElementResponseSchema,
} from '../shared/schemas/extraction-worker';
```

## Task 17: Add Bun proxy route

File: `src/server/routes/onboarding-routes.ts`

Add imports (find the existing imports and add):
```typescript
import {
  GenerateSelectorRequestSchema,
  PickElementRequestSchema,
} from '../../shared/schemas/extraction-worker';
```
and:
```typescript
import {
  generateSelectorFromElement,
  pickElement,
} from '../extraction-worker-client';
```

Add the proxy route (after the generate-selector route):
```typescript
/**
 * POST /api/onboarding/settings/profile-tooling/pick-element
 * Launches a headful browser for the user to click on an element.
 * Returns the generated selector + extracted preview.
 */
route.post('/onboarding/settings/profile-tooling/pick-element', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const parsed = PickElementRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      ok: false,
      error: 'Invalid request body',
      details: parsed.error.flatten(),
    }, 400);
  }

  const result = await pickElement(parsed.data);
  if (!result.ok) {
    return c.json({ ok: false, error: result.error });
  }
  return c.json({ ok: true, data: result.data });
});
```

## Task 18: Add client API function

File: `src/client/onboarding-api.ts`

Add import:
```typescript
import type { PickElementRequest, PickElementResponse } from '../shared/schemas/extraction-worker';
```

Add function:
```typescript
export async function pickElementVisually(
  req: PickElementRequest,
): Promise<{ ok: boolean; data?: PickElementResponse; error?: string }> {
  return request('/settings/profile-tooling/pick-element', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}
```

## What to verify
- `bun run typecheck` passes
- All routes follow existing patterns in the codebase

## What NOT to do
- Don't modify test files
- Don't modify frontend components (separate task)

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
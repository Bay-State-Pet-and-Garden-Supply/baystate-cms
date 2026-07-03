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
  bar.innerHTML = '<span><strong>Click on the ' + ${JSON.stringify(fieldLabel)} + ' element</strong> — hover to highlight, click to select. Cancel to abort.</span><button id="__ep-cancel">Cancel</button>';
  document.body.prepend(bar);

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
    highlightStyle.remove();

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
    highlightStyle.remove();
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
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // Set up the callback BEFORE navigating
    let pickResolve: (value: unknown) => void = () => {};
    const pickPromise = new Promise<unknown>((resolve) => {
      pickResolve = resolve;
    });

    await page.exposeFunction('__elementPicked', (data: unknown) => {
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
    const fieldLabel =
      field === 'title'
        ? 'product title'
        : field === 'description'
          ? 'description'
          : 'product image(s)';
    await page.evaluate(buildOverlayScript(fieldLabel));

    // Wait for the user to pick an element with 120s timeout
    const timeoutMs = 120_000;
    const picked = await Promise.race([
      pickPromise,
      new Promise<null>((_, reject) =>
        setTimeout(
          () => reject(new Error('Timed out waiting for user to pick an element after 120s')),
          timeoutMs,
        ),
      ),
    ]);

    if (picked === null || picked === undefined) {
      // User cancelled
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

    const pickedData = picked as Record<string, unknown>;
    const outerHTML = (pickedData.outerHTML as string) ?? '';

    // Take screenshot for confirmation
    try {
      const screenshotBuffer = await page.screenshot({ type: 'png' });
      screenshotRef = writeArtifact(artifactDir, 'picker-screenshot.png', screenshotBuffer);
    } catch {
      warnings.push('Failed to capture screenshot');
    }

    // Get full page HTML for selector generation
    const pageHtml = await page.content();
    const $ = cheerio.load(pageHtml);

    // Find the clicked element in the Cheerio DOM
    let matchedEl: cheerio.Element | null = null;

    const tag = (pickedData.tag as string) ?? '';
    const attrs = (pickedData.attributes as Record<string, string>) ?? {};

    // Strategy 1: match by id
    if (attrs.id && !attrs.id.startsWith('_')) {
      const safeId = attrs.id.replace(/(["'\\\s\[\]:.])/g, '\\$1');
      const byId = $(`#${safeId}`);
      if (byId.length === 1) matchedEl = byId.get(0) as cheerio.Element;
    }

    // Strategy 2: match by stable data-* attributes
    if (!matchedEl) {
      const stableAttrs = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-product-id', 'data-product-sku', 'itemprop'];
      for (const attr of stableAttrs) {
        const value = attrs[attr];
        if (!value) continue;
        const sel = `${tag}[${attr}="${value.replace(/"/g, '\\"')}"]`;
        const matches = $(sel);
        if (matches.length === 1) {
          matchedEl = matches.get(0) as cheerio.Element;
          break;
        }
        if (matches.length > 1 && attrs.class) {
          const cls = attrs.class.split(/\s+/).filter(Boolean).join('.');
          const narrowed = $(`${sel}.${cls}`);
          if (narrowed.length === 1) {
            matchedEl = narrowed.get(0) as cheerio.Element;
            break;
          }
        }
      }
    }

    // Strategy 3: match by tag + class (best-effort)
    if (!matchedEl && attrs.class) {
      const cls = attrs.class.split(/\s+/).filter(Boolean).join('.');
      const byClass = $(`${tag}.${cls}`);
      if (byClass.length >= 1) matchedEl = byClass.get(0) as cheerio.Element;
    }

    // Strategy 4: first element with same tag (weakest)
    if (!matchedEl) {
      const byTag = $(tag);
      if (byTag.length > 0) matchedEl = byTag.get(0) as cheerio.Element;
    }

    // Handle the image gallery case: if user clicked an <img>, try finding parent
    if (!matchedEl && field === 'images' && allowParentContainer && tag === 'img' && attrs.src) {
      const imgEl = $(`img[src="${attrs.src.replace(/"/g, '\\"')}"]`).first();
      if (imgEl.length > 0) {
        const parent = imgEl.parent();
        if (parent.length > 0 && parent.find('img').length > 1) {
          matchedEl = parent.get(0) as cheerio.Element;
          warnings.push(
            'Clicked a single image; used parent container (contains ' +
              parent.find('img').length +
              ' images)',
          );
        } else if (parent.length > 0) {
          matchedEl = imgEl.get(0) as cheerio.Element;
        }
      }
    }

    // Fallback: generate from outerHTML alone
    if (!matchedEl) {
      const el$ = cheerio.load(outerHTML);
      const root = el$.root().contents().first().get(0);
      if (root) {
        const fallbackResult = buildStableSelector(el$, root as cheerio.Element);
        const text = el$(root).text().replace(/\s+/g, ' ').trim();
        const images = collectImageSourcesFromHtml(outerHTML);
        warnings.push(
          'Selector generated from picked element alone — uniqueness not verified against full DOM',
        );

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
        warnings: ['Could not parse the picked element'],
      };
    }

    // Generate stable selector from the matched element
    const result = buildStableSelector($, matchedEl);

    // Validate syntax
    if (!isSupportedSelectorSyntax(result.selector)) {
      warnings.push(`Generated selector "${result.selector}" uses unsupported syntax`);
    }

    // Count matches in full DOM
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
    $(result.selector)
      .find('img')
      .each((_, el) => {
        const src = $(el).attr('src');
        if (isUsableImageSource(src)) images.push(src);
      });
    // Also check if the element itself is an img
    if (tag === 'img' && attrs.src && isUsableImageSource(attrs.src)) {
      if (!images.includes(attrs.src)) images.push(attrs.src);
    }

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
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// ─── Route handler ─────────────────────────────────────────────────────────────

/**
 * POST /profile-tooling/pick-element
 *
 * Accepts { url, field, allowParentContainer } and launches a headful
 * browser for the user to click on an element. Returns the generated
 * stable selector + extracted preview data.
 */
export function handlePickElement(
  req: IncomingMessage,
  res: ServerResponse,
): void {
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

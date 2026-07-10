/**
 * @deprecated Visual element picker — removed due to reliability issues.
 * This file is kept as a stub so the worker doesn't break if the route
 * is still registered elsewhere. The paste-HTML selector generator
 * (generate-selector.ts) remains available.
 *
 * Originally: POST /profile-tooling/pick-element
 *
 * Launched a headful Playwright Chromium, injected a click-to-select
 * overlay, and generated a stable CSS selector for the element the
 * user clicked on.
 */

// ─── Inline types (previously imported from shared schemas — removed) ───────
// This stub now carries local type definitions so the file remains valid.

interface LocalPickElementRequest {
  url: string;
  field: string;
  allowParentContainer: boolean;
}

interface LocalPickElementResponse {
  selector: string;
  stability: 'high' | 'medium' | 'low';
  extractedText: string | null;
  extractedImages: string[];
  matchCount: number;
  outerHTML: string | null;
  screenshotRef: string | null;
  warnings: string[];
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { z } from 'zod';
import {
  buildStableSelector,
  isSupportedSelectorSyntax,
} from '../../shared/selector-utils';
import { resolveArtifactDir, writeArtifact, generateJobId, extractDomainFromUrl } from '../artifacts';

// ─── Local schemas (mirrors of removed shared schemas) ─────────────────────────

const LocalPickElementRequestSchema = z.object({
  url: z.string().url(),
  field: z.string(),
  allowParentContainer: z.boolean().default(true),
});

const LocalPickElementResponseSchema = z.object({
  selector: z.string(),
  stability: z.enum(['high', 'medium', 'low']),
  extractedText: z.string().nullable().default(null),
  extractedImages: z.array(z.string()).default(() => []),
  matchCount: z.number().int(),
  outerHTML: z.string().nullable().default(null),
  screenshotRef: z.string().nullable().default(null),
  warnings: z.array(z.string()).default(() => []),
});

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
  const label = JSON.stringify(fieldLabel);
  return `(function() {
  if (window.__elementPickerInjected) return;
  window.__elementPickerInjected = true;

  var S = { HOVERING: 0, SELECTED: 1 };
  var state = S.HOVERING;
  var hl = null, sel = null, data = null;

  var st = document.createElement("style");
  st.textContent = ".__eph{outline:3px solid #2563eb!important;outline-offset:2px!important;background:rgba(37,99,235,0.08)!important;cursor:crosshair!important}.__eps{outline:3px solid #22c55e!important;outline-offset:2px!important;background:rgba(34,197,94,0.06)!important}.__epc{position:fixed;z-index:2147483647;pointer-events:none;top:-10px;right:-10px;width:24px;height:24px;border-radius:50%;background:#22c55e;color:#fff;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.3)}.__epb{position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:#1e293b;color:#fff;padding:12px 20px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 -2px 12px rgba(0,0,0,0.3);gap:12px}.__epb .__epl{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.__epb .__epl code{background:rgba(255,255,255,0.15);padding:1px 6px;border-radius:3px;font-size:12px}.__epbtn{border:none;border-radius:4px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer}.__epbtn:hover{opacity:0.85}.__epcf{background:#22c55e;color:#fff}.__eprt{background:#f59e0b;color:#fff}.__epcl{background:#6b7280;color:#fff}";
  document.head.appendChild(st);

  var bar = document.createElement("div");
  bar.className = "__epb";
  document.body.appendChild(bar);

  function esc(s){return s?s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"):""}
  function hoverInfo(el){var t=el.tagName.toLowerCase(),c=(el.className||"").slice(0,80),x=(el.textContent||"").trim().replace(/\\s+/g," ").slice(0,50);return t+(c?"."+c.split(/\\s+/).filter(Boolean).join("."):"")+" \u2014 \""+esc(x)+"\""}
  function showHover(el){if(state===S.SELECTED)return;bar.innerHTML="<span class=\"__epl\">Hovering: <code>"+esc(hoverInfo(el))+"</code></span><button class=\"__epbtn __epcl\" id=\"_c\">Cancel</button>";document.getElementById("_c").onclick=cancelSel}
  function showSelected(d){state=S.SELECTED;var t=d.tag+(d.className?"."+d.className.split(/\\s+/).filter(Boolean).join("."):""),x=(d.text||"").slice(0,50);bar.innerHTML="<span class=\"__epl\">\\u2713 Selected: <code>"+esc(t)+"</code> \u2014 \""+esc(x)+"\"</span><button class=\"__epbtn __epcf\" id=\"_cf\">Confirm \u2713</button><button class=\"__epbtn __eprt\" id=\"_rt\">Retry</button><button class=\"__epbtn __epcl\" id=\"_c\">Cancel</button>";document.getElementById("_cf").onclick=confirmSel;document.getElementById("_rt").onclick=retrySel;document.getElementById("_c").onclick=cancelSel};function reset(){state=S.HOVERING;if(sel){sel.classList.remove("__eps");var b=sel.querySelector(".__epc");if(b)b.remove();sel=null}data=null;bar.innerHTML="<span class=\"__epl\">Click on "+esc(${label})+" element</span><button class=\"__epbtn __epcl\" id=\"_c\">Cancel</button>";document.getElementById("_c").onclick=cancelSel}
  function confirmSel(){if(!data)return;cleanup();window.__elementPicked(data)}
  function retrySel(){reset()}
  function cancelSel(){cleanup();window.__elementPicked(null)}
  function cleanup(){if(hl){hl.classList.remove("__eph");hl=null}if(sel){sel.classList.remove("__eps");var b=sel.querySelector(".__epc");if(b)b.remove()}bar.remove();st.remove()}

  document.addEventListener("mouseover",function(e){if(state===S.SELECTED)return;var el=e.target;if(el.closest(".__epb"))return;if(hl&&hl!==el)hl.classList.remove("__eph");hl=el;hl.classList.add("__eph");showHover(el)},true);
  document.addEventListener("mouseout",function(e){if(state===S.SELECTED)return;var el=e.target;if(el.closest(".__epb"))return;if(hl){hl.classList.remove("__eph");hl=null}bar.innerHTML="<span class=\"__epl\">"+esc(${label})+"</span><button class=\"__epbtn __epcl\" id=\"_c\">Cancel</button>";document.getElementById("_c").onclick=cancelSel},true);
  document.addEventListener("click",function(e){if(e.target.closest(".__epb"))return;if(state===S.SELECTED)return;e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();var el=e.target,r=el.getBoundingClientRect(),a={};for(var i=0;i<el.attributes.length;i++){var at=el.attributes[i];a[at.name]=at.value}data={outerHTML:el.outerHTML,tag:el.tagName.toLowerCase(),text:(el.textContent||"").trim().slice(0,500),className:(el.className||"").trim(),attributes:a,boundingRect:{top:r.top,left:r.left,width:r.width,height:r.height}};if(hl){hl.classList.remove("__eph");hl=null}sel=el;sel.classList.add("__eps");var b=document.createElement("div");b.className="__epc";b.textContent="\\u2713";var p=el.getBoundingClientRect();b.style.left=(p.right-10)+"px";b.style.top=(p.top-10)+"px";document.body.appendChild(b);showSelected(data)},true);
  document.addEventListener("keydown",function(e){if(e.key==="Enter"&&state===S.SELECTED)confirmSel();if(e.key==="Escape"){if(state===S.SELECTED)retrySel();else cancelSel()}});

  reset();
})()`;
}
// ─── Core logic ────────────────────────────────────────────────────────────────

async function pickElement(
  url: string,
  field: string,
  allowParentContainer: boolean,
  domain: string,
  jobId: string,
): Promise<LocalPickElementResponse> {
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
    let matchedEl: Element | null = null;

    const tag = (pickedData.tag as string) ?? '';
    const attrs = (pickedData.attributes as Record<string, string>) ?? {};

    // Strategy 1: match by id
    if (attrs.id && !attrs.id.startsWith('_')) {
      const safeId = attrs.id.replace(/(["'\\\s\[\]:.])/g, '\\$1');
      const byId = $(`#${safeId}`);
      if (byId.length === 1) matchedEl = byId.get(0) as Element;
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
          matchedEl = matches.get(0) as Element;
          break;
        }
        if (matches.length > 1 && attrs.class) {
          const cls = attrs.class.split(/\s+/).filter(Boolean).join('.');
          const narrowed = $(`${sel}.${cls}`);
          if (narrowed.length === 1) {
            matchedEl = narrowed.get(0) as Element;
            break;
          }
        }
      }
    }

    // Strategy 3: match by tag + class (best-effort)
    if (!matchedEl && attrs.class) {
      const cls = attrs.class.split(/\s+/).filter(Boolean).join('.');
      const byClass = $(`${tag}.${cls}`);
      if (byClass.length >= 1) matchedEl = byClass.get(0) as Element;
    }

    // Strategy 4: first element with same tag (weakest)
    if (!matchedEl) {
      const byTag = $(tag);
      if (byTag.length > 0) matchedEl = byTag.get(0) as Element;
    }

    // Handle the image gallery case: if user clicked an <img>, try finding parent
    if (!matchedEl && field === 'images' && allowParentContainer && tag === 'img' && attrs.src) {
      const imgEl = $(`img[src="${attrs.src.replace(/"/g, '\\"')}"]`).first();
      if (imgEl.length > 0) {
        const parent = imgEl.parent();
        if (parent.length > 0 && parent.find('img').length > 1) {
          matchedEl = parent.get(0) as Element;
          warnings.push(
            'Clicked a single image; used parent container (contains ' +
              parent.find('img').length +
              ' images)',
          );
        } else if (parent.length > 0) {
          matchedEl = imgEl.get(0) as Element;
        }
      }
    }

    // Fallback: generate from outerHTML alone
    if (!matchedEl) {
      const el$ = cheerio.load(outerHTML);
      const root = el$.root().contents().first().get(0);
      if (root) {
        const fallbackResult = buildStableSelector(el$, root as Element);
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

      const validation = LocalPickElementRequestSchema.safeParse(parsed);
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
      const fallback = LocalPickElementResponseSchema.parse({
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

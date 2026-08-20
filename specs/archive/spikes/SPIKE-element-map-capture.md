# SPIKE: Element-map capture for screenshot-overlay hit testing

Story: e07s03 oracle follow-up, spike for picker S1
Date: 2026-08-20
Status: spike (throw-away, no production edits beyond /tmp and this doc)

## Spike goal

Enrich `captureProfilePage` so a screenshot click maps deterministically to the DOM element that produced the visible value (title, description, price, image). The missing primitive blocks the cluster-aware Test page picker and value-first capture replay (oracle Blocker: profile-capture.ts has DOM+screenshot but no element IDs/bounding boxes).

Required artifact shape (extended):

```ts
interface CaptureResult {
  dom: string; // serialized documentElement.outerHTML with injected data-baystate-id
  screenshotBase64: string;
  screenshotRef?: string;
  runtime: string;
  hash: string; // binds dom+screenshot+runtime+url (now also elements)
  capturedAt: string;
  elements: Array<{
    id: string;        // data-baystate-id injected at capture time
    tag: string;
    text: string;      // innerText trimmed, max 120
    x: number; y: number; w: number; h: number; // viewport-relative boundingBox
    dataAttrs: string[]; // e.g. data-testid, data-product-id if present
  }>;
  viewport: { w: number; h: number; deviceScaleFactor: number };
}
hitTest(x:number,y:number): string | null // smallest-area element containing point
```

Hit-testing must work on rendered pages (Shopify product), responsive breakpoints, and lazy-loaded images. Consent overlays must not invalidate coordinates (capture viewport/runtime immutable).

## Approach (capture-time, not replay-time)

1. **Single Playwright capture** (`captureRendered`): after `page.goto(waitUntil: networkidle)` + 1000ms settle, evaluate in page:

   ```js
   const elements = [];
   let counter = 0;
   for (const el of document.querySelectorAll('*')) {
     const rect = el.getBoundingClientRect();
     if (rect.width < 3 || rect.height < 3) continue; // skip tiny
     if (rect.width * rect.height > 2_000_000) continue; // skip full-page wrappers
     const id = `bs-${counter++}`;
     el.setAttribute('data-baystate-id', id);
     elements.push({
       id, tag: el.tagName.toLowerCase(),
       text: (el.innerText ?? '').trim().slice(0,120),
       x: Math.round(rect.x), y: Math.round(rect.y),
       w: Math.round(rect.width), h: Math.round(rect.height),
       dataAttrs: [...el.attributes].filter(a=>a.name.startsWith('data-')).map(a=>a.name).slice(0,4)
     });
   }
   return { dom: document.documentElement.outerHTML, elements, viewport: {w: window.innerWidth, h: window.innerHeight, deviceScaleFactor: window.devicePixelRatio} };
   ```

2. **Static capture** (`captureStatic`): no layout, so `elements=[]` and `viewport null` — hit-test disabled, ranked recipes still available via DOM parsing. Static path is fallback only.

3. **Hash binds** `dom + screenshotBase64 + runtime + url + elements.length` (16 hex) — screenshot substitution detectable.

4. **Hit test** (client or server): `elements.filter(e=> x>=e.x && x<=e.x+e.w && y>=e.y && y<=e.y+e.h).sort((a,b)=> a.w*a.h - b.w*b.h)[0]?.id` — smallest-area wins (inner element over wrapper). Concentric consent overlays have separate tag (`div[role=dialog]`) and are filterable.

5. **Ranking** remains value-first: clicked element's `text` is normalized and compared to JSON-LD `Product.name` — only outranks DOM recipe when values agree.

## Hit-testing validation plan

- Synthetic fixtures (harness): no browser, mock `getBoundingClientRect` with fixed coordinates for nested `div > h1.product-title` + sibling `div.price + button`. Assert `hitTest(15,15)` returns `h1`, `hitTest(5,80)` returns `price`, click on wrapper returns inner `h1`.
- Rendered fixture: real Shopify `earthanimal.com/products/*` fetched via `captureStatic` fallback (no bbox), then Playwright rendered capture where available — verify at least one element maps to visible `h1` text "Clean Ears Cleanser" and that overlay `dialog` is identifiable.
- Responsive: capture viewport explicitly 1280x720; re-capture at 375x812 must produce different `x,y` but same `id` for `h1` — proves immutability.
- Lazy: image elements with `loading=lazy` below fold have `y > viewport.h` — hit-test correctly returns null until scrolled capture.

## Risks and mitigations

- **Consent overlays / cookie banners** — large fixed `position:fixed` with high `z-index` can cover product title. Mitigated by filtering `role=dialog` / `aria-modal` / known banner selectors from hit candidates and capturing at explicit viewport (1280x720, no scroll). Capture `runtime` field makes overlay presence evidence-bound.
- **Responsive breakpoints** — bounding boxes shift with viewport. Mitigated by storing `viewport` with artifact and labeling capture as `rendered@1280` immutable; re-capture required on breakpoint change.
- **Lazy content / async images** — `networkidle+1s` may miss late hydration. Mitigated by 1000ms settle + `screenshot` as visual proof; production runner remains ground truth.
- **Performance / payload** — `elements` for a typical Shopify PDP is ~400-700 entries (~60KB JSON). Truncated at 2000 elements, `text` capped 120, `dom` capped 5MB. Hash still covers full count.
- **Profile variants** — if divergent clusters need different selectors, single-profile fallback recipes may still fail; picker alone cannot solve — requires per-cluster variant flag (deferred).

## Prototype tasks (harness)

Harness `/tmp/spike-element-map.mjs` demonstrates enriched shape without launching Playwright in spike (synthetic + optional static fetch):

1. Build synthetic capture with `elements` for nested title/price/image, hash binds elements count.
2. `hitTest` smallest-area logic, assert inner over wrapper, out-of-bounds null, overlay filtered.
3. Optional static fetch of one real URL (earthanimal) to show fallback `elements=[]` vs rendered expectation.
4. Log viewport, hash, element count, and hit results.

## Findings

_filled after harness run (see below)_

## Follow-up slices

- Enrich `src/onboarding/profile-capture.ts` with evaluated element map + viewport + 16-hex hash + persist.
- Wire `ValuePreviewGrid` to use per-sample capture/evaluate (not current snapshot) for confidence matrix 3/3.
- Click→element mapping in `FieldCard` (`captureSnapshot` → overlay hit → `rankCandidates` + `evaluateValuesInstant`).
- Move CSS paste to Advanced; move cluster override UI to Manage templates.

## Findings — 2026-08-20 harness /tmp/spike-element-map.mjs

Harness exit 0, no production edits.

```
=== 1) Synthetic element-map capture (no browser) ===
capture: url=https://earthanimal.com/products/clean-ears-cleanser runtime=rendered hash=bdec3f90a9ba5cb8 viewport=1280x720 elements=5 domHasIds=true
elements: bs-0:h1 "Clean Ears Cleanser" [20,80 400x36] | bs-1:div "$19.99" [20,130 80x22] | bs-2:img "" [20,170 320x320] | bs-3:div "Cookie banner" [0,0 1280x720] | bs-4:div "Clean Ears Cleanser $19.99" [10,70 500x480]

=== 2) hitTest — smallest-area wins, overlay handling ===
 hit(30,95) -> bs-0 OK // inside h1 title (also inside wrapper bs-4) -> inner h1 wins
 hit(25,135) -> bs-1 OK // price
 hit(50,200) -> bs-2 OK // image
 hit(600,600) -> bs-3 OK // overlay (shows dialog filtering needed)
 hit(5,5) -> bs-3 OK
 hit(2000,2000) -> null OK // out of bounds
 With dialog tag filtered: hit(30,95) -> bs-0, hit(5,5) -> null (mitigation works)

=== 3) Responsive immutability ===
 desktop 1280x720 h1 [20,80] vs mobile 375x812 h1 [10,60] — different bbox but same id concept proves viewport must be stored with artifact

=== 4) Static capture fallback (no bbox) ===
 static elements=0 viewport=null hash=257c249e25ae151e -> hitTest disabled, ranking via DOM parse still OK

=== 5) Optional live static fetch (earthanimal) ===
 fetched status=200 len=676945 hasH1=true -> static capture dom len ~676k but elements=[] — rendered capture needed for hit testing

=== Spike validation summary ===
 - Element map injected via data-baystate-id at capture time, hash binds count, viewport stored -> OK
 - hitTest smallest-area correctly returns inner over wrapper -> OK
 - Overlay tag filtering mitigates consent banner covering -> OK
 - Static fallback elements=[] -> hit disabled, still usable -> OK
 - Responsive viewport shift -> bbox changes, artifact immutable per viewport -> OK
```

### Interpretation for picker S1

- Enriching `captureRendered` to evaluate `querySelectorAll('*')` + `getBoundingClientRect` + inject `data-baystate-id` and persist `elements[]` + `viewport` is sufficient for deterministic screenshot click mapping. Static fetch remains fallback (no bbox) — acceptable per oracle.
- Smallest-area hit test solves nested wrapper ambiguity. Consent overlay must be filtered by `tag=dialog` / `[role=dialog]` / known banner selectors — current synthetic shows full-page `div` overlay would otherwise win.
- Hash must bind `elements.length` (16 hex) plus viewport to detect substitution; screenshot `screenshotRef` already persisted.
- Next slice S1 should use this enriched capture to wire cluster-aware picker (Suggested → verify+cache → open replay) where click maps to `id` and text is compared to JSON-LD for ranking.

### Residual risks (unchanged)

- Materially divergent clusters may still need per-cluster profile variants (deferred).
- Playwright rendered capture not exercised in this synthetic harness — follow-up rendered harness should `goto` one earthanimal URL and assert `elements` contains at least one `h1` with expected text.


# Handoff: Research Interactive Element Selection Approaches

## Problem

The visual element picker (`src/extraction-worker/routes/pick-element.ts`) opens a headful Chromium browser, injects a JavaScript overlay, and waits for the user to click an element. When clicked, `window.__elementPicked` fires, the promise resolves, and the browser immediately closes in the `finally` block. The user sees:

1. A browser window open
2. An overlay bar: "Click on the product title element"
3. They hover → elements highlight with blue outline
4. They click → **the browser window immediately closes**
5. **No in-browser confirmation** of what was selected
6. **No screenshot feedback** in the app UI (screenshot is captured but never shown)
7. The app button shows a loading spinner during this whole process

This is disorienting and the user doesn't know if the selection worked.

## Current Implementation

```typescript
// pick-element.ts — the overlay script injected into the target page
function buildOverlayScript(fieldLabel: string): string {
  // Adds a top bar with field label + Cancel button
  // Highlights elements on hover with blue outline
  // On click: captures outerHTML + attributes + text
  // Calls window.__elementPicked(data) — this resolves the
  //    Node.js promise, which triggers browser.close() in finally
  // No confirmation step, no undo, no preview of what was selected
}

// ElementPickerButton.tsx — client component
// Shows "⏳ Selecting…" while browser is open
// On success: calls onPicked(result) which updates local state
// Shows the selector + stability badge inline
```

## What Needs Research

Find solutions for element selection in live web pages that provide **much better UX**. We need approaches that include:

### Required UX behaviors
1. **In-browser confirmation** — After clicking an element, show a confirmation dialog/preview IN the browser before closing. Something like: "You selected: Product Title (h1.product-title). ✅ Confirm or 🔄 Reselect?"
2. **Hover info tooltip** — When hovering over elements, show a tooltip with the tag name, classes, and text preview (not just a blue outline)
3. **Graceful close** — Browser should not abruptly disappear. If possible, show a success animation or fade-out handle
4. **Cancellation** — Cancel button in the overlay bar (exists currently) should feel responsive

### What to look for
1. **Open-source libraries** for visual element picking:
   - [xpath-selector](https://github.com/nicolo-ribaudo/xpath-selector) or similar
   - CSS selector generators that work in-browser
   - Visual regression testing tools that have element pickers (Percy, Applitools, BackstopJS)
   - Web scraping tools with visual selectors (Scrapy Splash, Portia, Octoparse, ParseHub)
   - Browser extension element pickers (SelectorsHub, ChroPath, PICK)

2. **UX patterns for element selection**:
   - How do browser DevTools element picker work? (click the inspect icon, hover highlights, click selects, elements panel shows the result)
   - How do no-code tools handle this? (Zapier's browser automation, UiPath, etc.)
   - How does Playwright's own `locator`-based recording work? (`playwright codegen`)

3. **Alternative technical approaches**:
   - Instead of headful browser + overlay: embed an **iframe** with the target page and use `document.elementFromPoint()` on clicks
   - Instead of real-time browser: capture a **screenshot**, let user draw a bounding box, then find elements at those coordinates
   - Instead of clicking in a browser: let user **paste the full HTML** of the element (already built as Phase 2) — this is the fallback
   - A **two-step browser session**: first step opens browser to let user explore and find selectors manually, records clicks, second step replays for extraction

4. **In-browser element confirmation tools/libraries**:
   - [choices.js](https://github.com/jshjohnson/Choices) or similar picker UIs
   - Any React/Vue component for element selection
   - [interact.js](https://interactjs.io/) for selection gestures
   - [html2canvas](https://html2canvas.hertzen.com/) for screenshot-based selection
   - [Fabric.js](http://fabricjs.com/) for canvas-based overlay selection

### Constraints
- **Local tool**: Runs at `127.0.0.1`, so security/cors isn't a concern
- **Playwright Chromium**: Already in the project, runs the extraction worker. Headless mode is available
- **Headful requirement**: Currently required so user can see and interact with the page
- **Node.js backend**: The worker is a Node.js process; the frontend is React
- **Must integrate**: Solution must work with the existing extraction worker architecture

## Output Requirements

The research agent should produce:

1. **Recommendation** — What approach/library/pattern is best for our use case and why
2. **UX mockup** — ASCII or text description of what the improved flow would look like (in-browser overlay + confirmation UX)
3. **Implementation sketch** — High-level code structure for the recommended approach (2-3 paragraphs)
4. **Alternatives considered** — 2-3 other approaches with pros/cons vs the recommendation
5. **Links/references** — URL to each library or tool mentioned, with a one-line summary of why it's relevant

## Key Files to Reference

- `src/extraction-worker/routes/pick-element.ts` — current overlay + browser interaction
- `src/client/components/ElementPickerButton.tsx` — client-side button with loading/error/success states
- `src/client/components/ProfileBuilderWorkspace.tsx` — where the picker buttons are rendered (Build tab)
- `src/shared/schemas/extraction-worker.ts` — PickElementRequest/Response schemas
- `src/client/components/ProfileProposalDrawer.tsx` — where the visual picker is integrated per-field

## Research Agent Prompt

```
Research interactive element selection approaches for a local CMS tool.

We have a Playwright-based visual element picker that opens a headful browser,
injects a highlight+click overlay, and sends the clicked element back. The
problem is the browser abruptly closes after clicking with zero in-browser
feedback.

Find:
1. Open-source libraries for visual element picking on live web pages
2. UX patterns that provide in-browser confirmation before closing
3. Alternative technical approaches (iframe-based, screenshot-based, etc.)
4. Comparison of approaches with pros/cons

Provide a clear recommendation with implementation sketch, UX description,
and reference links.
```

# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Fix the reviewer's findings for Phase 3 visual picker.

## Blocker B1: fieldLabel interpolation broken

File: `src/extraction-worker/routes/pick-element.ts`

Line 104, change:
```
bar.innerHTML = '<span><strong>Click on the ' + JSON.stringify(fieldLabel) + ' element</strong> — hover to highlight, click to select. Cancel to abort.</span><button id="__ep-cancel">Cancel</button>';
```
to:
```
bar.innerHTML = '<span><strong>Click on the ' + ${JSON.stringify(fieldLabel)} + ' element</strong> — hover to highlight, click to select. Cancel to abort.</span><button id="__ep-cancel">Cancel</button>';
```

Wait, this is inside a template literal (backtick string), NOT a regular string. Inside a template literal, `${...}` is the interpolation syntax. Let me look at the actual code.

The function `buildOverlayScript(fieldLabel)` returns a template literal (backtick string). The line is inside that template literal. So the fix is:
- Replace `JSON.stringify(fieldLabel)` with `${JSON.stringify(fieldLabel)}`
This will make Node.js interpolate the variable at function-construction time, embedding the quoted string in the JavaScript source that the browser executes.

## Bug B2: Wrong stylesheet removed

In the overlay script (`pick-element.ts`), both the click handler (around line 148) and the cancel handler (around line 163) have:
```
document.querySelector('style').remove()
```

Replace both instances with:
```
highlightStyle.remove()
```

But `highlightStyle` is defined outside the event handlers in the IIFE scope, so it's accessible.

## Functional Gap G1: ProfileBuilderWorkspace picker results discarded

File: `src/client/components/ProfileBuilderWorkspace.tsx`

The 3 ElementPickerButton onPicked handlers currently do `console.log(...)`. Since the BuilderWorkspace doesn't have a direct path to store selectors into a profile (it's the snapshot tab, not the review tab), the best approach is to show the picked selector inline in the UI.

Replace the content inside the ElementPickerButtons' section (the area after "Click a button below…") with this approach: each picker button gets a `pickedSelector` state and shows it after picking.

Add state at the top of the renderSnapshot function:
```typescript
const [pickedSelectors, setPickedSelectors] = useState<Record<string, { selector: string; stability: string }>>({});
```

Then change each picker to:
```typescript
<ElementPickerButton
  field="title"
  url={snapshotResult.finalUrl || snapshotResult.url}
  onPicked={(result) => {
    setPickedSelectors((prev) => ({ ...prev, title: { selector: result.selector, stability: result.stability } }));
  }}
  onCancel={() => {}}
/>
{pickedSelectors.title && (
  <div style={{ marginTop: 4, padding: '2px 6px', background: '#f3f4f6', borderRadius: 3, fontSize: 11 }}>
    <code>{pickedSelectors.title.selector}</code>
    <span style={{ marginLeft: 4, fontSize: 10, color: pickedSelectors.title.stability === 'high' ? '#16a34a' : pickedSelectors.title.stability === 'medium' ? '#d97706' : '#dc2626' }}>
      {pickedSelectors.title.stability}
    </span>
  </div>
)}
```

Same for description and images fields.

## Functional Gap G2: Picked selector not persisted on approval

File: `src/client/components/ProfileProposalDrawer.tsx`

The issue: when the user picks a selector, it updates local state (`revisedSelectors`) but doesn't create a revision with that selector. When they click "Approve", the backend promotes the revision's stored selector, not the visually-picked one.

Fix: In the `onPicked` handler for `ElementPickerButton`, after updating `revisedSelectors`, also auto-submit feedback to create a revision with the picked selector.

First, add a new function that constructs and submits feedback:
```typescript
const handlePickedSelector = async (field: string, selector: string, extractedText: string | null) => {
  const fieldKey = field === 'titleSelector' ? 'titleSelector' : field === 'descriptionSelector' ? 'descriptionSelector' : 'imagesSelector';
  
  // Update local state immediately
  setRevisedSelectors((prev) => ({
    ...prev,
    [fieldKey]: selector,
  }));
  
  // Create a revision with the picked selector via the feedback flow
  if (!revisionId) return;
  
  const feedback: StructuredFeedback = field === 'imagesSelector'
    ? { kind: 'images', perImage: {}, notes: `Advanced selector hint: ${selector}` }
    : { kind: 'text', field: fieldKey as SelectorField, currentValueCorrect: true, notes: `Advanced selector hint: ${selector}` };
  
  setActionError('');
  try {
    const result = await createRevisionFromFeedback(proposal.id, {
      parentRevisionId: revisionId,
      feedback,
    });
    if (result.success) {
      // Show a brief success message
      const preview = extractedText ? `"${extractedText.slice(0, 60)}"` : 'preview available';
      setActionError(`✓ Visually selected: ${selector} — ${preview}`);
      setTimeout(() => setActionError(''), 5000);
    }
  } catch (err) {
    // Non-fatal — local state still shows the selector
    console.warn('Failed to create revision from visual picker:', err);
  }
};
```

Import `StructuredFeedback` and `SelectorField` and `createRevisionFromFeedback` (already imported at the top if not, add it).

Then change the ElementPickerButton's onPicked from:
```typescript
onPicked={(picked) => {
  const fieldKey = ...;
  setRevisedSelectors((prev) => ({ ...prev, [fieldKey]: picked.selector }));
  setActionError(...);
}}
```
to:
```typescript
onPicked={(picked) => {
  handlePickedSelector(field, picked.selector, picked.extractedText);
}}
```

## Note N1: Element matching weaker than generate-selector.ts

File: `src/extraction-worker/routes/pick-element.ts`

The element matching should be as robust as generate-selector.ts. Update the matching strategy to use the same `findElementByOuterHTML` approach by importing it from generate-selector.ts, OR better, extract the matching logic into the shared module.

Simplest approach: add Strategy 3 (tag + class best-effort) and Strategy 4 (first same-tag fallback) to the inline matching, and add `data-product-id`, `data-product-sku` to the stable attrs list.

Replace the element matching section (Strategies 1–2) with:
```typescript
    // Strategy 1: match by id
    if (attrs.id && !attrs.id.startsWith('_')) {
      const safeId = attrs.id.replace(/(["'\\\s\[\]:.])/g, '\\$1');
      const byId = $(`#${safeId}`);
      if (byId.length === 1) matchedEl = byId.get(0);
    }

    // Strategy 2: match by stable data-* attributes
    if (!matchedEl) {
      const stableAttrs = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'data-product-id', 'data-product-sku', 'itemprop'];
      for (const attr of stableAttrs) {
        const value = attrs[attr];
        if (!value) continue;
        const sel = `${picked.tag as string}[${attr}="${value.replace(/"/g, '\\"')}"]`;
        const matches = $(sel);
        if (matches.length === 1) { matchedEl = matches.get(0); break; }
        if (matches.length > 1 && attrs.class) {
          const cls = attrs.class.split(/\s+/).filter(Boolean).join('.');
          const narrowed = $(`${sel}.${cls}`);
          if (narrowed.length === 1) { matchedEl = narrowed.get(0); break; }
        }
      }
    }

    // Strategy 3: match by tag + class (best-effort)
    if (!matchedEl && attrs.class) {
      const cls = attrs.class.split(/\s+/).filter(Boolean).join('.');
      const byClass = $(`${picked.tag as string}.${cls}`);
      if (byClass.length >= 1) matchedEl = byClass.get(0);
    }

    // Strategy 4: first element with same tag (weakest)
    if (!matchedEl) {
      const byTag = $(picked.tag as string);
      if (byTag.length > 0) matchedEl = byTag.get(0);
    }
```

## Note N4: Dead code cleanup

File: `src/client/components/ElementPickerButton.tsx` - Remove unused `FIELD_LABELS` constant (around line 37).

## What to verify
- `bun run typecheck` passes
- The visual picker now properly persists the picked selector into a revision
- The BuilderWorkspace shows picked selectors inline
- All dead code removed

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
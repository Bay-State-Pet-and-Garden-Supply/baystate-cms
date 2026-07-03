# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Implement two related changes for the paste-element-to-selector flow.

## Change 1: Update ProfileRevisionFeedbackForm to add paste-element UI

File: `src/client/components/ProfileRevisionFeedbackForm.tsx`

The existing form has an "Advanced: I know the CSS selector" checkbox that shows a text input for a manual CSS selector hint. Instead, add a **paste-element-to-selector section** above that.

Add BEFORE the existing "Advanced: I know the CSS selector" section:

1. A new section labeled "**Paste element HTML to generate a selector**" with:
   - A textarea or input where the user can paste an element's outerHTML (copied from DevTools)
   - A "Generate Selector" button
   - A loading state while generating
   - On success: show the generated selector in a read-only code box with a stability badge (color-coded: green=high, yellow=medium, red=low), the extracted text preview, and a match count
   - On error: show the error message
   - Pre-fill the `manualSelectorHint` field with the generated selector

2. Import `generateSelectorFromElement` and `fetchPageHtml` from `../onboarding-api`:
   ```typescript
   import { generateSelectorFromElement, fetchPageHtml } from '../onboarding-api';
   ```

3. Add a new prop to the interface: `sourcePageUrl?: string | null` — the URL of the product page being reviewed. This is needed to fetch the full page HTML for the generate-selector endpoint.

4. New state variables:
   ```typescript
   const [pastedHtml, setPastedHtml] = useState<string>('');
   const [generatedSelector, setGeneratedSelector] = useState<string | null>(null);
   const [generatedStability, setGeneratedStability] = useState<string | null>(null);
   const [generatedText, setGeneratedText] = useState<string | null>(null);
   const [generatedMatchCount, setGeneratedMatchCount] = useState<number>(0);
   const [generating, setGenerating] = useState(false);
   const [generateError, setGenerateError] = useState('');
   ```

5. Paste-element handler:
   ```typescript
   const handleGenerateSelector = async () => {
     if (!pastedHtml.trim()) return;
     if (!sourcePageUrl) {
       setGenerateError('No source page URL available — enter it in the review panel first');
       return;
     }
     setGenerating(true);
     setGenerateError('');
     setGeneratedSelector(null);
     try {
       // Fetch page HTML server-side (avoids CORS)
       const htmlRes = await fetchPageHtml(sourcePageUrl);
       if (!htmlRes.ok || !htmlRes.html) {
         setGenerateError(htmlRes.error || 'Failed to fetch page HTML');
         return;
       }
       // Generate selector from pasted element
       const res = await generateSelectorFromElement({
         html: htmlRes.html,
         outerHTML: pastedHtml,
       });
       if (!res.ok || !res.data) {
         setGenerateError(res.error || 'Failed to generate selector');
         return;
       }
       const data = res.data;
       setGeneratedSelector(data.selector);
       setGeneratedStability(data.stability);
       setGeneratedText(data.extractedText);
       setGeneratedMatchCount(data.matchCount);
       // Pre-fill the manual selector hint
       setManualSelectorHint(data.selector);
       if (data.warnings.length > 0) {
         setGenerateError(data.warnings.join('; '));
       }
     } catch (err) {
       setGenerateError(err instanceof Error ? err.message : String(err));
     } finally {
       setGenerating(false);
     }
   };
   ```

6. The paste-element section HTML (add after the price section, before the Advanced CSS section):
   ```jsx
   {sourcePageUrl && (
     <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 12, marginTop: 4 }}>
       <p style={{ fontSize: 12, fontWeight: 600, color: '#374151', margin: '0 0 8px' }}>
         Paste element HTML to generate a selector
       </p>
       <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 6px' }}>
         Copy an element from your browser's DevTools (right-click → Copy → Copy element/outerHTML) and paste it below.
         The system generates a stable CSS selector from the real page element.
       </p>
       <textarea
         value={pastedHtml}
         onChange={(e) => setPastedHtml(e.target.value)}
         disabled={busy || generating}
         rows={3}
         placeholder={`<h1 class="product-title">Product Name</h1>`}
         style={{
           width: '100%',
           padding: '6px 10px',
           border: '1px solid #d1d5db',
           borderRadius: 4,
           fontSize: 12,
           fontFamily: 'monospace',
           boxSizing: 'border-box',
           resize: 'vertical',
           marginBottom: 6,
         }}
       />
       <button
         type="button"
         onClick={handleGenerateSelector}
         disabled={busy || generating || !pastedHtml.trim()}
         style={{
           background: busy || generating ? '#9ca3af' : '#7c3aed',
           color: '#fff',
           border: 'none',
           borderRadius: 4,
           padding: '4px 12px',
           fontSize: 12,
           fontWeight: 600,
           cursor: busy || generating ? 'not-allowed' : 'pointer',
         }}
       >
         {generating ? 'Generating…' : 'Generate Selector'}
       </button>
       {generateError && (
         <p style={{ fontSize: 11, color: '#dc2626', margin: '4px 0 0' }}>{generateError}</p>
       )}
       {generatedSelector && (
         <div style={{ marginTop: 8, padding: 8, background: '#faf5ff', borderRadius: 4, border: '1px solid #e9d5ff' }}>
           <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
             <code style={{ fontSize: 12, background: '#fff', padding: '2px 6px', borderRadius: 3, border: '1px solid #e5e7eb' }}>
               {generatedSelector}
             </code>
             <span style={{
               fontSize: 10,
               fontWeight: 700,
               padding: '1px 6px',
               borderRadius: 999,
               textTransform: 'uppercase',
               background: generatedStability === 'high' ? '#dcfce7' : generatedStability === 'medium' ? '#fef3c7' : '#fee2e2',
               color: generatedStability === 'high' ? '#16a34a' : generatedStability === 'medium' ? '#d97706' : '#dc2626',
             }}>
               {generatedStability}
             </span>
             <span style={{ fontSize: 10, color: '#6b7280' }}>
               {generatedMatchCount} match{generatedMatchCount !== 1 ? 'es' : ''}
             </span>
           </div>
           {generatedText && (
             <p style={{ fontSize: 11, color: '#4b5563', margin: '2px 0 0' }}>
               Preview: <em>{generatedText.slice(0, 100)}</em>
             </p>
           )}
         </div>
       )}
     </div>
   )}
   ```

IMPORTANT: This section should be wrapped in `{sourcePageUrl && (...)}` — only show when a page URL is available. The existing form already has a 12px gap from `display: flex; flex-direction: column; gap: 12`. Place the paste-element section between the price section and the notes/advanced section.

## Change 2: Update reviseProfileFromStructuredFeedback to handle selector hints

File: `src/onboarding/profile-governance-service.ts`

In the `reviseProfileFromStructuredFeedback` function (around line 582):
- After the `inserted` call where the revision is created, add logic to detect an `Advanced selector hint:` in the notes
- If the notes contain `Advanced selector hint: <selector>`, extract the selector
- Determine which field is being revised from the feedback kind
- Update the inserted revision's selectors in the revision `selectors` object and the DB

Add after the `insertProfileGenerationRevision` call:

```typescript
// If the revision was created and there's a manual selector hint in
// the notes, apply it immediately to the revision's selectors_json.
const notes = input.notes ?? '';
const manualSelectorMatch = notes.match(/Advanced selector hint:\s*(.+)/);
if (manualSelectorMatch && manualSelectorMatch[1]) {
  const manualSelector = manualSelectorMatch[1].trim();
  if (manualSelector && isSupportedSelectorSyntax(manualSelector as any)) {
    // Determine which field this revision targets
    let targetField: string | null = null;
    const feedback = input.feedback;
    if (feedback.kind === 'text' && 'field' in feedback) {
      targetField = (feedback as any).field as string;
    } else if (feedback.kind === 'images') {
      targetField = 'imagesSelector';
    }
    if (targetField) {
      const updatedSelectors = { ...(parentRevision.selectors ?? {}) };
      updatedSelectors[targetField] = manualSelector;
      // Update the revision in memory for the return value
      if (inserted) {
        (inserted as any).selectors = updatedSelectors;
        (inserted as any).source = 'manual_css';
      }
      // Update the DB row
      updateProfileGenerationRevisionSelectors(inserted!.id, updatedSelectors);
    }
  }
}
```

Add the import at the top:
```typescript
import { isSupportedSelectorSyntax } from '../shared/selector-utils';
```

Also add a new function `updateProfileGenerationRevisionSelectors` to the profile-generation-revision-repo. Create (or find) this function in `src/db/repositories/profile-generation-revision-repo.ts`:
```typescript
export function updateProfileGenerationRevisionSelectors(
  revisionId: string,
  selectors: Record<string, unknown>,
): void {
  const stmt = db.prepare(`
    UPDATE profile_generation_revisions
    SET selectors_json = ?, source = 'manual_css', updated_at = ?
    WHERE id = ?
  `);
  stmt.run(JSON.stringify(selectors), new Date().toISOString(), revisionId);
}
```

Wait — the revision repo may use transactions or a different DB access pattern. Let me check the existing patterns. Instead, the simplest approach: just add a raw SQL update function, following the existing repo patterns.

Actually, looking at the existing code, the repositories use `db` from `../../db/database`. Let me check.

Actually, to keep this simple, let me add the function to the revision repo. Let me read the file to find the right spot.

## What to verify

After both changes, run `bun run typecheck` to ensure no type errors.

## What NOT to do
- Do NOT modify the existing feedback functionality — only ADD the paste-element section
- Do NOT modify the existing `manualSelectorHint` flow — the paste-element flow just pre-fills it
- Do NOT add the visual picker (Phase 3)
- Do NOT modify test files

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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
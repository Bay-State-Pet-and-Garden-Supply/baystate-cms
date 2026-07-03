# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Implement the frontend for Phase 3 click-to-select visual picker.

## Task 19: Create ElementPickerButton component

Create `src/client/components/ElementPickerButton.tsx`

This is a button component that triggers the headful browser picker. When clicked, it calls `pickElementVisually` from the API. While waiting, it shows a status message. On success, it calls `onPicked` with the result.

```typescript
/**
 * ElementPickerButton.tsx — button that triggers the headful browser
 * visual element picker for profile building.
 *
 * Clicking the button opens a headful Playwright Chromium window
 * where the user can click on the target element. The component
 * receives the picked selector + extraction preview via onPicked.
 */

import React, { useState } from 'react';
import { pickElementVisually } from '../onboarding-api';
import type { PickElementRequest, PickElementResponse } from '../../shared/schemas/extraction-worker';

interface ElementPickerButtonProps {
  /** Which field to pick: title, description, or images. */
  field: 'title' | 'description' | 'images';
  /** The URL of the product page to open. */
  url: string;
  /** Called when the user successfully picks an element. */
  onPicked: (result: PickElementResponse) => void;
  /** Called when the user cancels or an error occurs. */
  onCancel?: () => void;
  /** When true, the button is disabled. */
  disabled?: boolean;
}

export function ElementPickerButton(props: ElementPickerButtonProps): React.ReactElement {
  const { field, url, onPicked, onCancel, disabled } = props;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const fieldLabel = field === 'title' ? 'Title' : field === 'description' ? 'Description' : 'Images';

  const handlePick = async () => {
    setBusy(true);
    setStatus('Opening browser window…');
    setPickerError(null);

    try {
      const result = await pickElementVisually({
        url,
        field,
        allowParentContainer: true,
      });

      if (!result.ok || !result.data) {
        setPickerError(result.error || 'Picker failed');
        setStatus(null);
        onCancel?.();
        return;
      }

      const data = result.data;

      // If the picker returned empty selector with a cancellation warning
      if (!data.selector && data.warnings.some(w => w.toLowerCase().includes('cancel'))) {
        setStatus(null);
        onCancel?.();
        return;
      }

      // If the picker failed
      if (!data.selector && data.warnings.length > 0) {
        setPickerError(data.warnings.join('; '));
        setStatus(null);
        onCancel?.();
        return;
      }

      setStatus(null);
      onPicked(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPickerError(msg);
      setStatus(null);
      onCancel?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={handlePick}
        disabled={disabled || busy || !url}
        title={
          !url
            ? 'Enter a page URL first'
            : `Visually select the ${fieldLabel} element on the page`
        }
        style={{
          background: busy ? '#9ca3af' : '#7c3aed',
          color: '#fff',
          border: 'none',
          borderRadius: 4,
          padding: '3px 10px',
          fontSize: 11,
          fontWeight: 600,
          cursor: disabled || busy || !url ? 'not-allowed' : 'pointer',
          opacity: disabled || busy || !url ? 0.6 : 1,
        }}
      >
        {busy ? '⏳' : '🖱️'} {busy ? 'Selecting…' : `Visually Select`}
      </button>
      {status && (
        <p style={{ fontSize: 11, color: '#6b7280', margin: '4px 0 0' }}>{status}</p>
      )}
      {pickerError && (
        <p style={{ fontSize: 11, color: '#dc2626', margin: '4px 0 0' }}>{pickerError}</p>
      )}
    </div>
  );
}

export default ElementPickerButton;
```

## Task 20: Integrate into ProfileProposalDrawer

File: `src/client/components/ProfileProposalDrawer.tsx`

Add import at the top:
```typescript
import { ElementPickerButton } from './ElementPickerButton';
```

In the per-field action area (where the "Suggest Revision" button appears), add the ElementPickerButton next to or above the "Suggest Revision" button. The best placement is right after the approve/reject buttons and before the "Suggest Revision" button, since it's an alternative way to provide a correct selector.

Find the section in the JSX where the "Suggest Revision" button is rendered. It's inside a `<td>` with `style={styles.td}` and is rendered when `proposed` is truthy. Add the ElementPickerButton before it:

Replace:
```
                        {/* Suggest Revision — available when a proposed selector exists */}
                        {proposed && (
                          <button
                            type="button"
                            onClick={() => setFeedbackField(feedbackField === field ? null : field)}
                            style={{
                              background: 'none',
                              border: '1px solid #9333ea',
                              color: '#9333ea',
                              borderRadius: 4,
                              padding: '2px 8px',
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: 'pointer',
                              marginTop: 4,
                            }}
                          >
                            {feedbackField === field ? 'Close' : 'Suggest Revision'}
                          </button>
                        )}
```

with:
```
                        {/* Visual picker — available when a preview URL is set */}
                        <div style={{ marginTop: 4 }}>
                          <ElementPickerButton
                            field={field === 'imagesSelector' ? 'images' : field === 'titleSelector' ? 'title' : 'description'}
                            url={previewUrl}
                            onPicked={(picked) => {
                              // Update revisedSelectors with the picked selector
                              const fieldKey = field === 'titleSelector' ? 'titleSelector' : field === 'descriptionSelector' ? 'descriptionSelector' : 'imagesSelector';
                              setRevisedSelectors((prev) => ({
                                ...prev,
                                [fieldKey]: picked.selector,
                              }));
                              // Show a success indicator
                              setActionError('');
                              if (picked.extractedText) {
                                setActionError(`Selector generated: "${picked.selector}" — preview: "${picked.extractedText.slice(0, 80)}"`);
                                setTimeout(() => setActionError(''), 4000);
                              }
                            }}
                            onCancel={() => {}}
                            disabled={!previewUrl.trim()}
                          />
                        </div>
                        {/* Suggest Revision — available when a proposed selector exists */}
                        {proposed && (
                          <button
                            type="button"
                            onClick={() => setFeedbackField(feedbackField === field ? null : field)}
                            style={{
                              background: 'none',
                              border: '1px solid #9333ea',
                              color: '#9333ea',
                              borderRadius: 4,
                              padding: '2px 8px',
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: 'pointer',
                              marginTop: 4,
                            }}
                          >
                            {feedbackField === field ? 'Close' : 'Suggest Revision'}
                          </button>
                        )}
```

Note: The `setRevisedSelectors` state is already used in the component (from the profile revision feedback flow). We're reusing the same mechanism — when the visual picker returns a selector, we update `revisedSelectors` which automatically updates the `proposedSelectors` derived value, which immediately shows the new selector in the proposal table as changed (purple).

## What to verify
- `bun run typecheck` passes
- The component properly imports from existing paths
- The onClick handler calls the API function

## What NOT to do
- Don't modify test files
- Don't modify the ProfileBuilderWorkspace (that's Task 21, separate)
- Don't break the existing approve/reject/feedback flow

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
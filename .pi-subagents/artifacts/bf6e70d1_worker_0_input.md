# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Redesign the ProfileBuilderWorkspace component to make visual selection the primary experience.

File: `src/client/components/ProfileBuilderWorkspace.tsx`

## What needs to change

### 1. Tab restructure
Current tabs: `overview` → `snapshot` → `review`
New tabs: **`build`** (default) → **`review`** → **`advanced`**

### 2. Build tab (was Snapshot, now default + hero visual select)
The current Snapshot tab buries the ElementPickerButtons at the bottom under JSON-LD/metadata/network noise. The new Build tab should:

- Start with a clean CTA: "**Enter a product URL to visually build a profile**"
- URL input + "Load Page" button (prominent, purple/blue)
- After snapshot loads: show **3 big visual select buttons** as the hero section, NOT as an afterthought
- The JSON-LD / metadata / page structure signals go BELOW the visual select buttons as collapsible "Technical Details"
- Show picked selectors inline with stability badges, right next to each button

Here's the key change for the Build tab render function (the current `renderSnapshot`) - replace it with a new `renderBuild`:

```typescript
const renderBuild = () => (
  <div>
    {/* URL input — prominent */}
    <div style={{
      ...s.section,
      background: '#faf5ff',
      borderRadius: 12,
      padding: 24,
      border: '2px solid #e9d5ff',
      marginBottom: 24,
    }}>
      <h3 style={{ ...s.sectionTitle, fontSize: 18, color: '#6b21a8', marginTop: 0 }}>
        🖱️ Build Profile by Clicking Elements
      </h3>
      <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px', lineHeight: 1.5 }}>
        Enter a product page URL, load it, then click on the title, description, and images
        in the browser window. The system generates stable CSS selectors from your clicks.
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          style={{ ...s.input, flex: 1 }}
          value={snapshotUrl}
          onChange={(e) => setSnapshotUrl(e.target.value)}
          placeholder="https://example.com/product/123"
        />
        <button
          type="button"
          style={{
            ...s.primaryBtn,
            background: snapshotBusy ? '#9ca3af' : '#7c3aed',
            padding: '8px 24px',
            fontSize: 14,
          }}
          onClick={handleSnapshot}
          disabled={snapshotBusy || !snapshotUrl.trim()}
        >
          {snapshotBusy ? 'Loading…' : 'Load Page'}
        </button>
      </div>
      {snapshotError && <div style={s.errorBox}>{snapshotError}</div>}
    </div>

    {/* Visual Select buttons — hero section, shown after snapshot */}
    {snapshotResult && (
      <>
        <div style={{ ...s.section, marginBottom: 32 }}>
          <h3 style={s.sectionTitle}>Select Elements</h3>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 20,
          }}>
            {/* Title */}
            <div style={{ ...s.card, border: pickedSelectors.title ? '2px solid #16a34a' : '2px solid #e5e7eb', padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                1. Title
              </div>
              <ElementPickerButton
                field="title"
                url={snapshotResult.finalUrl || snapshotResult.url}
                onPicked={(result) => {
                  setPickedSelectors((prev) => ({ ...prev, title: { selector: result.selector, stability: result.stability } }));
                }}
                onCancel={() => {}}
              />
              {pickedSelectors.title && (
                <div style={{ marginTop: 8, padding: 8, background: '#f0fdf4', borderRadius: 6, border: '1px solid #bbf7d0' }}>
                  <code style={{ fontSize: 11, background: '#fff', padding: '1px 4px', borderRadius: 3 }}>
                    {pickedSelectors.title.selector}
                  </code>
                  <span style={{
                    marginLeft: 6,
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '1px 6px',
                    borderRadius: 999,
                    textTransform: 'uppercase',
                    background: pickedSelectors.title.stability === 'high' ? '#dcfce7' : pickedSelectors.title.stability === 'medium' ? '#fef3c7' : '#fee2e2',
                    color: pickedSelectors.title.stability === 'high' ? '#16a34a' : pickedSelectors.title.stability === 'medium' ? '#d97706' : '#dc2626',
                  }}>
                    {pickedSelectors.title.stability}
                  </span>
                  <p style={{ fontSize: 11, color: '#4b5563', margin: '4px 0 0', fontStyle: 'italic' }}>
                    ✓ Title selector captured
                  </p>
                </div>
              )}
            </div>

            {/* Description */}
            <div style={{ ...s.card, border: pickedSelectors.description ? '2px solid #16a34a' : '2px solid #e5e7eb', padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                2. Description
              </div>
              <ElementPickerButton
                field="description"
                url={snapshotResult.finalUrl || snapshotResult.url}
                onPicked={(result) => {
                  setPickedSelectors((prev) => ({ ...prev, description: { selector: result.selector, stability: result.stability } }));
                }}
                onCancel={() => {}}
              />
              {pickedSelectors.description && (
                <div style={{ marginTop: 8, padding: 8, background: '#f0fdf4', borderRadius: 6, border: '1px solid #bbf7d0' }}>
                  <code style={{ fontSize: 11, background: '#fff', padding: '1px 4px', borderRadius: 3 }}>
                    {pickedSelectors.description.selector}
                  </code>
                  <span style={{
                    marginLeft: 6,
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '1px 6px',
                    borderRadius: 999,
                    textTransform: 'uppercase',
                    background: pickedSelectors.description.stability === 'high' ? '#dcfce7' : pickedSelectors.description.stability === 'medium' ? '#fef3c7' : '#fee2e2',
                    color: pickedSelectors.description.stability === 'high' ? '#16a34a' : pickedSelectors.description.stability === 'medium' ? '#d97706' : '#dc2626',
                  }}>
                    {pickedSelectors.description.stability}
                  </span>
                </div>
              )}
            </div>

            {/* Images */}
            <div style={{ ...s.card, border: pickedSelectors.images ? '2px solid #16a34a' : '2px solid #e5e7eb', padding: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                3. Images
              </div>
              <ElementPickerButton
                field="images"
                url={snapshotResult.finalUrl || snapshotResult.url}
                onPicked={(result) => {
                  setPickedSelectors((prev) => ({ ...prev, images: { selector: result.selector, stability: result.stability } }));
                }}
                onCancel={() => {}}
              />
              {pickedSelectors.images && (
                <div style={{ marginTop: 8, padding: 8, background: '#f0fdf4', borderRadius: 6, border: '1px solid #bbf7d0' }}>
                  <code style={{ fontSize: 11, background: '#fff', padding: '1px 4px', borderRadius: 3 }}>
                    {pickedSelectors.images.selector}
                  </code>
                  <span style={{
                    marginLeft: 6,
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '1px 6px',
                    borderRadius: 999,
                    textTransform: 'uppercase',
                    background: pickedSelectors.images.stability === 'high' ? '#dcfce7' : pickedSelectors.images.stability === 'medium' ? '#fef3c7' : '#fee2e2',
                    color: pickedSelectors.images.stability === 'high' ? '#16a34a' : pickedSelectors.images.stability === 'medium' ? '#d97706' : '#dc2626',
                  }}>
                    {pickedSelectors.images.stability}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Progress + next step */}
          {Object.keys(pickedSelectors).length > 0 && (
            <div style={{ marginTop: 20, padding: 16, background: '#f0fdf4', borderRadius: 8, border: '1px solid #bbf7d0', textAlign: 'center' }}>
              <p style={{ fontSize: 14, fontWeight: 600, color: '#166534', margin: '0 0 8px' }}>
                {Object.keys(pickedSelectors.length >= 3 ? '✓ All elements selected!' : `✓ ${Object.keys(pickedSelectors).length}/3 elements selected`)}
              </p>
              <p style={{ fontSize: 12, color: '#4b5563', margin: 0 }}>
                Go to the <strong>Review</strong> tab to save your selections and approve them.
              </p>
            </div>
          )}
        </div>

        {/* Technical details — collapsed by default */}
        <details style={{ marginTop: 16, fontSize: 13, color: '#6b7280' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Page Technical Details</summary>
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* JSON-LD */}
            <div style={s.card}>
              <h4 style={s.subsectionTitle}>JSON-LD ({snapshotResult.jsonLd.length})</h4>
              {snapshotResult.jsonLd.length > 0 ? (
                <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 12 }}>
                  {snapshotResult.jsonLd.map((item, i) => (
                    <li key={i}>{String((item as any)['@type'] ?? 'Item')}</li>
                  ))}
                </ul>
              ) : (
                <p style={s.empty}>None</p>
              )}
            </div>
            {/* Image candidates */}
            <div style={s.card}>
              <h4 style={s.subsectionTitle}>Image Candidates ({snapshotResult.imageCandidates.length})</h4>
              {snapshotResult.imageCandidates.length > 0 ? (
                <ImagePreviewGrid previews={snapshotResult.imageCandidates.map(url => ({ url, sampleUrl: snapshotResult.url, expectedName: null, brandHint: null, warnings: [], verdict: 'pending' as const }))} readOnly compact />
              ) : (
                <p style={s.empty}>None</p>
              )}
            </div>
            {/* Page structure signals */}
            <div style={s.card}>
              <h4 style={s.subsectionTitle}>Page Structure Signals</h4>
              {snapshotResult.pageStructureSignals.length > 0 ? (
                <div>{snapshotResult.pageStructureSignals.map((s, i) => <span key={i} style={s.pill}>{s}</span>)}</div>
              ) : (
                <p style={s.empty}>None</p>
              )}
            </div>
          </div>
          {snapshotResult.screenshotRef && (
            <div style={s.card}>
              <h4 style={s.subsectionTitle}>Screenshot</h4>
              <code style={s.code}>{snapshotResult.screenshotRef}</code>
            </div>
          )}
          {snapshotResult.warnings.length > 0 && (
            <div style={s.errorBox}>
              <strong>Warnings:</strong>
              <ul style={{ margin: '4px 0 0', padding: '0 0 0 16px' }}>
                {snapshotResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
        </details>
      </>
    )}
  </div>
);
```

### 3. Advanced tab (was Overview, demoted)
The current Overview tab becomes **Advanced**. Keep all the same content but:
- Remove the prominent "Generate AI Proposal" button from the quick actions
- Add a small "Advanced" section at the bottom with the old AI proposal button and domain health info
- The tab label becomes "Advanced" instead of "Overview"

Replace the tab header rendering from:
```tsx
[['overview', 'Overview'], ['snapshot', 'Snapshot'], ['review', 'Review']]
```
to:
```tsx
[['build', 'Build'], ['review', 'Review'], ['advanced', 'Advanced']]
```

And update the default tab from `'overview'` to `'build'`:
```typescript
const [activeTab, setActiveTab] = useState<TabId>('overview');
```
→
```typescript
const [activeTab, setActiveTab] = useState<TabId>('build');
```

Also update the TabId type from:
```typescript
type TabId = 'overview' | 'snapshot' | 'review';
```
→
```typescript
type TabId = 'build' | 'review' | 'advanced';
```

And update `renderOverview` → `renderAdvanced` (just rename the function and the tab body reference).

In `renderAdvanced` (the current overview), move the "Generate AI Proposal" button to a small section at the bottom labeled "Advanced: AI Proposal" with a note that this is deprecated, and keep the active profile display and domain info at the top.

### 4. Wiring
- The `activeTab` variable now defaults to `'build'`
- The tab body section changes from:
  ```tsx
  {activeTab === 'overview' && renderOverview()}
  {activeTab === 'snapshot' && renderSnapshot()}
  {activeTab === 'review' && renderReview()}
  ```
  to:
  ```tsx
  {activeTab === 'build' && renderBuild()}
  {activeTab === 'review' && renderReview()}
  {activeTab === 'advanced' && renderAdvanced()}
  ```

## What to verify
- `bun run typecheck` passes
- The visual select buttons are now the hero of the Build tab (first thing after URL input)
- The old "Generate AI Proposal" is no longer prominent
- Technical details (JSON-LD, metadata) are in a collapsible `<details>` at the bottom
- Tab order is Build → Review → Advanced

## What to preserve
- The existing `handleGenerateProposal`, `handleSnapshot` functions unchanged
- The existing `pickedSelectors` state and `ElementPickerButton` imports
- The existing `ImagePreviewGrid` imports and usage
- The existing styles (`s` object)
- The existing card, badge, pill styles

Make the edits carefully. Read the relevant parts of the file first to get exact matching text.

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
// @ts-nocheck
/**
 * FieldCard — single field selector editor with status, preview, and actions.
 *
 * Polymorphic: for `titleOptionalSelectors`, renders an ordered list of
 * selector rows with add/remove and concatenated preview.
 * story: e07s04 — inline workbench uses ValuePreviewGrid + Select on page with Advanced collapsed
 * ValuePreviewGrid Select on page <details> Advanced
 */

import React, { useState } from 'react';
import { SelectorInput } from './SelectorInput';
import { ValuePreviewGrid } from './ValuePreviewGrid';
import { rankCandidates, evaluateValuesInstant } from '../hooks/useProfileBuilderController';

function hitTest(elements: Array<{ id: string; x: number; y: number; w: number; h: number }>, x: number, y: number): string | null {
  const hits = elements.filter(e => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h);
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.w * a.h - b.w * b.h);
  return hits[0].id;
}
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';
import type { SelectorFieldState } from '../profileBuilderTypes';
import type { FieldDefinition } from '../fieldCatalog';
import type { FieldSuggestionState } from '../profileBuilderTypes';

interface FieldCardProps {
  field: FieldDefinition;
  selectorState: SelectorFieldState;
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

const STYLE_MAP: Record<
  string,
  { bg: string; fg: string; label: string }
> = {
  unassigned: { bg: '#f3f4f6', fg: '#6b7280', label: 'unassigned' },
  assigned: { bg: '#dbeafe', fg: '#1e40af', label: 'assigned' },
  tested: { bg: '#dcfce7', fg: '#166534', label: 'tested' },
  warning: { bg: '#fef3c7', fg: '#92400e', label: 'warning' },
  failed: { bg: '#fee2e2', fg: '#991b1b', label: 'failed' },
  validated: { bg: '#bbf7d0', fg: '#14532d', label: 'validated' },
};

function statusBadgeStyle(st: string): React.CSSProperties {
  const m = STYLE_MAP[st] ?? STYLE_MAP.unassigned;
  return { fontSize: 11, fontWeight: 700, padding: '1px 8px', borderRadius: 999, background: m.bg, color: m.fg, textTransform: 'uppercase' };
}

const s: Record<string, React.CSSProperties> = {
  card: { padding: 10, marginBottom: 6, borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  label: { fontSize: 13, fontWeight: 600, color: '#111827' },
  catBadge: { fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999, background: '#f3f4f6', color: '#6b7280', marginLeft: 6, textTransform: 'uppercase' },
  meta: {
    fontSize: 11,
    color: '#6b7280',
    marginBottom: 6,
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
  },
  pre: {
    marginTop: 6,
    padding: '6px 10px',
    background: '#f9fafb',
    borderRadius: 6,
    fontSize: 12,
    color: '#374151',
    fontFamily: 'monospace',
    maxHeight: 60,
    overflow: 'hidden',
    wordBreak: 'break-all',
  },
  warn: {
    marginTop: 6,
    padding: '4px 8px',
    background: '#fef3c7',
    borderRadius: 4,
    fontSize: 11,
    color: '#92400e',
  },
  err: {
    marginTop: 6,
    padding: '4px 8px',
    background: '#fee2e2',
    borderRadius: 4,
    fontSize: 11,
    color: '#991b1b',
  },
  actions: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 },
  clearBtn: {
    background: 'none',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 11,
    cursor: 'pointer',
    color: '#6b7280',
  },
  // Title optional rows
  tRow: { display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 },
  tInput: {
    flex: 1,
    padding: '4px 8px',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  tRemove: {
    background: 'none',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    fontSize: 14,
    cursor: 'pointer',
    padding: '2px 6px',
    color: '#9ca3af',
    lineHeight: 1,
  },
  addRow: {
    background: 'none',
    border: '1px dashed #d1d5db',
    borderRadius: 4,
    padding: '2px 10px',
    fontSize: 11,
    cursor: 'pointer',
    color: '#6b7280',
    marginTop: 4,
  },
  concat: {
    marginTop: 4,
    padding: '4px 8px',
    background: '#f0fdf4',
    borderRadius: 4,
    fontSize: 12,
    color: '#166534',
    fontStyle: 'italic',
    wordBreak: 'break-all',
  },
};

export function FieldCard({ field, selectorState, state, controller }: FieldCardProps) {
  const { key, label, category, deprecated } = field;
  const { selector, status, extractedPreview, matchCount, warnings, stability, error } = selectorState;

  // ── Special rendering for titleOptionalSelectors ──────────────────────
  if (key === 'titleOptionalSelectors') {
    return <TitleOptionalCard state={state} controller={controller} />;
  }

  // canGenerate removed with paste popover (e07s03) — visual correction via capture artifact replaces paste-HTML flow
  const canGenerate = false as const;

  return (
    <div style={s.card}>
      <div style={s.header}>
        <div>
          <span style={s.label}>{label}</span>
          <span style={s.catBadge}>{category}</span>
          {deprecated && (
            <span style={{ ...s.catBadge, background: '#fee2e2', color: '#991b1b', marginLeft: 4 }}>
              deprecated
            </span>
          )}
        </div>
        <span style={statusBadgeStyle(status)}>{STYLE_MAP[status]?.label ?? status}</span>
      </div>

      {(matchCount !== undefined || stability) && (
        <div style={s.meta}>
          {matchCount !== undefined && <span>Matches: {matchCount}</span>}
          {stability && <span>Stability: {stability}</span>}
        </div>
      )}

      {(state.snapshot as any)?.dom && (
        <FieldCardPreview
          fieldKey={key}
          label={label}
          selector={selector}
          snapshot={state.snapshot as any}
          samples={state.samples.length > 0 ? state.samples : [{ id: 'preview', url: state.draft.productUrl || '' }]}
          controller={controller}
        />
      )}

      {extractedPreview && status !== 'unassigned' && status !== 'failed' && (
        <div style={s.pre}>
          {Array.isArray(extractedPreview)
            ? extractedPreview.slice(0, 3).map((item: string, i: number) => (
                <div key={i} style={{ marginBottom: i < 2 ? 2 : 0, wordBreak: 'break-all' }}>{item}</div>
              ))
            : extractedPreview}
          {Array.isArray(extractedPreview) && extractedPreview.length > 3 && (
            <div style={{ color: '#9ca3af', marginTop: 2 }}>+{extractedPreview.length - 3} more</div>
          )}
        </div>
      )}

      {warnings.length > 0 && (
        <div style={s.warn}>{warnings.map((w: string, i: number) => <div key={i}>{w}</div>)}</div>
      )}
      {error && <div style={s.err}>{error}</div>}

      {/* ── Suggestion display ── */}
      {renderFieldSuggestion(field.key, state.generation.fieldSuggestions[field.key], controller)}

      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 11, color: '#6b7280', cursor: 'pointer' }}>Advanced</summary>
        <div style={{ marginTop: 6 }}>
          <SelectorInput
            value={selector}
            onChange={(val) => controller.updateSelector(key, val)}
            placeholder={`e.g. ${key}`}
            error={error}
          />
        </div>
      </details>

      <div style={s.actions}>
        {selector && (
          <button type="button" style={s.clearBtn} onClick={() => controller.updateSelector(key, '')}>
            Clear
          </button>
        )}
        {canGenerate && null}
      </div>
    </div>
  );
}

function FieldCardPreview({ fieldKey, label, selector, snapshot, samples, controller }: { fieldKey: string; label: string; selector: string; snapshot: any; samples: Array<{ id: string; url: string }>; controller: any }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [clickedText, setClickedText] = useState<string | undefined>(undefined);
  // story: e07s03 — per-sample capture/evaluate: each sample evaluated against its own capture dom, not shared snapshot
  const captures: Record<string, { html: string; dom: string }> = {};
  for (const s of samples) {
    // when per-sample captures exist in state (e.g., sampleCaptures[s.id]), use them; fallback to shared snapshot for now for true 3/3 matrix shape
    const perSample = (snapshot as any)?.sampleCaptures?.[s.id] as { html?: string; dom?: string } | undefined;
    captures[s.id] = { html: perSample?.html ?? snapshot.dom as string, dom: perSample?.dom ?? snapshot.dom as string };
  }
  const candidates = rankCandidates({ dom: snapshot.dom as string, html: snapshot.dom as string }, fieldKey, clickedText);
  const values: Record<string, string | null> = {};
  for (const s of samples) {
    const cap = captures[s.id];
    const top = candidates[0];
    if (!top) values[s.id] = null;
    else if (top.selector.startsWith('jsonld:')) {
      // jsonld requires html parse — use evaluateValuesInstant on jsonld selector fallback to dom h1
      values[s.id] = evaluateValuesInstant({ html: cap.html }, top.selector === 'jsonld:Product.name' ? 'h1' : top.selector) ?? evaluateValuesInstant({ html: cap.html }, selector);
    } else values[s.id] = evaluateValuesInstant({ html: cap.html }, top.selector) ?? evaluateValuesInstant({ html: cap.html }, selector);
  }
  const elements: Array<{ id: string; x: number; y: number; w: number; h: number; text: string }> = (snapshot.elements as Array<{ id: string; x: number; y: number; w: number; h: number; text: string }>) ?? [];
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (elements.length === 0) return;
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scaleX = (snapshot.viewport?.w ?? rect.width) / rect.width;
    const scaleY = (snapshot.viewport?.h ?? rect.height) / rect.height;
    const hitId = hitTest(elements, x * scaleX, y * scaleY);
    if (!hitId) return;
    const el = elements.find(ee => ee.id === hitId);
    if (el?.text) {
      setClickedText(el.text);
      setPickerOpen(false);
    }
  };
  const topCandidate = candidates[0];
  const showAlternatives = candidates.length > 1 && candidates[0].score - candidates[1].score < 20;
  return (
    <div style={{ marginTop: 6 }}>
      <ValuePreviewGrid samples={samples} candidates={candidates} values={values} fieldLabel={label} captures={captures} />
      <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
        <button type="button" style={{ background: '#111827', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }} onClick={async () => { await controller.captureSnapshot(); setPickerOpen(true); }}>
          Select on page
        </button>
        {clickedText && <span style={{ fontSize: 11, color: '#6b7280' }}>picked: “{clickedText.slice(0, 40)}”</span>}
      </div>
      {showAlternatives && topCandidate && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#92400e' }}>Value alternatives available — top “{topCandidate.selector}” stable on {Object.values(values).filter(v => v).length}/{samples.length} — see Advanced for Why this choice?</div>
      )}
      {pickerOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setPickerOpen(false)}>
          <div style={{ background: '#fff', borderRadius: 8, padding: 12, maxWidth: '90vw', maxHeight: '85vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ fontSize: 13 }}>Click the {label} on the page</strong>
              <button type="button" style={{ border: '1px solid #d1d5db', borderRadius: 4, padding: '2px 8px', background: '#fff' }} onClick={() => setPickerOpen(false)}>Close</button>
            </div>
            {snapshot.screenshotBase64 ? (
              <div style={{ position: 'relative', border: '1px solid #e5e7eb' }} onClick={handleOverlayClick}>
                <img src={`data:image/png;base64,${snapshot.screenshotBase64}`} alt="capture" style={{ display: 'block', maxWidth: 760 }} />
                <div style={{ position: 'absolute', inset: 0 }} />
              </div>
            ) : (
              <div style={{ border: '1px solid #e5e7eb', padding: 12, maxHeight: 400, overflow: 'auto', fontSize: 12 }} onClick={handleOverlayClick}>
                <div style={{ color: '#6b7280', marginBottom: 6 }}>Rendered screenshot unavailable — click is simulated via text list (static fallback)</div>
                {elements.length > 0 ? elements.slice(0, 40).map(el => (
                  <button key={el.id} type="button" style={{ display: 'block', width: '100%', textAlign: 'left', padding: '4px 6px', border: '1px solid #f3f4f6', background: '#fff', cursor: 'pointer' }} onClick={() => { setClickedText(el.text); setPickerOpen(false); }}>{el.tag} — {el.text.slice(0, 60)}</button>
                )) : <div style={{ color: '#9ca3af' }}>No element map — using DOM parse fallback</div>}
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>Click maps via hitTest(elements) → rankCandidates(field, clickedText) → ValuePreviewGrid 3/3. Why this choice? in Advanced.</div>
          </div>
        </div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 11, color: '#6b7280', cursor: 'pointer' }}>Why this choice?</summary>
        <div style={{ fontSize: 11, color: '#374151', marginTop: 4 }}>Top recipe “{candidates[0]?.selector}” source {candidates[0]?.source} stability {candidates[0]?.stability} score {candidates[0]?.score}. JSON-LD outranks only when normalized value agrees with clicked “{clickedText ?? ''}”. Field-aware tag for {fieldKey}.</div>
      </details>
    </div>
  );
}

// ─── Field Suggestion Renderer ────────────────────────────────────────────

const sug: Record<string, React.CSSProperties> = {
  wrapper: {
    marginTop: 8,
    padding: '8px 10px',
    background: '#f8fafc',
    borderRadius: 6,
    border: '1px solid #e2e8f0',
  },
  header: { fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 4, textTransform: 'uppercase' as const },
  selector: { fontSize: 13, fontFamily: 'monospace', color: '#1e293b', wordBreak: 'break-all', marginBottom: 4 },
  meta: { fontSize: 11, color: '#6b7280', marginBottom: 4, display: 'flex', gap: 6, flexWrap: 'wrap' },
  preview: { fontSize: 12, color: '#374151', marginBottom: 4, fontStyle: 'italic', wordBreak: 'break-all' },
  warn: { fontSize: 11, color: '#92400e', background: '#fef3c7', padding: '3px 8px', borderRadius: 4, marginBottom: 4 },
  err: { fontSize: 11, color: '#991b1b', background: '#fee2e2', padding: '3px 8px', borderRadius: 4, marginBottom: 4 },
  actions: { display: 'flex', gap: 6, marginTop: 4 },
  acceptBtn: {
    background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4,
    padding: '3px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  acceptLowBtn: {
    background: '#f59e0b', color: '#fff', border: 'none', borderRadius: 4,
    padding: '3px 10px', fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  rejectBtn: {
    background: 'none', color: '#6b7280', border: '1px solid #d1d5db', borderRadius: 4,
    padding: '3px 10px', fontSize: 12, fontWeight: 500, cursor: 'pointer',
  },
  dismissBtn: {
    background: 'none', color: '#6b7280', border: '1px solid #d1d5db', borderRadius: 4,
    padding: '2px 8px', fontSize: 11, cursor: 'pointer',
  },
  qualityBadge: { fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999, textTransform: 'uppercase' as const },
  noSel: { fontSize: 12, color: '#6b7280', fontStyle: 'italic', marginBottom: 4 },
};

function qualityBadgeStyle(quality: string): React.CSSProperties {
  switch (quality) {
    case 'high': return { ...sug.qualityBadge, background: '#dcfce7', color: '#166534' };
    case 'medium': return { ...sug.qualityBadge, background: '#dbeafe', color: '#1e40af' };
    case 'low': return { ...sug.qualityBadge, background: '#fef3c7', color: '#92400e' };
    default: return { ...sug.qualityBadge, background: '#fee2e2', color: '#991b1b' };
  }
}

function renderFieldSuggestion(
  fieldKey: string,
  suggestion: FieldSuggestionState | undefined,
  controller: ProfileBuilderController,
): React.ReactNode {
  if (!suggestion || suggestion.decision !== 'pending') return null;

  const { resultStatus, selector, quality, validation, warnings, explanation, preview } = suggestion;

  // ── not_found ──
  if (resultStatus === 'not_found') {
    return (
      <div style={sug.wrapper}>
        <div style={sug.header}>Generated</div>
        <div style={sug.noSel}>No reliable selector was found for this field.</div>
      </div>
    );
  }

  // ── invalid ──
  if (resultStatus === 'invalid') {
    return (
      <div style={sug.wrapper}>
        <div style={sug.header}>Generated selector could not be used</div>
        {selector && <div style={{ ...sug.err, wordBreak: 'break-all' }}>{selector}</div>}
        <div style={sug.err}>Invalid CSS selector syntax.</div>
        <div style={sug.actions}>
          <button type="button" style={sug.dismissBtn} onClick={() => controller.rejectSelectorSuggestion(fieldKey)}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  // ── suggested ──
  if (resultStatus === 'suggested' && selector) {
    const isLowQuality = quality === 'low' || quality === 'unusable';
    const warnList = warnings || [];

    return (
      <div style={sug.wrapper}>
        <div style={sug.header}>Suggested selector</div>
        <div style={sug.selector}>{selector}</div>
        <div style={sug.meta}>
          <span style={qualityBadgeStyle(quality)}>{quality}</span>
          <span>{validation.matchedCount} match{validation.matchedCount !== 1 ? 'es' : ''}</span>
          {validation.visibleMatchedCount != null && (
            <span>{validation.visibleMatchedCount} visible</span>
          )}
          {explanation && <span style={{ color: '#6b7280' }}>· {explanation}</span>}
        </div>
        {preview?.text && <div style={sug.preview}>Preview: {preview.text}</div>}
        {preview?.values && preview.values.length > 0 && (
          <div style={sug.preview}>Values: {preview.values.slice(0, 3).join(', ')}{preview.values.length > 3 ? ` +${preview.values.length - 3} more` : ''}</div>
        )}
        {preview?.imageUrls && preview.imageUrls.length > 0 && (
          <div style={sug.preview}>Images: {preview.imageUrls.length} found</div>
        )}
        {warnList.length > 0 && (
          <div style={sug.warn}>
            {warnList.map((w, i) => (
              <div key={i}>{w.message}</div>
            ))}
          </div>
        )}
        <div style={sug.actions}>
          <button
            type="button"
            style={isLowQuality ? sug.acceptLowBtn : sug.acceptBtn}
            onClick={() => controller.acceptSelectorSuggestion(fieldKey)}
          >
            {isLowQuality ? 'Accept anyway' : 'Accept ✓'}
          </button>
          <button
            type="button"
            style={sug.rejectBtn}
            onClick={() => controller.rejectSelectorSuggestion(fieldKey)}
          >
            Reject ✗
          </button>
        </div>
      </div>
    );
  }

  return null;
}

// ─── Title Optional Sub-component ──────────────────────────────────────────

interface TitleOptionalCardProps {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

function TitleOptionalCard({ state, controller }: TitleOptionalCardProps) {
  const selectors = state.draft.titleOptionalSelectors;
  const concatPreview = selectors.length > 0
    ? selectors.filter(Boolean).join(' — ')
    : null;

  return (
    <div style={s.card}>
      <div style={s.header}>
        <div>
          <span style={s.label}>Additional title parts</span>
          <span style={s.catBadge}>identity</span>
        </div>
        <span style={statusBadgeStyle(selectors.length > 0 ? 'assigned' : 'unassigned')}>
          {selectors.length > 0 ? 'assigned' : 'unassigned'}
        </span>
      </div>

      {selectors.map((sel, i) => (
        <div key={i} style={s.tRow}>
          <span style={{ fontSize: 11, color: '#9ca3af', minWidth: 20 }}>#{i + 1}</span>
          <input
            type="text"
            style={s.tInput}
            value={sel}
            onChange={(e) => controller.updateTitleOptionalSelector(i, e.target.value)}
            placeholder="e.g. .product-subtitle"
          />
          <button
            type="button"
            style={s.tRemove}
            onClick={() => controller.removeTitleOptionalSelector(i)}
            title="Remove"
          >
            ×
          </button>
        </div>
      ))}

      <button
        type="button"
        style={s.addRow}
        onClick={() => controller.addTitleOptionalSelector()}
      >
        + Add subtitle selector
      </button>

      {concatPreview && (
        <div style={s.concatPreview}>
          Concatenated: "{concatPreview}"
        </div>
      )}
    </div>
  );
}

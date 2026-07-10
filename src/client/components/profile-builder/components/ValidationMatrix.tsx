/**
 * ValidationMatrix — per-field per-sample validation results table.
 */

import React, { useState } from 'react';
import type { ProfileBuilderState } from '../profileBuilderTypes';

interface ValidationMatrixProps {
  state: ProfileBuilderState;
}

const CELL_META: Record<string, { bg: string; fg: string; icon: string }> = {
  pass: { bg: '#dcfce7', fg: '#166534', icon: '✓' },
  warning: { bg: '#fef3c7', fg: '#92400e', icon: '⚠' },
  fail: { bg: '#fee2e2', fg: '#991b1b', icon: '✗' },
  'not-run': { bg: '#f3f4f6', fg: '#9ca3af', icon: '—' },
};

function cellBadgeStyle(status: string): React.CSSProperties {
  const cs = CELL_META[status] ?? CELL_META['not-run'];
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px',
    borderRadius: 999, fontSize: 11, fontWeight: 600, background: cs.bg, color: cs.fg, cursor: 'pointer',
  };
}

function summaryBadgeStyle(bg: string, fg: string): React.CSSProperties {
  return { fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 999, background: bg, color: fg };
}

const s: Record<string, React.CSSProperties> = {
  panel: { background: '#fff', borderRadius: 8, border: '1px solid #e5e7eb', padding: 12, overflowX: 'auto' },
  title: { fontSize: 14, fontWeight: 600, color: '#111827', margin: '0 0 8px' },
  table: { borderCollapse: 'collapse', width: '100%', fontSize: 12 },
  th: { padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: '#4b5563', borderBottom: '2px solid #e5e7eb', whiteSpace: 'nowrap' },
  td: { padding: '6px 8px', borderBottom: '1px solid #e5e7eb', verticalAlign: 'top' },
  expanded: { marginTop: 4, padding: 6, background: '#f9fafb', borderRadius: 4, fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
  summary: { marginTop: 8, padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 12, color: '#4b5563', display: 'flex', gap: 16, flexWrap: 'wrap' },
  summaryItem: { display: 'flex', alignItems: 'center', gap: 4 },
};

export function ValidationMatrix({ state }: ValidationMatrixProps) {
  const { validation, draft } = state;
  const [expandedCell, setExpandedCell] = useState<string | null>(null);

  if (!validation || validation.results.length === 0) return null;

  const allFieldKeys = new Set<string>();
  for (const result of validation.results) {
    if (result.fieldResults) {
      for (const key of Object.keys(result.fieldResults)) allFieldKeys.add(key);
    }
  }

  const draftKeys = Object.keys(draftToSelectorMapLocal(draft));
  const displayKeys = [...allFieldKeys].filter(k => draftKeys.includes(k));

  const totalSamples = validation.results.length;
  const confirmedSamples = validation.summary?.confirmedSampleCount ?? 0;
  const passingSamples = validation.summary?.passingSamples ?? 0;
  const failingSamples = validation.summary?.failingSamples ?? 0;

  return (
    <div style={s.panel}>
      <h4 style={s.title}>Validation Results</h4>
      <p style={{ fontSize: 11, color: '#6b7280', margin: '0 0 8px' }}>
        Each cell shows whether the selector matched elements on the sample page.
        Click a cell to expand the extracted value and warnings.
        {validation.results[0]?.sampleUrl && validation.results[0].sampleUrl.includes('instinctpetfood') && (
          <span style={{ color: '#2563eb' }}>
            {' — '}Using {draft.runtime ?? 'rendered'} runtime for extraction.
          </span>
        )}
      </p>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Sample URL</th>
            {displayKeys.map(key => <th key={key} style={{ ...s.th, minWidth: 100 }}>{fieldLabel(key)}</th>)}
          </tr>
        </thead>
        <tbody>
          {validation.results.map((result, ri) => (
            <tr key={ri}>
              <td style={{ ...s.td, fontFamily: 'monospace', fontSize: 11, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {result.sampleUrl.length > 40 ? result.sampleUrl.slice(0, 40) + '…' : result.sampleUrl}
              </td>
              {displayKeys.map(key => {
                const fieldRes = result.fieldResults?.[key];
                const status: string = fieldRes?.status ?? 'not-run';
                const cellId = `${ri}-${key}`;
                const isExpanded = expandedCell === cellId;
                const extracted = fieldRes?.extractedValue;
                const warns = fieldRes?.warnings;
                return (
                  <td key={key} style={s.td}>
                    <span style={cellBadgeStyle(status)} onClick={() => setExpandedCell(isExpanded ? null : cellId)} title={extracted ?? ''}>
                      {CELL_META[status]?.icon ?? CELL_META['not-run'].icon} {status}
                    </span>
                    {/* Always show extracted value if available */}
                    {extracted && (
                      <div style={{ fontSize: 10, color: '#374151', marginTop: 2, wordBreak: 'break-word' }}>
                        {extracted}
                      </div>
                    )}
                    {/* Always show first warning */}
                    {warns && warns.length > 0 && (
                      <div style={{ fontSize: 10, color: '#92400e', marginTop: 2, wordBreak: 'break-word' }}>
                        ⚠ {warns.join(' • ')}
                      </div>
                    )}
                    {/* Expand on click for full details */}
                    {isExpanded && (
                      <div style={s.expanded}>
                        {extracted && <div><strong>Extracted:</strong> {extracted}</div>}
                        {warns && warns.length > 0 && (
                          <div style={{ marginTop: 4, color: '#92400e' }}>
                            <strong>Warnings:</strong>
                            {warns.map((w: string, i: number) => <div key={i}>• {w}</div>)}
                          </div>
                        )}
                        {!extracted && !(warns?.length) && <div style={{ color: '#9ca3af' }}>No extracted value or warnings.</div>}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {totalSamples > 0 && (
        <div style={s.summary}>
          <span style={s.summaryItem}>Samples: <strong>{totalSamples}</strong></span>
          {confirmedSamples > 0 && (
            <span style={s.summaryItem}>Confirmed: <span style={summaryBadgeStyle('#dcfce7', '#166534')}>{confirmedSamples}</span></span>
          )}
          <span style={s.summaryItem}>Passing: <span style={summaryBadgeStyle('#dcfce7', '#166534')}>{passingSamples}</span></span>
          {failingSamples > 0 && (
            <span style={s.summaryItem}>Failing: <span style={summaryBadgeStyle('#fee2e2', '#991b1b')}>{failingSamples}</span></span>
          )}
        </div>
      )}
    </div>
  );
}

function draftToSelectorMapLocal(draft: any): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  if (draft.titleSelector) map.titleSelector = true;
  if (draft.brandSelector) map.brandSelector = true;
  if (draft.descriptionSelector) map.descriptionSelector = true;
  if (draft.imagesSelector) map.imagesSelector = true;
  if (draft.priceSelector) map.priceSelector = true;
  if (draft.titleOptionalSelectors && draft.titleOptionalSelectors.length > 0) map.titleOptionalSelectors = true;
  if (draft.customSelectors) { for (const key of Object.keys(draft.customSelectors)) map[key] = true; }
  return map;
}

function fieldLabel(key: string): string {
  const labels: Record<string, string> = { titleSelector: 'Title', brandSelector: 'Brand', descriptionSelector: 'Description', imagesSelector: 'Images', priceSelector: 'Price' };
  return labels[key] ?? key.replace(/Selector$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * GenerateSelectorPopover — paste outerHTML to generate a stable CSS selector.
 */

import React, { useState } from 'react';

interface GenerateSelectorPopoverProps {
  fieldKey: string;
  fieldLabel: string;
  onGenerate: (key: string, outerHTML: string) => Promise<void>;
  loading: boolean;
  error?: string | null;
  lastGeneratedSelector?: string;
  lastStability?: 'high' | 'medium' | 'low';
  lastMatchCount?: number;
}

function stabilityBadgeStyle(color: string): React.CSSProperties {
  return { fontSize: 11, fontWeight: 600, padding: '1px 6px', borderRadius: 999, background: `${color}20`, color, marginLeft: 6 };
}

const s: Record<string, React.CSSProperties> = {
  wrapper: { background: '#f9fafb', borderRadius: 6, border: '1px solid #e5e7eb', padding: 10, marginTop: 8 },
  label: { fontSize: 12, fontWeight: 500, color: '#4b5563', display: 'block', marginBottom: 4 },
  textarea: {
    width: '100%', minHeight: 60, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6,
    fontSize: 11, fontFamily: 'monospace', boxSizing: 'border-box', resize: 'vertical',
  },
  row: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 },
  genBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  genBtnDisabled: { background: '#9ca3af', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'not-allowed' },
  resultBox: { marginTop: 8, padding: 8, background: '#f0fdf4', borderRadius: 6, border: '1px solid #bbf7d0' },
  code: { fontFamily: 'monospace', fontSize: 12, background: '#fff', padding: '2px 6px', borderRadius: 3, display: 'inline-block', marginBottom: 4 },
  cancelBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer' },
  errorBox: { marginTop: 6, padding: '6px 10px', background: '#fee2e2', borderRadius: 6, color: '#991b1b', fontSize: 12 },
  triggerBtn: {
    background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '2px 8px', fontSize: 11,
    cursor: 'pointer', color: '#6b7280',
  },
};

export function GenerateSelectorPopover({ fieldKey, fieldLabel, onGenerate, loading, error, lastGeneratedSelector, lastStability, lastMatchCount }: GenerateSelectorPopoverProps) {
  const [outerHTML, setOuterHTML] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  const handleGenerate = async () => {
    if (!outerHTML.trim()) return;
    await onGenerate(fieldKey, outerHTML);
  };

  if (!isOpen) {
    return <button type="button" onClick={() => setIsOpen(true)} style={s.triggerBtn}>Paste HTML</button>;
  }

  return (
    <div style={s.wrapper}>
      <label style={s.label}>Paste element outerHTML for {fieldLabel} (copy from DevTools → Copy → Copy outerHTML)</label>
      <textarea style={s.textarea} value={outerHTML} onChange={(e) => setOuterHTML(e.target.value)}
        placeholder='<h1 class="product-title">Product Name</h1>' />
      <div style={s.row}>
        <button type="button" style={loading || !outerHTML.trim() ? s.genBtnDisabled : s.genBtn}
          onClick={handleGenerate} disabled={loading || !outerHTML.trim()}>
          {loading ? 'Generating…' : 'Generate'}
        </button>
        <button type="button" onClick={() => { setIsOpen(false); setOuterHTML(''); }} style={s.cancelBtn}>Cancel</button>
      </div>
      {error && <div style={s.errorBox}>{error}</div>}
      {lastGeneratedSelector && (
        <div style={s.resultBox}>
          <div style={s.code}>{lastGeneratedSelector}</div>
          {lastStability && (
            <span style={stabilityBadgeStyle(
              lastStability === 'high' ? '#16a34a' : lastStability === 'medium' ? '#f59e0b' : '#dc2626',
            )}>
              {lastStability}
            </span>
          )}
          {lastMatchCount !== undefined && <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 6 }}>{lastMatchCount} match{lastMatchCount !== 1 ? 'es' : ''}</span>}
        </div>
      )}
    </div>
  );
}

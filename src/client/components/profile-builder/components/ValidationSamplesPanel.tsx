/**
 * ValidationSamplesPanel — manage sample URLs and trigger validation.
 */

import React, { useState } from 'react';
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';

interface ValidationSamplesPanelProps {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    background: '#fff',
    borderRadius: 8,
    border: '1px solid #e5e7eb',
    padding: 12,
  },
  title: { fontSize: 14, fontWeight: 600, color: '#111827', margin: '0 0 8px' },
  addRow: { display: 'flex', gap: 6, marginBottom: 10 },
  input: {
    flex: 1,
    padding: '6px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'monospace',
  },
  addBtn: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  sampleList: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 },
  sampleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 8px',
    background: '#f9fafb',
    borderRadius: 6,
    fontSize: 12,
  },
  sampleUrl: { flex: 1, fontFamily: 'monospace', fontSize: 11, color: '#374151', wordBreak: 'break-all' },
  checkbox: { cursor: 'pointer', margin: 0 },
  expectedInput: {
    width: 120,
    padding: '2px 6px',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    fontSize: 11,
  },
  removeBtn: {
    background: 'none',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    fontSize: 14,
    cursor: 'pointer',
    padding: '2px 6px',
    color: '#9ca3af',
    lineHeight: 1,
  },
  validateBtn: {
    background: '#16a34a',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 20px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
  },
  validateBtnDisabled: {
    background: '#9ca3af',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 20px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'not-allowed',
  },
  empty: { fontSize: 12, color: '#9ca3af', fontStyle: 'italic', marginBottom: 10 },
  count: { fontSize: 12, color: '#6b7280', marginBottom: 6 },
};

export function ValidationSamplesPanel({ state, controller }: ValidationSamplesPanelProps) {
  const [urlInput, setUrlInput] = useState('');
  const { samples, requests } = state;
  const hasSamples = samples.length > 0;

  const handleAdd = () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    controller.addSample(trimmed);
    setUrlInput('');
  };

  return (
    <div style={s.panel}>
      <h4 style={s.title}>Validation Samples</h4>

      <div style={s.addRow}>
        <input
          type="text"
          style={s.input}
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          placeholder="https://example.com/products/another-product"
        />
        <button
          type="button"
          style={s.addBtn}
          onClick={handleAdd}
          disabled={!urlInput.trim()}
        >
          + Add
        </button>
      </div>

      {hasSamples && (
        <div style={s.count}>
          {samples.length} sample{samples.length !== 1 ? 's' : ''}
        </div>
      )}

      {hasSamples ? (
        <div style={s.sampleList}>
          {samples.map((sample) => (
            <div key={sample.id} style={s.sampleRow}>
              <span style={s.sampleUrl}>
                {sample.url.length > 50 ? sample.url.slice(0, 50) + '…' : sample.url}
              </span>
              <label style={{ fontSize: 11, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 2 }}>
                <input
                  type="checkbox"
                  style={s.checkbox}
                  checked={sample.confirmed}
                  onChange={(e) => controller.updateSample(sample.id, { confirmed: e.target.checked })}
                />
                Confirmed
              </label>
              <input
                type="text"
                style={s.expectedInput}
                value={sample.expectedName ?? ''}
                onChange={(e) => controller.updateSample(sample.id, { expectedName: e.target.value })}
                placeholder="Expected name"
              />
              <button
                type="button"
                style={s.removeBtn}
                onClick={() => controller.removeSample(sample.id)}
                title="Remove sample"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div style={s.empty}>No sample URLs added yet.</div>
      )}

      <button
        type="button"
        style={hasSamples && !requests.validate.loading ? s.validateBtn : s.validateBtnDisabled}
        onClick={controller.runValidation}
        disabled={!hasSamples || requests.validate.loading}
      >
        {requests.validate.loading ? 'Validating…' : 'Run Validation'}
      </button>

      {requests.validate.error && (
        <div style={{
          marginTop: 8,
          padding: '6px 10px',
          background: '#fee2e2',
          borderRadius: 6,
          color: '#991b1b',
          fontSize: 12,
        }}>
          {requests.validate.error}
        </div>
      )}
    </div>
  );
}

/**
 * SelectorInput — controlled monospace CSS selector input.
 */

import React from 'react';

interface SelectorInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
}

function inputStyle(hasError: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: '6px 10px',
    paddingRight: 30,
    border: `1px solid ${hasError ? '#dc2626' : '#d1d5db'}`,
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'monospace',
    outline: hasError ? '1px solid #dc2626' : 'none',
  };
}

const s: Record<string, React.CSSProperties> = {
  wrapper: { position: 'relative', display: 'flex', alignItems: 'center' },
  clearBtn: {
    position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
    background: 'none', border: 'none', fontSize: 16, cursor: 'pointer', color: '#9ca3af',
    lineHeight: 1, padding: '2px 4px',
  },
};

export function SelectorInput({ value, onChange, placeholder = 'e.g. h1.product-title', error }: SelectorInputProps) {
  return (
    <div style={s.wrapper}>
      <input type="text" style={inputStyle(!!error)} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {value && <button type="button" style={s.clearBtn} onClick={() => onChange('')} title="Clear selector">×</button>}
    </div>
  );
}

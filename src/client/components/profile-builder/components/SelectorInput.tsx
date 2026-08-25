/**
 * SelectorInput — controlled monospace CSS selector input (General Store)
 */

import React from 'react';
import { colors, fonts, rounded } from '../../../theme';

interface SelectorInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
}

function inputStyle(hasError: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: '8px 12px',
    paddingRight: 32,
    border: `1px solid ${hasError ? colors.signetBurgundy : colors.cardBorder}`,
    borderRadius: rounded.sm,
    fontSize: 12,
    fontFamily: fonts.mono,
    color: colors.ledgerCharcoal,
    background: colors.whiteSurface,
    outline: hasError ? `1px solid ${colors.signetBurgundy}` : 'none',
  };
}

const s: Record<string, React.CSSProperties> = {
  wrapper: { position: 'relative', display: 'flex', alignItems: 'center' },
  clearBtn: {
    position: 'absolute',
    right: 8,
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'none',
    border: 'none',
    fontSize: 16,
    cursor: 'pointer',
    color: colors.mulchBrown,
    lineHeight: 1,
    padding: '2px 4px',
  },
};

export function SelectorInput({ value, onChange, placeholder = 'e.g. h1.product-title', error }: SelectorInputProps) {
  return (
    <div style={s.wrapper}>
      <input
        type="text"
        style={inputStyle(Boolean(error))}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <button
          type="button"
          style={s.clearBtn}
          onClick={() => onChange('')}
          title="Clear selector"
        >
          ×
        </button>
      )}
    </div>
  );
}


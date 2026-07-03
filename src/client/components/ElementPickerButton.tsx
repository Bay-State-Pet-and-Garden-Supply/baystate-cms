/**
 * ElementPickerButton.tsx — click-to-select visual element picker button
 *
 * Launches a headful Playwright browser (via the extraction worker)
 * so the operator can visually click on a page element to generate
 * a stable CSS selector.
 *
 * Usage:
 *   <ElementPickerButton
 *     field="title"
 *     url="https://example.com/product/123"
 *     onPicked={(result) => console.log(result.selector)}
 *   />
 */

import React, { useState, useCallback } from 'react';
import { pickElementVisually } from '../onboarding-api';
import type { PickElementResponse } from '../../shared/schemas/extraction-worker';

// ─── Props ───────────────────────────────────────────────────────────────────

interface ElementPickerButtonProps {
  /** Which field is being selected: title, description, or images. */
  field: 'title' | 'description' | 'images';
  /** The URL of the product page to open in the headful browser. */
  url: string;
  /** Called with the picker result when the user clicks an element. */
  onPicked: (result: PickElementResponse) => void;
  /** Called when the user cancels or an error occurs. */
  onCancel?: () => void;
  /** Disable the button. */
  disabled?: boolean;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const btnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid #2563eb',
  color: '#2563eb',
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
  marginTop: 4,
};

const btnDisabledStyle: React.CSSProperties = {
  ...btnStyle,
  opacity: 0.5,
  cursor: 'not-allowed',
  borderColor: '#9ca3af',
  color: '#9ca3af',
};

const statusStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#6b7280',
  marginTop: 4,
  fontStyle: 'italic',
};

const errorStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#dc2626',
  marginTop: 4,
};

const successStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#16a34a',
  marginTop: 4,
};

// ─── Component ───────────────────────────────────────────────────────────────

export function ElementPickerButton(
  props: ElementPickerButtonProps,
): React.ReactElement {
  const { field, url, onPicked, onCancel, disabled } = props;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    if (busy || !url.trim()) return;

    setBusy(true);
    setStatus('Opening browser window… Click on the element to select it.');
    setError(null);

    try {
      const result = await pickElementVisually({
        url: url.trim(),
        field,
        allowParentContainer: true,
      });

      if (result.ok && result.data) {
        if (result.data.selector) {
          setStatus(`Selector generated: ${result.data.selector}`);
          onPicked(result.data);
        } else {
          // User cancelled
          setStatus(null);
          onCancel?.();
        }
      } else {
        setError(result.error ?? 'Visual picker failed');
        onCancel?.();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      onCancel?.();
    } finally {
      setBusy(false);
    }
  }, [busy, url, field, onPicked, onCancel]);

  return (
    <div>
      <button
        type="button"
        style={disabled || busy ? btnDisabledStyle : btnStyle}
        onClick={handleClick}
        disabled={disabled || busy || !url.trim()}
      >
        {busy ? '🖱️ Selecting…' : '🖱️ Visually Select'}
      </button>
      {status && <div style={statusStyle}>{status}</div>}
      {error && <div style={errorStyle}>{error}</div>}
      {!busy && !error && status && (
        <div style={successStyle}>✓ Selector ready</div>
      )}
    </div>
  );
}

export default ElementPickerButton;

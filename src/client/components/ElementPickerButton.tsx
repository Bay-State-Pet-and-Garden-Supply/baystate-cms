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
  /** Which field is being selected (e.g. title, description, images, or custom). */
  field: string;
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

const cardStyle: React.CSSProperties = {
  marginTop: 8,
  padding: 10,
  background: '#f0fdf4',
  borderRadius: 6,
  border: '1px solid #bbf7d0',
  fontSize: 12,
};

const codeStyle: React.CSSProperties = {
  fontSize: 11,
  background: '#fff',
  padding: '2px 6px',
  borderRadius: 3,
  display: 'inline-block',
  marginBottom: 4,
  wordBreak: 'break-all',
  fontFamily: 'monospace',
};

function stabilityBadgeStyle(stability: string): React.CSSProperties {
  const colors: Record<string, { bg: string; fg: string }> = {
    high: { bg: '#dcfce7', fg: '#16a34a' },
    medium: { bg: '#fef3c7', fg: '#d97706' },
    low: { bg: '#fee2e2', fg: '#dc2626' },
  };
  const c = colors[stability] ?? colors.low;
  return {
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 700,
    padding: '1px 6px',
    borderRadius: 999,
    textTransform: 'uppercase',
    background: c.bg,
    color: c.fg,
    marginLeft: 6,
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ElementPickerButton(
  props: ElementPickerButtonProps,
): React.ReactElement {
  const { field, url, onPicked, onCancel, disabled } = props;
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickedResult, setPickedResult] = useState<PickElementResponse | null>(null);

  const handleClick = useCallback(async () => {
    if (busy || !url.trim()) return;

    setBusy(true);
    setPickedResult(null);
    setStatus('Opening browser window... Click on the element to select it.');
    setError(null);

    try {
      const result = await pickElementVisually({
        url: url.trim(),
        field,
        allowParentContainer: true,
      });

      if (result.ok && result.data) {
        if (result.data.selector) {
          setPickedResult(result.data);
          setStatus(null);
          onPicked(result.data);
        } else {
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
        {busy ? 'Selecting...' : 'Visually Select'}
      </button>
      {status && <div style={statusStyle}>{status}</div>}
      {error && <div style={errorStyle}>{error}</div>}

      {/* Confirmation card shown after successful pick */}
      {pickedResult && (
        <div style={cardStyle}>
          <div>
            <code style={codeStyle}>{pickedResult.selector}</code>
            <span style={stabilityBadgeStyle(pickedResult.stability)}>
              {pickedResult.stability}
            </span>
          </div>
          {pickedResult.extractedText && (
            <div style={{ color: '#4b5563', marginTop: 4, lineHeight: 1.4 }}>
              {pickedResult.extractedText.slice(0, 120)}
              {pickedResult.extractedText.length > 120 ? '...' : ''}
            </div>
          )}
          {pickedResult.extractedImages && pickedResult.extractedImages.length > 0 && (
            <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
              {pickedResult.extractedImages.slice(0, 3).map((imgUrl, i) => (
                <img
                  key={i}
                  src={imgUrl}
                  alt="Extracted preview"
                  style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4, border: '1px solid #e5e7eb' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ))}
            </div>
          )}
          {pickedResult.matchCount > 0 && (
            <div style={{ fontSize: 10, color: '#6b7280', marginTop: 4 }}>
              Matches {pickedResult.matchCount} element{pickedResult.matchCount !== 1 ? 's' : ''}
            </div>
          )}
          {pickedResult.warnings && pickedResult.warnings.length > 0 && (
            <div style={{ fontSize: 10, color: '#d97706', marginTop: 4 }}>
              {pickedResult.warnings.join('; ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ElementPickerButton;

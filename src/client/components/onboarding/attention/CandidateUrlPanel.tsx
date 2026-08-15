/**
 * Epic #46 Phase 4 — Candidate official page panel.
 *
 * Shows the candidate URLs found by the official-site search with the
 * operator decision:
 *   [Confirm Page] — accept a candidate
 *   [Choose Another] — provide a different URL manually
 * Variant identity is visible on every candidate. Confirming persists the
 * URL (server-side) before extraction resumes.
 */
import React, { useState } from 'react';
import type { OnboardingSource } from '../../../../shared/schemas/onboarding';
import { candidateMethodLabel, candidateWhy, domainFromUrl, formatConfidence } from './attention-logic';

interface CandidateUrlPanelProps {
  candidates: OnboardingSource[];
  itemName: string;
  expectedName?: string | null;
  upc: string;
  /** In-flight mutation kind, or null when idle. */
  busy?: 'confirming' | 'saving-url' | null;
  onConfirm: (source: OnboardingSource) => void;
  onUseManualUrl: (url: string) => Promise<void>;
}

export function CandidateUrlPanel({
  candidates,
  itemName,
  expectedName,
  upc,
  busy = null,
  onConfirm,
  onUseManualUrl,
}: CandidateUrlPanelProps): React.ReactElement {
  const [showManual, setShowManual] = useState(candidates.length === 0);
  const [manualUrl, setManualUrl] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);

  const sorted = [...candidates].sort((a, b) => {
    // Selected first, then highest confidence.
    if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  const handleManualSubmit = async () => {
    const url = manualUrl.trim();
    if (!url) {
      setManualError('Enter a product page URL.');
      return;
    }
    try {
      new URL(url);
    } catch {
      setManualError('That does not look like a valid URL (include https://).');
      return;
    }
    setManualError(null);
    try {
      await onUseManualUrl(url);
      setManualUrl('');
    } catch (err) {
      setManualError(err instanceof Error ? err.message : 'Could not save that URL.');
    }
  };

  return (
    <section className="attn-section" aria-label="Candidate official product pages">
      <h3 className="attn-section-title">Official product page</h3>
      <div className="attn-section-body">
        <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: '0.8125rem', color: 'var(--color-mulch-brown)' }}>
          Matching <strong>{itemName}</strong>
          {expectedName && expectedName !== itemName ? ` (imported as “${expectedName}”)` : ''} · UPC{' '}
          <span className="font-mono">{upc}</span>
        </p>

        {sorted.map((source) => {
          const domain = domainFromUrl(source.url);
          return (
            <div
              key={source.id}
              className={`attn-candidate ${source.isSelected ? 'attn-candidate-selected' : ''}`}
            >
              <div className="attn-candidate-title">
                {source.title && source.title.length > 0 ? source.title : domain ?? source.url}
              </div>
              <div className="attn-candidate-url">{source.url}</div>
              {source.snippet && source.snippet.length > 0 ? (
                <div className="attn-candidate-snippet">{source.snippet}</div>
              ) : null}
              <div className="attn-candidate-why">{candidateWhy(source)}</div>
              <div className="attn-candidate-actions">
                <span className="badge" style={{ background: 'var(--color-feed-bag-cream)', color: 'var(--color-ledger-charcoal)', border: '1px solid var(--color-card-border)' }}>
                  {candidateMethodLabel(source.sourceMethod)} · {formatConfidence(source.confidence)}
                </span>
                {source.isSelected ? (
                  <span className="badge" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success-text)' }}>
                    Currently selected
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ height: '2rem', padding: '0 0.75rem' }}
                    onClick={() => onConfirm(source)}
                    disabled={busy !== null}
                  >
                    {busy === 'confirming' ? 'Saving…' : 'Confirm Page'}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {sorted.length === 0 ? (
          <p style={{ margin: 0, fontFamily: 'var(--font-body)', fontSize: '0.8125rem', color: 'var(--color-ledger-charcoal)' }}>
            No search candidates were found. Enter the official product page URL below, or search the
            manufacturer site for this SKU.
          </p>
        ) : null}

        <div className="attn-candidate-actions">
          {!showManual ? (
            <button type="button" className="btn btn-outline" style={{ height: '2rem', padding: '0 0.75rem' }} onClick={() => setShowManual(true)} disabled={busy !== null}>
              Choose Another
            </button>
          ) : null}
        </div>

        {showManual ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label htmlFor="attn-manual-url" className="text-label" style={{ color: 'var(--color-mulch-brown)' }}>
              Product page URL
            </label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                id="attn-manual-url"
                className="input"
                type="url"
                placeholder="https://www.manufacturer.com/product/12345"
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleManualSubmit();
                }}
                disabled={busy !== null}
              />
              <button
                type="button"
                className="btn btn-primary"
                style={{ flexShrink: 0 }}
                onClick={() => void handleManualSubmit()}
                disabled={busy !== null || manualUrl.trim().length === 0}
              >
                {busy === 'saving-url' ? 'Saving…' : 'Use This URL'}
              </button>
            </div>
            {manualError ? (
              <div className="attn-error" style={{ padding: 8, fontSize: '0.75rem' }} role="alert">
                {manualError}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

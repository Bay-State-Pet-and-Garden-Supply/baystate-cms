// story: e08 tracer + history — evidence inspector bound to selected sample/cell (General Store)
import React, { useState } from 'react';
import { colors, fonts, rounded } from '../../theme';

type CaptureLite = {
  dom: string;
  screenshotBase64?: string;
  screenshotRef?: string;
  runtime: string;
  hash: string;
  capturedAt: string;
  url: string;
  provenance?: { provider: string; model: string };
  jsonLd?: string;
} | null;

type MatrixCellLite = {
  field: string;
  extracted?: string | null;
  expected?: string;
  provenance?: string;
  artifactHash?: string;
  failureReason?: string | null;
} | null;

export function EvidenceRail({ capture, matrixCell }: { capture?: CaptureLite; matrixCell?: MatrixCellLite }): React.ReactElement {
  const cell = matrixCell ?? null;
  const [tab, setTab] = useState<'dom' | 'jsonld'>('dom');

  return (
    <aside aria-label="Evidence">
      <div
        style={{
          background: colors.whiteSurface,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: rounded.lg,
          padding: 16,
          boxShadow: '0 1px 4px rgba(33, 20, 20, 0.06)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
            paddingBottom: 10,
            borderBottom: `2px solid ${colors.cornerCalloutGold}`,
          }}
        >
          <div
            style={{
              fontFamily: fonts.body,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: colors.mulchBrown,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            Evidence Inspector
            <span
              style={{
                fontFamily: fonts.body,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                color: colors.uniformGreen,
                background: colors.feedBagCream,
                border: `1px solid ${colors.cardBorder}`,
                padding: '2px 6px',
                borderRadius: rounded.sm,
              }}
            >
              Ledger
            </span>
          </div>
        </div>

        {/* Screenshot Viewport */}
        <div
          style={{
            aspectRatio: '16 / 9',
            background: colors.feedBagCream,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.sm,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: colors.mulchBrown,
            fontFamily: fonts.body,
            fontSize: 12,
            marginBottom: 14,
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          {capture?.screenshotBase64 || capture?.screenshotRef ? (
            <img
              src={capture.screenshotBase64 ? `data:image/png;base64,${capture.screenshotBase64}` : capture.screenshotRef!}
              alt="capture evidence"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{ textAlign: 'center', padding: 12 }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>📷</div>
              <div style={{ fontSize: 11, color: colors.mulchBrown }}>
                {capture ? 'Captured (no screenshot)' : 'Select a sample or matrix cell'}
              </div>
            </div>
          )}

          {capture?.runtime && (
            <span
              style={{
                position: 'absolute',
                top: 6,
                right: 6,
                fontSize: 10,
                fontWeight: 700,
                fontFamily: fonts.mono,
                textTransform: 'uppercase',
                background: 'rgba(33, 20, 20, 0.75)',
                color: colors.feedBagCream,
                padding: '2px 6px',
                borderRadius: rounded.sm,
              }}
            >
              {capture.runtime}
            </span>
          )}
        </div>

        {/* Inspected Matrix Cell */}
        {cell && (
          <div
            style={{
              marginBottom: 14,
              padding: 10,
              background: cell.failureReason ? 'rgba(118, 12, 25, 0.06)' : 'rgba(22, 132, 77, 0.06)',
              border: `1px solid ${cell.failureReason ? 'rgba(118, 12, 25, 0.25)' : 'rgba(22, 132, 77, 0.25)'}`,
              borderLeft: `3px solid ${cell.failureReason ? colors.signetBurgundy : colors.seedlingGreen}`,
              borderRadius: rounded.sm,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: cell.failureReason ? colors.signetBurgundy : colors.seedlingGreen }}>
                Field: {cell.field}
              </span>
              <span style={{ fontFamily: fonts.body, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: cell.failureReason ? colors.signetBurgundy : colors.seedlingGreen }}>
                {cell.failureReason ? 'Failed' : 'Pass'}
              </span>
            </div>

            <div style={{ marginTop: 6, fontSize: 12, color: colors.ledgerCharcoal }}>
              <div><strong>Extracted:</strong> <span style={{ fontFamily: fonts.mono, color: colors.ledgerCharcoal }}>{String(cell.extracted ?? '—')}</span></div>
              <div style={{ marginTop: 2 }}><strong>Expected:</strong> <span style={{ fontFamily: fonts.mono, color: colors.mulchBrown }}>{String(cell.expected ?? '—')}</span></div>
            </div>

            {cell.failureReason && (
              <div style={{ marginTop: 6, fontSize: 11, color: colors.signetBurgundy, fontWeight: 600, background: colors.whiteSurface, padding: '4px 8px', borderRadius: rounded.sm }}>
                ⚠ {cell.failureReason}
              </div>
            )}
          </div>
        )}

        {/* Capture Metadata */}
        {capture ? (
          <div>
            <div style={{ display: 'flex', gap: 4, marginBottom: 8, borderBottom: `1px solid ${colors.cardBorder}` }}>
              <button
                type="button"
                onClick={() => setTab('dom')}
                style={{
                  padding: '4px 10px',
                  fontFamily: fonts.body,
                  fontSize: 11,
                  fontWeight: 600,
                  background: 'none',
                  border: 'none',
                  borderBottom: `2px solid ${tab === 'dom' ? colors.uniformGreen : 'transparent'}`,
                  color: tab === 'dom' ? colors.uniformGreen : colors.mulchBrown,
                  cursor: 'pointer',
                }}
              >
                DOM Snippet
              </button>
              {capture.jsonLd && (
                <button
                  type="button"
                  onClick={() => setTab('jsonld')}
                  style={{
                    padding: '4px 10px',
                    fontFamily: fonts.body,
                    fontSize: 11,
                    fontWeight: 600,
                    background: 'none',
                    border: 'none',
                    borderBottom: `2px solid ${tab === 'jsonld' ? colors.uniformGreen : 'transparent'}`,
                    color: tab === 'jsonld' ? colors.uniformGreen : colors.mulchBrown,
                    cursor: 'pointer',
                  }}
                >
                  JSON-LD
                </button>
              )}
            </div>

            <div
              style={{
                fontFamily: fonts.mono,
                fontSize: 10,
                color: colors.ledgerCharcoal,
                background: colors.feedBagCream,
                padding: '8px 10px',
                borderRadius: rounded.sm,
                border: `1px solid ${colors.cardBorder}`,
                maxHeight: 140,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {tab === 'jsonld' && capture.jsonLd ? capture.jsonLd : capture.dom?.slice(0, 800) || 'No DOM content'}
            </div>

            <div style={{ marginTop: 8, fontSize: 10, fontFamily: fonts.mono, color: colors.mulchBrown, wordBreak: 'break-all' }}>
              <div>SHA: {capture.hash?.slice(0, 16) || '—'}</div>
              <div>URL: {capture.url}</div>
              <div>Captured: {capture.capturedAt ? new Date(capture.capturedAt).toLocaleTimeString() : '—'}</div>
            </div>
          </div>
        ) : (
          !cell && (
            <div
              style={{
                padding: 16,
                textAlign: 'center',
                border: `1px dashed ${colors.cardBorder}`,
                borderRadius: rounded.sm,
                background: colors.feedBagCream,
                color: colors.mulchBrown,
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              Select a sample or click any test matrix cell to inspect DOM & screenshot evidence.
            </div>
          )
        )}
      </div>
    </aside>
  );
}


/**
 * ArtifactBrowser — displays snapshot artifacts and diagnostics (General Store).
 * Screenshots render inline when the URL resolves; otherwise fall back to path display.
 */

import React from 'react';
import type { SnapshotResponse } from '../../../../shared/schemas/extraction-worker';
import { defaultArtifactUrlResolver } from '../artifactUrls';
import { colors, fonts, rounded } from '../../../theme';

interface ArtifactBrowserProps {
  snapshot: SnapshotResponse | null;
  artifactUrlResolver?: (ref: string) => string | null;
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    background: colors.whiteSurface,
    borderRadius: rounded.lg,
    border: `1px solid ${colors.cardBorder}`,
    padding: 14,
    boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
  },
  title: {
    fontFamily: fonts.display,
    fontSize: '0.9375rem',
    fontWeight: 700,
    color: colors.ledgerCharcoal,
    margin: '0 0 10px',
    paddingBottom: 6,
    borderBottom: `1px solid ${colors.cardBorder}`,
  },
  section: { marginBottom: 10 },
  sectionTitle: {
    fontFamily: fonts.body,
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: colors.mulchBrown,
    margin: '0 0 4px',
  },
  jsonBlock: {
    fontSize: 10,
    fontFamily: fonts.mono,
    background: colors.feedBagCream,
    border: `1px solid ${colors.cardBorder}`,
    padding: 8,
    borderRadius: rounded.sm,
    maxHeight: 120,
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    margin: 0,
    color: colors.ledgerCharcoal,
  },
  screenshot: { maxWidth: '100%', borderRadius: rounded.sm, marginBottom: 8, border: `1px solid ${colors.cardBorder}` },
  fallback: { fontSize: 11, color: colors.mulchBrown, fontStyle: 'italic', padding: '6px 0' },
  list: { fontSize: 11, fontFamily: fonts.body, color: colors.ledgerCharcoal, margin: 0, padding: '0 0 0 16px' },
  warning: {
    fontSize: 11,
    color: colors.ledgerCharcoal,
    background: 'rgba(246, 219, 18, 0.2)',
    border: `1px solid ${colors.mutedGold}`,
    padding: '3px 8px',
    borderRadius: rounded.sm,
    marginBottom: 4,
  },
};

export function ArtifactBrowser({ snapshot, artifactUrlResolver }: ArtifactBrowserProps) {
  if (!snapshot) {
    return (
      <div style={s.panel}>
        <h4 style={s.title}>Snapshot Artifacts</h4>
        <div style={s.fallback}>No snapshot captured yet.</div>
      </div>
    );
  }

  const resolveUrl = artifactUrlResolver ?? defaultArtifactUrlResolver;
  const screenshotUrl = snapshot.screenshotRef ? resolveUrl(snapshot.screenshotRef) : null;
  const hasData = (snapshot.jsonLd && snapshot.jsonLd.length > 0) ||
    (snapshot.embeddedProductData && snapshot.embeddedProductData.length > 0) ||
    (snapshot.imageCandidates && snapshot.imageCandidates.length > 0) ||
    (snapshot.pageStructureSignals && snapshot.pageStructureSignals.length > 0) ||
    (snapshot.warnings && snapshot.warnings.length > 0);

  return (
    <div style={s.panel}>
      <h4 style={s.title}>Snapshot Artifacts</h4>

      {screenshotUrl ? (
        <img src={screenshotUrl} alt="Page screenshot" style={s.screenshot} />
      ) : snapshot.screenshotRef ? (
        <div style={s.fallback}>
          Screenshot artifact captured but is not browser-accessible from this environment.
          <div style={{ fontSize: 10, color: colors.mulchBrown, fontFamily: fonts.mono, marginTop: 2 }}>{snapshot.screenshotRef}</div>
        </div>
      ) : null}

      {hasData && (
        <>
          {snapshot.jsonLd && snapshot.jsonLd.length > 0 && (
            <div style={s.section}>
              <div style={s.sectionTitle}>JSON-LD ({snapshot.jsonLd.length})</div>
              <pre style={s.jsonBlock}>{JSON.stringify(snapshot.jsonLd[0], null, 2).slice(0, 500)}{JSON.stringify(snapshot.jsonLd[0], null, 2).length > 500 ? '\n…' : ''}</pre>
            </div>
          )}
          {snapshot.embeddedProductData && snapshot.embeddedProductData.length > 0 && (
            <div style={s.section}>
              <div style={s.sectionTitle}>Embedded Data ({snapshot.embeddedProductData.length})</div>
              <pre style={s.jsonBlock}>{JSON.stringify(snapshot.embeddedProductData[0], null, 2).slice(0, 300)}</pre>
            </div>
          )}
          {snapshot.imageCandidates && snapshot.imageCandidates.length > 0 && (
            <div style={s.section}>
              <div style={s.sectionTitle}>Image Candidates ({snapshot.imageCandidates.length})</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {snapshot.imageCandidates.slice(0, 6).map((url: string, i: number) => (
                  <span key={i} style={{ display: 'inline-block', width: 44, height: 44, background: colors.feedBagCream, border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.sm, overflow: 'hidden', fontSize: 8, color: colors.mulchBrown, textAlign: 'center', lineHeight: '44px' }} title={url}>img</span>
                ))}
                {snapshot.imageCandidates.length > 6 && <span style={{ fontSize: 11, color: colors.mulchBrown, alignSelf: 'center' }}>+{snapshot.imageCandidates.length - 6} more</span>}
              </div>
            </div>
          )}
          {snapshot.pageStructureSignals && snapshot.pageStructureSignals.length > 0 && (
            <div style={s.section}>
              <div style={s.sectionTitle}>Page Structure Signals</div>
              <ul style={s.list}>{snapshot.pageStructureSignals.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
          {snapshot.warnings && snapshot.warnings.length > 0 && (
            <div style={s.section}>
              <div style={s.sectionTitle}>Warnings</div>
              {snapshot.warnings.map((w: string, i: number) => <div key={i} style={s.warning}>{w}</div>)}
            </div>
          )}
        </>
      )}


      {!hasData && !snapshot.screenshotRef && <div style={s.fallback}>No structured data or artifacts available.</div>}
    </div>
  );
}

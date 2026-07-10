/**
 * ArtifactBrowser — displays snapshot artifacts and diagnostics.
 * Screenshots render inline when the URL resolves; otherwise fall back to path display.
 */

import React from 'react';
import type { SnapshotResponse } from '../../../../shared/schemas/extraction-worker';
import { defaultArtifactUrlResolver } from '../artifactUrls';

interface ArtifactBrowserProps {
  snapshot: SnapshotResponse | null;
  artifactUrlResolver?: (ref: string) => string | null;
}

function badgeStyle(bg: string, fg: string): React.CSSProperties {
  return { display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999, background: bg, color: fg, marginRight: 4, marginBottom: 2 };
}

const s: Record<string, React.CSSProperties> = {
  panel: { background: '#fff', borderRadius: 8, border: '1px solid #e5e7eb', padding: 12 },
  title: { fontSize: 14, fontWeight: 600, color: '#111827', margin: '0 0 8px' },
  section: { marginBottom: 8 },
  sectionTitle: { fontSize: 12, fontWeight: 600, color: '#4b5563', margin: '0 0 4px' },
  jsonBlock: { fontSize: 10, fontFamily: 'monospace', background: '#f9fafb', padding: 8, borderRadius: 4, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 },
  screenshot: { maxWidth: '100%', borderRadius: 6, marginBottom: 8 },
  fallback: { fontSize: 11, color: '#9ca3af', fontStyle: 'italic', padding: '8px 0' },
  list: { fontSize: 11, color: '#374151', margin: 0, padding: '0 0 0 16px' },
  warning: { fontSize: 11, color: '#92400e', background: '#fef3c7', padding: '2px 8px', borderRadius: 4, marginBottom: 2 },
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
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>{snapshot.screenshotRef}</div>
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
                  <span key={i} style={{ display: 'inline-block', width: 48, height: 48, background: '#f3f4f6', borderRadius: 4, overflow: 'hidden', fontSize: 8, color: '#9ca3af', textAlign: 'center', lineHeight: '48px' }} title={url}>img</span>
                ))}
                {snapshot.imageCandidates.length > 6 && <span style={{ fontSize: 11, color: '#9ca3af', alignSelf: 'center' }}>+{snapshot.imageCandidates.length - 6} more</span>}
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

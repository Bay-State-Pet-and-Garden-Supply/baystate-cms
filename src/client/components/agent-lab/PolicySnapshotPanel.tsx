/**
 * PolicySnapshotPanel — read-only policy snapshot + capability versions (e02s01 Task 4).
 * Server owns policy; client only displays. No PUT/POST.
 */
import React from 'react';
import { toPolicySnapshotDisplay, escapeArtifactString } from '../../agent-lab/specialist-workspace-logic';
import type { PiRunRow } from '../../product-intelligence-api';

interface Props {
  run: PiRunRow;
}

export function PolicySnapshotPanel({ run }: Props) {
  const display = toPolicySnapshotDisplay(run.policyJson);
  const extVersions = parseExtensionVersions(run.extensionVersionsJson);

  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    title: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 8 },
    badge: { display: 'inline-block', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8, background: '#f3f4f6', color: '#6b7280', marginLeft: 8 },
    row: { fontSize: 13, color: '#4b5563', marginBottom: 4 },
    label: { fontWeight: 600, color: '#374151' },
    chips: { display: 'flex', gap: 4, flexWrap: 'wrap' as const, marginTop: 4 },
    chip: { display: 'inline-block', fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 8, background: '#f3f4f6', color: '#4b5563' },
    mono: { fontFamily: 'monospace', fontSize: 12, color: '#4b5563' },
    empty: { fontSize: 13, color: '#9ca3af' },
    note: { fontSize: 11, color: '#6b7280', fontStyle: 'italic', marginTop: 8 },
  };

  if (!display) {
    return (
      <div style={styles.card}>
        <h3 style={styles.title}>Policy Snapshot</h3>
        <p style={styles.empty}>Could not parse policy JSON.</p>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Policy Snapshot <span style={styles.badge}>read-only — server owns policy</span></h3>
      <div style={styles.row}><span style={styles.label}>Config ID:</span> <span style={styles.mono}>{display.configId ? escapeArtifactString(display.configId.slice(0, 16)) + '…' : '(missing)'}</span></div>
      <div style={styles.row}><span style={styles.label}>Executor:</span> {escapeArtifactString(run.executor)}</div>
      {run.piVersion && <div style={styles.row}><span style={styles.label}>Pi version:</span> {escapeArtifactString(run.piVersion)}</div>}
      {extVersions.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginTop: 8, marginBottom: 4 }}>Capability versions</div>
          <div style={styles.chips}>
            {extVersions.map((e, i) => (
              <span key={i} style={styles.chip}>{escapeArtifactString(String(e.name ?? '?'))} {e.version ? `@${escapeArtifactString(String(e.version))}` : '(unknown)'}</span>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginTop: 10, marginBottom: 4 }}>Allowed tools</div>
      <div style={styles.chips}>
        {display.allowedTools.length > 0 ? display.allowedTools.map((t) => <span key={t} style={styles.chip}>{escapeArtifactString(t)}</span>) : <span style={styles.empty}>(none)</span>}
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginTop: 8, marginBottom: 4 }}>Research tools</div>
      <div style={styles.chips}>
        {display.researchTools.length > 0 ? display.researchTools.map((t) => <span key={t} style={styles.chip}>{escapeArtifactString(t)}</span>) : <span style={styles.empty}>(none)</span>}
      </div>

      {display.allowedSourceDomains.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', marginTop: 8, marginBottom: 4 }}>Allowed source domains</div>
          <div style={styles.chips}>
            {display.allowedSourceDomains.map((d) => <span key={d} style={styles.chip}>{escapeArtifactString(d)}</span>)}
          </div>
        </div>
      )}

      {display.modelRoute ? (
        <div style={styles.row}><span style={styles.label}>Model:</span> {escapeArtifactString(display.modelRoute.provider)}/{escapeArtifactString(display.modelRoute.model)} ({escapeArtifactString(display.modelRoute.thinkingLevel)})</div>
      ) : (
        <div style={styles.row}><span style={styles.label}>Model:</span> <span style={{ color: '#dc2626' }}>none (fail closed)</span></div>
      )}

      <div style={{ marginTop: 8 }}>
        <div style={styles.row}><span style={styles.label}>Max tool calls:</span> {display.maxToolCalls ?? '?'}</div>
        {display.maxCostUsd != null && <div style={styles.row}><span style={styles.label}>Max cost (USD):</span> ${display.maxCostUsd}</div>}
        <div style={styles.row}><span style={styles.label}>Deadline (ms):</span> {display.deadlineMs ?? '?'}</div>
      </div>

      <p style={styles.note}>Policy is immutable per run (configId = SHA-256). Edits are not offered in the UI.</p>
    </div>
  );
}

function parseExtensionVersions(json: string): Array<Record<string, unknown>> {
  try {
    const arr = JSON.parse(json) as unknown[];
    return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

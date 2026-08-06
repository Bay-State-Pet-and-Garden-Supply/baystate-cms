/**
 * AgentPolicySummary — read-only policy snapshot display (PI-7).
 */

import React from 'react';
import type { PiRunRow } from '../../product-intelligence-api';
import { parseRunPolicy } from '../../product-intelligence-api';

interface Props {
  run: PiRunRow;
}

export function AgentPolicySummary({ run }: Props) {
  const policy = parseRunPolicy(run);

  const styles: Record<string, React.CSSProperties> = {
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    title: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 12 },
    row: { fontSize: 13, color: '#4b5563', marginBottom: 6 },
    label: { fontWeight: 600, color: '#374151' },
    chips: { display: 'flex', gap: 4, flexWrap: 'wrap' as const, marginTop: 4 },
    chip: { display: 'inline-block', fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 8, background: '#f3f4f6', color: '#4b5563', whiteSpace: 'nowrap' },
    empty: { fontSize: 13, color: '#9ca3af' },
    sectionTitle: { fontSize: 12, fontWeight: 700, color: '#6b7280', marginTop: 12, marginBottom: 6, textTransform: 'uppercase' as const },
    mono: { fontFamily: 'monospace', fontSize: 12, color: '#4b5563' },
  };

  if (!policy) {
    return (
      <div style={styles.card}>
        <p style={styles.empty}>Could not parse policy JSON for this run.</p>
      </div>
    );
  }

  const configId = (policy.configId as string) ?? '';
  const allowedTools = Array.isArray(policy.allowedTools) ? policy.allowedTools : [];
  const researchTools = Array.isArray(policy.researchTools) ? policy.researchTools : [];
  const allowedDomains = Array.isArray(policy.allowedSourceDomains) ? policy.allowedSourceDomains : [];
  const modelRoute = policy.modelRoute as Record<string, unknown> | null;
  const extVersions = (() => {
    try { return JSON.parse(run.extensionVersionsJson) as unknown[]; } catch { return []; }
  })();

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>Policy Snapshot</h3>

      <div style={styles.row}><span style={styles.label}>Config ID:</span> <span style={styles.mono}>{configId.slice(0, 16)}…</span></div>
      <div style={styles.row}><span style={styles.label}>Executor:</span> {run.executor}</div>
      {run.piVersion && <div style={styles.row}><span style={styles.label}>Pi version:</span> {run.piVersion}</div>}
      {extVersions.length > 0 && (
        <div>
          <div style={styles.sectionTitle}>Extension versions</div>
          <div style={styles.chips}>
            {extVersions.map((ext, i) => {
              const e = ext as Record<string, unknown>;
              return <span key={i} style={styles.chip}>{String(e.name ?? '?')} {e.version ? `@${e.version}` : '(unknown)'}</span>;
            })}
          </div>
        </div>
      )}

      <div style={styles.sectionTitle}>Allowed tools</div>
      <div style={styles.chips}>
        {allowedTools.length > 0
          ? (allowedTools as string[]).map((t) => <span key={t} style={styles.chip}>{t}</span>)
          : <span style={{ fontSize: 13, color: '#9ca3af' }}>(none)</span>}
      </div>

      <div style={styles.sectionTitle}>Research tools</div>
      <div style={styles.chips}>
        {researchTools.length > 0
          ? (researchTools as string[]).map((t) => <span key={t} style={styles.chip}>{t}</span>)
          : <span style={{ fontSize: 13, color: '#9ca3af' }}>(none)</span>}
      </div>

      {modelRoute && (
        <div style={styles.row}><span style={styles.label}>Model route:</span> {String(modelRoute.provider ?? '?')}/{String(modelRoute.model ?? '?')} ({String(modelRoute.thinkingLevel ?? '?')})</div>
      )}
      {!modelRoute && <div style={styles.row}><span style={styles.label}>Model route:</span> <span style={{ color: '#dc2626' }}>none (fail closed)</span></div>}

      <div style={styles.row}><span style={styles.label}>Data sharing:</span> {String(policy.dataSharingPolicy ?? '?')}</div>
      <div style={styles.row}><span style={styles.label}>Network policy:</span> {String(policy.networkPolicy ?? '?')}</div>

      {allowedDomains.length > 0 && (
        <div>
          <div style={styles.sectionTitle}>Allowed source domains</div>
          <div style={styles.chips}>
            {(allowedDomains as string[]).map((d) => <span key={d} style={styles.chip}>{d}</span>)}
          </div>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <div style={styles.row}><span style={styles.label}>Max tool calls:</span> {String(policy.maxToolCalls ?? '?')}</div>
        {policy.maxCostUsd != null && <div style={styles.row}><span style={styles.label}>Max cost (USD):</span> ${String(policy.maxCostUsd)}</div>}
        <div style={styles.row}><span style={styles.label}>Deadline (ms):</span> {String(policy.deadlineMs ?? '?')}</div>
        <div style={styles.row}><span style={styles.label}>Max response bytes:</span> {String(policy.maxResponseBytes ?? '?')}</div>
      </div>
    </div>
  );
}
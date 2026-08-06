/**
 * AgentLab — top-level tab component (PI-7).
 *
 * Fetches feature flags on mount; shows an unavailable panel when disabled;
 * otherwise renders Runs | Policies | Metrics sub-views.
 */

import React, { useEffect, useState } from 'react';
import { getPiFlags, type ProductIntelligenceFlags } from '../../product-intelligence-api';
import { AgentRunList } from './AgentRunList';
import { AgentLabPolicies } from './AgentLabPolicies';
import { AgentMetrics } from './AgentMetrics';
import { AgentRunInspector } from './AgentRunInspector';

type SubView = 'runs' | 'policies' | 'metrics';

export function AgentLab() {
  const [flags, setFlags] = useState<ProductIntelligenceFlags | null>(null);
  const [flagsError, setFlagsError] = useState<string | null>(null);
  const [subView, setSubView] = useState<SubView>('runs');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  useEffect(() => {
    getPiFlags()
      .then((res) => setFlags(res.flags))
      .catch((err) => setFlagsError(err instanceof Error ? err.message : String(err)));
  }, []);

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    titleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    title: { fontSize: 24, fontWeight: 600, margin: 0, color: '#111827' },
    pill: {
      display: 'inline-block',
      fontSize: 10,
      fontWeight: 600,
      padding: '1px 6px',
      borderRadius: 8,
      background: '#fef3c7',
      color: '#92400e',
      marginLeft: 8,
      verticalAlign: 'middle',
    },
    subTabs: { display: 'flex', gap: 8, marginBottom: 20 },
    subTab: {
      background: 'none',
      border: '1px solid #e5e7eb',
      borderRadius: 6,
      padding: '6px 14px',
      fontSize: 13,
      cursor: 'pointer',
      color: '#6b7280',
      fontWeight: 600,
    },
    subTabActive: {
      background: '#eff6ff',
      border: '1px solid #bfdbfe',
      borderRadius: 6,
      padding: '6px 14px',
      fontSize: 13,
      cursor: 'pointer',
      color: '#2563eb',
      fontWeight: 600,
    },
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24, marginBottom: 20 },
    unavailableTitle: { fontSize: 18, fontWeight: 600, color: '#374151', marginBottom: 12 },
    unavailableText: { fontSize: 14, color: '#6b7280', lineHeight: 1.6 },
    flagRow: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 },
    flagName: { fontSize: 13, fontFamily: 'monospace', color: '#374151' },
    flagVal: { fontSize: 13, fontWeight: 600, fontFamily: 'monospace' },
  };

  if (flagsError) {
    return (
      <div style={styles.container}>
        <div style={styles.titleRow}>
          <h1 style={styles.title}>
            🤖 Agent Lab
            <span style={styles.pill}>Experimental</span>
          </h1>
        </div>
        <div style={styles.card}>
          <p style={styles.unavailableText}>Failed to load feature flags: {flagsError}</p>
        </div>
      </div>
    );
  }

  if (!flags) {
    return (
      <div style={styles.container}>
        <h1 style={styles.title}>
          🤖 Agent Lab
          <span style={styles.pill}>Experimental</span>
        </h1>
        <p style={{ color: '#6b7280', fontSize: 14 }}>Loading flags…</p>
      </div>
    );
  }

  if (!flags.productIntelligenceEnabled) {
    return (
      <div style={styles.container}>
        <div style={styles.titleRow}>
          <h1 style={styles.title}>
            🤖 Agent Lab
            <span style={styles.pill}>Experimental</span>
          </h1>
        </div>
        <div style={styles.card}>
          <p style={styles.unavailableTitle}>Product Intelligence is disabled</p>
          <p style={styles.unavailableText}>
            Enable the master flag to use Agent Lab:
          </p>
          {(Object.entries(flags) as Array<[string, boolean]>).map(([key, val]) => (
            <div key={key} style={styles.flagRow}>
              <span style={styles.flagName}>{key}:</span>
              <span style={{ ...styles.flagVal, color: val ? '#16a34a' : '#9ca3af' }}>{String(val)}</span>
            </div>
          ))}
          <p style={{ ...styles.unavailableText, marginTop: 16 }}>
            Set <code style={{ fontSize: 13 }}>BAYSTATE_CMS_PRODUCT_INTELLIGENCE_ENABLED=true</code> to enable.
          </p>
        </div>
      </div>
    );
  }

  if (selectedRunId) {
    return (
      <div style={styles.container}>
        <AgentRunInspector runId={selectedRunId} onBack={() => setSelectedRunId(null)} />
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.titleRow}>
        <h1 style={styles.title}>
          🤖 Agent Lab
          <span style={styles.pill}>Experimental</span>
        </h1>
      </div>
      <div style={styles.subTabs}>
        <button
          style={subView === 'runs' ? styles.subTabActive : styles.subTab}
          onClick={() => setSubView('runs')}
        >
          Runs
        </button>
        <button
          style={subView === 'policies' ? styles.subTabActive : styles.subTab}
          onClick={() => setSubView('policies')}
        >
          Policies
        </button>
        <button
          style={subView === 'metrics' ? styles.subTabActive : styles.subTab}
          onClick={() => setSubView('metrics')}
        >
          Metrics
        </button>
      </div>
      {subView === 'runs' && <AgentRunList onSelect={(id) => setSelectedRunId(id)} />}
      {subView === 'policies' && <AgentLabPolicies flags={flags} onSelectRun={(id) => setSelectedRunId(id)} />}
      {subView === 'metrics' && <AgentMetrics onOpenRun={(id) => setSelectedRunId(id)} />}
    </div>
  );
}
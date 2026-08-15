/**
 * Agent Lab: Version Lineage.
 *
 * Lineage tree and historical snapshot registry showing immutable content hashes,
 * qualification states, and parent-child derivation history.
 */
import React, { useEffect, useState } from 'react';
import { listAgentVersions, type AgentVersionSummary } from '../../product-intelligence-api';

export interface VersionLineageProps {
  onSelectVersion?: (version: AgentVersionSummary) => void;
}

export function VersionLineage({ onSelectVersion: _onSelectVersion }: VersionLineageProps) {
  const [versions, setVersions] = useState<AgentVersionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedSnapshot, setSelectedSnapshot] = useState<AgentVersionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadVersions();
  }, []);

  async function loadVersions() {
    setIsLoading(true);
    setError(null);
    try {
      const list = await listAgentVersions();
      setVersions(list);
    } catch (err: any) {
      setError(err.message || 'Failed to list agent versions');
    } finally {
      setIsLoading(false);
    }
  }

  const statusColors = {
    active: { bg: '#dcfce7', color: '#15803d', label: '🛡️ Active Production' },
    qualified: { bg: '#eff6ff', color: '#1d4ed8', label: '✓ Qualified' },
    evaluating: { bg: '#fef3c7', color: '#b45309', label: '⏳ Evaluating' },
    draft: { bg: '#f1f5f9', color: '#475569', label: '📝 Candidate Draft' },
    retired: { bg: '#f3f4f6', color: '#9ca3af', label: 'Retired' },
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { display: 'flex', flexDirection: 'column', gap: 16 },
    card: {
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderRadius: 8,
      overflow: 'hidden',
    },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
    th: {
      textAlign: 'left',
      padding: '10px 14px',
      background: '#f8fafc',
      borderBottom: '1px solid #e2e8f0',
      color: '#475569',
      fontWeight: 600,
      fontSize: 12,
    },
    td: {
      padding: '12px 14px',
      borderBottom: '1px solid #f1f5f9',
      color: '#1e293b',
    },
    badge: {
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 12,
      fontSize: 11,
      fontWeight: 600,
    },
  };

  return (
    <div style={styles.container}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0, color: '#111827' }}>
            📜 Agent Version Lineage & Content Snapshots
          </h2>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 0 0' }}>
            Immutable, content-addressed prompt and guidance versions.
          </p>
        </div>
        <button
          onClick={loadVersions}
          style={{
            background: '#fff',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            padding: '6px 12px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Refresh Lineage
        </button>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', color: '#b91c1c', padding: 12, borderRadius: 6 }}>
          {error}
        </div>
      )}

      <div style={styles.card}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Version</th>
              <th style={styles.th}>Lifecycle Status</th>
              <th style={styles.th}>Content Hash</th>
              <th style={styles.th}>Rules / Examples</th>
              <th style={styles.th}>Change Summary</th>
              <th style={styles.th}>Created</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: 24, color: '#6b7280' }}>
                  Loading version registry…
                </td>
              </tr>
            ) : versions.length === 0 ? (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: 24, color: '#6b7280' }}>
                  No agent versions found.
                </td>
              </tr>
            ) : (
              versions.map((v) => {
                const statusMeta =
                  (statusColors as any)[v.state.lifecycleStatus] || statusColors.draft;

                return (
                  <tr key={v.snapshot.id}>
                    <td style={{ ...styles.td, fontWeight: 700 }}>
                      v{v.snapshot.versionNumber}.{v.snapshot.revisionNumber}
                    </td>
                    <td style={styles.td}>
                      <span
                        style={{
                          ...styles.badge,
                          background: statusMeta.bg,
                          color: statusMeta.color,
                        }}
                      >
                        {statusMeta.label}
                      </span>
                    </td>
                    <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 12 }}>
                      {v.snapshot.contentHash.slice(0, 10)}…
                    </td>
                    <td style={styles.td}>
                      {v.snapshot.instructions.length} rules •{' '}
                      {v.snapshot.fewShotExamples.length} examples
                    </td>
                    <td style={styles.td}>
                      {v.snapshot.changeSummary || '(initial baseline seed)'}
                    </td>
                    <td style={{ ...styles.td, fontSize: 12, color: '#64748b' }}>
                      {new Date(v.snapshot.createdAt).toLocaleDateString()} by{' '}
                      {v.snapshot.createdBy}
                    </td>
                    <td style={styles.td}>
                      <button
                        onClick={() => setSelectedSnapshot(v)}
                        style={{
                          background: '#f8fafc',
                          border: '1px solid #cbd5e1',
                          borderRadius: 4,
                          padding: '3px 8px',
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {selectedSnapshot && (
        <div
          style={{
            background: '#ffffff',
            border: '1px solid #cbd5e1',
            borderRadius: 8,
            padding: 16,
            marginTop: 8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
            <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              Snapshot Details: v{selectedSnapshot.snapshot.versionNumber}.
              {selectedSnapshot.snapshot.revisionNumber} ({selectedSnapshot.snapshot.contentHash})
            </h4>
            <button
              onClick={() => setSelectedSnapshot(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8' }}
            >
              Close
            </button>
          </div>
          <pre
            style={{
              background: '#f8fafc',
              padding: 12,
              borderRadius: 6,
              fontSize: 12,
              overflowX: 'auto',
              border: '1px solid #e2e8f0',
            }}
          >
            {JSON.stringify(selectedSnapshot, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

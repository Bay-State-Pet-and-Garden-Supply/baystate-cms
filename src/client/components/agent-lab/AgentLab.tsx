/**
 * Agent Lab: Root Training & Alignment Interface (PI-7 reshaped).
 *
 * Implements the continuous training & alignment loop:
 * Workbench → Correct → Teach → Evaluate → Promote
 */
import React, { useEffect, useState } from 'react';
import {
  getActiveAgentVersion,
  getCandidateAgentVersion,
  getPiFlags,
  type AgentVersionSummary,
  type ProductIntelligenceFlags,
} from '../../product-intelligence-api';
import { AgentWorkbench } from './AgentWorkbench';
import { CurriculumExplorer } from './CurriculumExplorer';
import { EvaluationMatrix } from './EvaluationMatrix';
import { AgentConfigStudio } from './AgentConfigStudio';
import { VersionLineage } from './VersionLineage';
import { AgentRunList } from './AgentRunList';
import { AgentRunInspector } from './AgentRunInspector';
import { ViewHeader } from '../common/ViewHeader';

type MainTab = 'workbench' | 'curriculum' | 'evaluate' | 'config' | 'versions' | 'runs';

export function AgentLab() {
  const [flags, setFlags] = useState<ProductIntelligenceFlags | null>(null);
  const [flagsError, setFlagsError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MainTab>('workbench');

  const [activeVersion, setActiveVersion] = useState<AgentVersionSummary | null>(null);
  const [candidateVersion, setCandidateVersion] = useState<AgentVersionSummary | null>(null);

  // Deep link support: ?view=agentlab&run=<id> opens that run's inspector.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() =>
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('run') : null,
  );

  useEffect(() => {
    getPiFlags()
      .then((res) => setFlags(res.flags))
      .catch((err) => setFlagsError(err instanceof Error ? err.message : String(err)));

    loadVersions();
  }, []);

  async function loadVersions() {
    try {
      const [act, cand] = await Promise.all([
        getActiveAgentVersion().catch(() => null),
        getCandidateAgentVersion().catch(() => null),
      ]);
      setActiveVersion(act);
      setCandidateVersion(cand);
    } catch {
      // Ignored if unconfigured
    }
  }

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24, maxWidth: 1400, margin: '0 auto' },
    pill: {
      display: 'inline-block',
      fontSize: 10,
      fontWeight: 600,
      padding: '2px 8px',
      borderRadius: 10,
      background: '#fef3c7',
      color: '#92400e',
      marginLeft: 8,
      verticalAlign: 'middle',
    },
    versionHeaderRow: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      marginBottom: 16,
      background: '#fff',
      padding: '12px 16px',
      borderRadius: 8,
      border: '1px solid #e5e7eb',
    },
    versionBadgeActive: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      background: '#dcfce7',
      color: '#15803d',
      border: '1px solid #bbf7d0',
      padding: '3px 10px',
      borderRadius: 14,
      fontSize: 12,
      fontWeight: 600,
    },
    versionBadgeCandidate: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      background: '#eff6ff',
      color: '#1d4ed8',
      border: '1px solid #bfdbfe',
      padding: '3px 10px',
      borderRadius: 14,
      fontSize: 12,
      fontWeight: 600,
    },
    subTabs: {
      display: 'flex',
      gap: 6,
      marginBottom: 20,
      borderBottom: '1px solid #e5e7eb',
      paddingBottom: 8,
    },
    subTab: {
      background: 'none',
      border: 'none',
      borderRadius: 6,
      padding: '8px 16px',
      fontSize: 13,
      cursor: 'pointer',
      color: '#6b7280',
      fontWeight: 600,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    subTabActive: {
      background: '#eff6ff',
      border: 'none',
      borderRadius: 6,
      padding: '8px 16px',
      fontSize: 13,
      cursor: 'pointer',
      color: '#2563eb',
      fontWeight: 700,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24, marginBottom: 20 },
    unavailableTitle: { fontSize: 18, fontWeight: 600, color: '#374151', marginBottom: 12 },
    unavailableText: { fontSize: 14, color: '#6b7280', lineHeight: 1.6 },
  };

  if (flagsError) {
    return (
      <div style={styles.container}>
        <ViewHeader
          title="Agent Lab"
          description="Agent training & alignment interface"
          badge={<span style={styles.pill}>Experimental</span>}
        />
        <div style={styles.card}>
          <p style={styles.unavailableText}>Failed to load feature flags: {flagsError}</p>
        </div>
      </div>
    );
  }

  if (!flags) {
    return (
      <div style={styles.container}>
        <ViewHeader
          title="Agent Lab"
          description="Agent training & alignment interface"
          badge={<span style={styles.pill}>Experimental</span>}
        />
        <p style={{ color: '#6b7280', fontSize: 14 }}>Loading agent flags…</p>
      </div>
    );
  }

  if (!flags.productIntelligenceEnabled) {
    return (
      <div style={styles.container}>
        <ViewHeader
          title="Agent Lab"
          description="Agent training & alignment interface"
          badge={<span style={styles.pill}>Experimental</span>}
        />
        <div style={styles.card}>
          <p style={styles.unavailableTitle}>Product Intelligence is disabled</p>
          <p style={styles.unavailableText}>
            Enable the master flag to use the Agent Lab training interface:
          </p>
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
      <ViewHeader
        title="Agent Lab"
        description="Agent training & alignment environment. Train, correct, benchmark, and promote Product Intelligence versions."
        badge={<span style={styles.pill}>Training Interface</span>}
      />

      {/* Version Status Summary Header */}
      <div style={styles.versionHeaderRow}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b' }}>Active Lineage:</span>
        {activeVersion ? (
          <div style={styles.versionBadgeActive}>
            <span>🛡️ Production: v{activeVersion.snapshot.versionNumber}.{activeVersion.snapshot.revisionNumber}</span>
          </div>
        ) : (
          <span style={{ fontSize: 12, color: '#94a3b8' }}>No active version</span>
        )}

        {candidateVersion && (
          <div style={styles.versionBadgeCandidate}>
            <span>🧪 Candidate: v{candidateVersion.snapshot.versionNumber}.{candidateVersion.snapshot.revisionNumber} ({candidateVersion.state.lifecycleStatus})</span>
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            onClick={() => setActiveTab('evaluate')}
            style={{
              background: '#f8fafc',
              border: '1px solid #cbd5e1',
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              color: '#334155',
            }}
          >
            ⚖️ Benchmark Scorecard
          </button>
        </div>
      </div>

      {/* Main 6 Navigation Tabs */}
      <div style={styles.subTabs}>
        <button
          style={activeTab === 'workbench' ? styles.subTabActive : styles.subTab}
          onClick={() => setActiveTab('workbench')}
        >
          <span>🔬</span> Workbench
        </button>
        <button
          style={activeTab === 'curriculum' ? styles.subTabActive : styles.subTab}
          onClick={() => setActiveTab('curriculum')}
        >
          <span>📚</span> Curriculum & Datasets
        </button>
        <button
          style={activeTab === 'evaluate' ? styles.subTabActive : styles.subTab}
          onClick={() => setActiveTab('evaluate')}
        >
          <span>⚖️</span> Evaluate
        </button>
        <button
          style={activeTab === 'config' ? styles.subTabActive : styles.subTab}
          onClick={() => setActiveTab('config')}
        >
          <span>⚙️</span> Agent Config
        </button>
        <button
          style={activeTab === 'versions' ? styles.subTabActive : styles.subTab}
          onClick={() => setActiveTab('versions')}
        >
          <span>📜</span> Versions
        </button>
        <button
          style={activeTab === 'runs' ? styles.subTabActive : styles.subTab}
          onClick={() => setActiveTab('runs')}
        >
          <span>📋</span> Runs
        </button>
      </div>

      {/* Tab Panels */}
      {activeTab === 'workbench' && (
        <AgentWorkbench
          activeVersion={activeVersion}
          candidateVersion={candidateVersion}
          flags={flags}
          onVersionUpdated={(v) => {
            setCandidateVersion(v);
            loadVersions();
          }}
        />
      )}

      {activeTab === 'curriculum' && <CurriculumExplorer />}

      {activeTab === 'evaluate' && (
        <EvaluationMatrix
          activeVersion={activeVersion}
          candidateVersion={candidateVersion}
          onVersionPromoted={(p) => {
            setActiveVersion(p);
            loadVersions();
          }}
        />
      )}

      {activeTab === 'config' && (
        <AgentConfigStudio
          activeVersion={activeVersion}
          candidateVersion={candidateVersion}
          onVersionSaved={(v) => {
            setCandidateVersion(v);
            loadVersions();
          }}
        />
      )}

      {activeTab === 'versions' && <VersionLineage />}

      {activeTab === 'runs' && <AgentRunList onSelect={(id) => setSelectedRunId(id)} />}
    </div>
  );
}
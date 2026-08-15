/**
 * Agent Lab: Evaluation Matrix.
 *
 * Side-by-side paired evaluation runner and case-level matrix comparing
 * Candidate vs Active Baseline versions with promotion gate verification.
 */
import React, { useEffect, useState } from 'react';
import {
  getAgentEvaluation,
  listAgentEvaluations,
  promoteAgentVersion,
  runAgentEvaluation,
  type AgentEvaluationCase,
  type AgentEvaluationSnapshot,
  type AgentVersionSummary,
} from '../../product-intelligence-api';

export interface EvaluationMatrixProps {
  activeVersion: AgentVersionSummary | null;
  candidateVersion: AgentVersionSummary | null;
  onVersionPromoted: (promoted: AgentVersionSummary) => void;
}

export function EvaluationMatrix({
  activeVersion,
  candidateVersion,
  onVersionPromoted,
}: EvaluationMatrixProps) {
  const [evaluations, setEvaluations] = useState<AgentEvaluationSnapshot[]>([]);
  const [selectedEvalId, setSelectedEvalId] = useState<string | null>(null);
  const [currentSnapshot, setCurrentSnapshot] = useState<AgentEvaluationSnapshot | null>(null);
  const [cases, setCases] = useState<AgentEvaluationCase[]>([]);
  const [filterClass, setFilterClass] = useState<'all' | 'fixed' | 'regressed' | 'critical' | 'unchanged'>('all');

  const [isRunning, setIsRunning] = useState(false);
  const [isPromoting, setIsPromoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadEvaluations();
  }, []);

  useEffect(() => {
    if (selectedEvalId) {
      loadEvaluationDetails(selectedEvalId);
    }
  }, [selectedEvalId]);

  async function loadEvaluations() {
    try {
      const list = await listAgentEvaluations();
      setEvaluations(list);
      if (list.length > 0 && !selectedEvalId) {
        setSelectedEvalId(list[0].id);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to list evaluations');
    }
  }

  async function loadEvaluationDetails(id: string) {
    try {
      const res = await getAgentEvaluation(id);
      setCurrentSnapshot(res.snapshot);
      setCases(res.cases);
    } catch (err: any) {
      setError(err.message || 'Failed to load evaluation cases');
    }
  }

  async function handleLaunchEvaluation() {
    if (!candidateVersion) {
      alert('No candidate version available to evaluate. Create a candidate first in Agent Config.');
      return;
    }

    setIsRunning(true);
    setError(null);
    try {
      const res = await runAgentEvaluation({
        candidateVersionId: candidateVersion.snapshot.id,
        baselineVersionId: activeVersion?.snapshot.id,
        splitGroup: 'test',
        actor: 'operator',
      });
      setCurrentSnapshot(res.snapshot);
      setCases(res.cases);
      setSelectedEvalId(res.snapshot.id);
      await loadEvaluations();
    } catch (err: any) {
      setError(err.message || 'Evaluation run failed');
    } finally {
      setIsRunning(false);
    }
  }

  async function handlePromote() {
    if (!candidateVersion || !currentSnapshot) return;
    const notes = window.prompt('Enter release notes for this agent promotion:', `Promoted via evaluation ${currentSnapshot.id.slice(0, 8)}`);
    if (notes === null) return;

    setIsPromoting(true);
    try {
      const res = await promoteAgentVersion({
        candidateVersionId: candidateVersion.snapshot.id,
        evaluationId: currentSnapshot.id,
        promotedBy: 'operator',
        notes,
      });
      onVersionPromoted(res);
      alert(`Agent Version v${res.snapshot.versionNumber}.${res.snapshot.revisionNumber} is now ACTIVE in production!`);
    } catch (err: any) {
      alert(err.message || 'Promotion failed');
    } finally {
      setIsPromoting(false);
    }
  }

  const filteredCases = cases.filter((c) => {
    if (filterClass === 'all') return true;
    if (filterClass === 'fixed') return c.deltaClass === 'fixed';
    if (filterClass === 'regressed') return c.deltaClass === 'regressed';
    if (filterClass === 'critical') return c.criticalRegression;
    if (filterClass === 'unchanged') return c.deltaClass === 'unchanged';
    return true;
  });

  const styles: Record<string, React.CSSProperties> = {
    container: { display: 'flex', flexDirection: 'column', gap: 20 },
    topBar: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      background: '#fff',
      padding: '16px 20px',
      borderRadius: 10,
      border: '1px solid #e5e7eb',
    },
    btnRun: {
      background: '#2563eb',
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      padding: '8px 16px',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    btnPromote: {
      background: '#16a34a',
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      padding: '8px 18px',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
    scorecardGrid: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
      gap: 12,
    },
    metricCard: {
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderRadius: 8,
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    },
    metricTitle: { fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase' },
    metricVal: { fontSize: 22, fontWeight: 700, color: '#0f172a' },
    metricSub: { fontSize: 12, color: '#64748b' },
    gateBannerPassed: {
      background: '#f0fdf4',
      border: '1px solid #bbf7d0',
      borderRadius: 8,
      padding: '16px 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    gateBannerDenied: {
      background: '#fef2f2',
      border: '1px solid #fecaca',
      borderRadius: 8,
      padding: '16px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    },
    filterBar: { display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' },
    filterBtn: {
      padding: '5px 12px',
      borderRadius: 16,
      border: '1px solid #e2e8f0',
      background: '#fff',
      fontSize: 12,
      fontWeight: 500,
      cursor: 'pointer',
      color: '#475569',
    },
    filterBtnActive: {
      padding: '5px 12px',
      borderRadius: 16,
      border: '1px solid #2563eb',
      background: '#eff6ff',
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
      color: '#2563eb',
    },
    tableCard: {
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
    deltaBadge: {
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 10,
      fontSize: 11,
      fontWeight: 600,
    },
  };

  const deltaColors = {
    fixed: { bg: '#dcfce7', color: '#15803d', label: '✓ Fixed' },
    regressed: { bg: '#fef3c7', color: '#b45309', label: '⚠️ Regressed' },
    critical: { bg: '#fee2e2', color: '#b91c1c', label: '🛑 Critical' },
    unchanged: { bg: '#f1f5f9', color: '#64748b', label: '— Unchanged' },
  };

  return (
    <div style={styles.container}>
      <div style={styles.topBar}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#1e293b' }}>
            Paired Benchmark Evaluation
          </div>
          <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>
            {candidateVersion
              ? `Evaluating Candidate v${candidateVersion.snapshot.versionNumber}.${candidateVersion.snapshot.revisionNumber} vs Baseline v${activeVersion?.snapshot.versionNumber ?? 1}.${activeVersion?.snapshot.revisionNumber ?? 1}`
              : 'No candidate version active'}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          {evaluations.length > 0 && (
            <select
              value={selectedEvalId || ''}
              onChange={(e) => setSelectedEvalId(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
            >
              {evaluations.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  Eval {ev.id.slice(0, 8)} ({ev.splitGroup}) — {ev.status.toUpperCase()}
                </option>
              ))}
            </select>
          )}

          <button
            onClick={handleLaunchEvaluation}
            style={styles.btnRun}
            disabled={isRunning || !candidateVersion}
          >
            {isRunning ? 'Evaluating Benchmark…' : '⚡ Run Paired Evaluation'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', color: '#b91c1c', padding: 12, borderRadius: 6, fontSize: 13 }}>
          {error}
        </div>
      )}

      {currentSnapshot && (
        <>
          {/* Promotion Gate Status Card */}
          {currentSnapshot.promotionGateVerdict.allowed ? (
            <div style={styles.gateBannerPassed}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#15803d', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>✓</span> PROMOTION GATE PASSED — Version Qualified
                </div>
                <div style={{ fontSize: 13, color: '#166534', marginTop: 4 }}>
                  Zero critical regressions detected. Measured exact product hit rate satisfies rollout thresholds.
                </div>
              </div>
              <button
                onClick={handlePromote}
                style={styles.btnPromote}
                disabled={isPromoting || candidateVersion?.state.lifecycleStatus === 'active'}
              >
                {isPromoting ? 'Promoting…' : '🚀 Promote to Production'}
              </button>
            </div>
          ) : (
            <div style={styles.gateBannerDenied}>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#b91c1c', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>🛑</span> PROMOTION GATE DENIED
              </div>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#991b1b' }}>
                {currentSnapshot.promotionGateVerdict.reasons.map((r: string, i: number) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Aggregate Scorecards */}
          <div style={styles.scorecardGrid}>
            <div style={styles.metricCard}>
              <span style={styles.metricTitle}>Exact Product Hit</span>
              <span style={styles.metricVal}>
                {(currentSnapshot.scorecard.candidateExactProductHit * 100).toFixed(1)}%
              </span>
              <span style={{ ...styles.metricSub, color: currentSnapshot.scorecard.deltaExactProductHit >= 0 ? '#16a34a' : '#dc2626' }}>
                {currentSnapshot.scorecard.deltaExactProductHit >= 0 ? '+' : ''}
                {(currentSnapshot.scorecard.deltaExactProductHit * 100).toFixed(1)}% vs baseline
              </span>
            </div>

            <div style={styles.metricCard}>
              <span style={styles.metricTitle}>Fixed / Improved</span>
              <span style={{ ...styles.metricVal, color: '#16a34a' }}>
                +{currentSnapshot.scorecard.fixedCount}
              </span>
              <span style={styles.metricSub}>Cases fixed vs baseline</span>
            </div>

            <div style={styles.metricCard}>
              <span style={styles.metricTitle}>Regressed</span>
              <span style={{ ...styles.metricVal, color: currentSnapshot.scorecard.regressedCount > 0 ? '#d97706' : '#64748b' }}>
                {currentSnapshot.scorecard.regressedCount}
              </span>
              <span style={styles.metricSub}>Non-critical regressions</span>
            </div>

            <div style={styles.metricCard}>
              <span style={styles.metricTitle}>Critical Regressions</span>
              <span style={{ ...styles.metricVal, color: currentSnapshot.scorecard.criticalRegressions > 0 ? '#dc2626' : '#16a34a' }}>
                {currentSnapshot.scorecard.criticalRegressions}
              </span>
              <span style={styles.metricSub}>Must be 0 to qualify</span>
            </div>

            <div style={styles.metricCard}>
              <span style={styles.metricTitle}>Total Test Cases</span>
              <span style={styles.metricVal}>
                {currentSnapshot.scorecard.completedCases} / {currentSnapshot.scorecard.totalCases}
              </span>
              <span style={styles.metricSub}>100% paired completion required</span>
            </div>
          </div>

          {/* Granular Case Table */}
          <div>
            <div style={styles.filterBar}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#64748b', marginRight: 4 }}>Filter:</span>
              <button
                style={filterClass === 'all' ? styles.filterBtnActive : styles.filterBtn}
                onClick={() => setFilterClass('all')}
              >
                All ({cases.length})
              </button>
              <button
                style={filterClass === 'fixed' ? styles.filterBtnActive : styles.filterBtn}
                onClick={() => setFilterClass('fixed')}
              >
                Fixed ({cases.filter((c) => c.deltaClass === 'fixed').length})
              </button>
              <button
                style={filterClass === 'regressed' ? styles.filterBtnActive : styles.filterBtn}
                onClick={() => setFilterClass('regressed')}
              >
                Regressed ({cases.filter((c) => c.deltaClass === 'regressed').length})
              </button>
              <button
                style={filterClass === 'critical' ? styles.filterBtnActive : styles.filterBtn}
                onClick={() => setFilterClass('critical')}
              >
                Critical ({cases.filter((c) => c.criticalRegression).length})
              </button>
              <button
                style={filterClass === 'unchanged' ? styles.filterBtnActive : styles.filterBtn}
                onClick={() => setFilterClass('unchanged')}
              >
                Unchanged ({cases.filter((c) => c.deltaClass === 'unchanged').length})
              </button>
            </div>

            <div style={styles.tableCard}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>SKU / UPC</th>
                    <th style={styles.th}>Delta Class</th>
                    <th style={styles.th}>Candidate Outcome</th>
                    <th style={styles.th}>Baseline Outcome</th>
                    <th style={styles.th}>Critical Flag</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCases.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', padding: 24, color: '#94a3b8' }}>
                        No cases match filter.
                      </td>
                    </tr>
                  ) : (
                    filteredCases.map((c) => {
                      const color = c.criticalRegression
                        ? deltaColors.critical
                        : (deltaColors as any)[c.deltaClass] || deltaColors.unchanged;

                      return (
                        <tr key={c.id}>
                          <td style={{ ...styles.td, fontFamily: 'monospace', fontWeight: 600 }}>
                            {c.productSku}
                          </td>
                          <td style={styles.td}>
                            <span
                              style={{
                                ...styles.deltaBadge,
                                background: color.bg,
                                color: color.color,
                              }}
                            >
                              {color.label}
                            </span>
                          </td>
                          <td style={styles.td}>
                            <span style={{ fontWeight: 500 }}>{c.candidateOutcome}</span>
                          </td>
                          <td style={styles.td}>
                            <span style={{ color: '#64748b' }}>{c.baselineOutcome}</span>
                          </td>
                          <td style={styles.td}>
                            {c.criticalRegression ? (
                              <span style={{ color: '#dc2626', fontWeight: 600, fontSize: 12 }}>
                                🛑 Critical Regression
                              </span>
                            ) : (
                              <span style={{ color: '#16a34a', fontSize: 12 }}>✓ Safe</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

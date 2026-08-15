/**
 * Agent Lab: Curriculum & Datasets Explorer.
 *
 * Browses frozen golden benchmark datasets across splits (Train, Validation,
 * Promotion Test, Holdout) with contamination tracking and split visibility safety.
 */
import React, { useEffect, useState } from 'react';
import {
  getCurriculumExamples,
  markCurriculumExampleContaminated,
  type CurriculumExample,
} from '../../product-intelligence-api';

export function CurriculumExplorer() {
  const [split, setSplit] = useState<'train' | 'validation' | 'promotion_test' | 'holdout'>('train');
  const [examples, setExamples] = useState<CurriculumExample[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedExample, setSelectedExample] = useState<CurriculumExample | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadExamples(split);
  }, [split]);

  async function loadExamples(targetSplit: string) {
    setIsLoading(true);
    setError(null);
    try {
      const list = await getCurriculumExamples(undefined, targetSplit);
      setExamples(list);
    } catch (err: any) {
      setError(err.message || 'Failed to load curriculum examples');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleMarkContaminated(exampleId: string) {
    const reason = window.prompt(
      'Enter reason for marking this validation case contaminated (e.g., inspected and taught in guideline rule):',
      'Inspected for teaching',
    );
    if (!reason) return;

    try {
      await markCurriculumExampleContaminated(exampleId, reason);
      await loadExamples(split);
      if (selectedExample?.id === exampleId) {
        setSelectedExample((prev) =>
          prev ? { ...prev, is_contaminated: 1, contamination_reason: reason } : null,
        );
      }
    } catch (err: any) {
      alert(err.message || 'Failed to mark case contaminated');
    }
  }

  const styles: Record<string, React.CSSProperties> = {
    container: { display: 'flex', flexDirection: 'column', gap: 16 },
    splitTabs: { display: 'flex', gap: 8, borderBottom: '1px solid #e5e7eb', paddingBottom: 12 },
    tab: {
      padding: '8px 16px',
      fontSize: 13,
      fontWeight: 600,
      borderRadius: 6,
      border: '1px solid #e5e7eb',
      background: '#fff',
      cursor: 'pointer',
      color: '#4b5563',
    },
    tabActive: {
      padding: '8px 16px',
      fontSize: 13,
      fontWeight: 600,
      borderRadius: 6,
      border: '1px solid #2563eb',
      background: '#eff6ff',
      cursor: 'pointer',
      color: '#2563eb',
    },
    card: {
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderRadius: 8,
      overflow: 'hidden',
    },
    infoBanner: {
      padding: '12px 16px',
      borderRadius: 8,
      fontSize: 13,
      lineHeight: 1.5,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
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
    tagPill: {
      display: 'inline-block',
      padding: '2px 6px',
      borderRadius: 4,
      fontSize: 11,
      background: '#f1f5f9',
      color: '#475569',
      marginRight: 4,
      marginBottom: 2,
    },
  };

  const splitDescriptions = {
    train: {
      title: 'Training Split (100% Inspectable)',
      desc: 'Used for formulating behavioral rules, discovering domain patterns, and providing in-context few-shot reference examples.',
      bg: '#f0fdf4',
      border: '#bbf7d0',
      color: '#166534',
    },
    validation: {
      title: 'Validation Split (Diagnostic Only)',
      desc: 'Used for tuning and error analysis. If an example is inspected to build a rule or few-shot example, it must be marked contaminated.',
      bg: '#fffbeb',
      border: '#fde68a',
      color: '#92400e',
    },
    promotion_test: {
      title: 'Promotion Test Split (Blind Regression Suite)',
      desc: 'Labels are hidden by default to prevent data leakage. Used by the Promotion Gate to measure exact product hit rates and critical regressions.',
      bg: '#eff6ff',
      border: '#bfdbfe',
      color: '#1e40af',
    },
    holdout: {
      title: 'Holdout Split (Protected)',
      desc: 'Completely protected holdout benchmark suite evaluated only on major version releases.',
      bg: '#faf5ff',
      border: '#e9d5ff',
      color: '#6b21a8',
    },
  };

  const currentMeta = splitDescriptions[split];

  return (
    <div style={styles.container}>
      <div style={styles.splitTabs}>
        <button
          style={split === 'train' ? styles.tabActive : styles.tab}
          onClick={() => setSplit('train')}
        >
          📚 Training Split
        </button>
        <button
          style={split === 'validation' ? styles.tabActive : styles.tab}
          onClick={() => setSplit('validation')}
        >
          🔍 Validation Split
        </button>
        <button
          style={split === 'promotion_test' ? styles.tabActive : styles.tab}
          onClick={() => setSplit('promotion_test')}
        >
          🛡️ Promotion Test Split (Hidden Labels)
        </button>
        <button
          style={split === 'holdout' ? styles.tabActive : styles.tab}
          onClick={() => setSplit('holdout')}
        >
          🔒 Holdout Split
        </button>
      </div>

      <div
        style={{
          ...styles.infoBanner,
          background: currentMeta.bg,
          border: `1px solid ${currentMeta.border}`,
          color: currentMeta.color,
        }}
      >
        <div>
          <strong>{currentMeta.title}:</strong> {currentMeta.desc}
        </div>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{examples.length} Cases</span>
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
              <th style={styles.th}>SKU / UPC</th>
              <th style={styles.th}>Register Title / Hint</th>
              <th style={styles.th}>Difficulty Tags</th>
              <th style={styles.th}>Contamination</th>
              <th style={styles.th}>Gold Labels</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: 30, color: '#6b7280' }}>
                  Loading curriculum cases…
                </td>
              </tr>
            ) : split === 'holdout' ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: 40, color: '#4b5563' }}>
                  <div style={{ fontSize: 24, marginBottom: 8 }}>🛡️</div>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Protected Holdout Split</div>
                  <div style={{ fontSize: 12, color: '#6b7280', maxWidth: 460, margin: '0 auto' }}>
                    Individual cases in the holdout split are strictly confidential and protected from direct browsing to prevent contamination and overfitting. Aggregate benchmarks are evaluated exclusively through automated reporting.
                  </div>
                </td>
              </tr>
            ) : examples.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: 30, color: '#6b7280' }}>
                  No cases found in {split} split.
                </td>
              </tr>
            ) : (
              examples.map((ex) => {
                let inputData: any;
                try {
                  inputData = JSON.parse(ex.input_snapshot_json || ex.product_input_json || '{}');
                } catch {
                  inputData = {};
                }

                let goldData: any;
                if (ex.gold_labels_json) {
                  try {
                    goldData = JSON.parse(ex.gold_labels_json);
                  } catch {
                    goldData = null;
                  }
                } else {
                  goldData = null;
                }

                const isContaminated = ex.is_contaminated === 1;

                return (
                  <tr key={ex.id}>
                    <td style={{ ...styles.td, fontFamily: 'monospace', fontWeight: 600 }}>
                      {ex.product_sku || ex.upc || 'N/A'}
                    </td>
                    <td style={styles.td}>
                      {inputData.registerName || inputData.brandHint || '(untitled input)'}
                    </td>
                    <td style={styles.td}>
                      {goldData?.difficultyTags?.length > 0 ? (
                        goldData.difficultyTags.map((t: string) => (
                          <span key={t} style={styles.tagPill}>
                            {t}
                          </span>
                        ))
                      ) : (
                        <span style={{ color: '#9ca3af', fontSize: 12 }}>—</span>
                      )}
                    </td>
                    <td style={styles.td}>
                      {isContaminated ? (
                        <span
                          style={{
                            ...styles.badge,
                            background: '#fee2e2',
                            color: '#991b1b',
                          }}
                          title={ex.contamination_reason || 'Contaminated'}
                        >
                          ⚠️ Contaminated
                        </span>
                      ) : (
                        <span
                          style={{
                            ...styles.badge,
                            background: '#dcfce7',
                            color: '#15803d',
                          }}
                        >
                          ✓ Clean
                        </span>
                      )}
                    </td>
                    <td style={styles.td}>
                      {ex.gold_labels_json ? (
                        <span style={{ color: '#16a34a', fontSize: 12, fontWeight: 500 }}>
                          ✓ Available
                        </span>
                      ) : (
                        <span style={{ color: '#6b7280', fontSize: 12, fontStyle: 'italic' }}>
                          🔒 Hidden (Test Invariant)
                        </span>
                      )}
                    </td>
                    <td style={styles.td}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          onClick={() => setSelectedExample(ex)}
                          style={{
                            background: '#f3f4f6',
                            border: '1px solid #d1d5db',
                            borderRadius: 4,
                            padding: '3px 8px',
                            fontSize: 12,
                            cursor: 'pointer',
                          }}
                        >
                          Inspect
                        </button>
                        {split === 'validation' && !isContaminated && (
                          <button
                            onClick={() => handleMarkContaminated(ex.id)}
                            style={{
                              background: '#fff1f2',
                              border: '1px solid #fecdd3',
                              color: '#be123c',
                              borderRadius: 4,
                              padding: '3px 8px',
                              fontSize: 12,
                              cursor: 'pointer',
                            }}
                          >
                            Mark Contaminated
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {selectedExample && (
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
              Inspection Drawer: Case {selectedExample.product_sku}
            </h4>
            <button
              onClick={() => setSelectedExample(null)}
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
            {JSON.stringify(
              {
                sku: selectedExample.product_sku,
                split: selectedExample.split_group,
                is_contaminated: selectedExample.is_contaminated === 1,
                contamination_reason: selectedExample.contamination_reason,
                input: JSON.parse(selectedExample.product_input_json || '{}'),
                gold: selectedExample.gold_labels_json
                  ? JSON.parse(selectedExample.gold_labels_json)
                  : '(HIDDEN BY SPLIT POLICY)',
              },
              null,
              2,
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

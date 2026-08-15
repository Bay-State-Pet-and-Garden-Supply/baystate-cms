/**
 * Agent Lab: Teach Modal.
 *
 * Dedicated modal that closes the human teaching loop:
 * Inspect Mistake → Correct Fields → Generate Guidance / Few-Shot → Fork Candidate Snapshot.
 */
import React, { useState } from 'react';
import { teachAgent, type AgentVersionSummary } from '../../product-intelligence-api';

export interface TeachModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (newVersion: AgentVersionSummary) => void;
  runId: string;
  versionId: string;
  originalResultHash: string;
  initialGtin?: string;
  initialRegisterName?: string;
  initialExtractedTitle?: string;
  initialBrand?: string;
  initialFacts?: Array<{ field: string; value: string }>;
}

export function TeachModal({
  isOpen,
  onClose,
  onSuccess,
  runId: _runId,
  versionId,
  originalResultHash: _originalResultHash,
  initialGtin = '',
  initialRegisterName = '',
  initialExtractedTitle = '',
  initialBrand = '',
  initialFacts = [],
}: TeachModalProps) {
  const [strategy, setStrategy] = useState<'rule' | 'few_shot' | 'negative_pattern'>('rule');
  const [category, setCategory] = useState<'facts' | 'identity' | 'extraction' | 'classification' | 'sources' | 'abstention'>('facts');
  const [ruleText, setRuleText] = useState('');
  const [explanation, setExplanation] = useState('');
  const [rationale, setRationale] = useState('');
  const [failureMode, setFailureMode] = useState('wrong_size_retailer');
  const [correctedTitle, setCorrectedTitle] = useState(initialExtractedTitle || initialRegisterName);
  const [correctedBrand, setCorrectedBrand] = useState(initialBrand);
  const [forbiddenDomain, setForbiddenDomain] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!rationale.trim()) {
      setError('Please provide a short rationale explaining why this correction is being taught.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const actions: any[] = [];
      if (strategy === 'rule') {
        if (!ruleText.trim()) throw new Error('Rule text cannot be empty');
        actions.push({
          type: 'add_rule',
          category,
          rule: ruleText.trim(),
        });
      } else if (strategy === 'few_shot') {
        if (!explanation.trim()) throw new Error('Please provide an explanation for the few-shot example');
        actions.push({
          type: 'add_few_shot',
          gtin: initialGtin || 'unknown',
          registerName: initialRegisterName || 'unknown',
          brandHint: correctedBrand || undefined,
          expectedOutput: {
            title: correctedTitle.trim(),
            brand: correctedBrand.trim() || null,
            facts: initialFacts,
            categoryPages: [],
            forbiddenSourceDomains: [],
            shouldAbstain: false,
          },
          explanation: explanation.trim(),
          difficultyTags: [failureMode],
        });
      } else if (strategy === 'negative_pattern') {
        if (!forbiddenDomain.trim()) throw new Error('Domain cannot be empty');
        actions.push({
          type: 'add_negative_pattern',
          domain: forbiddenDomain.trim(),
          reason: rationale.trim(),
        });
      }

      const res = await teachAgent({
        correctionId: `corr-${Date.now()}`,
        baseVersionId: versionId,
        actions,
        rationale: rationale.trim(),
        createdBy: 'operator',
      });

      onSuccess(res.version);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to teach agent');
    } finally {
      setIsSubmitting(false);
    }
  }

  const styles: Record<string, React.CSSProperties> = {
    overlay: {
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(17, 24, 39, 0.6)',
      backdropFilter: 'blur(2px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
      padding: 16,
    },
    modal: {
      backgroundColor: '#ffffff',
      borderRadius: 12,
      width: '100%',
      maxWidth: 640,
      maxHeight: '90vh',
      display: 'flex',
      flexDirection: 'column',
      boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
      border: '1px solid #e5e7eb',
      overflow: 'hidden',
    },
    header: {
      padding: '16px 20px',
      borderBottom: '1px solid #f3f4f6',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      background: '#fafafa',
    },
    title: { fontSize: 16, fontWeight: 600, color: '#111827', margin: 0, display: 'flex', alignItems: 'center', gap: 8 },
    body: { padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 16 },
    footer: {
      padding: '14px 20px',
      borderTop: '1px solid #f3f4f6',
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 10,
      background: '#fafafa',
    },
    label: { fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'block' },
    input: {
      width: '100%',
      padding: '8px 12px',
      borderRadius: 6,
      border: '1px solid #d1d5db',
      fontSize: 13,
      boxSizing: 'border-box',
    },
    textarea: {
      width: '100%',
      padding: '8px 12px',
      borderRadius: 6,
      border: '1px solid #d1d5db',
      fontSize: 13,
      minHeight: 70,
      fontFamily: 'inherit',
      boxSizing: 'border-box',
    },
    select: {
      width: '100%',
      padding: '8px 12px',
      borderRadius: 6,
      border: '1px solid #d1d5db',
      fontSize: 13,
      background: '#fff',
      boxSizing: 'border-box',
    },
    btnPrimary: {
      background: '#2563eb',
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      padding: '8px 16px',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
    },
    btnSecondary: {
      background: '#fff',
      color: '#374151',
      border: '1px solid #d1d5db',
      borderRadius: 6,
      padding: '8px 14px',
      fontSize: 13,
      fontWeight: 500,
      cursor: 'pointer',
    },
    strategyTabs: { display: 'flex', gap: 6, marginBottom: 8 },
    strategyBtn: {
      flex: 1,
      padding: '8px 10px',
      fontSize: 12,
      fontWeight: 600,
      border: '1px solid #e5e7eb',
      borderRadius: 6,
      background: '#fff',
      cursor: 'pointer',
      color: '#4b5563',
      textAlign: 'center',
    },
    strategyBtnActive: {
      flex: 1,
      padding: '8px 10px',
      fontSize: 12,
      fontWeight: 600,
      border: '1px solid #2563eb',
      borderRadius: 6,
      background: '#eff6ff',
      cursor: 'pointer',
      color: '#2563eb',
      textAlign: 'center',
    },
    contextCard: {
      background: '#f8fafc',
      border: '1px solid #e2e8f0',
      borderRadius: 6,
      padding: 12,
      fontSize: 12,
      color: '#475569',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
    },
    errorAlert: {
      background: '#fef2f2',
      border: '1px solid #fecaca',
      color: '#b91c1c',
      padding: '8px 12px',
      borderRadius: 6,
      fontSize: 13,
    },
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h3 style={styles.title}>
            <span>🎓</span> Teach Agent from Run
          </h3>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: '#9ca3af' }}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={styles.body}>
            {error && <div style={styles.errorAlert}>{error}</div>}

            <div style={styles.contextCard}>
              <div><strong>SKU / GTIN:</strong> {initialGtin || '(none)'}</div>
              <div><strong>Register Name:</strong> {initialRegisterName || '(none)'}</div>
              <div><strong>Original Extraction:</strong> {initialExtractedTitle || '(none)'}</div>
            </div>

            <div>
              <label style={styles.label}>Teaching Strategy</label>
              <div style={styles.strategyTabs}>
                <button
                  type="button"
                  style={strategy === 'rule' ? styles.strategyBtnActive : styles.strategyBtn}
                  onClick={() => setStrategy('rule')}
                >
                  📝 Add Guideline Rule
                </button>
                <button
                  type="button"
                  style={strategy === 'few_shot' ? styles.strategyBtnActive : styles.strategyBtn}
                  onClick={() => setStrategy('few_shot')}
                >
                  💡 Add Few-Shot Example
                </button>
                <button
                  type="button"
                  style={strategy === 'negative_pattern' ? styles.strategyBtnActive : styles.strategyBtn}
                  onClick={() => setStrategy('negative_pattern')}
                >
                  🚫 Negative Source Pattern
                </button>
              </div>
            </div>

            {strategy === 'rule' && (
              <>
                <div>
                  <label style={styles.label}>Guideline Category</label>
                  <select
                    style={styles.select}
                    value={category}
                    onChange={(e) => setCategory(e.target.value as any)}
                  >
                    <option value="facts">Fact Prioritization & Multipack Conflicts</option>
                    <option value="identity">Identity & UPC/GTIN Resolution</option>
                    <option value="extraction">Web Extraction & Sizing</option>
                    <option value="classification">Taxonomy & Category Assignment</option>
                    <option value="sources">Source Preferences & Domain Authority</option>
                    <option value="abstention">Abstention Criteria</option>
                  </select>
                </div>

                <div>
                  <label style={styles.label}>Guideline Instruction Rule</label>
                  <textarea
                    style={styles.textarea}
                    placeholder="e.g. When register price indicates single unit (<$5), do not resolve to 12-pack case SKU even if brand site lists pack."
                    value={ruleText}
                    onChange={(e) => setRuleText(e.target.value)}
                  />
                </div>
              </>
            )}

            {strategy === 'few_shot' && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={styles.label}>Corrected Store Title</label>
                    <input
                      style={styles.input}
                      value={correctedTitle}
                      onChange={(e) => setCorrectedTitle(e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={styles.label}>Corrected Brand</label>
                    <input
                      style={styles.input}
                      value={correctedBrand}
                      onChange={(e) => setCorrectedBrand(e.target.value)}
                    />
                  </div>
                </div>

                <div>
                  <label style={styles.label}>Failure Mode Tag</label>
                  <select
                    style={styles.select}
                    value={failureMode}
                    onChange={(e) => setFailureMode(e.target.value)}
                  >
                    <option value="wrong_size_retailer">Wrong Size / Multipack Extrapolation</option>
                    <option value="unofficial_store">Misleading Unofficial Source</option>
                    <option value="upc_normalization">UPC / GTIN Leading Zero Truncation</option>
                    <option value="flavor_formula_mismatch">Flavor / Formula Confusion</option>
                    <option value="image_rights_violation">Image Rights Violation</option>
                  </select>
                </div>

                <div>
                  <label style={styles.label}>Reasoning Explanation (for Agent Context)</label>
                  <textarea
                    style={styles.textarea}
                    placeholder="Explain why the corrected title/brand is right and what signal to prioritize."
                    value={explanation}
                    onChange={(e) => setExplanation(e.target.value)}
                  />
                </div>
              </>
            )}

            {strategy === 'negative_pattern' && (
              <div>
                <label style={styles.label}>Forbidden / Misleading Domain</label>
                <input
                  style={styles.input}
                  placeholder="e.g. spammy-reseller.com"
                  value={forbiddenDomain}
                  onChange={(e) => setForbiddenDomain(e.target.value)}
                />
              </div>
            )}

            <div>
              <label style={styles.label}>Teaching Rationale (Audit Log & Lineage)</label>
              <input
                style={styles.input}
                placeholder="e.g. Taught single-can price conflict rule from Blue Buffalo SKU"
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
              />
            </div>
          </div>

          <div style={styles.footer}>
            <button type="button" style={styles.btnSecondary} onClick={onClose} disabled={isSubmitting}>
              Cancel
            </button>
            <button type="submit" style={styles.btnPrimary} disabled={isSubmitting}>
              {isSubmitting ? 'Teaching & Forking…' : 'Teach Agent (Create Candidate Revision)'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

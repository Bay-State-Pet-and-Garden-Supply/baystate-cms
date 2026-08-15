/**
 * Agent Lab: Agent Config Studio.
 *
 * Behavioral domain guidance & few-shot example studio. Allows editing
 * domain instruction rules, budgeting in-context examples, and saving
 * immutable candidate version snapshots.
 */
import React, { useState } from 'react';
import {
  createCandidateAgentVersion,
  type AgentFewShotExample,
  type AgentInstructionRule,
  type AgentVersionSummary,
} from '../../product-intelligence-api';

export interface AgentConfigStudioProps {
  activeVersion: AgentVersionSummary | null;
  candidateVersion: AgentVersionSummary | null;
  onVersionSaved: (newVersion: AgentVersionSummary) => void;
}

const CATEGORY_META = {
  facts: { label: 'Fact Prioritization & Multipack Conflicts', desc: 'Rules for resolving unit price vs case pack discrepancies.' },
  identity: { label: 'Identity & GTIN Resolution', desc: 'Rules for barcode normalization and variant disambiguation.' },
  extraction: { label: 'Web Extraction & Sizing', desc: 'Rules for extracting ounces, pounds, counts, and dimensions.' },
  classification: { label: 'Taxonomy & Category Assignment', desc: 'Rules for internal product type and category page selection.' },
  sources: { label: 'Source Preferences & Anti-Patterns', desc: 'Domain authority guidelines and third-party reseller demotion.' },
  abstention: { label: 'Abstention Criteria', desc: 'Mandatory triggers for honest abstention when evidence is insufficient.' },
};

export function AgentConfigStudio({
  activeVersion,
  candidateVersion,
  onVersionSaved,
}: AgentConfigStudioProps) {
  // Use candidate version if available, otherwise active baseline
  const baseVersion = candidateVersion ?? activeVersion;

  const [instructions, setInstructions] = useState<AgentInstructionRule[]>(
    baseVersion?.snapshot.instructions ?? [],
  );
  const [fewShotExamples, setFewShotExamples] = useState<AgentFewShotExample[]>(
    baseVersion?.snapshot.fewShotExamples ?? [],
  );
  const [tokenBudget, setTokenBudget] = useState<number>(
    baseVersion?.snapshot.fewShotTokenBudget ?? 4000,
  );
  const [changeSummary, setChangeSummary] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New rule state
  const [newRuleCat, setNewRuleCat] = useState<'facts' | 'identity' | 'extraction' | 'classification' | 'sources' | 'abstention'>('facts');
  const [newRuleText, setNewRuleText] = useState('');

  // Sync state if base version changes
  React.useEffect(() => {
    if (baseVersion) {
      setInstructions(baseVersion.snapshot.instructions);
      setFewShotExamples(baseVersion.snapshot.fewShotExamples);
      setTokenBudget(baseVersion.snapshot.fewShotTokenBudget);
    }
  }, [baseVersion?.snapshot.id]);

  const usedTokens = fewShotExamples
    .filter((e) => e.isActive)
    .reduce((acc, e) => acc + (e.tokenCount || 100), 0);

  const tokenUsagePercent = Math.min(100, Math.round((usedTokens / tokenBudget) * 100));

  function handleAddRule() {
    if (!newRuleText.trim()) return;
    const rule: AgentInstructionRule = {
      id: `rule-${Date.now()}`,
      category: newRuleCat,
      rule: newRuleText.trim(),
      createdAt: new Date().toISOString(),
    };
    setInstructions([...instructions, rule]);
    setNewRuleText('');
  }

  function handleRemoveRule(id: string) {
    setInstructions(instructions.filter((r) => r.id !== id));
  }

  function handleToggleExample(id: string) {
    setFewShotExamples(
      fewShotExamples.map((ex) => (ex.id === id ? { ...ex, isActive: !ex.isActive } : ex)),
    );
  }

  function handleRemoveExample(id: string) {
    setFewShotExamples(fewShotExamples.filter((ex) => ex.id !== id));
  }

  async function handleSaveCandidate(e: React.FormEvent) {
    e.preventDefault();
    if (!changeSummary.trim()) {
      setError('Please provide a brief change summary describing this candidate revision.');
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const res = await createCandidateAgentVersion({
        parentVersionId: baseVersion?.snapshot.id,
        instructions,
        fewShotExamples,
        fewShotTokenBudget: tokenBudget,
        createdBy: 'operator',
        changeSummary: changeSummary.trim(),
      });
      onVersionSaved(res);
      setChangeSummary('');
      alert(`Saved Candidate Revision v${res.snapshot.versionNumber}.${res.snapshot.revisionNumber}!`);
    } catch (err: any) {
      setError(err.message || 'Failed to save candidate version');
    } finally {
      setIsSaving(false);
    }
  }

  const styles: Record<string, React.CSSProperties> = {
    container: { display: 'flex', flexDirection: 'column', gap: 20 },
    headerCard: {
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderRadius: 10,
      padding: '16px 20px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    versionTitle: { fontSize: 16, fontWeight: 700, color: '#111827', margin: 0 },
    section: {
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderRadius: 10,
      padding: 20,
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    },
    sectionTitle: { fontSize: 14, fontWeight: 700, color: '#1f2937', margin: 0 },
    sectionDesc: { fontSize: 12, color: '#6b7280', margin: '4px 0 0 0' },
    ruleCard: {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      padding: '10px 14px',
      background: '#f8fafc',
      border: '1px solid #e2e8f0',
      borderRadius: 6,
      fontSize: 13,
      lineHeight: 1.5,
    },
    btnDelete: {
      background: 'none',
      border: 'none',
      color: '#94a3b8',
      cursor: 'pointer',
      fontSize: 14,
      padding: '0 4px',
    },
    addRuleBox: {
      display: 'flex',
      gap: 10,
      alignItems: 'center',
      background: '#f1f5f9',
      padding: 12,
      borderRadius: 8,
    },
    input: {
      flex: 1,
      padding: '8px 12px',
      borderRadius: 6,
      border: '1px solid #cbd5e1',
      fontSize: 13,
    },
    select: {
      padding: '8px 12px',
      borderRadius: 6,
      border: '1px solid #cbd5e1',
      fontSize: 13,
      background: '#fff',
    },
    btnAdd: {
      background: '#3b82f6',
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      padding: '8px 16px',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
    },
    tokenMeter: {
      background: '#f8fafc',
      border: '1px solid #e2e8f0',
      borderRadius: 8,
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    },
    progressBarOuter: {
      width: '100%',
      height: 8,
      borderRadius: 4,
      background: '#e2e8f0',
      overflow: 'hidden',
    },
    progressBarInner: {
      height: '100%',
      background: tokenUsagePercent > 90 ? '#ef4444' : tokenUsagePercent > 70 ? '#f59e0b' : '#10b981',
      width: `${tokenUsagePercent}%`,
      transition: 'width 0.3s ease',
    },
    securityBanner: {
      background: '#f8fafc',
      border: '1px dashed #cbd5e1',
      borderRadius: 8,
      padding: 16,
      fontSize: 12,
      color: '#475569',
      lineHeight: 1.5,
    },
  };

  return (
    <div style={styles.container}>
      <div style={styles.headerCard}>
        <div>
          <h2 style={styles.versionTitle}>
            ⚙️ Agent Configuration & Guidance Studio
          </h2>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
            Editing target:{' '}
            <strong>
              v{baseVersion?.snapshot.versionNumber ?? 1}.{baseVersion?.snapshot.revisionNumber ?? 1} (
              {baseVersion?.state.lifecycleStatus ?? 'active'})
            </strong>
          </div>
        </div>

        <form
          onSubmit={handleSaveCandidate}
          style={{ display: 'flex', gap: 10, alignItems: 'center' }}
        >
          <input
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13, width: 260 }}
            placeholder="Change summary (e.g. Added sizing guidelines)"
            value={changeSummary}
            onChange={(e) => setChangeSummary(e.target.value)}
          />
          <button
            type="submit"
            style={{
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            disabled={isSaving}
          >
            {isSaving ? 'Saving…' : '💾 Save as New Candidate Revision'}
          </button>
        </form>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', color: '#b91c1c', padding: 12, borderRadius: 6 }}>
          {error}
        </div>
      )}

      {/* Security & Runtime Audit Note */}
      <div style={styles.securityBanner}>
        <strong>🛡️ Safety & Execution Boundary Architecture:</strong> Hard constraints (tool access allowlists,
        SSRF network filters, timeout budgets, and rights validation) are enforced by deterministic CMS runtime
        code and cannot be weakened here. This studio configures <em>behavioral guidance</em> and <em>in-context reference examples</em>.
      </div>

      {/* Behavioral Domain Guidelines */}
      <div style={styles.section}>
        <div>
          <h3 style={styles.sectionTitle}>Behavioral Domain Guidelines ({instructions.length} rules)</h3>
          <p style={styles.sectionDesc}>
            Categorized instruction rules compiled into the agent session prompt.
          </p>
        </div>

        <div style={styles.addRuleBox}>
          <select
            style={styles.select}
            value={newRuleCat}
            onChange={(e) => setNewRuleCat(e.target.value as any)}
          >
            {Object.entries(CATEGORY_META).map(([key, meta]) => (
              <option key={key} value={key}>
                {meta.label}
              </option>
            ))}
          </select>
          <input
            style={styles.input}
            placeholder="Add new instruction rule (e.g. Prioritize manufacturer spec sheet over retail description)"
            value={newRuleText}
            onChange={(e) => setNewRuleText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddRule();
              }
            }}
          />
          <button type="button" style={styles.btnAdd} onClick={handleAddRule}>
            + Add Rule
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {instructions.length === 0 ? (
            <div style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic', padding: 12 }}>
              No custom behavioral rules configured. The agent operates under the default baseline prompt.
            </div>
          ) : (
            instructions.map((r) => (
              <div key={r.id} style={styles.ruleCard}>
                <div>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      color: '#475569',
                      background: '#e2e8f0',
                      padding: '2px 6px',
                      borderRadius: 4,
                      marginRight: 8,
                    }}
                  >
                    {r.category}
                  </span>
                  <span>{r.rule}</span>
                </div>
                <button
                  type="button"
                  style={styles.btnDelete}
                  onClick={() => handleRemoveRule(r.id)}
                  title="Remove rule"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* In-Context Few-Shot Examples */}
      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 style={styles.sectionTitle}>In-Context Reference Examples ({fewShotExamples.length} examples)</h3>
            <p style={styles.sectionDesc}>
              Exemplar inputs and expected outputs budgeted deterministically into the agent prompt.
            </p>
          </div>
        </div>

        {/* Token Budget Meter */}
        <div style={styles.tokenMeter}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, color: '#334155' }}>
            <span>In-Context Token Budget Usage</span>
            <span>
              {usedTokens} / {tokenBudget} tokens ({tokenUsagePercent}%)
            </span>
          </div>
          <div style={styles.progressBarOuter}>
            <div style={styles.progressBarInner} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {fewShotExamples.length === 0 ? (
            <div style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic', padding: 12 }}>
              No few-shot examples added yet. Teach examples from the Workbench or Curriculum tabs.
            </div>
          ) : (
            fewShotExamples.map((ex) => (
              <div
                key={ex.id}
                style={{
                  border: '1px solid #e2e8f0',
                  borderRadius: 8,
                  padding: 14,
                  background: ex.isActive ? '#fff' : '#f8fafc',
                  opacity: ex.isActive ? 1 : 0.6,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={ex.isActive}
                      onChange={() => handleToggleExample(ex.id)}
                      title="Toggle active"
                    />
                    <strong style={{ fontSize: 13 }}>
                      {ex.gtin} ({ex.registerName})
                    </strong>
                    <span style={{ fontSize: 11, color: '#64748b' }}>
                      ~{ex.tokenCount || 100} tokens
                    </span>
                  </div>
                  <button
                    type="button"
                    style={styles.btnDelete}
                    onClick={() => handleRemoveExample(ex.id)}
                  >
                    ✕
                  </button>
                </div>
                <div style={{ fontSize: 12, color: '#475569', marginBottom: 6 }}>
                  <strong>Rationale:</strong> {ex.explanation}
                </div>
                <pre
                  style={{
                    background: '#f8fafc',
                    padding: 8,
                    borderRadius: 4,
                    fontSize: 11,
                    margin: 0,
                    overflowX: 'auto',
                    border: '1px solid #f1f5f9',
                  }}
                >
                  {JSON.stringify(ex.expectedOutput, null, 2)}
                </pre>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

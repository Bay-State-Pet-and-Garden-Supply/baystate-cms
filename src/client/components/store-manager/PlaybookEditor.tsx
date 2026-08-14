import React, { useEffect, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import {
  fetchStoreManagerPlaybookDetail,
  saveStoreManagerPlaybookDraft,
  activateStoreManagerPlaybook,
  type StoreManagerPlaybookDetail,
  type StoreManagerPlaybookVersion,
} from '../../store-manager-api';
import {
  stepKindLabel,
  stepSummary,
  riskClassLabel,
  riskTone,
  networkActivityLabel,
  stepSequence,
  variableTypeLabel,
} from '../../store-manager-playbook-logic';

interface PlaybookEditorProps {
  playbookId: string;
  onClose: () => void;
  onSaved: () => void;
}

const TONE_COLOR: Record<string, string> = {
  ok: '#2f5d3a',
  warn: '#8a6116',
  bad: '#8b1e2d',
  neutral: colors.mulchBrown,
};

/**
 * Playbook Editor — version history, risk badges, step contracts, and
 * activation review. Drafts are immutable version rows: "Save draft" appends a
 * new version and never mutates prior ones. Activation is an explicit reviewed
 * action with the active hash shown. There is deliberately NO "trust this
 * playbook" toggle and NO run button — execution arrives in Issue 7 and is
 * gated by flags + approval checkpoints.
 */
export function PlaybookEditor({ playbookId, onClose, onSaved }: PlaybookEditorProps) {
  const [detail, setDetail] = useState<StoreManagerPlaybookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const load = async () => {
    setError(null);
    try {
      setDetail(await fetchStoreManagerPlaybookDetail(playbookId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbookId]);

  const latest = detail?.versions[0];
  const active = detail?.playbook.status === 'active';

  const handleSaveDraft = async () => {
    if (!detail || !latest) return;
    setBusy(true);
    setError(null);
    try {
      await saveStoreManagerPlaybookDraft(playbookId, {
        name: name.trim() || latest.name,
        description: description.trim() || latest.description,
        scopeInput: latest.scopeInput,
        variables: latest.variables,
        steps: latest.steps,
      });
      setEditing(false);
      await load();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleActivate = async (version: StoreManagerPlaybookVersion) => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await activateStoreManagerPlaybook(playbookId, version.version);
      await load();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const renderRiskBadge = (riskClass: string) => {
    const tone = riskTone(riskClass as never);
    return (
      <span
        style={{
          display: 'inline-block',
          fontSize: '10px',
          fontWeight: 700,
          padding: '2px 6px',
          borderRadius: rounded.sm,
          background: tone === 'bad' ? '#fbecec' : tone === 'warn' ? '#faf3e4' : '#eef4ef',
          color: TONE_COLOR[tone],
          marginRight: 4,
        }}
      >
        {riskClassLabel(riskClass as never)}
      </span>
    );
  };

  return (
    <div
      role="dialog"
      aria-label="Playbook editor"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(33,20,20,0.45)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 'min(880px, 92vw)',
          maxHeight: '88vh',
          overflowY: 'auto',
          background: colors.whiteSurface,
          borderRadius: rounded.lg,
          border: `1px solid ${colors.cardBorder}`,
          boxShadow: '0 16px 48px rgba(33,20,20,0.2)',
          padding: '20px 24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ fontSize: '18px', fontWeight: 700, fontFamily: fonts.display, color: colors.ledgerCharcoal, margin: 0 }}>
            📋 {detail?.playbook.name ?? 'Playbook'}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close playbook editor"
            className="btn btn-outline"
            style={{ height: '2rem', fontSize: '0.75rem', padding: '0 12px' }}
          >
            Close
          </button>
        </div>

        {error && (
          <div style={{ background: '#fbecec', color: '#8b1e2d', padding: '8px 12px', borderRadius: rounded.md, fontSize: '12px', marginBottom: 12 }}>
            {error}
          </div>
        )}

        {latest && (
          <>
            {/* Status + activation banner */}
            <div
              style={{
                border: `1px solid ${colors.cardBorder}`,
                borderRadius: rounded.md,
                padding: 12,
                marginBottom: 12,
                background: active ? '#eef4ef' : '#faf9f6',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: '12px', color: colors.ledgerCharcoal }}>
                  {active ? `Active v${detail?.playbook.activeVersion}` : `Draft (inert) v${latest.version}`}
                </span>
                {active && (
                  <span style={{ fontSize: '11px', color: TONE_COLOR.ok }}>
                    hash {(detail?.playbook.activeHash ?? '').slice(0, 12)}… activated{' '}
                    {detail?.playbook.activatedAt ? new Date(detail.playbook.activatedAt).toLocaleString() : ''} by{' '}
                    {detail?.playbook.activatedBy ?? 'operator'}
                  </span>
                )}
                {!active && (
                  <span style={{ fontSize: '11px', color: colors.mulchBrown }}>
                    Templates and drafts do nothing until explicitly activated.
                  </span>
                )}
              </div>
              {!active && (
                <button
                  type="button"
                  onClick={() => void handleActivate(latest)}
                  disabled={busy}
                  className="btn btn-primary"
                  style={{ height: '2rem', fontSize: '0.75rem', padding: '0 12px', marginTop: 8 }}
                >
                  {busy ? 'Activating…' : 'Review + activate this version'}
                </button>
              )}
            </div>

            {/* Step contracts + risk */}
            <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 6 }}>
                Step contracts
              </div>
              <div style={{ fontSize: '11px', color: colors.mulchBrown, marginBottom: 8 }}>
                {stepSequence(latest.steps)}
              </div>
              <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {latest.steps.map((step) => (
                  <li key={step.stepId} style={{ fontSize: '12px', color: colors.ledgerCharcoal }}>
                    <span style={{ fontWeight: 700 }}>{stepKindLabel(step.kind)}</span>
                    <span style={{ color: colors.mulchBrown }}> — {stepSummary(step)}</span>
                  </li>
                ))}
              </ol>
              <div style={{ marginTop: 10, fontSize: '11px', color: colors.mulchBrown }}>
                Variables:{' '}
                {latest.variables.length === 0
                  ? 'none'
                  : latest.variables.map((v) => `${v.name} (${variableTypeLabel(v.type)}${v.required ? '' : ', optional'})`).join(', ')}
              </div>
            </div>

            {/* Static risk (registry-derived shape) */}
            <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 6 }}>
                Static risk (registry-derived)
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                {latest.scopeInput.allowedKinds.length === 0 ? (
                  <span style={{ fontSize: '11px', color: colors.mulchBrown }}>Catalog-wide scope</span>
                ) : (
                  <span style={{ fontSize: '11px', color: colors.mulchBrown }}>Scope: {latest.scopeInput.allowedKinds.join(', ')}</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {latest.steps
                  .filter((s) => s.kind === 'execute' && s.declaredRiskClass)
                  .map((s) => renderRiskBadge(s.declaredRiskClass!))}
              </div>
              <div style={{ fontSize: '11px', color: colors.mulchBrown, marginTop: 4 }}>
                {networkActivityLabel(
                  latest.steps.some((s) => s.declaredRiskClass === 'network_filesystem_repair') ? 'bounded' : 'none',
                )}
              </div>
            </div>

            {/* Version history */}
            <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: '12px', fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 6 }}>
                Version history (immutable)
              </div>
              {detail?.versions.map((v) => (
                <div key={v.versionId} style={{ fontSize: '12px', color: colors.mulchBrown, padding: '4px 0', borderBottom: `1px solid ${colors.cardBorder}` }}>
                  v{v.version} — {new Date(v.createdAt).toLocaleString()} — hash {v.definitionHash.slice(0, 12)}…
                  {v.version === detail.playbook.activeVersion ? ` — ${active ? 'ACTIVE' : 'was active'}` : ''}
                </div>
              ))}
            </div>

            {/* Copy-on-edit draft editor */}
            <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: 12 }}>
              {!editing ? (
                <button
                  type="button"
                  onClick={() => {
                    setName(latest.name);
                    setDescription(latest.description ?? '');
                    setEditing(true);
                  }}
                  className="btn btn-outline"
                  style={{ height: '2rem', fontSize: '0.75rem', padding: '0 12px' }}
                >
                  Edit copy (creates a new immutable version)
                </button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: colors.ledgerCharcoal }}>
                    Editing copy of v{latest.version} — saving appends v{latest.version + 1}
                  </div>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    aria-label="Playbook name"
                    style={{ height: '2rem', fontSize: '0.75rem', borderRadius: rounded.md, border: `1px solid ${colors.cardBorder}`, padding: '0 8px' }}
                  />
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    aria-label="Playbook description"
                    rows={2}
                    style={{ fontSize: '0.75rem', borderRadius: rounded.md, border: `1px solid ${colors.cardBorder}`, padding: '6px 8px' }}
                  />
                  <div style={{ fontSize: '11px', color: colors.mulchBrown }}>
                    Steps, scope, and variables are edited in the source definition; this surface preserves them and re-validates against the registry on save.
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => void handleSaveDraft()}
                      disabled={busy || name.trim().length === 0}
                      className="btn btn-primary"
                      style={{ height: '2rem', fontSize: '0.75rem', padding: '0 12px' }}
                    >
                      {busy ? 'Saving…' : 'Save new version'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="btn btn-outline"
                      style={{ height: '2rem', fontSize: '0.75rem', padding: '0 12px' }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

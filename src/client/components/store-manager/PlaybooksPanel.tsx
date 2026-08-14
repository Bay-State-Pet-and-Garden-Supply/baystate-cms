import React, { useEffect, useCallback, useState } from 'react';
import { colors, fonts, rounded } from '../../theme';
import {
  fetchStoreManagerPlaybooks,
  fetchStoreManagerPlaybookTemplates,
  fetchStoreManagerPlaybookDetail,
  createStoreManagerPlaybook,
  type StoreManagerPlaybookSummary,
  type StoreManagerPlaybookTemplate,
  type StoreManagerPlaybookDetail,
} from '../../store-manager-api';
import {
  sortPlaybooks,
  playbookStatusLabel,
  playbookStatusTone,
  activationNote,
  stepSequence,
} from '../../store-manager-playbook-logic';
import { PlaybookEditor } from './PlaybookEditor';

interface PlaybooksPanelProps {
  open: boolean;
  onClose: () => void;
}

const TONE_COLOR: Record<string, string> = {
  ok: '#2f5d3a',
  warn: '#8a6116',
  bad: '#8b1e2d',
  neutral: colors.mulchBrown,
};

/**
 * Playbooks Panel — immutable versioned playbook definitions. Templates are
 * inert until copied into a workspace draft; drafts do nothing until explicitly
 * activated (no "trust this playbook" toggle anywhere). The editor shows risk
 * badges, step contracts, version history, and the active hash; there is no
 * run button in this surface (execution arrives with Issue 7).
 */
export function PlaybooksPanel({ open, onClose }: PlaybooksPanelProps) {
  const [playbooks, setPlaybooks] = useState<StoreManagerPlaybookSummary[]>([]);
  const [templates, setTemplates] = useState<StoreManagerPlaybookTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [templateKind, setTemplateKind] = useState<string>('weekly_taxonomy_cleanup');
  const [draftName, setDraftName] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [details, setDetails] = useState<StoreManagerPlaybookDetail[]>([]);

  const load = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    setError(null);
    try {
      const [list, templatesList] = await Promise.all([
        fetchStoreManagerPlaybooks(),
        fetchStoreManagerPlaybookTemplates(),
      ]);
      // Bounded per-playbook detail fetch so the list can show the real step
      // sequence and active version without a second server contract.
      const details = await Promise.all(
        list.slice(0, 50).map(async (pb) => {
          try {
            return await fetchStoreManagerPlaybookDetail(pb.id);
          } catch {
            return null;
          }
        }),
      );
      setPlaybooks(list);
      setTemplates(templatesList);
      setDetails(details.filter((d) => d !== null));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleCreate = async () => {
    setCreateError(null);
    setCreating(true);
    try {
      await createStoreManagerPlaybook(
        templateKind as StoreManagerPlaybookTemplate['kind'],
        draftName.trim() || undefined,
      );
      setDraftName('');
      await load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleEdit = (id: string) => setEditingId(id);

  return (
    <div
      role="dialog"
      aria-label="Playbooks"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: open ? 'flex' : 'none',
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
          width: 'min(920px, 92vw)',
          maxHeight: '86vh',
          overflowY: 'auto',
          background: colors.whiteSurface,
          borderRadius: rounded.lg,
          border: `1px solid ${colors.cardBorder}`,
          boxShadow: '0 16px 48px rgba(33,20,20,0.2)',
          padding: '20px 24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <h3 style={{ fontSize: '18px', fontWeight: 700, fontFamily: fonts.display, color: colors.ledgerCharcoal, margin: 0 }}>
              📋 Playbooks
            </h3>
            <p style={{ margin: '4px 0 0', fontSize: '12px', color: colors.mulchBrown }}>
              Versioned data, not code. Drafts are inert until explicitly activated.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close playbooks"
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
        {loading && <div style={{ fontSize: '12px', color: colors.mulchBrown }}>Loading…</div>}

        {/* Template copy */}
        <div style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: colors.ledgerCharcoal, marginBottom: 8 }}>
            Copy a starter template into a workspace draft
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              value={templateKind}
              onChange={(e) => setTemplateKind(e.target.value)}
              aria-label="Playbook template"
              style={{ height: '2rem', fontSize: '0.75rem', borderRadius: rounded.md, border: `1px solid ${colors.cardBorder}`, padding: '0 8px' }}
            >
              {templates.map((t) => (
                <option key={t.kind} value={t.kind}>
                  {t.name} ({t.stepCount} steps)
                </option>
              ))}
            </select>
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Draft name (optional)"
              aria-label="Draft name"
              style={{ height: '2rem', fontSize: '0.75rem', borderRadius: rounded.md, border: `1px solid ${colors.cardBorder}`, padding: '0 8px', width: 200 }}
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || templates.length === 0}
              className="btn btn-primary"
              style={{ height: '2rem', fontSize: '0.75rem', padding: '0 12px' }}
            >
              {creating ? 'Copying…' : 'Copy template → draft'}
            </button>
          </div>
          {createError && <div style={{ color: '#8b1e2d', fontSize: '12px', marginTop: 6 }}>{createError}</div>}
        </div>

        {/* Playbook list */}
        {playbooks.length === 0 && !loading ? (
          <div style={{ fontSize: '12px', color: colors.mulchBrown, padding: '12px 0' }}>
            No playbooks yet. Copy a starter template above to create an inert workspace draft.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sortPlaybooks(playbooks).map((pb) => {
              const tone = playbookStatusTone(pb.status);
              const note = activationNote(pb);
              const detail = details.find((d) => d.playbook.id === pb.id);
              const seq = detail ? stepSequence(detail.versions[0]?.steps ?? []) : 'Loading steps…';
              return (
                <div
                  key={pb.id}
                  style={{ border: `1px solid ${colors.cardBorder}`, borderRadius: rounded.md, padding: '10px 12px' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: '13px', color: colors.ledgerCharcoal }}>{pb.name}</div>
                      <div style={{ fontSize: '11px', color: colors.mulchBrown }}>
                        v{pb.currentVersion} · <span style={{ color: TONE_COLOR[tone] }}>{playbookStatusLabel(pb.status)}</span>
                        {pb.activeVersion ? ` · active hash ${(pb.activeHash ?? '').slice(0, 10)}…` : ''}
                      </div>
                      {note && <div style={{ fontSize: '11px', color: colors.mulchBrown }}>{note}</div>}
                    </div>
                    <button
                      type="button"
                      onClick={() => handleEdit(pb.id)}
                      className="btn btn-outline"
                      style={{ height: '2rem', fontSize: '0.75rem', padding: '0 12px', whiteSpace: 'nowrap' }}
                    >
                      {pb.status === 'active' ? 'Inspect / edit copy' : 'Edit draft'}
                    </button>
                  </div>
                  <div style={{ fontSize: '11px', color: colors.mulchBrown, marginTop: 4 }}>
                    {seq}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editingId && (
        <PlaybookEditor
          playbookId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

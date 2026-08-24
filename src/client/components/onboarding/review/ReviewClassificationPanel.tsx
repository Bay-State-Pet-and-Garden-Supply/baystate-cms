/**
 * Epic #46 — Review classification panel (Phase 6).
 *
 * Renders classification proposals (Product Type, Category Pages, attribute
 * assignments) with accept/reject affordances for pending proposals.
 *
 * Clarity rules (epic #46 review round, operator feedback):
 * - Abstentions are INFORMATIONAL, never decisions: the review-complete
 *   route auto-accepts remaining pending proposals, so an abstention row
 *   with Accept/Reject buttons was pure noise ("I have no idea what I am
 *   accepting"). They render as plain "nothing to propose" notes.
 * - Proposal values are humanized (product type labels, matched-word chips,
 *   evidence counts) — raw JSON blobs never appear.
 * - Identical pending proposals (same type + value + confidence, e.g. two
 *   free-text targets producing the same text) collapse into one row.
 * - Confidence renders as a qualitative chip + percent.
 */
import { useEffect, useState } from 'react';
import type { ItemDetailResponse } from '../../../onboarding-api';
import type { ClassificationProposal } from '../../../../shared/schemas/classification';
import type { CurationData } from '../../../../shared/schemas/onboarding';
import { listPages, listVerifiedPageOptionSummaries } from '../../../api';

/** e09 round-3 FIX 1 (adjudication #10): correction payload written alongside
 *  suggestedPages when the added page resolves to a VERIFIED Page ID. */
export interface CategoryPageCorrection {
  pageId: string;
  activePageImportHash: string;
}

export interface ReviewClassificationPanelProps {
  detail: ItemDetailResponse | null;
  onDecision: (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => Promise<void>;
  /** Item id currently performing a decision write (disables row buttons). */
  busyDecisionId: string | null;
  onUpdatePages?: (suggestedPages: string[], correction?: CategoryPageCorrection) => Promise<void>;
}

export const PROPOSAL_TYPE_LABELS: Record<string, string> = {
  primary_product_type: 'Primary Product Type',
  category_page: 'Category Page',
  field_assignment: 'Attribute',
  configuration_gap: 'Configuration gap',
  reviewable_abstention: 'Reviewable abstention',
};

// ─── Humanization helpers ─────────────────────────────────────────────────────

function humanizeId(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase())
    .trim();
}

function confidenceTier(confidence: number): { label: string; cls: string } {
  if (confidence >= 0.85) return { label: 'High', cls: 'rv-conf-high' };
  if (confidence >= 0.5) return { label: 'Moderate', cls: 'rv-conf-moderate' };
  return { label: 'Low', cls: 'rv-conf-low' };
}

/** Human-readable proposal value (never raw JSON). */
function proposalValueText(proposal: ClassificationProposal): {
  text: string;
  matchedWords: string[];
} {
  const raw = proposal.revisedValue ?? proposal.proposedValue;
  if (raw === null || raw === undefined) return { text: '—', matchedWords: [] };

  if (proposal.proposalType === 'primary_product_type' && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const typeId = typeof obj.productTypeId === 'string' ? obj.productTypeId : null;
    const words = Array.isArray(obj.matchedWords)
      ? (obj.matchedWords as unknown[]).filter((w): w is string => typeof w === 'string')
      : [];
    return {
      text: typeId ? humanizeId(typeId) : '—',
      matchedWords: words,
    };
  }

  if (typeof raw === 'string') return { text: raw, matchedWords: [] };
  if (typeof raw === 'number') return { text: String(raw), matchedWords: [] };

  if (Array.isArray(raw)) {
    const parts = raw.map(value => proposalValueText({ ...proposal, proposedValue: value, revisedValue: value }).text);
    return { text: parts.filter(Boolean).join(', '), matchedWords: [] };
  }

  const obj = raw as Record<string, unknown>;
  const label =
    obj.label ?? obj.name ?? obj.value ?? obj.pageName ?? obj.productTypeLabel ?? obj.fieldLabel;
  if (typeof label === 'string' && label) return { text: label, matchedWords: [] };
  const id = obj.id ?? obj.pageId ?? obj.typeId ?? obj.fieldId;
  if (typeof id === 'string') return { text: humanizeId(id), matchedWords: [] };
  return { text: '—', matchedWords: [] };
}

function abstentionReason(proposal: ClassificationProposal): string | null {
  const raw = proposal.proposedValue;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const reason = (raw as Record<string, unknown>).reason;
    if (typeof reason === 'string' && reason) return sanitizeReasonText(reason);
  }
  return null;
}

/**
 * Abstention reasons are system/model text — never render raw JSON blobs
 * or unbounded explanations (review round 2, MEDIUM-4).
 */
function sanitizeReasonText(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'No evidence available.';
  const singleLine = trimmed.replace(/\s+/g, ' ');
  return singleLine.length > 240 ? `${singleLine.slice(0, 237)}…` : singleLine;
}

function statusLabel(status: ClassificationProposal['status']): string {
  switch (status) {
    case 'pending':
      return 'Needs your decision';
    case 'accepted':
      return 'Accepted';
    case 'rejected':
      return 'Rejected';
    case 'stale':
      return 'Stale';
    default:
      return String(status);
  }
}

const STATUS_CLASS: Record<string, string> = {
  pending: 'rv-proposal-status-pending',
  accepted: 'rv-proposal-status-accepted',
  rejected: 'rv-proposal-status-rejected',
  stale: 'rv-proposal-status-stale',
};

// ─── Panel ────────────────────────────────────────────────────────────────────

export function ReviewClassificationPanel({
  detail,
  onDecision,
  busyDecisionId,
  onUpdatePages,
}: ReviewClassificationPanelProps) {
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [availablePages, setAvailablePages] = useState<string[]>([]);
  // e09 round-3 FIX 1: verified options + active import hash for corrections.
  const [verifiedPages, setVerifiedPages] = useState<Array<{ id: string; name: string }>>([]);
  const [activeImportHash, setActiveImportHash] = useState<string | null>(null);
  const [isAddingPage, setIsAddingPage] = useState(false);
  const [pageSearch, setPageSearch] = useState('');
  const [savingPages, setSavingPages] = useState(false);

  useEffect(() => {
    let mounted = true;
    listPages()
      .then(res => {
        if (mounted && res?.pages) {
          const names = [...new Set(res.pages.map(p => p.name).filter(Boolean))].sort();
          setAvailablePages(names);
        }
      })
      .catch(() => {});
    listVerifiedPageOptionSummaries()
      .then(res => {
        if (!mounted) return;
        setVerifiedPages((res?.pages ?? []).map(p => ({ id: p.id, name: p.name })));
        setActiveImportHash(res?.activeImportHash ?? null);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const curation = detail?.item.curationData as CurationData | null;
  const proposals = curation?.classificationProposals ?? [];
  const suggestedPages = curation?.suggestedPages ?? [];
  const suggestions = suggestedPages.length > 0;
  const withoutResults = proposals.length === 0 && !suggestions;
  // e05s01: surface applicability + gating provenance instead of silent emptiness
  const applicability = curation?.attributeApplicability ?? [];
  const gating = curation?.categoryPageGating ?? null;
  const dropped = curation?.speciesGuardDropped ?? [];
  const provenance = curation?.taxonomyProvenance ?? null;

  const handleDecision = async (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => {
    setDecisionError(null);
    try {
      await onDecision(proposal, decision);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemovePage = async (pageToRemove: string) => {
    if (!onUpdatePages || savingPages) return;
    setSavingPages(true);
    try {
      const next = suggestedPages.filter(p => p !== pageToRemove);
      await onUpdatePages(next);
    } finally {
      setSavingPages(false);
    }
  };

  const handleAddPage = async (pageToAdd: string) => {
    if (!onUpdatePages || savingPages || suggestedPages.includes(pageToAdd)) return;
    setSavingPages(true);
    try {
      const next = [...suggestedPages, pageToAdd];
      // e09 round-3 FIX 1: when the added page resolves to a verified identity,
      // stamp the correction record so an abstained durable decision can be
      // resolved by this manual selection (adjudication #10). Non-verified
      // additions keep today's name-only behavior (never acceptance authority).
      const verified = verifiedPages.find(p => p.name === pageToAdd);
      const correction: CategoryPageCorrection | undefined =
        verified && activeImportHash
          ? { pageId: verified.id, activePageImportHash: activeImportHash }
          : undefined;
      await onUpdatePages(next, correction);
      setIsAddingPage(false);
      setPageSearch('');
    } finally {
      setSavingPages(false);
    }
  };

  const primary = proposals.find(p => p.proposalType === 'primary_product_type');
  const abstentions = proposals.filter(p => p.proposalType === 'reviewable_abstention');
  // Attributes/category pages/brand field assignments — the primary type lives
  // in its own headline row above, never duplicated here.
  const reviewable = proposals.filter(
    p =>
      p.proposalType !== 'reviewable_abstention' &&
      p.proposalType !== 'primary_product_type' &&
      p.status === 'pending',
  );
  const settled = proposals.filter(
    p =>
      p.proposalType !== 'reviewable_abstention' &&
      p.proposalType !== 'primary_product_type' &&
      p.status !== 'pending',
  );

  // Collapse identical pending proposals (same type + value + confidence).
  const dedupedReviewable = reviewable.reduce<ClassificationProposal[]>((acc, p) => {
    const key = `${p.proposalType}|${JSON.stringify(p.proposedValue)}|${p.confidence}`;
    const existing = acc.find(q => {
      const qKey = `${q.proposalType}|${JSON.stringify(q.proposedValue)}|${q.confidence}`;
      return qKey === key;
    });
    if (!existing) acc.push(p);
    return acc;
  }, []);
  const dedupeCount = reviewable.length - dedupedReviewable.length;

  const filteredPageOptions = availablePages.filter(
    p => !suggestedPages.includes(p) && p.toLowerCase().includes(pageSearch.toLowerCase().trim()),
  );

  return (
    <section
      className="rv-panel"
      aria-label="Classification"
      id="rv-classification-panel"
      tabIndex={-1}
    >
      <header className="rv-panel-head">Classification</header>
      <div className="rv-panel-body">
        {withoutResults && (
          <div className="rv-empty">
            {gating?.needsReviewedType
              ? 'Needs reviewed Product Type — page assignment requires an accepted Product Type. Review the type proposal above first.'
              : gating?.needsVerifiedPages
                ? `No verified Catalog Pages for import — ${gating.verifiedPageCount} verified page${gating.verifiedPageCount === 1 ? '' : 's'} in snapshot. Import ShopSite pages first.`
                : 'No classification proposals or category suggestions yet.'}
            {gating?.reason && !gating.needsReviewedType && !gating.needsVerifiedPages ? ` Reason: ${gating.reason}` : ''}
          </div>
        )}

        {primary && (
          <div className="rv-field">
            <div className="rv-field-label">Primary Product Type</div>
            <ReviewProposalRow proposal={primary} onDecision={handleDecision} busy={busyDecisionId} />
          </div>
        )}

        {/* Assigned or Suggested Category Pages with Interactive Editing */}
        <div className="rv-field" style={{ marginTop: '0.875rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="rv-field-label">Category Pages</div>
            {onUpdatePages && (
              <button
                type="button"
                className="rv-btn rv-btn-secondary"
                style={{ fontSize: '0.75rem', padding: '0.125rem 0.5rem', height: 'auto' }}
                onClick={() => setIsAddingPage(prev => !prev)}
                disabled={savingPages}
              >
                {isAddingPage ? 'Done' : '+ Add Page'}
              </button>
            )}
          </div>
          {suggestedPages.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginTop: '0.25rem' }}>
              {suggestedPages.map(page => (
                <span
                  key={page}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '0.25rem 0.625rem',
                    borderRadius: '9999px',
                    fontSize: '0.8125rem',
                    fontWeight: 500,
                    background: '#eff6ff',
                    color: '#1d4ed8',
                    border: '1px solid #bfdbfe',
                  }}
                >
                  📁 {page}
                  {onUpdatePages && (
                    <button
                      type="button"
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#1d4ed8',
                        cursor: 'pointer',
                        fontWeight: 'bold',
                        marginLeft: '0.375rem',
                        padding: 0,
                        fontSize: '0.875rem',
                        lineHeight: 1,
                      }}
                      title={`Remove ${page}`}
                      disabled={savingPages}
                      onClick={() => void handleRemovePage(page)}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
          ) : (
            <div className="rv-field-value" style={{ color: 'var(--text-muted, #64748b)', fontStyle: 'italic' }}>
              No category pages assigned yet.
            </div>
          )}

          {isAddingPage && (
            <div style={{ marginTop: '0.5rem', background: '#f8fafc', padding: '0.5rem', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
              <input
                type="text"
                className="rv-input"
                style={{ fontSize: '0.8125rem', width: '100%', marginBottom: '0.375rem' }}
                placeholder="Search category pages to add..."
                value={pageSearch}
                onChange={e => setPageSearch(e.target.value)}
                autoFocus
              />
              <div style={{ maxHeight: '140px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {filteredPageOptions.slice(0, 20).map(page => (
                  <button
                    key={page}
                    type="button"
                    style={{
                      textAlign: 'left',
                      padding: '0.25rem 0.5rem',
                      background: '#fff',
                      border: '1px solid #cbd5e1',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '0.8125rem',
                    }}
                    onClick={() => void handleAddPage(page)}
                  >
                    + {page}
                  </button>
                ))}
                {filteredPageOptions.length === 0 && (
                  <div style={{ fontSize: '0.75rem', color: '#64748b', padding: '0.25rem' }}>
                    {pageSearch ? 'No matching pages found.' : 'All store pages already added.'}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {dedupedReviewable.length > 0 && (
          <div className="rv-field">
            <div className="rv-field-label">
              Decisions needed ({dedupedReviewable.length})
              {dedupeCount > 0 ? ` · ${dedupeCount} duplicate${dedupeCount === 1 ? '' : 's'} merged` : ''}
            </div>
            {dedupedReviewable.map(proposal => (
              <ReviewProposalRow
                key={proposal.id}
                proposal={proposal}
                onDecision={handleDecision}
                busy={busyDecisionId}
                siblings={reviewable.filter(
                  q =>
                    q.id !== proposal.id &&
                    q.proposalType === proposal.proposalType &&
                    JSON.stringify(q.proposedValue) === JSON.stringify(proposal.proposedValue),
                )}
              />
            ))}
          </div>
        )}

        {abstentions.length > 0 && (
          <div className="rv-field">
            <div className="rv-field-label">Nothing to propose ({abstentions.length})</div>
            {abstentions.map(proposal => (
              <div key={proposal.id} className="rv-abstention">
                <span className="rv-abstention-target">{humanizeId(proposal.targetId ?? '')}</span>
                <span className="rv-abstention-reason">{abstentionReason(proposal) ?? 'No evidence available.'}</span>
              </div>
            ))}
            {gating && (gating.needsReviewedType || gating.needsVerifiedPages) && abstentions.some(a => String(a.targetId) === 'category_page_proposals') ? (
              <p className="rv-meta-note">
                {gating.needsReviewedType
                  ? 'Needs reviewed Product Type — accept a Product Type above to unlock page assignment.'
                  : `No verified Catalog Pages — ${gating.verifiedPageCount} verified in snapshot ${gating.snapshotHash ? `(${String(gating.snapshotHash).slice(0, 8)})` : ''}.`}
              </p>
            ) : (
              <p className="rv-meta-note">
                Informational only — abstentions are acknowledged automatically when you complete the
                review. You never need to accept or reject an abstention.
              </p>
            )}
          </div>
        )}

        {settled.length > 0 && (
          <div className="rv-field">
            <div className="rv-field-label">Settled decisions</div>
            {settled.map(proposal => (
              <ReviewProposalRow
                key={proposal.id}
                proposal={proposal}
                onDecision={handleDecision}
                busy={busyDecisionId}
              />
            ))}
          </div>
        )}

        {/* Collapsible Technical Provenance & Gating Details */}
        {(provenance || applicability.length > 0 || dropped.length > 0) && (
          <details
            className="rv-advanced-details"
            style={{
              marginTop: '1.25rem',
              padding: '0.625rem 0.875rem',
              background: 'var(--surface-muted, #f8fafc)',
              border: '1px solid var(--border-subtle, #e2e8f0)',
              borderRadius: '6px',
            }}
          >
            <summary style={{ cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-muted, #64748b)' }}>
              Technical Provenance & Gating Details
            </summary>
            <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {/* e05s01: attribute applicability */}
              {applicability.length > 0 && (
                <div className="rv-field" aria-label="Attribute applicability" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Attribute applicability ({applicability.length})</div>
                  {applicability.map(entry => (
                    <div key={entry.attributeId} className="rv-abstention">
                      <span className="rv-abstention-target">{humanizeId(entry.attributeId)}</span>
                      <span className={`rv-applicability-state rv-applicability-${entry.state}`}>{entry.state}</span>
                      <span className="rv-abstention-reason">
                        {entry.state === 'unknown'
                          ? entry.reason ?? 'type not reviewed'
                          : entry.state === 'not_applicable'
                            ? entry.reason ?? 'not in profile'
                            : entry.reason ?? 'applicable'}
                      </span>
                    </div>
                  ))}
                  <p className="rv-meta-note">
                    Unknown means the attribute is type-gated and no reviewed Product Type exists yet; not_applicable means the attribute is not in the accepted type&apos;s profile.
                  </p>
                </div>
              )}

              {/* e05s02: taxonomy provenance — bundle/snapshot/verified identity, no invented IDs */}
              {provenance && (
                <div className="rv-field" aria-label="Taxonomy provenance" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Taxonomy provenance</div>
                  <div className="rv-abstention">
                    <span className="rv-abstention-target">Bundle</span>
                    <span className="rv-abstention-reason" title={provenance.bundleHash ?? ''}>
                      {provenance.bundleVersion ? `${provenance.bundleVersion} · ${String(provenance.bundleHash).slice(0, 12)}` : provenance.bundleHash ?? '—'}
                    </span>
                  </div>
                  <div className="rv-abstention">
                    <span className="rv-abstention-target">Snapshot</span>
                    <span className="rv-abstention-reason" title={provenance.snapshotHash ?? ''}>
                      {provenance.snapshotHash ? `${String(provenance.snapshotHash).slice(0, 8)} · ${String(provenance.snapshotHash).slice(0, 12)}` : '—'}
                    </span>
                  </div>
                  <div className="rv-abstention">
                    <span className="rv-abstention-target">Verified pages</span>
                    <span className="rv-abstention-reason">
                      {(provenance.verifiedPageCount ?? 0).toString()} verified — IDs: {(provenance.verifiedPageIdSet ?? []).slice(0, 5).join(', ') || '—'}
                      {(provenance.verifiedPageIdSet ?? []).length > 5 ? ` +${(provenance.verifiedPageIdSet?.length ?? 0) - 5} more` : ''}
                    </span>
                  </div>
                  {provenance.attributeProfileId ? (
                    <div className="rv-abstention">
                      <span className="rv-abstention-target">Attribute profile</span>
                      <span className="rv-abstention-reason">{provenance.attributeProfileId}</span>
                    </div>
                  ) : null}
                  {provenance.classificationRunId ? (
                    <div className="rv-abstention">
                      <span className="rv-abstention-target">Run</span>
                      <span className="rv-abstention-reason">{String(provenance.classificationRunId).slice(0, 8)}</span>
                    </div>
                  ) : null}
                  <p className="rv-meta-note">SoT: store/classification/*.json → RuntimeClassificationSnapshot (snapshotHash) → verified Pages/Fields catalog → promotion. Non-technical UI is deferred; safe path is JSON-file edit + bundle release via config-store. No invented IDs (ADR 0012).</p>
                </div>
              )}

              {/* e05s01: species-guard dropped pages */}
              {dropped.length > 0 && (
                <div className="rv-field" aria-label="Filtered by species guard" style={{ marginBottom: 0 }}>
                  <div className="rv-field-label">Filtered by species guard ({dropped.length})</div>
                  {dropped.map(item => (
                    <div key={item.pageName} className="rv-abstention">
                      <span className="rv-abstention-target">{item.pageName}</span>
                      <span className="rv-abstention-reason">
                        species_incompatible — species &quot;{item.species}&quot; vs term &quot;{item.matchedTerm ?? ''}&quot;
                      </span>
                    </div>
                  ))}
                  <p className="rv-meta-note">Safety net — cross-species pages are dropped by curation. This list is provenance only.</p>
                </div>
              )}
            </div>
          </details>
        )}

        {decisionError && <div className="rv-error-banner" style={{ marginTop: '0.625rem' }}>{decisionError}</div>}
      </div>
    </section>
  );
}

// ─── Proposal row ─────────────────────────────────────────────────────────────

function ReviewProposalRow({
  proposal,
  onDecision,
  busy,
  siblings = [],
}: {
  proposal: ClassificationProposal;
  onDecision: (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => Promise<void>;
  busy: string | null;
  /** Identical pending proposals merged into this row (different targets). */
  siblings?: ClassificationProposal[];
}) {
  const { text, matchedWords } = proposalValueText(proposal);
  const isPending = proposal.status === 'pending';
  const tier = typeof proposal.confidence === 'number' ? confidenceTier(proposal.confidence) : null;
  const targetLabels = [proposal.targetId, ...siblings.map(s => s.targetId)]
    .filter((id): id is string => Boolean(id))
    .map(id => humanizeId(id));
  const uniqueLabels = [...new Set(targetLabels)];

  return (
    <div className="rv-proposal">
      <div className="rv-proposal-head">
        <span className="rv-proposal-type">
          {PROPOSAL_TYPE_LABELS[proposal.proposalType] ?? proposal.proposalType}
          {uniqueLabels.length > 0 && proposal.proposalType !== 'primary_product_type' && (
            <span className="rv-proposal-target"> · {uniqueLabels.join(' & ')}</span>
          )}
        </span>
        <span className={`rv-proposal-status ${STATUS_CLASS[proposal.status] ?? ''}`}>
          {statusLabel(proposal.status)}
        </span>
      </div>

      <div className="rv-proposal-value">
        {text}
        {typeof proposal.confidence === 'number' && isPending && tier && (
          <span
            className={`rv-conf-chip ${tier.cls}`}
            role="status"
            aria-label={`Proposal confidence: ${Math.round(proposal.confidence * 100)} percent, ${tier.label.toLowerCase()}`}
            title={`Confidence of the proposal: ${Math.round(proposal.confidence * 100)}% (${tier.label})`}
          >
            {Math.round(proposal.confidence * 100)}% · {tier.label}
          </span>
        )}
      </div>

      {matchedWords.length > 0 && (
        <div className="rv-matched-words">
          <span className="rv-matched-words-label">Keyword match:</span>
          {matchedWords.map(word => (
            <span key={word} className="rv-matched-word">{word}</span>
          ))}
        </div>
      )}
      {proposal.proposalType === 'primary_product_type' && matchedWords.length === 0 && isPending && (
        <div className="rv-meta-note">Model pick — no keyword evidence. Only accept if it's clearly right.</div>
      )}

      {isPending ? (
        <div className="rv-proposal-actions">
          <button
            type="button"
            className="rv-btn rv-btn-primary"
            disabled={busy === proposal.id}
            onClick={() => void decideAll(onDecision, [proposal, ...siblings], 'accepted')}
          >
            {busy === proposal.id ? 'Saving…' : 'Accept'}
          </button>
          <button
            type="button"
            className="rv-btn rv-btn-danger"
            disabled={busy === proposal.id}
            onClick={() => void decideAll(onDecision, [proposal, ...siblings], 'rejected')}
          >
            {busy === proposal.id ? 'Saving…' : 'Reject'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Review round 2 (BLOCKER): a merged row represents N proposals — the
 * decision MUST fan out to every underlying proposal id, never just the
 * visible representative. Otherwise hidden siblings stay pending and the
 * review drawer lies about its own state.
 */
function decideAll(
  onDecision: (proposal: ClassificationProposal, decision: 'accepted' | 'rejected') => Promise<void>,
  proposals: ClassificationProposal[],
  decision: 'accepted' | 'rejected',
): Promise<void[]> {
  return Promise.all(proposals.map(p => onDecision(p, decision)));
}

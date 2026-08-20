/**
 * AgentRunInspector — full run view: timeline, preview, evidence, review (PI-7).
 *
 * Desktop (width >= 1100): 3-col grid [Progress | Listing | Review] + evidence bar.
 * Narrow: 4 tabs (Progress | Listing | Evidence | Review).
 */

import React, { useEffect, useState } from 'react';
import {
  cancelPiRun,
  createPiRun,
  parseRunInput,
  getPiFlags,
  importRunToOnboarding,
  reviewPiRun,
  getPiRunReview,
} from '../../product-intelligence-api';
import { useProductIntelligenceRun } from '../../hooks/useProductIntelligenceRun';
import { useProductIntelligenceEvents } from '../../hooks/useProductIntelligenceEvents';
import { AgentRunTimeline } from './AgentRunTimeline';
import { AgentStepDetails } from './AgentStepDetails';
import { ProductListingPreview } from './ProductListingPreview';
import { EvidenceInspector } from './EvidenceInspector';
import { ConflictReviewPanel } from './ConflictReviewPanel';
import { ImageEvidencePanel } from './ImageEvidencePanel';
import { AgentRunComparison } from './AgentRunComparison';
import { SpecialistStagePanel } from './SpecialistStagePanel';
import { SeedPanel } from './SeedPanel';
import { CuratorProvenancePanel } from './CuratorProvenancePanel';
import { ResolverConflictPanel } from './ResolverConflictPanel';
import { PolicySnapshotPanel } from './PolicySnapshotPanel';

interface Props {
  runId: string;
  onBack: () => void;
}

type NarrowTab = 'progress' | 'listing' | 'evidence' | 'review';

const REVIEW_STATE_PREFIX = {
  approve: 'Approved',
  reject: 'Rejected',
} as const;

/** Human label for a durable review decision (structured actor, never raw JSON). */
function reviewerDisplay(decision: { reviewerActor?: { displayLabel: string | null; authentication: string } }): string {
  const actor = decision.reviewerActor;
  if (!actor) return 'unknown reviewer';
  if (actor.displayLabel && actor.displayLabel.trim() !== '') return actor.displayLabel.trim();
  return actor.authentication === 'shared_api_token' ? 'API token operator' : 'local operator';
}

function formatReviewState(decision: {
  decision: 'approve' | 'reject';
  reviewerActor?: { displayLabel: string | null; authentication: string };
  createdAt: string;
}): string {
  return `${REVIEW_STATE_PREFIX[decision.decision]} by ${reviewerDisplay(decision)} (${new Date(decision.createdAt).toLocaleString()})`;
}

export function AgentRunInspector({ runId, onBack }: Props) {
  const { run: projection, error, loading, refresh } = useProductIntelligenceRun(runId);
  const { events } = useProductIntelligenceEvents(runId);
  const [selectedToolSeq, setSelectedToolSeq] = useState<number | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [narrowTab, setNarrowTab] = useState<NarrowTab>('progress');
  const [isWide, setIsWide] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 1100 : true));
  const [actionError, setActionError] = useState<string | null>(null);
  const [importFlags, setImportFlags] = useState<{ allowOnboardingImport: boolean; shadowOnly: boolean } | null>(null);
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [reviewApproved, setReviewApproved] = useState(false);
  const [reviewing, setReviewing] = useState<'approve' | 'reject' | null>(null);
  const [reviewState, setReviewState] = useState<string | null>(null);

  // P1-2: load the durable review state for this run; import stays disabled
  // until the latest decision approves the run's current stored result.
  useEffect(() => {
    let cancelled = false;
    getPiRunReview(runId)
      .then((res) => {
        if (cancelled) return;
        setReviewApproved(res.approved);
        setReviewState(
          res.decision
            ? formatReviewState(res.decision)
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setReviewApproved(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, refresh]);

  useEffect(() => {
    getPiFlags()
      .then((res) =>
        setImportFlags({
          allowOnboardingImport: res.flags.allowOnboardingImport,
          shadowOnly: res.flags.shadowOnly,
        }),
      )
      .catch(() => setImportFlags(null));
  }, []);

  useEffect(() => {
    const checkWidth = () => setIsWide(window.innerWidth >= 1100);
    checkWidth();
    window.addEventListener('resize', checkWidth);
    return () => window.removeEventListener('resize', checkWidth);
  }, []);

  // Auto-refresh projection when events change (to pick up tool calls, evidence, etc.)
  useEffect(() => {
    if (events.length > 0) {
      refresh();
    }
  }, [events.length, refresh]);

  const handleCancel = async () => {
    setActionError(null);
    try {
      await cancelPiRun(runId);
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRerun = async () => {
    if (!projection) return;
    setActionError(null);
    try {
      const input = parseRunInput(projection.run);
      if (!input) throw new Error('Could not parse run input');
      await createPiRun({
        gtin: String(input.gtin ?? ''),
        registerName: String(input.registerName ?? ''),
        brandHint: input.brandHint != null ? String(input.brandHint) : undefined,
        departmentHint: input.departmentHint != null ? String(input.departmentHint) : undefined,
        price: input.price != null ? String(input.price) : undefined,
        quantity: typeof input.quantity === 'number' ? input.quantity : undefined,
        mode: projection.run.mode,
      });
      onBack();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleImport = async () => {
    setActionError(null);
    setImportNotice(null);
    if (!projection) return;
    const targetItemId = projection.run.onboardingItemId ?? null;
    setImporting(true);
    try {
      const res = await importRunToOnboarding(runId, {
        mode: targetItemId ? 'augment' : 'create',
        onboardingItemId: targetItemId,
        importingUser: null,
      });
      setImportNotice(
        `Imported to onboarding item ${res.itemId.slice(0, 8)}… (${res.created ? 'new item' : 'already imported'})`,
      );
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const handleReject = async () => {
    if (!window.confirm('Reject this result? The run and its evidence stay in the audit log (durable reject decision).')) return;
    setActionError(null);
    try {
      await reviewPiRun(runId, { decision: 'reject', reviewer: 'user' });
      onBack();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReviewDecision = async (decision: 'approve' | 'reject') => {
    setActionError(null);
    setReviewing(decision);
    try {
      const res = await reviewPiRun(runId, { decision, reviewer: 'user' });
      setReviewApproved(res.decision.decision === 'approve');
      setReviewState(
        formatReviewState(res.decision),
      );
      refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewing(null);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' as const, gap: 8 },
    headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
    backBtn: { background: '#fff', border: '1px solid #d1d5db', color: '#4b5563', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
    runId: { fontSize: 13, color: '#9ca3af', fontFamily: 'monospace' },
    statusPill: { display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 8 },
    actionBtns: { display: 'flex', gap: 8, flexWrap: 'wrap' as const },
    actionBtn: { border: 'none', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
    cancelBtn: { background: '#fef3c7', color: '#92400e' },
    rerunBtn: { background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe' },
    rejectBtn: { background: '#dc2626', color: '#fff' },
    importBtn: { background: '#2563eb', color: '#fff' },
    openOnboardingBtn: { background: '#fff', color: '#2563eb', border: '1px solid #bfdbfe' },
    importNotice: { fontSize: 12, color: '#16a34a', background: '#f0fdf4', padding: '6px 10px', borderRadius: 6, marginBottom: 12 },
    tabs: { display: 'flex', gap: 4, marginBottom: 12 },
    tab: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 13, color: '#6b7280', fontWeight: 600 },
    tabActive: { background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 13, color: '#2563eb', fontWeight: 600 },
    wideGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 16 },
    wideCol: { minHeight: 300 },
    narrowContent: { marginBottom: 16 },
    error: { fontSize: 13, color: '#dc2626', background: '#fef2f2', padding: 8, borderRadius: 6, marginBottom: 12 },
    loading: { fontSize: 14, color: '#6b7280', padding: 20, textAlign: 'center' as const },
  };

  if (loading && !projection) {
    return <div style={styles.loading}>Loading run…</div>;
  }

  if (error && !projection) {
    return (
      <div>
        <div style={styles.error}>{error}</div>
        <button style={styles.backBtn} onClick={onBack}>← Back to runs</button>
      </div>
    );
  }

  if (!projection) {
    return <div style={styles.loading}>No data.</div>;
  }

  const run = projection.run;
  const isRunning = run.status === 'running';
  const importEligible =
    run.status === 'completed' &&
    projection.result != null &&
    projection.result.disposition === 'submitted' &&
    importFlags?.allowOnboardingImport === true &&
    importFlags?.shadowOnly === false;
  const statusColors: Record<string, { bg: string; color: string }> = {
    running: { bg: '#eff6ff', color: '#2563eb' },
    completed: { bg: '#f0fdf4', color: '#16a34a' },
    failed: { bg: '#fef2f2', color: '#dc2626' },
    cancelled: { bg: '#f3f4f6', color: '#6b7280' },
  };
  const sc = statusColors[run.status] ?? { bg: '#f3f4f6', color: '#6b7280' };

  const HeaderActions = (
    <div style={styles.actionBtns}>
      {isRunning && (
        <button style={{ ...styles.actionBtn, ...styles.cancelBtn }} onClick={handleCancel}>Cancel run</button>
      )}
      <button style={{ ...styles.actionBtn, ...styles.rerunBtn }} onClick={handleRerun}>Run again</button>
      <button style={{ ...styles.actionBtn, background: '#374151', color: '#fff' }} onClick={() => setShowEvidence(true)}>Evidence</button>
      {!isRunning && (
        <button style={{ ...styles.actionBtn, ...styles.rejectBtn }} onClick={handleReject}>Reject</button>
      )}
      {run.onboardingItemId && (
        <button
          style={{ ...styles.actionBtn, ...styles.openOnboardingBtn }}
          onClick={() => window.location.assign('/?view=onboarding')}
        >
          Open in Onboarding
        </button>
      )}
      {importEligible && (
        <button style={{ ...styles.actionBtn, ...styles.importBtn }} disabled={importing || !reviewApproved} onClick={handleImport}>
          {importing ? 'Importing…' : reviewApproved ? 'Send to Onboarding review' : 'Approve result to import'}
        </button>
      )}
      <button style={{ ...styles.actionBtn, background: '#6b7280', color: '#fff' }} onClick={onBack}>Close</button>
    </div>
  );

  const timeline = (
    <div>
      <AgentRunTimeline events={events} onToolSelect={setSelectedToolSeq} />
      {selectedToolSeq !== null && (
        <div style={{ marginTop: 12 }}>
          <AgentStepDetails toolCalls={projection.toolCalls} sequence={selectedToolSeq} />
        </div>
      )}
    </div>
  );

  const listing = (
    <div>
      <ProductListingPreview projection={projection} onFieldSelect={(key) => { setSelectedField(key); setShowEvidence(true); }} />
      <div style={{ marginTop: 12 }}>
        <ImageEvidencePanel assets={projection.assets} />
      </div>
    </div>
  );

  const specialistWorkspace = (
    <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
      <SpecialistStagePanel projection={projection} />
      <SeedPanel inputJson={projection.run.inputJson} />
      <CuratorProvenancePanel projection={projection} />
      <ResolverConflictPanel projection={projection} />
      <PolicySnapshotPanel run={projection.run} />
    </div>
  );

  const review = (
    <div>
      <ConflictReviewPanel projection={projection} onReject={handleReject} />
      <div style={{ marginTop: 12 }}>
        <AgentRunComparison projection={projection} />
      </div>
      <div style={{ marginTop: 12, padding: 12, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', marginBottom: 8 }}>
          Review decision
        </div>
        <div style={{ fontSize: 13, color: reviewApproved ? '#15803d' : '#b45309', marginBottom: 8 }}>
          {reviewState ?? 'No durable review decision yet — import is locked until this result is approved.'}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            style={{ ...styles.actionBtn, background: '#15803d', color: '#fff' }}
            disabled={reviewing !== null}
            onClick={() => void handleReviewDecision('approve')}
          >
            {reviewing === 'approve' ? 'Approving…' : 'Approve for onboarding'}
          </button>
          <button
            style={{ ...styles.actionBtn, background: '#b91c1c', color: '#fff' }}
            disabled={reviewing !== null}
            onClick={() => void handleReviewDecision('reject')}
          >
            {reviewing === 'reject' ? 'Rejecting…' : 'Reject decision'}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.backBtn} onClick={onBack}>← Back</button>
          <span style={styles.runId}>{run.id.slice(0, 12)}…</span>
          <span style={{ ...styles.statusPill, background: sc.bg, color: sc.color }}>{run.status}</span>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{run.executor} · {run.mode}</span>
        </div>
        {HeaderActions}
      </div>

      {actionError && <div style={styles.error}>{actionError}</div>}
      {importNotice && <div style={styles.importNotice}>{importNotice}</div>}

      {specialistWorkspace}

      {isWide ? (
        <div style={styles.wideGrid}>
          <div style={styles.wideCol}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 8 }}>Progress</div>
            {timeline}
          </div>
          <div style={styles.wideCol}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 8 }}>Ecommerce preview</div>
            {listing}
          </div>
          <div style={styles.wideCol}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 8 }}>Review</div>
            {review}
          </div>
        </div>
      ) : (
        <div>
          <div style={styles.tabs}>
            <button style={narrowTab === 'progress' ? styles.tabActive : styles.tab} onClick={() => setNarrowTab('progress')}>Progress</button>
            <button style={narrowTab === 'listing' ? styles.tabActive : styles.tab} onClick={() => setNarrowTab('listing')}>Listing</button>
            <button style={narrowTab === 'evidence' ? styles.tabActive : styles.tab} onClick={() => setNarrowTab('evidence')}>Evidence</button>
            <button style={narrowTab === 'review' ? styles.tabActive : styles.tab} onClick={() => setNarrowTab('review')}>Review</button>
          </div>
          <div style={styles.narrowContent}>
            {narrowTab === 'progress' && timeline}
            {narrowTab === 'listing' && listing}
            {narrowTab === 'evidence' && (
              <div>
                <p style={{ fontSize: 14, color: '#6b7280' }}>Evidence inspector opens in the overlay bar on wide screens.</p>
                {projection.sources.map((src) => (
                  <div key={src.id} style={{ fontSize: 13, color: '#4b5563', marginBottom: 4 }}>
                    {src.domain} — {src.url.slice(0, 60)}
                  </div>
                ))}
              </div>
            )}
            {narrowTab === 'review' && review}
          </div>
        </div>
      )}

      {showEvidence && projection && (
        <EvidenceInspector
          projection={projection}
          initialFieldKey={selectedField ?? undefined}
          onClose={() => setShowEvidence(false)}
        />
      )}
    </div>
  );
}
import React, { useState, useEffect, useCallback } from 'react';
import {
  getBatchStagedItems,
  advanceItems,
  resetStageItems,
  skipStageItems,
  moveToPreviousStage,
  fallbackSourcingItemsToDiscovery,
  getItemDetail,
  getOnboardingCapabilities,
  getCurationTargets,
  getClassificationReadiness,
  type ConsistencyWarning,
  type CurationTargetsResponse,
  type SemanticValidationPayload,
  type SourcingGenerationView,
  type SourcingQualificationView,
} from '../onboarding-api';
import type { OnboardingEvidenceConflict } from '../../shared/schemas/distributor';
import type {
  OnboardingItem,
  ExtractionData,
  CurationData,
  PipelineStage,
  StageStatus,
  BrandSite,
  DistributorEvidenceAttemptView,
  OnboardingSource,
} from '../../shared/schemas/onboarding';
import type {
  ClassificationProposalDecision,
  ClassificationEvidence,
  ClassificationProposal,
} from '../../shared/schemas/classification';
import {
  SequentialActionQueue,
  isCurrentReviewGeneration,
  isCurrentReviewVersion,
  proposalDecisionSnapshot,
  type PreparedDecisionAction,
  type ProposalDecisionSnapshot,
} from '../pipeline-decision-state';
import { readinessViewFromReport } from '../classification-readiness-view';
import { useCohortFamilyState, type CohortFamilyStateByItem } from '../hooks/useCohortFamilyState';

const STAGES: PipelineStage[] = ['sourcing', 'discovery', 'extraction', 'curation', 'review', 'promotion'];

const STAGE_LABELS: Record<PipelineStage, string> = {
  sourcing: 'Sourcing',
  discovery: 'Discovery',
  extraction: 'Extraction',
  curation: 'Curation',
  review: 'Review',
  promotion: 'Promotion',
};

const STAGE_DESCRIPTIONS: Record<PipelineStage, string> = {
  sourcing: 'Match distributor records',
  discovery: 'Find source URLs',
  extraction: 'Scrape product data',
  curation: 'Synthesize titles & classify',
  review: 'Review & approve drafts',
  promotion: 'Create product drafts',
};

const STAGE_STATUS_STYLE: Record<StageStatus, { bg: string; text: string; icon: string }> = {
  pending: { bg: '#f3f4f6', text: '#374151', icon: '○' },
  in_progress: { bg: '#dbeafe', text: '#1e40af', icon: '◌' },
  needs_input: { bg: '#fef3c7', text: '#92400e', icon: '⚠' },
  completed: { bg: '#f0fdf4', text: '#166534', icon: '✓' },
  failed: { bg: '#fee2e2', text: '#991b1b', icon: '✗' },
  skipped: { bg: '#e5e7eb', text: '#6b7280', icon: '⊘' },
};


/**
 * Per-member family badge text/colors for the curation column (issue #30,
 * PR2 + round-2 F7 + round-3 R2). Wording is stage-neutral and follows a
 * fixed precedence: (1) this member itself failed → deterministic blocked
 * text; (2) the family is blocked by a sibling failure → family-blocked;
 * (3) this member's own extraction is still completing (it IS the blocker);
 * (4) the member is waiting on N siblings; (5) the family is ready.
 */
function familyBadgeFor(familyState: CohortFamilyStateByItem[string]): { text: string; background: string; color: string } {
  const { state, cohortState, waitingOnCount, readyCount, memberCount } = familyState;
  if (state === 'blocked') {
    return { text: 'This item failed — retry required', background: '#fee2e2', color: '#991b1b' };
  }
  if (cohortState === 'blocked') {
    return { text: 'Family blocked — sibling retry required', background: '#fee2e2', color: '#991b1b' };
  }
  if (state === 'waiting' && waitingOnCount === 0) {
    return { text: 'Your extraction is still completing', background: '#ffedd5', color: '#c2410c' };
  }
  if (waitingOnCount > 0) {
    return { text: `Waiting for ${waitingOnCount} sibling${waitingOnCount === 1 ? '' : 's'}`, background: '#ffedd5', color: '#c2410c' };
  }
  return { text: `Family: Ready ${readyCount}/${memberCount}`, background: '#ecfdf5', color: '#047857' };
}

interface ItemSaveAction {
  extractionData: Partial<ExtractionData>;
  curationData: Partial<CurationData>;
}

/** Per-item transport state so late saves cannot race another drawer. */
interface ItemDecisionTransportState {
  /** Optimistic predecessor ids include queued client-generated decision ids. */
  revisionIds: Record<string, string | null>;
  /** Latest canonical or optimistically queued semantic state per proposal. */
  proposalSnapshots: Record<string, ProposalDecisionSnapshot>;
  pendingActions: Record<string, PreparedDecisionAction>;
  /** Incremented whenever a local write begins; canonical GETs capture it. */
  mutationVersion: number;
  decisionQueue: SequentialActionQueue<PreparedDecisionAction, ClassificationProposalDecision>;
  itemSaveQueue: SequentialActionQueue<ItemSaveAction, void>;
}

function createEmptyDecisionTransportState(): ItemDecisionTransportState {
  return {
    revisionIds: {},
    proposalSnapshots: {},
    pendingActions: {},
    mutationVersion: 0,
    decisionQueue: new SequentialActionQueue(),
    itemSaveQueue: new SequentialActionQueue(),
  };
}

function deriveProfileFailReason(errorMessage: string | null): 'no_profile' | 'ambiguous_match' | 'structure_mismatch' | null {
  if (!errorMessage) return null;
  if (/no (healthy )?profile/i.test(errorMessage) || /profile.*required/i.test(errorMessage)) return 'no_profile';
  if (/ambiguous/i.test(errorMessage)) return 'ambiguous_match';
  if (/structure.*mismatch|page.*structure.*signal/i.test(errorMessage)) return 'structure_mismatch';
  return null;
}

interface PipelineBoardProps {
  batchId: string;
  batchName: string;
  onBack: () => void;
  cachedBrandSites: BrandSite[];
  _catalogBrands?: string[];
  onRefreshBrandSites: () => void;
  onOpenProfileBuilder?: (domain: string, item: OnboardingItem) => void;
  onOpenBrandSetup?: (brandHint?: string | null) => void;
  /** Sourcing engine capability (server-reported). While false, Sourcing items may only continue to Discovery. */
  sourcingEngineEnabled: boolean;
}

export function PipelineBoard({
  batchId,
  batchName,
  onBack,
  cachedBrandSites,
  _catalogBrands: _catalogBrands,
  onRefreshBrandSites: _onRefreshBrandSites,
  onOpenProfileBuilder,
  onOpenBrandSetup,
  sourcingEngineEnabled,
}: PipelineBoardProps) {
  // Retained write-only state: setters are invoked by shared fetch/refresh paths;
  // the drawer-only value consumers were removed with the legacy review drawer.
  const [, setActiveImageIdx] = useState(0);
  const [, setCitationSelections] = useState<Record<string, string[]>>({});
  const [, setClassificationEvidence] = useState<ClassificationEvidence[]>([]);
  const [, setClassificationProposals] = useState<ClassificationProposal[]>([]);
  const [, setConfigurationReason] = useState<string | null>(null);
  const [, setConsistencyWarnings] = useState<ConsistencyWarning[]>([]);
  const [, setCurationFields] = useState<Partial<CurationData>>({});
  const [, setCurationTargetState] = useState<CurationTargetsResponse | null>(null);
  const [, setEditFields] = useState<Partial<ExtractionData>>({});
  const [, setManualImageUrl] = useState('');
  const [, setManualUrlInput] = useState('');
  const [, setReviewConflicts] = useState<OnboardingEvidenceConflict[]>([]);
  const [, setReviewEvidenceAttempts] = useState<DistributorEvidenceAttemptView[]>([]);
  const [, setReviewExtraction] = useState<ExtractionData | null>(null);
  const [, setReviewGenerations] = useState<SourcingGenerationView[]>([]);
  const [, setReviewQualificationView] = useState<SourcingQualificationView | null>(null);
  const [, setReviewSources] = useState<OnboardingSource[]>([]);
  const [, setSaveError] = useState<string | null>(null);
  const [, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [, setSemanticValidation] = useState<SemanticValidationPayload | null>(null);
  const [, setShowEditUrl] = useState(false);
  const [, setStorePages] = useState<string[]>([]);

  const [staged, setStaged] = useState<Record<PipelineStage, OnboardingItem[]>>({
    sourcing: [],
    discovery: [],
    extraction: [],
    curation: [],
    review: [],
    promotion: [],
  });

  // Candidate family state for the curation-stage family indicator (issue #30, PR2).
  const { byItem: cohortFamilyByItem, refresh: refreshCohortFamilyState } = useCohortFamilyState(batchId);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Review drawer state
  const [reviewItem, setReviewItem] = useState<OnboardingItem | null>(null);
  const reviewItemRef = React.useRef<string | null>(null);
  const reviewGenerationRef = React.useRef(0);
  // Reviewer-selected evidence citations per proposal (issue #17 I). Keyed by
  // proposal id; part of the queued decision action and exact retry equality.
  // PR10 (issue #30, DECISION-A): the first-class active-cohort semantic
  // validation surface threaded from the hydrated item detail into the
  // review drawer (null in legacy mode — the legacy warnings box stays).
  const [_drawerBrandName, setDrawerBrandName] = useState('');
  const [_drawerBrandDomain, setDrawerBrandDomain] = useState('');
  // Amendment A: effective Sourcing mode + configuration reason from
  // /onboarding/capabilities. Defaults degrade to the prop (engineEnabled
  // → automatic) while the fetch is in flight or fails.
  const [sourcingMode, setSourcingMode] = useState<'observe' | 'manual' | 'automatic' | null>(null);
  // Effective routing capability (Amendment A): engine enabled AND a routing
  // mode. OFF/invalid/observe never reset Sourcing rows in place (that would
  // strand unclaimed items) — the audited fallback path is used instead.
  // While the capabilities fetch is in flight (mode null) this fails closed;
  // the server remains authoritative either way.
  const sourcingCapabilityActive =
    sourcingEngineEnabled && (sourcingMode === 'manual' || sourcingMode === 'automatic');
  // Server-derived distributor-record qualification + entry-policy version
  // for the open review item (Amendment A manual mode).

  useEffect(() => {
    let cancelled = false;
    getOnboardingCapabilities()
      .then((caps) => {
        if (cancelled) return;
        const s = caps.sourcing;
        setSourcingMode(s?.mode ?? null);
        setConfigurationReason(s?.configurationReason ?? null);
      })
      .catch(() => {
        // Degrade: mode stays null (the engineEnabled prop governs the
        // board's action surface); the server remains authoritative.
      });
    return () => { cancelled = true; };
  }, []);
  const reviewTransitionRef = React.useRef<{ itemId: string; generation: number } | null>(null);
  // Decision transport is scoped per onboarding item so a late save for item A
  // cannot read/write predecessor state belonging to item B.
  const decisionTransportByItemRef = React.useRef<Map<string, ItemDecisionTransportState>>(new Map());

  const getDecisionTransport = (itemId: string): ItemDecisionTransportState => {
    let state = decisionTransportByItemRef.current.get(itemId);
    if (!state) {
      state = createEmptyDecisionTransportState();
      decisionTransportByItemRef.current.set(itemId, state);
    }
    return state;
  };

  const transportHasLocalWork = (transport: ItemDecisionTransportState): boolean =>
    transport.decisionQueue.hasPending()
    || transport.decisionQueue.hasFailure()
    || transport.itemSaveQueue.hasPending()
    || transport.itemSaveQueue.hasFailure();

  const installCanonicalDecisionState = (
    item: OnboardingItem | null | undefined,
    options: { force?: boolean } = {},
  ): boolean => {
    const proposals = item?.curationData?.classificationProposals ?? [];
    const evidence = item?.curationData?.classificationEvidence ?? [];
    if (item) {
      const transport = getDecisionTransport(item.id);
      if (!options.force && transportHasLocalWork(transport)) return false;
      if (options.force) {
        const decisionIsActivelyRunning = transport.decisionQueue.hasPending()
          && !transport.decisionQueue.hasFailure();
        if (decisionIsActivelyRunning) return false;
        if (transport.decisionQueue.hasFailure()) {
          transport.decisionQueue.resetAfterCanonicalRefresh();
        }
      }
      transport.revisionIds = Object.fromEntries(
        proposals.map(proposal => [proposal.id, proposal.currentDecisionId ?? null]),
      );
      // Prior snapshots include the stored citations from the hydrated live
      // decisions so a later citation toggle produces a DIFFERENT snapshot and
      // a real revision action (issue #17 pass 5c).
      const decisionCitations = citationsFromDecisions(item);
      transport.proposalSnapshots = Object.fromEntries(
        proposals.map(proposal => [
          proposal.id,
          proposalDecisionSnapshot(proposal, decisionCitations[proposal.id] ?? []),
        ]),
      );
      transport.pendingActions = {};
      // Initialize reviewer citation selections from the hydrated LIVE decision
      // for each proposal (issue #17 pass 5b). Stored citations render and stay
      // selected across canonical loads; they are never silently cleared.
      setCitationSelections(decisionCitations);
    }
    setClassificationProposals(proposals);
    setClassificationEvidence(evidence);
    return true;
  };

  /**
   * Reviewer citation selections derived from the hydrated LIVE decisions for
   * each proposal (issue #17 pass 5b). Stored citations initialize the UI so
   * persisted corrections render and stay selected across canonical loads.
   */
  const citationsFromDecisions = (
    item: OnboardingItem | null | undefined,
  ): Record<string, string[]> => {
    const decisions = item?.curationData?.classificationDecisions ?? [];
    const result: Record<string, string[]> = {};
    for (const decision of decisions) {
      if (decision.evidenceIds && decision.evidenceIds.length > 0) {
        result[decision.proposalId] = [...new Set(decision.evidenceIds)].sort();
      }
    }
    return result;
  };


  const drainAllWrites = async (itemId: string | null | undefined) => {
    if (!itemId) return;
    const transport = decisionTransportByItemRef.current.get(itemId);
    if (!transport) return;
    await Promise.all([
      transport.decisionQueue.drain(),
      transport.itemSaveQueue.drain(),
    ]);
  };

  // SSE
  const sseRef = React.useRef<EventSource | null>(null);

  // Anchor of the current range selection — the last card that was single-clicked
  // (non-shift). Shift+click selects every card between this anchor and the
  // target within the same column. Held in a ref so it survives re-renders
  // (and batched state updates) without forcing a re-render of its own.
  const rangeAnchorIdRef = React.useRef<string | null>(null);

  // Ref for keyboard nav — updated before return to avoid TDZ
  const navRef = React.useRef({ handlePrevItem: () => {}, handleNextItem: () => {}, hasPrev: false, hasNext: false });

  // Total card count across all stages — used by the header counter. Cheap
  // (one reduce), so no need to memoize.
  const totalCards = STAGES.reduce(
    (sum, stage) => sum + (staged[stage]?.length || 0),
    0,
  );

  const fetchStaged = useCallback(async () => {
    try {
      const res = await getBatchStagedItems(batchId);
      setStaged(res.staged);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [batchId]);

  const loadStorePages = useCallback(async () => {
    try {
      const res = await fetch('/api/pages');
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.pages)) {
          setStorePages(data.pages.map((p: any) => p.name));
        }
      }
    } catch { /* network error loading pages */ }
  }, []);

  const loadCurationTargets = useCallback(async () => {
    try {
      const res = await getCurationTargets();
      setCurationTargetState(res);
    } catch { /* classification target settings are optional for legacy workspaces */ }
  }, []);

  // Classification readiness banner (issue #17 L): automatic curation is
  // blocked server-side when not ready; the banner surfaces why.
  const [readinessView, setReadinessView] = useState<ReturnType<typeof readinessViewFromReport> | null>(null);
  const loadReadiness = useCallback(async () => {
    try {
      const res = await getClassificationReadiness();
      setReadinessView(readinessViewFromReport(res.readiness));
    } catch {
      setReadinessView(readinessViewFromReport(null));
    }
  }, []);

  useEffect(() => {
    loadReadiness();
  }, [loadReadiness]);

  useEffect(() => {
    fetchStaged();
    loadStorePages();
    loadCurationTargets();

    // SSE connection
    const sse = new EventSource(`/api/onboarding/batches/${batchId}/events`);
    sseRef.current = sse;

    sse.addEventListener('item:status', async (e: MessageEvent) => {
      fetchStaged();
      refreshCohortFamilyState();
      try {
        const event = JSON.parse(e.data);
        const itemId = typeof event?.itemId === 'string' ? event.itemId : null;
        if (!itemId || itemId !== reviewItemRef.current || reviewTransitionRef.current) return;
        const generation = reviewGenerationRef.current;
        const transport = getDecisionTransport(itemId);
        // A background refresh must not overwrite a dirty/failed local action.
        if (transportHasLocalWork(transport)) return;
        const mutationVersion = transport.mutationVersion;

        const res = await getItemDetail(itemId);
        if (!isCurrentReviewVersion(
          reviewItemRef.current,
          reviewGenerationRef.current,
          transport.mutationVersion,
          itemId,
          generation,
          mutationVersion,
        ) || transportHasLocalWork(transport)) return;

        setReviewItem(res.item);
        const extractionData = res.extraction ?? res.item?.extractionData ?? null;
        if (extractionData) {
          setReviewExtraction(extractionData);
          setEditFields(extractionData);
        } else {
          setReviewExtraction(null);
          setEditFields({});
        }
        setReviewQualificationView(res.sourcingQualificationView ?? null);
        if (res.item?.curationData) setCurationFields(res.item.curationData);
        installCanonicalDecisionState(res.item);
        setConsistencyWarnings(res.consistencyWarnings ?? []);
        setSemanticValidation(res.semanticValidation ?? null);
      } catch (err) {
        console.warn('Failed to process SSE item:status event:', err);
      }
    });

    sse.addEventListener('batch:progress', () => {
      fetchStaged();
      refreshCohortFamilyState();
    });

    return () => {
      sse.close();
    };
  }, [batchId, fetchStaged, loadStorePages, loadCurationTargets, refreshCohortFamilyState]);



  // ─── Selection ──────────────────────────────────────────────────────────────

  /**
   * Resolve a card id to its current column and index within that column's
   * visible items. Returns null if the id is no longer present (e.g. it was
   * advanced/removed between the click and the handler running).
   */
  const locateCard = (id: string): { stage: PipelineStage; index: number } | null => {
    for (const stage of STAGES) {
      const items = staged[stage] || [];
      const index = items.findIndex(item => item.id === id);
      if (index >= 0) return { stage, index };
    }
    return null;
  };

  /**
   * Handle a click on a card's checkbox. Supports shift+click range select
   * (additive, bounded by the column). When shift is held and a valid anchor
   * is present in the same column, every card between the anchor and the
   * target is added to the selection. Otherwise it falls through to a normal
   * toggle and the clicked card becomes the new anchor.
   */
  const handleCheckboxClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();

    const anchorId = rangeAnchorIdRef.current;
    if (e.shiftKey && anchorId && anchorId !== id) {
      const anchor = locateCard(anchorId);
      const target = locateCard(id);
      if (anchor && target && anchor.stage === target.stage) {
        const stageItems = staged[anchor.stage] || [];
        const start = Math.min(anchor.index, target.index);
        const end = Math.max(anchor.index, target.index);
        setSelectedIds(prev => {
          const next = new Set(prev);
          for (let i = start; i <= end; i++) {
            next.add(stageItems[i].id);
          }
          return next;
        });
        // Anchor stays put so the user can chain shift+clicks to keep
        // extending from the same starting card.
        return;
      }
      // Cross-column shift+click (or anchor no longer in the board):
      // fall through to a regular toggle so the user still gets feedback.
    }

    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    rangeAnchorIdRef.current = id;
  };

  const selectAllInColumn = (stage: PipelineStage) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const stageItems = staged[stage] || [];
      const allSelected = stageItems.every(item => next.has(item.id));
      if (allSelected) {
        stageItems.forEach(item => next.delete(item.id));
      } else {
        stageItems.forEach(item => next.add(item.id));
      }
      return next;
    });
  };

  const clearSelection = () => {
    rangeAnchorIdRef.current = null;
    setSelectedIds(new Set());
  };

  // ─── Actions ────────────────────────────────────────────────────────────────

  const getSelectedItems = () => {
    const allItems = Object.values(staged).flat();
    return allItems.filter(item => selectedIds.has(item.id));
  };

  const handleSendBackSelected = async () => {
    const selectedItems = getSelectedItems();
    const eligibleItems = selectedItems.filter(item => item.stage !== 'sourcing');
    if (eligibleItems.length === 0) {
      alert('Selected products in the Sourcing stage cannot be sent back.');
      return;
    }

    const count = eligibleItems.length;
    if (!confirm(`Send ${count} selected product(s) back to their previous stage? This will clear current stage results.`)) return;

    setLoading(true);
    try {
      await moveToPreviousStage(eligibleItems.map(item => item.id));
      clearSelection();
      await fetchStaged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleResetSelected = async () => {
    const selectedItems = getSelectedItems();
    if (selectedItems.length === 0) return;

    // While the sourcing engine is disabled (or in observe/invalid mode),
    // Sourcing rows cannot be reset in place (that would strand them) —
    // route them through the audited fallback-to-Discovery repair instead.
    const sourcingItems = !sourcingCapabilityActive
      ? selectedItems.filter(item => item.stage === 'sourcing')
      : [];
    const resetItems = selectedItems.filter(item => item.stage !== 'sourcing' || sourcingCapabilityActive);

    const count = selectedItems.length;
    const repairNote = sourcingItems.length > 0
      ? `\n\n${sourcingItems.length} Sourcing item(s) will move to Discovery (sourcing engine disabled).`
      : '';
    if (!confirm(`Reset ${count} selected product(s)?${repairNote}`)) return;

    setLoading(true);
    try {
      if (resetItems.length > 0) {
        await resetStageItems(resetItems.map(item => item.id));
      }
      if (sourcingItems.length > 0) {
        const res = await fallbackSourcingItemsToDiscovery(sourcingItems.map(item => item.id));
        if (res.skipped.length > 0) {
          setError(`${res.skipped.length} Sourcing item(s) could not be moved: ${res.skipped.map(s => s.reason).join(', ')}`);
        }
      }
      clearSelection();
      await fetchStaged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  /**
   * Bulk audited repair: move selected `sourcing/pending` items to Discovery
   * (sourcing engine disabled). Distinct from Advance/Reset — this is the
   * operator repair operation for the inert stage.
   */
  const handleContinueToDiscoverySelected = async () => {
    const selectedItems = getSelectedItems();
    const eligibleItems = selectedItems.filter(
      item => item.stage === 'sourcing' && item.stageStatus === 'pending',
    );
    if (eligibleItems.length === 0) return;

    const count = eligibleItems.length;
    if (!confirm(`Continue ${count} Sourcing item(s) to Discovery?\n\nThis records a fallback-to-Discovery decision and lets the Discovery worker pick them up.`)) return;

    setLoading(true);
    try {
      const res = await fallbackSourcingItemsToDiscovery(eligibleItems.map(item => item.id));
      if (res.skipped.length > 0) {
        setError(`${res.skipped.length} item(s) could not be moved: ${res.skipped.map(s => s.reason).join(', ')}`);
      }
      clearSelection();
      await fetchStaged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSkipSelected = async () => {
    const selectedItems = getSelectedItems();
    const eligibleItems = selectedItems.filter(item => item.stage !== 'promotion');
    if (eligibleItems.length === 0) {
      alert('Selected products in the Promotion stage cannot be skipped.');
      return;
    }

    const count = eligibleItems.length;
    if (!confirm(`Skip ${count} selected product(s) in their current stage?`)) return;

    setLoading(true);
    try {
      await skipStageItems(eligibleItems.map(item => item.id));
      clearSelection();
      await fetchStaged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleAdvanceSelected = async () => {
    const selectedItems = getSelectedItems();
    const eligibleItems = selectedItems.filter(item => item.stage !== 'promotion');
    if (eligibleItems.length === 0) {
      alert('Selected products in the Promotion stage cannot be advanced (use "Create Drafts" instead).');
      return;
    }


    const count = eligibleItems.length;
    if (!confirm(`Advance ${count} selected product(s) to their next stage?`)) return;

    setLoading(true);
    try {
      await advanceItems(eligibleItems.map(item => item.id));
      clearSelection();
      await fetchStaged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handlePromoteSelected = async () => {
    const selectedItems = getSelectedItems();
    const eligibleItems = selectedItems.filter(item =>
      item.stage === 'promotion' && (item.stageStatus === 'pending' || item.stageStatus === 'completed')
    );
    if (eligibleItems.length === 0) {
      alert('No selected products are in the Promotion stage and ready/completed.');
      return;
    }

    const count = eligibleItems.length;
    if (!confirm(`Create product drafts for ${count} promotion product(s)?`)) return;

    setLoading(true);
    try {
      const res = await fetch('/api/onboarding/batches/' + batchId + '/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: eligibleItems.map(i => i.id) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Promotion failed');
      alert(`Created ${data.count} product drafts!`);
      clearSelection();
      await fetchStaged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // ─── Review Drawer ──────────────────────────────────────────────────────────

  const openReview = async (item: OnboardingItem) => {
    if (reviewTransitionRef.current) return;
    const previousItemId = reviewItemRef.current;
    if (previousItemId && previousItemId !== item.id) {
      try {
        await drainAllWrites(previousItemId);
      } catch (err) {
        setSaveStatus('error');
        setSaveError(err instanceof Error ? err.message : String(err));
        return;
      }
    }

    const generation = reviewGenerationRef.current + 1;
    reviewGenerationRef.current = generation;
    reviewItemRef.current = item.id;
    // Clear sourcing state immediately: item B must never briefly show
    // item A's evidence/conflicts/generations while its detail loads.
    setReviewEvidenceAttempts([]);
    setReviewConflicts([]);
    setReviewGenerations([]);
    setReviewItem(item);
    setManualUrlInput(item.sourceUrl || '');
    setManualImageUrl('');
    setShowEditUrl(false);
    setDrawerBrandName(item.brandHint || '');
    setSaveStatus('idle');
    setSaveError(null);
    setConsistencyWarnings([]);
    setSemanticValidation(null);
    const site = cachedBrandSites.find(
      b => b.brandName.toLowerCase() === (item.brandHint || '').toLowerCase().trim(),
    );
    setDrawerBrandDomain(site?.domain || '');

    // Seed from staged JSON first, then replace with server-hydrated canonical
    // proposals/decision ids from item detail (which include live revisions).
    installCanonicalDecisionState(item);
    const transport = getDecisionTransport(item.id);
    const mutationVersion = transport.mutationVersion;

    try {
      const res = await getItemDetail(item.id);
      if (!isCurrentReviewVersion(
        reviewItemRef.current,
        reviewGenerationRef.current,
        transport.mutationVersion,
        item.id,
        generation,
        mutationVersion,
      )) return;

      setReviewItem(res.item);
      setReviewSources(res.sources);
      setReviewEvidenceAttempts(res.evidenceAttempts ?? []);
      setReviewConflicts(res.conflicts ?? []);
      setReviewGenerations(res.generations ?? []);
      setReviewQualificationView(res.sourcingQualificationView ?? null);
      setConsistencyWarnings(res.consistencyWarnings ?? []);
      setSemanticValidation(res.semanticValidation ?? null);
      // Prefer extraction from the dedicated extractions table, then fall
      // back to extraction_data_json stored on the item itself so the
      // drawer shows data even when the extractions table row is missing.
      const extractionData = res.extraction ?? res.item?.extractionData ?? null;
      if (extractionData) {
        setReviewExtraction(extractionData);
        setEditFields(extractionData);
        setActiveImageIdx(0);
      }
      if (res.item?.curationData) {
        setCurationFields(res.item.curationData);
      } else if (item.curationData) {
        setCurationFields(item.curationData);
      } else {
        setCurationFields({
          curatedTitle: extractionData?.title || item.name,
          packagingOcrTitle: null,
          titleSource: 'web',
          suggestedPages: [],
          suggestedProductType: null,
        });
      }
      // Server hydration is authoritative for proposals + currentDecisionId.
      installCanonicalDecisionState(res.item);
    } catch (err) {
      if (isCurrentReviewGeneration(
        reviewItemRef.current,
        reviewGenerationRef.current,
        item.id,
        generation,
      )) {
        setSaveStatus('error');
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    }
  };


  const itemsInStage = reviewItem ? (staged[reviewItem.stage] || []) : [];
  const currentReviewIndex = reviewItem ? itemsInStage.findIndex(item => item.id === reviewItem.id) : -1;
  const hasPrev = currentReviewIndex > 0;
  const hasNext = currentReviewIndex !== -1 && currentReviewIndex < itemsInStage.length - 1;

  // Live decisions keyed by proposal id (issue #17 pass 5b): the matching
  // decision renders stored citations on both review surfaces.
  const decisionsByProposal: Record<string, ClassificationProposalDecision> = {};
  for (const decision of reviewItem?.curationData?.classificationDecisions ?? []) {
    decisionsByProposal[decision.proposalId] = decision;
  }

  const handlePrevItem = () => {
    if (hasPrev) {
      void openReview(itemsInStage[currentReviewIndex - 1]);
    }
  };

  const handleNextItem = () => {
    if (hasNext) {
      void openReview(itemsInStage[currentReviewIndex + 1]);
    }
  };







  /** Save editable item fields only. Proposal decisions use their own endpoint. */








  /**
   * Refresh the review drawer from the server after ANY sourcing mutation
   * (continue / conflict resolve / retry). Never optimistic: the drawer
   * always reflects the persisted decision, generation, and evidence.
   */

  /**
   * Single-item audited continuation: move the review item from Sourcing to
   * Discovery (the only supported Sourcing resolution while the engine is
   * disabled — no distributor-bundle routing exists).
   */

  /**
   * Resolve a durable sourcing conflict (ADR 0014): resolve_candidate |
   * custom_value | dismiss. Refreshes the drawer + board after success —
   * never optimistic advancement.
   */

  /**
   * Engine-ON retry: POST /onboarding/items/:id/retry supersedes the
   * current evidence generation and resets the sourcing item for a clean
   * re-run (ADR 0014). Refreshes the drawer + board after success.
   */

  /**
   * Manual-mode operator decision: adopt the qualified distributor record.
   * Sends ONLY the action — the server recomputes qualification and derives
   * every accepted-id/hash/provider value (Amendment A).
   */

  // ─── Render ─────────────────────────────────────────────────────────────────

  const renderCard = (item: OnboardingItem) => {
    const isNeedsReview = item.stageStatus === 'completed' && item.errorMessage?.startsWith('needs_review:');
    const statusStyle = isNeedsReview
      ? { bg: '#ffedd5', text: '#c2410c', icon: '⚠' }
      : (STAGE_STATUS_STYLE[item.stageStatus] || STAGE_STATUS_STYLE.pending);
    const isSelected = selectedIds.has(item.id);
    const isAutomatedStage = ['discovery', 'extraction', 'curation'].includes(item.stage);
    const isReviewStage = item.stage === 'review';
    // Family indicator state for the curation column (issue #30, PR2).
    const familyState = item.stage === 'curation' ? cohortFamilyByItem[item.id] : undefined;
    // Per-member badge wording (round-2 F7); hidden for singletons.
    const familyBadge = familyState && familyState.memberCount >= 2 ? familyBadgeFor(familyState) : null;

    return (
      <div
        key={item.id}
        style={{
          padding: '10px 12px',
          background: isSelected ? '#eff6ff' : '#fff',
          border: `1px solid ${isSelected ? '#3b82f6' : '#e5e7eb'}`,
          borderRadius: 6,
          marginBottom: 6,
          cursor: 'pointer',
          fontSize: 13,
          transition: 'background 0.15s',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          {/* Checkbox for selection — clicking opens drawer via card body.
              Uses onClick (not onChange) so we can read e.shiftKey directly
              for range selection between the anchor and the clicked card. */}
          <input
            type="checkbox"
            checked={isSelected}
            onClick={(e) => handleCheckboxClick(item.id, e)}
            style={{ marginTop: 2, cursor: 'pointer' }}
          />
          {/* Card body — click opens the drawer for any stage */}
          <div
            onClick={() => openReview(item)}
            style={{ flex: 1, cursor: 'pointer', minWidth: 0 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
              <strong style={{ fontSize: 13, color: '#111827', flex: 1, marginRight: 8 }}>
                {item.curationData?.curatedTitle || item.expectedName || item.name}
              </strong>
              <span style={{
                fontSize: 10,
                fontWeight: 600,
                padding: '1px 6px',
                borderRadius: 8,
                background: statusStyle.bg,
                color: statusStyle.text,
                whiteSpace: 'nowrap',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}>
                {item.stageStatus === 'in_progress' ? (
                  <span style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '8px',
                    border: '1.5px solid currentColor',
                    borderTopColor: 'transparent',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }} />
                ) : (
                  <span>{statusStyle.icon}</span>
                )}
                {isNeedsReview ? 'needs review' : item.stageStatus}
              </span>
            </div>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>
              UPC: {item.upc}
              {item.brandHint ? (
                <span>
                  {' · '}{item.brandHint}
                  {onOpenBrandSetup && (
                    <a href="#" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenBrandSetup(item.brandHint); }} style={{ fontSize: 10, color: '#2563eb', fontWeight: 500, textDecoration: 'underline', marginLeft: 4 }}>
                      (setup)
                    </a>
                  )}
                </span>
              ) : (['curation', 'review', 'promotion'].includes(item.stage) && (
                <span style={{ color: '#dc2626', fontWeight: 600, fontSize: 10, marginLeft: 4 }}>
                  · ⚠ Missing Brand
                </span>
              ))}
            </div>
            {item.sourceUrl && (
              <div style={{ fontSize: 10, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.sourceUrl}
              </div>
            )}
            {item.errorMessage && (
              <div style={{ fontSize: 10, color: '#dc2626', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>{item.errorMessage}</span>
                {(() => {
                  if (item.stage !== 'extraction' || item.stageStatus !== 'failed') return null;
                  const failReason = deriveProfileFailReason(item.errorMessage);
                  if (!failReason) return null;
                  const itemDomain = item.sourceUrl ? new URL(item.sourceUrl).hostname.replace(/^www\./, '') : item.brandHint || '';

                  if (failReason === 'no_profile') {
                    return (
                      <>
                        <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 8, background: '#fef3c7', color: '#92400e' }}>
                          ⚠ Profile required
                        </span>
                        {onOpenProfileBuilder && (
                          <a href="#" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenProfileBuilder(itemDomain, item); }} style={{ fontSize: 10, color: '#2563eb', fontWeight: 600, textDecoration: 'underline' }}>
                            Open Profile Builder →
                          </a>
                        )}
                        {onOpenBrandSetup && (
                          <a href="#" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenBrandSetup(item.brandHint); }} style={{ fontSize: 10, color: '#059669', fontWeight: 600, textDecoration: 'underline', marginLeft: 4 }}>
                            Setup Brand →
                          </a>
                        )}
                      </>
                    );
                  }

                  const badgeStyle = failReason === 'ambiguous_match'
                    ? { background: '#ffedd5', color: '#c2410c' }
                    : { background: '#fee2e2', color: '#991b1b' };
                  const badgeText = failReason === 'ambiguous_match' ? '⚠ Ambiguous match' : '⚠ Structure mismatch';

                  return (
                    <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 8, ...badgeStyle }}>
                      {badgeText}
                    </span>
                  );
                })()}
              </div>
            )}
            {item.stage === 'curation' && familyBadge && (
              <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{
                  display: 'inline-block',
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '1px 6px',
                  borderRadius: 8,
                  background: familyBadge.background,
                  color: familyBadge.color,
                }}>
                  {familyBadge.text}
                </span>
                <span style={{ fontSize: 10, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
                  {familyState!.groupLabel}
                </span>
              </div>
            )}
            {/* PR10 (issue #30, DECISION-B): a blocked active-cohort member's
                committed semanticValidation projects to a red card badge so
                blocked members are visible from the board before opening the
                drawer (the committed payload is only written by processCohort
                for active members; legacy items never carry the key). */}
            {item.curationData?.semanticValidation?.status === 'blocked' && (
              <span style={{
                marginTop: 4,
                display: 'inline-block',
                padding: '1px 6px',
                fontSize: 10,
                fontWeight: 600,
                borderRadius: 8,
                background: '#fee2e2',
                color: '#991b1b',
              }}>
                ⛔ Semantic blocked
              </span>
            )}
            {isReviewStage && (
              <span style={{
                marginTop: 4,
                display: 'inline-block',
                padding: '2px 8px',
                fontSize: 11,
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                fontWeight: 600,
              }}>
                Review & Approve
              </span>
            )}
            {isAutomatedStage && (
              <span style={{
                marginTop: 4,
                display: 'inline-block',
                fontSize: 10,
                color: '#6b7280',
                fontStyle: 'italic',
              }}>
                Click to inspect
              </span>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderColumn = (stage: PipelineStage) => {
    const items = staged[stage] || [];
    const inProgressCount = items.filter(i => i.stageStatus === 'in_progress').length;
    const pendingCount = items.filter(i => i.stageStatus === 'pending').length;
    const completedCount = items.filter(i => i.stageStatus === 'completed' && !i.errorMessage?.startsWith('needs_review:')).length;
    const needsReviewCount = items.filter(i => i.stageStatus === 'completed' && i.errorMessage?.startsWith('needs_review:')).length;
    const failedCount = items.filter(i => i.stageStatus === 'failed').length;
    const skippedCount = items.filter(i => i.stageStatus === 'skipped').length;
    const columnAllSelected = items.length > 0 && items.every(i => selectedIds.has(i.id));

    return (
      <div
        key={stage}
        style={{
          flex: '1 1 0',
          minWidth: 220,
          display: 'flex',
          flexDirection: 'column',
          background: '#f9fafb',
          borderRadius: 8,
          border: '1px solid #e5e7eb',
          overflow: 'hidden',
        }}
      >
        {/* Column Header */}
        <div style={{
          padding: '12px 16px',
          borderBottom: '2px solid #e5e7eb',
          background: '#fff',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#111827' }}>
                {STAGE_LABELS[stage]}
              </h3>
              <span style={{ fontSize: 11, color: '#6b7280' }}>
                {STAGE_DESCRIPTIONS[stage]}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 22, fontWeight: 600, color: '#374151' }}>
                {items.length}
              </span>
              {items.length > 0 && (
                <button
                   onClick={() => selectAllInColumn(stage)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#2563eb',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 600,
                    padding: 0,
                  }}
                >
                  {columnAllSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, fontSize: 11, flexWrap: 'wrap' }}>
            {inProgressCount > 0 && (
              <span style={{ color: '#2563eb', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <span style={{
                  display: 'inline-block',
                  width: '8px',
                  height: '8px',
                  border: '1.5px solid currentColor',
                  borderTopColor: 'transparent',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }} />
                {inProgressCount} running
              </span>
            )}
            {pendingCount > 0 && <span style={{ color: '#4b5563' }}>⏳ {pendingCount} queued</span>}
            {completedCount > 0 && <span style={{ color: '#16a34a' }}>✓ {completedCount} ready</span>}
            {needsReviewCount > 0 && <span style={{ color: '#c2410c' }}>⚠ {needsReviewCount} review</span>}
            {failedCount > 0 && <span style={{ color: '#dc2626' }}>✗ {failedCount} failed</span>}
            {skippedCount > 0 && <span style={{ color: '#6b7280' }}>⊘ {skippedCount} skipped</span>}
          </div>
        </div>

        {/* Item Cards */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px', minHeight: 100 }}>
          {items.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 24, color: '#9ca3af', fontSize: 12, fontStyle: 'italic' }}>
              No items
            </div>
          ) : (
            items.map(renderCard)
          )}
        </div>
      </div>
    );
  };

  // Keep navRef.current in sync for the keyboard nav effect
  navRef.current = { handlePrevItem, handleNextItem, hasPrev, hasNext };

  useEffect(() => {
    if (!reviewItem) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const { hasPrev: hp, hasNext: hn, handlePrevItem: prev, handleNextItem: next } = navRef.current;
      if (e.key === 'ArrowLeft' && hp) {
        e.preventDefault();
        prev();
      } else if (e.key === 'ArrowRight' && hn) {
        e.preventDefault();
        next();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [reviewItem]);

  const selectedItems = getSelectedItems();
  // While the sourcing engine is disabled (or observe/invalid mode),
  // sourcing/pending rows are repaired through the audited
  // Continue-to-Discovery action (not generic Advance/Reset).
  const hasContinueToDiscoveryEligible = !sourcingCapabilityActive && selectedItems.some(
    item => item.stage === 'sourcing' && item.stageStatus === 'pending',
  );
  const hasSendBackEligible = selectedItems.some(item => item.stage !== 'sourcing');
  const hasResetEligible = selectedItems.length > 0;
  const hasSkipEligible = selectedItems.some(item => item.stage !== 'promotion');
  const hasAdvanceEligible = selectedItems.some(item => item.stage !== 'promotion');
  const hasPromoteEligible = selectedItems.some(item =>
    item.stage === 'promotion' && (item.stageStatus === 'pending' || item.stageStatus === 'completed')
  );

  return (
    <div style={{ height: 'calc(100vh - 48px)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
      {/* Header */}
      {readinessView && !readinessView.isReady && (
        <div style={{ padding: '8px 24px', flexShrink: 0, background: '#fff7ed', borderBottom: '1px solid #fdba74', fontSize: 13 }}>
          <span style={{ color: '#9a3412', fontWeight: 600 }}>⚠ Automatic curation is blocked — classification is not ready.</span>{' '}
          <span style={{ color: '#7c2d12' }}>{readinessView.capabilities.page.reason || readinessView.summary.join(' ')}</span>
          {readinessView.findingCodes.length > 0 && (
            <span style={{ color: '#7c2d12' }}> (Findings: {readinessView.findingCodes.join(', ')})</span>
          )}
          {' '}
          <a href="/?view=onboarding&settingsTab=curation" style={{ color: '#9a3412', fontWeight: 600 }}>Open Curation Targets settings →</a>
        </div>
      )}
      {/* Header */}
      <div style={{ padding: '12px 24px', flexShrink: 0, borderBottom: '1px solid #e5e7eb', background: '#fff', marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={onBack}
              style={{
                padding: '6px 12px',
                fontSize: 12,
                background: '#fff',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                cursor: 'pointer',
                color: '#4b5563',
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = '#f3f4f6';
                e.currentTarget.style.borderColor = '#9ca3af';
                e.currentTarget.style.color = '#1f2937';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = '#fff';
                e.currentTarget.style.borderColor = '#d1d5db';
                e.currentTarget.style.color = '#4b5563';
              }}
            >
              ← All Batches
            </button>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#111827' }}>
                  Pipeline Board: <span style={{ color: '#2563eb' }}>{batchName}</span>
                </h1>
                <span style={{ fontSize: 11, fontWeight: 600, background: '#f3f4f6', border: '1px solid #d1d5db', color: '#4b5563', borderRadius: 999, padding: '2px 10px' }}>
                  Diagnostics
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                Pipeline diagnostics — raw execution state (read-only guidance for troubleshooting).
                The Batch Workspace is the recommended operator surface; manual stage actions here are admin tools.
              </div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            {totalCards > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span>{selectedIds.size} of {totalCards} selected</span>
                {selectedIds.size > 0 && (
                  <>
                    <span style={{ color: '#e5e7eb' }}>|</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {hasSendBackEligible && (
                        <button
                          onClick={handleSendBackSelected}
                          disabled={loading}
                          style={{
                            padding: '4px 8px',
                            fontSize: 11,
                            fontWeight: 600,
                            background: '#fff',
                            border: '1px solid #fee2e2',
                            color: '#dc2626',
                            borderRadius: 4,
                            cursor: loading ? 'not-allowed' : 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                            transition: 'all 0.15s',
                          }}
                        >
                          ◀ Send Back
                        </button>
                      )}
                      {hasContinueToDiscoveryEligible && (
                        <button
                          onClick={handleContinueToDiscoverySelected}
                          disabled={loading}
                          style={{
                            padding: '4px 8px',
                            fontSize: 11,
                            fontWeight: 700,
                            background: '#2563eb',
                            border: '1px solid #2563eb',
                            color: '#ffffff',
                            borderRadius: 4,
                            cursor: loading ? 'not-allowed' : 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                            transition: 'all 0.15s',
                          }}
                        >
                          → Continue to Discovery
                        </button>
                      )}
                      {hasResetEligible && (
                        <button
                          onClick={handleResetSelected}
                          disabled={loading}
                          style={{
                            padding: '4px 8px',
                            fontSize: 11,
                            fontWeight: 600,
                            background: '#fff',
                            border: '1px solid #d1d5db',
                            color: '#2563eb',
                            borderRadius: 4,
                            cursor: loading ? 'not-allowed' : 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                            transition: 'all 0.15s',
                          }}
                        >
                          🔄 Reset
                        </button>
                      )}
                      {hasSkipEligible && (
                        <button
                          onClick={handleSkipSelected}
                          disabled={loading}
                          style={{
                            padding: '4px 8px',
                            fontSize: 11,
                            fontWeight: 600,
                            background: '#fff',
                            border: '1px solid #d1d5db',
                            color: '#6b7280',
                            borderRadius: 4,
                            cursor: loading ? 'not-allowed' : 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                            transition: 'all 0.15s',
                          }}
                        >
                          ⊘ Skip
                        </button>
                      )}
                      {hasAdvanceEligible && (
                        <button
                          onClick={handleAdvanceSelected}
                          disabled={loading}
                          style={{
                            padding: '4px 8px',
                            fontSize: 11,
                            fontWeight: 600,
                            background: '#16a34a',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 4,
                            cursor: loading ? 'not-allowed' : 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                            transition: 'all 0.15s',
                          }}
                        >
                          ▶ Advance
                        </button>
                      )}
                      {hasPromoteEligible && (
                        <button
                          onClick={handlePromoteSelected}
                          disabled={loading}
                          style={{
                            padding: '4px 8px',
                            fontSize: 11,
                            fontWeight: 600,
                            background: '#2563eb',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 4,
                            cursor: loading ? 'not-allowed' : 'pointer',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 2,
                            transition: 'all 0.15s',
                          }}
                        >
                          🚀 Create Drafts
                        </button>
                      )}
                    </div>
                    <span style={{ color: '#e5e7eb' }}>|</span>
                    <button
                      onClick={clearSelection}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#6b7280',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                        textDecoration: 'underline',
                      }}
                    >
                      Clear
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div style={{ color: '#dc2626', background: '#fef2f2', padding: '8px 12px', borderRadius: 6, marginTop: 8 }}>
            {error}
          </div>
        )}
      </div>

      {/* Kanban Columns */}
      <div style={{
        display: 'flex',
        gap: 12,
        overflowX: 'auto',
        padding: '0 24px 16px',
        flex: 1,
        minHeight: 0,
      }}>
        {STAGES.map(renderColumn)}
      </div>

    </div>
  );
}

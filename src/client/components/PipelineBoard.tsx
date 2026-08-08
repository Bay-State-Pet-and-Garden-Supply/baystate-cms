import React, { useState, useEffect, useCallback } from 'react';
import {
  getBatchStagedItems,
  advanceItems,
  resetStageItems,
  skipStageItems,
  moveToPreviousStage,
  updateItem,
  getItemDetail,
  setItemUrl,
  submitDecisions,
  completeReviewStage,
  OnboardingApiError,
  getCurationTargets,
  getClassificationReadiness,
  type CurationTargetsResponse,
  type ConsistencyWarning,
} from '../onboarding-api';
import type {
  OnboardingItem,
  OnboardingSource,
  ExtractionData,
  CurationData,
  PipelineStage,
  StageStatus,
  BrandSite,
} from '../../shared/schemas/onboarding';
import type {
  ClassificationProposal,
  ClassificationProposalDecision,
  ClassificationEvidence,
  CurationTargetConfig,
} from '../../shared/schemas/classification';
import {
  ActionQueueResetError,
  SequentialActionQueue,
  canApplyProposalEdit,
  editableCurationData,
  getEffectiveProductTypeId,
  getEffectiveProposalTargetId,
  getEffectiveProposalValue,
  isCurrentReviewGeneration,
  isCurrentReviewVersion,
  prepareDecisionAction,
  proposalDecisionSnapshot,
  withReviewedProductTypeId,
  withReviewedProposalValue,
  type PreparedDecisionAction,
  type ProposalDecisionSnapshot,
} from '../pipeline-decision-state';
import { ReviewDrawerShell } from './pipeline-drawer/ReviewDrawerShell';
import { ProductImageGallery } from './pipeline-drawer/ProductImageGallery';
import { DiscoveryStagePanel } from './pipeline-drawer/DiscoveryStagePanel';
import { ExtractionStagePanel } from './pipeline-drawer/ExtractionStagePanel';
import { CurationStagePanel } from './pipeline-drawer/CurationStagePanel';
import { readinessViewFromReport } from '../classification-readiness-view';

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

function createDecisionActionToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
}: PipelineBoardProps) {
  const [staged, setStaged] = useState<Record<PipelineStage, OnboardingItem[]>>({
    sourcing: [],
    discovery: [],
    extraction: [],
    curation: [],
    review: [],
    promotion: [],
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Review drawer state
  const [reviewItem, setReviewItem] = useState<OnboardingItem | null>(null);
  const reviewItemRef = React.useRef<string | null>(null);
  const reviewGenerationRef = React.useRef(0);
  const [reviewSources, setReviewSources] = useState<OnboardingSource[]>([]);
  const [reviewExtraction, setReviewExtraction] = useState<ExtractionData | null>(null);
  const [editFields, setEditFields] = useState<Partial<ExtractionData>>({});
  const [activeImageIdx, setActiveImageIdx] = useState(0);
  const [curationFields, setCurationFields] = useState<Partial<CurationData>>({});
  const [classificationProposals, setClassificationProposals] = useState<ClassificationProposal[]>([]);
  const [_classificationEvidence, setClassificationEvidence] = useState<ClassificationEvidence[]>([]);
  const [consistencyWarnings, setConsistencyWarnings] = useState<ConsistencyWarning[]>([]);
  const [curationTargetState, setCurationTargetState] = useState<CurationTargetsResponse | null>(null);
  const [manualUrlInput, setManualUrlInput] = useState('');
  const [manualImageUrl, setManualImageUrl] = useState('');
  const [showEditUrl, setShowEditUrl] = useState(false);
  const [storePages, setStorePages] = useState<string[]>([]);
  const [pageSearchQuery, setPageSearchQuery] = useState('');
  const [_drawerBrandName, setDrawerBrandName] = useState('');
  const [_drawerBrandDomain, setDrawerBrandDomain] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reviewTransitioning, setReviewTransitioning] = useState(false);
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
      transport.proposalSnapshots = Object.fromEntries(
        proposals.map(proposal => [proposal.id, proposalDecisionSnapshot(proposal)]),
      );
      transport.pendingActions = {};
    }
    setClassificationProposals(proposals);
    setClassificationEvidence(evidence);
    return true;
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
        if (res.item?.curationData) setCurationFields(res.item.curationData);
        installCanonicalDecisionState(res.item);
        setConsistencyWarnings(res.consistencyWarnings ?? []);
      } catch (err) {
        console.warn('Failed to process SSE item:status event:', err);
      }
    });

    sse.addEventListener('batch:progress', () => {
      fetchStaged();
    });

    return () => {
      sse.close();
    };
  }, [batchId, fetchStaged, loadStorePages, loadCurationTargets]);



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
    const eligibleItems = selectedItems.filter(item => item.stage !== 'discovery');
    if (eligibleItems.length === 0) {
      alert('Selected products in the Discovery stage cannot be sent back.');
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

    const count = selectedItems.length;
    if (!confirm(`Reset ${count} selected product(s)?`)) return;

    setLoading(true);
    try {
      await resetStageItems(selectedItems.map(item => item.id));
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
    setReviewItem(item);
    setManualUrlInput(item.sourceUrl || '');
    setManualImageUrl('');
    setShowEditUrl(false);
    setDrawerBrandName(item.brandHint || '');
    setSaveStatus('idle');
    setSaveError(null);
    setConsistencyWarnings([]);
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
      setConsistencyWarnings(res.consistencyWarnings ?? []);
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

  const closeReview = async () => {
    if (reviewTransitionRef.current) return;
    const closingId = reviewItemRef.current;
    try {
      await drainAllWrites(closingId);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
      return;
    }
    reviewGenerationRef.current += 1;
    reviewItemRef.current = null;
    setReviewItem(null);
    setReviewSources([]);
    setReviewExtraction(null);
    setEditFields({});
    setCurationFields({});
    setManualImageUrl('');
    setClassificationProposals([]);
    setClassificationEvidence([]);
    setConsistencyWarnings([]);
    setSaveStatus('idle');
    setSaveError(null);
    setPageSearchQuery('');
    await fetchStaged();
  };

  const itemsInStage = reviewItem ? (staged[reviewItem.stage] || []) : [];
  const currentReviewIndex = reviewItem ? itemsInStage.findIndex(item => item.id === reviewItem.id) : -1;
  const hasPrev = currentReviewIndex > 0;
  const hasNext = currentReviewIndex !== -1 && currentReviewIndex < itemsInStage.length - 1;

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

  const handleResetSingle = async () => {
    if (!reviewItem || reviewTransitionRef.current) return;
    setLoading(true);
    try {
      await drainAllWrites(reviewItem.id);
      const itemId = reviewItem.id;
      const generation = reviewGenerationRef.current;
      const transport = getDecisionTransport(itemId);
      transport.mutationVersion += 1;
      const mutationVersion = transport.mutationVersion;
      await resetStageItems([itemId]);
      const res = await getItemDetail(itemId);
      if (!isCurrentReviewVersion(
        reviewItemRef.current,
        reviewGenerationRef.current,
        transport.mutationVersion,
        itemId,
        generation,
        mutationVersion,
      )) return;
      setReviewItem(res.item);
      setConsistencyWarnings(res.consistencyWarnings ?? []);
      const extractionData = res.extraction ?? res.item?.extractionData ?? null;
      if (extractionData) {
        setReviewExtraction(extractionData);
        setEditFields(extractionData);
      } else {
        setReviewExtraction(null);
        setEditFields({});
      }
      if (res.item?.curationData) {
        setCurationFields(res.item.curationData);
      }
      // After review→curation reset, proposals are pending and decisions are
      // superseded — install the hydrated server state, not the cached accept.
      installCanonicalDecisionState(res.item);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleAdvanceSingle = async () => {
    if (!reviewItem || reviewTransitionRef.current) return;
    setLoading(true);
    try {
      await drainAllWrites(reviewItem.id);
      await advanceItems([reviewItem.id]);
      await fetchStaged();
      const res = await getItemDetail(reviewItem.id);
      setReviewItem(res.item);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleApproveAndNext = async () => {
    if (!reviewItem || reviewTransitionRef.current) return;
    const nextItemToOpen = hasNext ? itemsInStage[currentReviewIndex + 1] : null;
    await handleApproveReview();
    if (nextItemToOpen) {
      void openReview(nextItemToOpen);
    }
  };

  const fieldTargetForProposal = (proposal: ClassificationProposal): { target: CurationTargetConfig | null; values: string[]; label: string } => {
    const effectiveTargetId = getEffectiveProposalTargetId(proposal);
    if (proposal.proposalType !== 'field_assignment' || !curationTargetState) {
      return { target: null, values: [], label: effectiveTargetId || 'Field' };
    }
    const field = curationTargetState.candidates.productFields.find(candidate =>
      candidate.attributeId === effectiveTargetId || candidate.target?.attributeId === effectiveTargetId,
    );
    return {
      target: field?.target ?? null,
      values: field?.values ?? [],
      label: field ? `${field.label} (${field.catalogField})` : effectiveTargetId || 'Field',
    };
  };

  const productTypeOptions = () => curationTargetState?.candidates.productTypes ?? [];

  const markSavedWhenIdle = (itemId: string, generation: number) => {
    const transport = getDecisionTransport(itemId);
    if (transportHasLocalWork(transport)) return;
    if (!isCurrentReviewGeneration(
      reviewItemRef.current,
      reviewGenerationRef.current,
      itemId,
      generation,
    )) return;
    setSaveStatus('saved');
    setTimeout(() => {
      if (isCurrentReviewGeneration(
        reviewItemRef.current,
        reviewGenerationRef.current,
        itemId,
        generation,
      )) {
        setSaveStatus(previous => previous === 'saved' ? 'idle' : previous);
      }
    }, 1500);
  };

  /** Save editable item fields only. Proposal decisions use their own endpoint. */
  const saveItemChangesQuietly = (
    itemId: string,
    currentEditFields: Partial<ExtractionData>,
    currentCurationFields: Partial<CurationData>,
  ) => {
    if (reviewTransitionRef.current) return;
    const generation = reviewGenerationRef.current;
    const transport = getDecisionTransport(itemId);
    transport.mutationVersion += 1;
    const action: ItemSaveAction = JSON.parse(JSON.stringify({
      extractionData: currentEditFields,
      curationData: editableCurationData(currentCurationFields),
    })) as ItemSaveAction;

    if (isCurrentReviewGeneration(
      reviewItemRef.current,
      reviewGenerationRef.current,
      itemId,
      generation,
    )) {
      setSaveStatus('saving');
      setSaveError(null);
    }

    const operation = transport.itemSaveQueue.enqueue(action, async captured => {
      await updateItem(itemId, {
        extraction_data: captured.extractionData,
        curation_data: captured.curationData,
      });
    });

    void operation
      .then(() => markSavedWhenIdle(itemId, generation))
      .catch(err => {
        if (isCurrentReviewGeneration(
          reviewItemRef.current,
          reviewGenerationRef.current,
          itemId,
          generation,
        )) {
          setSaveStatus('error');
          setSaveError(err instanceof Error ? err.message : String(err));
        }
      });
  };

  const refreshCanonicalAfterConflict = async (
    itemId: string,
    generation: number,
    conflictMessage: string,
  ) => {
    try {
      const res = await getItemDetail(itemId);
      if (!isCurrentReviewGeneration(
        reviewItemRef.current,
        reviewGenerationRef.current,
        itemId,
        generation,
      )) return;
      setReviewItem(res.item);
      installCanonicalDecisionState(res.item, { force: true });
      setConsistencyWarnings(res.consistencyWarnings ?? []);
      setSaveStatus('error');
      setSaveError(`${conflictMessage} Canonical decisions were refreshed; reapply your edit.`);
    } catch (refreshError) {
      setSaveStatus('error');
      setSaveError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  };

  const handleDecisionSuccess = (
    itemId: string,
    generation: number,
    action: PreparedDecisionAction,
    decision: ClassificationProposalDecision,
  ) => {
    const transport = getDecisionTransport(itemId);
    if (transport.pendingActions[action.input.proposalId]?.input.actionToken === action.input.actionToken) {
      delete transport.pendingActions[action.input.proposalId];
    }
    if (transport.revisionIds[action.input.proposalId] === action.input.id) {
      transport.revisionIds[action.input.proposalId] = decision.id;
    }
    if (isCurrentReviewGeneration(
      reviewItemRef.current,
      reviewGenerationRef.current,
      itemId,
      generation,
    ) && !transport.pendingActions[action.input.proposalId]) {
      setClassificationProposals(previous => previous.map(proposal =>
        proposal.id === action.input.proposalId
          ? { ...proposal, currentDecisionId: decision.id }
          : proposal,
      ));
    }
    markSavedWhenIdle(itemId, generation);
  };

  const enqueueProposalDecision = (
    itemId: string,
    generation: number,
    proposal: ClassificationProposal,
  ) => {
    const transport = getDecisionTransport(itemId);
    if (!canApplyProposalEdit(transport.decisionQueue.hasFailure(), reviewTransitionRef.current !== null)) {
      setSaveStatus('error');
      setSaveError('A proposal decision failed. Retry the failed save or refresh canonical state before continuing.');
      return;
    }

    const priorSnapshot = transport.proposalSnapshots[proposal.id]
      ?? proposalDecisionSnapshot(proposal);
    const action = prepareDecisionAction({
      proposal,
      priorSnapshot,
      expectedRevisionId: transport.revisionIds[proposal.id] ?? null,
      existingAction: transport.pendingActions[proposal.id],
      createId: createDecisionActionToken,
      createActionToken: createDecisionActionToken,
    });
    if (!action) return;

    // Capture the semantic state and optimistic predecessor now. Rapid A1/A2
    // edits form a deterministic client-generated revision chain.
    transport.pendingActions[proposal.id] = action;
    transport.proposalSnapshots[proposal.id] = action.snapshot;
    transport.revisionIds[proposal.id] = action.input.id;
    transport.mutationVersion += 1;
    setSaveStatus('saving');
    setSaveError(null);

    const operation = transport.decisionQueue.enqueue(action, async captured => {
      const response = await submitDecisions(itemId, [captured.input]);
      const persisted = response.decisions[0];
      if (!persisted) throw new Error('Decision endpoint returned no persisted decision.');
      if (persisted.id !== captured.input.id) {
        throw new Error('Decision endpoint returned an unexpected decision id.');
      }
      return persisted;
    });

    void operation
      .then(decision => handleDecisionSuccess(itemId, generation, action, decision))
      .catch(err => {
        if (err instanceof ActionQueueResetError) return;
        if (err instanceof OnboardingApiError && err.status === 409) {
          void refreshCanonicalAfterConflict(itemId, generation, err.message);
          return;
        }
        if (isCurrentReviewGeneration(
          reviewItemRef.current,
          reviewGenerationRef.current,
          itemId,
          generation,
        )) {
          setSaveStatus('error');
          setSaveError(err instanceof Error ? err.message : String(err));
        }
      });
  };

  const updateProposal = (proposalId: string, patch: Partial<ClassificationProposal>) => {
    const current = classificationProposals.find(proposal => proposal.id === proposalId);
    if (!current || !reviewItem) return;
    const transport = getDecisionTransport(reviewItem.id);
    if (!canApplyProposalEdit(transport.decisionQueue.hasFailure(), reviewTransitionRef.current !== null)) {
      setSaveStatus('error');
      setSaveError(transport.decisionQueue.hasFailure()
        ? 'Retry the failed proposal save or refresh canonical state before making another edit.'
        : 'Review approval is already in progress.');
      return;
    }
    const nextProposal = { ...current, ...patch };
    if (patch.hasRevisedValue === false) delete nextProposal.revisedValue;
    if (patch.hasRevisedTargetId === false) delete nextProposal.revisedTargetId;
    setClassificationProposals(previous => previous.map(proposal =>
      proposal.id === proposalId ? nextProposal : proposal,
    ));
    enqueueProposalDecision(reviewItem.id, reviewGenerationRef.current, nextProposal);
  };

  const retryFailedWrites = async () => {
    if (!reviewItem) return;
    const itemId = reviewItem.id;
    const generation = reviewGenerationRef.current;
    const transport = getDecisionTransport(itemId);
    setSaveStatus('saving');
    setSaveError(null);
    try {
      if (transport.itemSaveQueue.hasFailure()) {
        await transport.itemSaveQueue.retryFailed();
      }
      if (transport.decisionQueue.hasFailure()) {
        const failedAction = transport.decisionQueue.getFailedAction();
        const decision = await transport.decisionQueue.retryFailed();
        if (failedAction) handleDecisionSuccess(itemId, generation, failedAction, decision);
      }
      await drainAllWrites(itemId);
      markSavedWhenIdle(itemId, generation);
    } catch (err) {
      if (err instanceof OnboardingApiError && err.status === 409) {
        await refreshCanonicalAfterConflict(itemId, generation, err.message);
        return;
      }
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleApproveReview = async () => {
    if (!reviewItem || reviewTransitionRef.current) return;

    const hasPageProposal = classificationProposals.some(
      proposal => proposal.proposalType === 'category_page' && proposal.status !== 'rejected',
    );
    const hasManualPageAssignment = Boolean(curationFields.suggestedPages?.length);
    if (!hasPageProposal && !hasManualPageAssignment) {
      alert('At least one Product Page must be selected before review can be completed.');
      return;
    }

    if (!curationFields.curatedWeight || !curationFields.curatedWeight.trim()) {
      alert('Weight is required.');
      return;
    }

    const nextItem = hasNext ? itemsInStage[currentReviewIndex + 1] : null;
    const itemId = reviewItem.id;
    const generation = reviewGenerationRef.current;
    const transition = { itemId, generation };
    const approvalEditFields = JSON.parse(JSON.stringify(editFields)) as Partial<ExtractionData>;
    const approvalCurationFields = JSON.parse(JSON.stringify(
      editableCurationData(curationFields),
    )) as Partial<CurationData>;
    const transport = getDecisionTransport(itemId);
    transport.mutationVersion += 1;
    reviewTransitionRef.current = transition;
    setReviewTransitioning(true);

    const transitionIsCurrent = () => reviewTransitionRef.current === transition
      && isCurrentReviewGeneration(
        reviewItemRef.current,
        reviewGenerationRef.current,
        itemId,
        generation,
      );
    const releaseTransition = () => {
      if (reviewTransitionRef.current === transition) {
        reviewTransitionRef.current = null;
        setReviewTransitioning(false);
      }
    };

    try {
      setSaveStatus('saving');
      // A failed/conflicted write rejects here; approval never resubmits all
      // proposals and never outruns the append-only revision queue.
      await drainAllWrites(itemId);
      if (!transitionIsCurrent()) return;
      await updateItem(itemId, {
        extraction_data: approvalEditFields,
        curation_data: approvalCurationFields,
      });
      if (!transitionIsCurrent()) return;
      await completeReviewStage([itemId]);
      if (!transitionIsCurrent()) return;
      setSaveStatus('saved');
      releaseTransition();
      if (nextItem) {
        await openReview(nextItem);
      } else {
        await closeReview();
      }
    } catch (err) {
      if (transitionIsCurrent()) {
        setSaveStatus('error');
        setSaveError(err instanceof Error ? err.message : String(err));
        alert('Error updating item: ' + (err instanceof Error ? err.message : String(err)));
      }
    } finally {
      releaseTransition();
    }
  };

  const hasRetryableSaveFailure = reviewItem
    ? getDecisionTransport(reviewItem.id).decisionQueue.hasFailure()
      || getDecisionTransport(reviewItem.id).itemSaveQueue.hasFailure()
    : false;
  const proposalControlsDisabled = reviewTransitioning || Boolean(
    reviewItem && getDecisionTransport(reviewItem.id).decisionQueue.hasFailure(),
  );

  // ─── Render ─────────────────────────────────────────────────────────────────

  const renderCard = (item: OnboardingItem) => {
    const isNeedsReview = item.stageStatus === 'completed' && item.errorMessage?.startsWith('needs_review:');
    const statusStyle = isNeedsReview
      ? { bg: '#ffedd5', text: '#c2410c', icon: '⚠' }
      : (STAGE_STATUS_STYLE[item.stageStatus] || STAGE_STATUS_STYLE.pending);
    const isSelected = selectedIds.has(item.id);
    const isAutomatedStage = ['discovery', 'extraction', 'curation'].includes(item.stage);
    const isReviewStage = item.stage === 'review';

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
            {((item.extractionData?.productIntelligenceEvidence?.length ?? 0) > 0) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 8, background: '#fef3c7', color: '#92400e' }}>
                  🤖 Agent result available
                </span>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const first = item.extractionData?.productIntelligenceEvidence?.[0];
                    window.location.assign(first?.runId ? `/?view=agentlab&run=${first.runId}` : '/?view=agentlab');
                  }}
                  style={{ fontSize: 10, color: '#2563eb', fontWeight: 600, textDecoration: 'underline' }}
                >
                  Open in Agent Lab →
                </a>
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
  const hasSendBackEligible = selectedItems.some(item => item.stage !== 'discovery');
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
          <a href="/?view=settings" style={{ color: '#9a3412', fontWeight: 600 }}>Open Curation Targets settings →</a>
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
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#111827' }}>
              Pipeline Board: <span style={{ color: '#7c3aed' }}>{batchName}</span>
            </h1>
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
                            background: '#7c3aed',
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

      {/* ─── REVIEW DRAWER ────────────────────────────────────────────────── */}
      {reviewItem && (
        <ReviewDrawerShell
          reviewItem={reviewItem}
          hasPrev={hasPrev}
          hasNext={hasNext}
          reviewTransitioning={reviewTransitioning}
          onPrevItem={handlePrevItem}
          onNextItem={handleNextItem}
          onClose={closeReview}
          onOpenProfileBuilder={onOpenProfileBuilder}
          consistencyWarnings={consistencyWarnings}
          handleResetSingle={handleResetSingle}
          saveStatus={saveStatus}
          saveError={saveError}
          hasRetryableSaveFailure={hasRetryableSaveFailure}
          retryFailedWrites={retryFailedWrites}
          onApproveReview={handleApproveReview}
          onApproveAndNext={handleApproveAndNext}
          onAdvanceStage={handleAdvanceSingle}
          leftColumnContent={
            <ProductImageGallery
              primaryImage={editFields.primaryImage || null}
              additionalImages={editFields.additionalImages || []}
              activeImageIdx={activeImageIdx}
              setActiveImageIdx={setActiveImageIdx}
              manualImageUrl={manualImageUrl}
              setManualImageUrl={setManualImageUrl}
              onSetPrimary={(newPrimary) => {
                const oldPrimary = editFields.primaryImage;
                const newAdditional = [
                  ...(oldPrimary ? [oldPrimary] : []),
                  ...(editFields.additionalImages || []).filter((x) => x !== newPrimary),
                ];
                const nextEdit = {
                  ...editFields,
                  primaryImage: newPrimary,
                  additionalImages: newAdditional,
                };
                setEditFields(nextEdit);
                saveItemChangesQuietly(reviewItem.id, nextEdit, curationFields);
              }}
              onRemoveImage={(urlToRemove, isPrimary) => {
                let nextEdit;
                const additional = editFields.additionalImages || [];
                if (isPrimary) {
                  const newPrimary = additional[0] || null;
                  const newAdditional = additional.slice(1);
                  nextEdit = {
                    ...editFields,
                    primaryImage: newPrimary,
                    additionalImages: newAdditional,
                  };
                } else {
                  nextEdit = {
                    ...editFields,
                    additionalImages: additional.filter((x) => x !== urlToRemove),
                  };
                }
                setEditFields(nextEdit);
                saveItemChangesQuietly(reviewItem.id, nextEdit, curationFields);
                setActiveImageIdx((prev) => Math.max(0, prev - 1));
              }}
              onAddManualUrl={(urlToAdd) => {
                let nextEdit;
                if (!editFields.primaryImage) {
                  nextEdit = { ...editFields, primaryImage: urlToAdd };
                  setActiveImageIdx(0);
                } else {
                  const additional = editFields.additionalImages || [];
                  if (!additional.includes(urlToAdd) && editFields.primaryImage !== urlToAdd) {
                    nextEdit = {
                      ...editFields,
                      additionalImages: [...additional, urlToAdd],
                    };
                    setActiveImageIdx((editFields.primaryImage ? 1 : 0) + additional.length);
                  } else {
                    nextEdit = editFields;
                  }
                }
                setEditFields(nextEdit);
                saveItemChangesQuietly(reviewItem.id, nextEdit, curationFields);
              }}
            />
          }
          rightColumnContent={
            <>
              {reviewItem.stage === 'discovery' && (
                <DiscoveryStagePanel
                  reviewItem={reviewItem}
                  reviewSources={reviewSources}
                  drawerBrandName={_drawerBrandName}
                  drawerBrandDomain={_drawerBrandDomain}
                  setDrawerBrandName={setDrawerBrandName}
                  setDrawerBrandDomain={setDrawerBrandDomain}
                  cachedBrandSites={cachedBrandSites}
                  catalogBrands={_catalogBrands}
                  onRefreshBrandSites={_onRefreshBrandSites}
                  onSelectSource={async (sourceId, url) => {
                    try {
                      await fetch(`/api/onboarding/items/${reviewItem.id}/select-source`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ sourceId }),
                      });
                      setManualUrlInput(url);
                      const res = await getItemDetail(reviewItem.id);
                      setReviewItem(res.item);
                      setReviewSources(res.sources);
                    } catch (err) {
                      alert('Failed to select source: ' + String(err));
                    }
                  }}
                  manualUrlInput={manualUrlInput}
                  setManualUrlInput={setManualUrlInput}
                  onSetManualUrl={async (url) => {
                    await setItemUrl(reviewItem.id, url);
                    const res = await getItemDetail(reviewItem.id);
                    setReviewItem(res.item);
                    setManualUrlInput(res.item.sourceUrl || '');
                    setShowEditUrl(false);
                  }}
                  saveStatus={saveStatus}
                  saveError={saveError}
                  setSaveStatus={setSaveStatus}
                  setSaveError={setSaveError}
                  onUpdateReviewItem={async () => {
                    const detail = await getItemDetail(reviewItem.id);
                    setReviewItem(detail.item);
                    await fetchStaged();
                  }}
                />
              )}

              {reviewItem.stage === 'extraction' && (
                <ExtractionStagePanel
                  extractionData={reviewExtraction}
                  sourceUrl={reviewItem.sourceUrl}
                  showEditUrl={showEditUrl}
                  setShowEditUrl={setShowEditUrl}
                  manualUrlInput={manualUrlInput}
                  setManualUrlInput={setManualUrlInput}
                  onSetManualUrl={async (url) => {
                    await setItemUrl(reviewItem.id, url);
                    const res = await getItemDetail(reviewItem.id);
                    setReviewItem(res.item);
                    setManualUrlInput(res.item.sourceUrl || '');
                  }}
                />
              )}

              {(reviewItem.stage === 'curation' ||
                reviewItem.stage === 'review' ||
                reviewItem.stage === 'promotion') && (
                <CurationStagePanel
                  curatedTitle={curationFields.curatedTitle || ''}
                  titleSource={curationFields.titleSource}
                  curatedAt={curationFields.curatedAt}
                  curationMethod={curationFields.curationMethod}
                  curatedWeight={curationFields.curatedWeight || ''}
                  brandName={_drawerBrandName || reviewItem.brandHint}
                  onUpdateBrand={async (newBrandName) => {
                    const trimmed = newBrandName.trim();
                    setDrawerBrandName(trimmed);
                    setReviewItem((prev) => (prev ? { ...prev, brandHint: trimmed || null } : prev));
                    setSaveStatus('saving');
                    try {
                      await updateItem(reviewItem.id, { brandHint: trimmed || null });
                      await fetchStaged();
                      setSaveStatus('saved');
                      setTimeout(() => setSaveStatus('idle'), 1500);
                    } catch (err) {
                      setSaveStatus('error');
                      setSaveError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                  cachedBrandSites={cachedBrandSites}
                  catalogBrands={_catalogBrands || []}
                  suggestedProductType={curationFields.suggestedProductType}
                  classificationProposals={classificationProposals}
                  proposalControlsDisabled={proposalControlsDisabled}
                  storePages={storePages}
                  suggestedPages={curationFields.suggestedPages || []}
                  pageSearchQuery={pageSearchQuery}
                  setPageSearchQuery={setPageSearchQuery}
                  onUpdateTitle={(newTitle) => {
                    const nextCuration = {
                      ...curationFields,
                      curatedTitle: newTitle,
                      titleSource: 'manual' as const,
                    };
                    setCurationFields(nextCuration);
                    saveItemChangesQuietly(reviewItem.id, editFields, nextCuration);
                  }}
                  onUpdateWeight={(newWeight) => {
                    const nextCuration = {
                      ...curationFields,
                      curatedWeight: newWeight,
                    };
                    setCurationFields(nextCuration);
                    saveItemChangesQuietly(reviewItem.id, editFields, nextCuration);
                  }}
                  onTogglePage={(pageName, isAssigned) => {
                    let nextPages: string[];
                    if (isAssigned) {
                      nextPages = [...(curationFields.suggestedPages || []), pageName];
                    } else {
                      nextPages = (curationFields.suggestedPages || []).filter((n) => n !== pageName);
                    }
                    const nextCuration = { ...curationFields, suggestedPages: nextPages };
                    setCurationFields(nextCuration);
                    saveItemChangesQuietly(reviewItem.id, editFields, nextCuration);
                  }}
                  onRemovePage={(pageName) => {
                    const nextPages = (curationFields.suggestedPages || []).filter((n) => n !== pageName);
                    const nextCuration = { ...curationFields, suggestedPages: nextPages };
                    setCurationFields(nextCuration);
                    saveItemChangesQuietly(reviewItem.id, editFields, nextCuration);
                  }}
                  fieldTargetForProposal={fieldTargetForProposal}
                  productTypeOptions={productTypeOptions}
                  getEffectiveProposalValue={getEffectiveProposalValue}
                  getEffectiveProductTypeId={getEffectiveProductTypeId}
                  withReviewedProposalValue={withReviewedProposalValue}
                  withReviewedProductTypeId={withReviewedProductTypeId}
                  updateProposal={updateProposal}
                />
              )}
            </>
          }
        />
      )}
    </div>
  );
}

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
  getCurationTargets,
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
import type { ClassificationProposal, ClassificationEvidence, CurationTargetConfig } from '../../shared/schemas/classification';
import { SearchableBrandSelector } from './SearchableBrandSelector';

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
  onOpenBrandSetup: _onOpenBrandSetup,
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
  const [reviewSources, setReviewSources] = useState<OnboardingSource[]>([]);
  const [reviewExtraction, setReviewExtraction] = useState<ExtractionData | null>(null);
  const [editFields, setEditFields] = useState<Partial<ExtractionData>>({});
  const [activeImageIdx, setActiveImageIdx] = useState(0);
  const [curationFields, setCurationFields] = useState<Partial<CurationData>>({});
  const [classificationProposals, setClassificationProposals] = useState<ClassificationProposal[]>([]);
  const [classificationEvidence, setClassificationEvidence] = useState<ClassificationEvidence[]>([]);
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

  useEffect(() => {
    fetchStaged();
    loadStorePages();
    loadCurationTargets();

    // SSE connection
    const sse = new EventSource(`/api/onboarding/batches/${batchId}/events`);
    sseRef.current = sse;

    sse.addEventListener('item:status', async (e: MessageEvent) => {
      // Refresh staged items on any item update
      fetchStaged();
      try {
        const event = JSON.parse(e.data);
        if (event && event.itemId && event.itemId === reviewItemRef.current) {
          // Re-fetch detail for the active review item to update the drawer dynamically
          const res = await getItemDetail(event.itemId);
          setReviewItem(res.item);
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
          setConsistencyWarnings(res.consistencyWarnings ?? []);
        }
      } catch (err) {
        console.warn('Failed to parse SSE item:status event:', err);
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

    // Curation validation
    const curationItemsToValidate = eligibleItems.filter(item => item.stage === 'curation');
    const itemsWithPendingProposals = curationItemsToValidate.filter(item => {
      const proposals = item.curationData?.classificationProposals || [];
      return proposals.some((p: any) => p.targetId !== 'product_draft_projection' && p.status !== 'accepted' && p.status !== 'rejected');
    });

    if (itemsWithPendingProposals.length > 0) {
      const names = itemsWithPendingProposals.map(item => `'${item.name || item.upc}'`).join(', ');
      alert(`Cannot advance: the following products have AI proposals that haven't been accepted or rejected: ${names}`);
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

    if (item.curationData?.classificationProposals) {
      setClassificationProposals(item.curationData.classificationProposals);
      setClassificationEvidence(item.curationData.classificationEvidence || []);
    } else {
      setClassificationProposals([]);
      setClassificationEvidence([]);
    }

    try {
      const res = await getItemDetail(item.id);
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
    } catch (err) {
      console.error(err);
    }
  };

  const closeReview = async () => {
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
      openReview(itemsInStage[currentReviewIndex - 1]);
    }
  };

  const handleNextItem = () => {
    if (hasNext) {
      openReview(itemsInStage[currentReviewIndex + 1]);
    }
  };

  const handleResetSingle = async () => {
    if (!reviewItem) return;
    setLoading(true);
    try {
      await resetStageItems([reviewItem.id]);
      const res = await getItemDetail(reviewItem.id);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const fieldTargetForProposal = (proposal: ClassificationProposal): { target: CurationTargetConfig | null; values: string[]; label: string } => {
    if (proposal.proposalType !== 'field_assignment' || !curationTargetState) {
      return { target: null, values: [], label: proposal.targetId || 'Field' };
    }
    const field = curationTargetState.candidates.productFields.find(candidate =>
      candidate.attributeId === proposal.targetId || candidate.target?.attributeId === proposal.targetId,
    );
    return {
      target: field?.target ?? null,
      values: field?.values ?? [],
      label: field ? `${field.label} (${field.catalogField})` : proposal.targetId || 'Field',
    };
  };

  const productTypeOptions = () => curationTargetState?.candidates.productTypes ?? [];

  const saveChangesQuietly = async (
    itemId: string,
    currentEditFields: Partial<ExtractionData>,
    currentCurationFields: Partial<CurationData>,
    currentProposals: ClassificationProposal[]
  ) => {
    setSaveStatus('saving');
    setSaveError(null);
    try {
      await updateItem(itemId, {
        extraction_data: currentEditFields,
        curation_data: { ...currentCurationFields, classificationProposals: currentProposals, classificationEvidence },
      });
      if (currentProposals.length > 0) {
        const decs = currentProposals
          .filter(p => ['accepted', 'rejected', 'deferred'].includes(p.status))
          .map(p => ({
            proposalId: p.id,
            decision: p.status as 'accepted' | 'rejected' | 'deferred',
            proposedValue: p.proposedValue,
            targetId: p.targetId,
          }));
        if (decs.length > 0) {
          await submitDecisions(itemId, decs);
        }
      }
      setSaveStatus('saved');
      setTimeout(() => {
        setSaveStatus(prev => prev === 'saved' ? 'idle' : prev);
      }, 1500);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateProposal = (proposalId: string, patch: Partial<ClassificationProposal>) => {
    const nextProposals = classificationProposals.map(p => p.id === proposalId ? { ...p, ...patch } : p);
    setClassificationProposals(nextProposals);
    if (reviewItem) {
      saveChangesQuietly(reviewItem.id, editFields, curationFields, nextProposals);
    }
  };

  const handleApproveReview = async () => {
    if (!reviewItem) return;

    const hasAcceptedPageProposal = classificationProposals.some(
      proposal => proposal.proposalType === 'category_page' && proposal.status === 'accepted',
    );
    const hasManualPageAssignment = Boolean(curationFields.suggestedPages?.length);
    if (!hasAcceptedPageProposal && !hasManualPageAssignment) {
      alert('At least one Product Page must be selected or accepted before review can be completed.');
      return;
    }

    if (!curationFields.curatedWeight || !curationFields.curatedWeight.trim()) {
      alert('Weight is required.');
      return;
    }

    // Determine the next item in this stage before updating state
    const nextItem = hasNext ? itemsInStage[currentReviewIndex + 1] : null;

    try {
      setSaveStatus('saving');
      await updateItem(reviewItem.id, {
        extraction_data: editFields,
        curation_data: { ...curationFields, classificationProposals, classificationEvidence },
      });
      if (classificationProposals.length > 0) {
        const decs = classificationProposals
          .filter(p => ['accepted', 'rejected', 'deferred'].includes(p.status))
          .map(p => ({
            proposalId: p.id,
            decision: p.status as 'accepted' | 'rejected' | 'deferred',
            proposedValue: p.proposedValue,
            targetId: p.targetId,
          }));
        if (decs.length > 0) {
          await submitDecisions(reviewItem.id, decs);
        }
      }
      // The server verifies that every active-run proposal has a durable
      // decision. Any failure keeps the drawer open and the item in Review.
      await completeReviewStage([reviewItem.id]);
      setSaveStatus('saved');
      if (nextItem) {
        openReview(nextItem);
      } else {
        closeReview();
      }
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : String(err));
      alert('Error updating item: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

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
              {item.brandHint && <span> · {item.brandHint}</span>}
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
        <>
          <div
            onClick={closeReview}
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              background: 'rgba(0,0,0,0.5)', zIndex: 1000,
            }}
          />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0,
            width: '100%', maxWidth: 700, background: '#fff',
            zIndex: 1001,
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '-4px 0 12px rgba(0,0,0,0.15)',
            boxSizing: 'border-box',
            overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{
              padding: '24px 24px 16px',
              borderBottom: '1px solid #e5e7eb',
              position: 'relative',
              flexShrink: 0
            }}>
              <div style={{
                position: 'absolute', top: 20, right: 20,
                display: 'flex', alignItems: 'center', gap: 8
              }}>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    onClick={handlePrevItem}
                    disabled={!hasPrev}
                    style={{
                      padding: '4px 8px',
                      background: '#fff',
                      border: '1px solid #d1d5db',
                      borderRadius: 4,
                      color: hasPrev ? '#374151' : '#d1d5db',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: hasPrev ? 'pointer' : 'not-allowed',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                    }}
                  >
                    ◀ Prev
                  </button>
                  <button
                    onClick={handleNextItem}
                    disabled={!hasNext}
                    style={{
                      padding: '4px 8px',
                      background: '#fff',
                      border: '1px solid #d1d5db',
                      borderRadius: 4,
                      color: hasNext ? '#374151' : '#d1d5db',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: hasNext ? 'pointer' : 'not-allowed',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                    }}
                  >
                    Next ▶
                  </button>
                </div>
                <button
                  onClick={closeReview}
                  style={{
                    background: 'none', border: 'none', fontSize: 20,
                    cursor: 'pointer', color: '#6b7280', marginLeft: 4,
                    display: 'flex', alignItems: 'center', justifyContent: 'center'
                  }}
                >
                  ✕
                </button>
              </div>

              <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 600, color: '#111827' }}>
                {reviewItem.name}
              </h2>
              {reviewItem.expectedName && reviewItem.expectedName !== reviewItem.name && (
                <p style={{ margin: '0 0 4px', fontSize: 13, color: '#7c3aed', fontWeight: 500 }}>
                  Expected: {reviewItem.expectedName}
                </p>
              )}
              <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>
                UPC: {reviewItem.upc}
                {reviewItem.price ? <span> · Price: <strong>${(() => { const n = parseFloat(reviewItem.price.replace(/[^0-9.]/g, '')); return isNaN(n) ? reviewItem.price : n.toFixed(2); })()}</strong></span> : null}
              </p>
              {(() => {
                try {
                  const domain = reviewItem.sourceUrl ? new URL(reviewItem.sourceUrl).hostname.replace(/^www./, '') : null;
                  if (!domain) return null;
                  return (
                    <button
                      onClick={(e) => { e.stopPropagation(); closeReview(); onOpenProfileBuilder?.(domain, reviewItem); }}
                      style={{ marginTop: 8, padding: '4px 12px', fontSize: 12, cursor: 'pointer', border: '1px solid #007bff', borderRadius: 4, color: '#007bff', background: '#fff', fontWeight: 600 }}
                    >
                      Open Profile Builder
                    </button>
                  );
                } catch { return null; }
              })()}
            </div>

            {/* Scrollable Body */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              padding: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
              minHeight: 0,
            }}>
              {/* Stage Stepper Progress */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f9fafb', padding: '12px 16px', borderRadius: 8, border: '1px solid #e5e7eb', marginBottom: 4 }}>
                {STAGES.map((stg, idx) => {
                  const isCurrent = reviewItem.stage === stg;
                  const isPast = STAGES.indexOf(reviewItem.stage) > idx;
                  const label = STAGE_LABELS[stg];
                  
                  let color = '#9ca3af'; // Future
                  let fontWeight = 'normal';
                  let icon = '○';
                  if (isCurrent) {
                    color = '#7c3aed'; // Current
                    fontWeight = '600';
                    icon = reviewItem.stageStatus === 'in_progress' ? '◌' : '●';
                  } else if (isPast) {
                    color = '#16a34a'; // Past
                    fontWeight = '500';
                    icon = '✓';
                  }

                  return (
                    <React.Fragment key={stg}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, color, fontSize: 11, fontWeight }}>
                        {isCurrent && reviewItem.stageStatus === 'in_progress' ? (
                          <span style={{
                            display: 'inline-block',
                            width: '10px',
                            height: '10px',
                            border: '1.5px solid currentColor',
                            borderTopColor: 'transparent',
                            borderRadius: '50%',
                            animation: 'spin 0.8s linear infinite',
                          }} />
                        ) : (
                          <span>{icon}</span>
                        )}
                        <span>{label}</span>
                      </div>
                      {idx < STAGES.length - 1 && <span style={{ color: '#e5e7eb', fontSize: 11 }}>➔</span>}
                    </React.Fragment>
                  );
                })}
              </div>

              {consistencyWarnings.length > 0 && (
                <div style={{
                  padding: '12px 14px',
                  borderRadius: 8,
                  border: '1px solid #f59e0b',
                  background: '#fffbeb',
                  color: '#92400e',
                }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
                    Sibling consistency review required
                  </div>
                  {consistencyWarnings.map(warning => (
                    <div key={`${warning.groupId}:${warning.field}`} style={{ fontSize: 12, marginTop: 4 }}>
                      <strong>{warning.field.replaceAll('_', ' ')}:</strong> {warning.message}
                    </div>
                  ))}
                  <div style={{ fontSize: 11, marginTop: 8 }}>
                    This is a warning only. Results were not copied, unioned, or majority-voted across siblings.
                  </div>
                </div>
              )}

              {/* Status Banner */}
              {(() => {
                const currentStageLabel = STAGE_LABELS[reviewItem.stage];
                const stageStatus = reviewItem.stageStatus;
                const isNeedsReview = stageStatus === 'completed' && reviewItem.errorMessage?.startsWith('needs_review:');
                
                let statusBannerBg = '#f3f4f6';
                let statusBannerTextColor = '#374151';
                let statusBannerBorderColor = '#d1d5db';
                let statusTitle = '';
                let statusDesc = '';

                if (stageStatus === 'pending') {
                  statusBannerBg = '#f3f4f6';
                  statusBannerTextColor = '#374151';
                  statusBannerBorderColor = '#d1d5db';
                  statusTitle = `Pending ${currentStageLabel}`;
                  statusDesc = 'Queued. Waiting for the background worker to start processing this step...';
                } else if (stageStatus === 'in_progress') {
                  statusBannerBg = '#eff6ff';
                  statusBannerTextColor = '#1e40af';
                  statusBannerBorderColor = '#bfdbfe';
                  statusTitle = `${currentStageLabel} in progress...`;
                  
                  if (reviewItem.stage === 'discovery') {
                    statusDesc = 'Searching brand domains and search engines to find the best product page URLs...';
                  } else if (reviewItem.stage === 'extraction') {
                    statusDesc = 'Scraping target web page using Crawlee + Playwright, extracting product specs, title, brand, price, and downloading images...';
                  } else if (reviewItem.stage === 'curation') {
                    statusDesc = 'Synthesizing store-ready titles, running Ollama VLM OCR on packaging image, and matching categories...';
                  } else {
                    statusDesc = 'Processing in background...';
                  }
                } else if (isNeedsReview) {
                  statusBannerBg = '#ffedd5';
                  statusBannerTextColor = '#c2410c';
                  statusBannerBorderColor = '#fed7aa';
                  statusTitle = `${currentStageLabel} needs review`;
                  statusDesc = reviewItem.errorMessage || 'This item requires manual review.';
                } else if (stageStatus === 'completed') {
                  statusBannerBg = '#f0fdf4';
                  statusBannerTextColor = '#166534';
                  statusBannerBorderColor = '#bbf7d0';
                  statusTitle = `${currentStageLabel} completed`;
                  
                  if (reviewItem.stage === 'discovery') {
                    statusDesc = `Successfully found product page URL: ${reviewItem.sourceUrl}`;
                  } else if (reviewItem.stage === 'extraction') {
                    statusDesc = 'Scraped product details and downloaded images successfully. Results are displayed below.';
                  } else if (reviewItem.stage === 'curation') {
                    statusDesc = 'Auto-curated title, categories, and attributes. Ready for review.';
                  } else {
                    statusDesc = 'This stage completed successfully.';
                  }
                } else if (stageStatus === 'failed') {
                  statusBannerBg = '#fee2e2';
                  statusBannerTextColor = '#991b1b';
                  statusBannerBorderColor = '#fca5a5';
                  statusTitle = `${currentStageLabel} failed`;
                  statusDesc = reviewItem.errorMessage || 'An unknown error occurred during this stage.';
                } else if (stageStatus === 'skipped') {
                  statusBannerBg = '#f9fafb';
                  statusBannerTextColor = '#4b5563';
                  statusBannerBorderColor = '#e5e7eb';
                  statusTitle = `${currentStageLabel} skipped`;
                  statusDesc = 'This stage was skipped by the user.';
                }

                return (
                  <div style={{
                    background: statusBannerBg,
                    color: statusBannerTextColor,
                    border: `1px solid ${statusBannerBorderColor}`,
                    borderRadius: 8,
                    padding: '10px 14px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    flexShrink: 0,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, lineHeight: 1.4 }}>
                      {stageStatus === 'in_progress' ? (
                        <span style={{
                          display: 'inline-block',
                          width: '12px',
                          height: '12px',
                          border: '2px solid currentColor',
                          borderTopColor: 'transparent',
                          borderRadius: '50%',
                          animation: 'spin 0.8s linear infinite',
                          flexShrink: 0,
                        }} />
                      ) : isNeedsReview ? (
                        <span style={{ fontWeight: 'bold', color: '#c2410c', flexShrink: 0 }}>⚠</span>
                      ) : stageStatus === 'completed' ? (
                        <span style={{ fontWeight: 'bold', color: '#16a34a', flexShrink: 0 }}>✓</span>
                      ) : stageStatus === 'failed' ? (
                        <span style={{ fontWeight: 'bold', color: '#dc2626', flexShrink: 0 }}>✗</span>
                      ) : (
                        <span style={{ flexShrink: 0 }}>⏳</span>
                      )}
                      <div>
                        <strong style={{ marginRight: 6 }}>{statusTitle}:</strong>
                        <span style={{ opacity: 0.9 }}>{statusDesc}</span>
                      </div>
                    </div>
                    {(stageStatus === 'failed' || stageStatus === 'completed' || stageStatus === 'skipped') && (
                      <button
                        onClick={handleResetSingle}
                        disabled={loading}
                        style={{
                          padding: '4px 10px',
                          background: '#fff',
                          border: `1px solid ${statusBannerBorderColor}`,
                          color: statusBannerTextColor,
                          borderRadius: 4,
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: loading ? 'not-allowed' : 'pointer',
                          boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                          transition: 'background 0.15s',
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f9fafb'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#fff'; }}
                      >
                        {stageStatus === 'failed' ? '🔄 Retry' : '🔄 Reset'}
                      </button>
                    )}
                  </div>
                );
              })()}

              {/* Brand Configuration Editor */}
              {reviewItem && reviewItem.stage === 'discovery' && (
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  background: '#f9fafb',
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  padding: 12,
                  marginTop: 12,
                  flexShrink: 0,
                }}>
                  <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 10px 0', color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
                    🏷️ Brand Configuration
                  </h3>
                  <SearchableBrandSelector
                    brandName={_drawerBrandName}
                    brandDomain={_drawerBrandDomain}
                    onSelect={(brand, domain) => {
                      setDrawerBrandName(brand);
                      if (domain) {
                        setDrawerBrandDomain(domain);
                      }
                    }}
                    onDomainChange={(domain) => setDrawerBrandDomain(domain)}
                    cachedBrandSites={cachedBrandSites}
                    catalogBrands={_catalogBrands || []}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button
                      onClick={async () => {
                        setSaveStatus('saving');
                        try {
                          const res = await fetch(`/api/onboarding/batches/${reviewItem.batchId}/bulk-brand`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              itemIds: [reviewItem.id],
                              brandHint: _drawerBrandName.trim(),
                              brandDomain: _drawerBrandDomain.trim(),
                            }),
                          });
                          if (!res.ok) {
                            const errBody = await res.json().catch(() => ({}));
                            throw new Error(errBody.error || `HTTP ${res.status}`);
                          }

                          if (_onRefreshBrandSites) {
                            _onRefreshBrandSites();
                          }

                          const detail = await getItemDetail(reviewItem.id);
                          setReviewItem(detail.item);
                          await fetchStaged();

                          setSaveStatus('saved');
                          setTimeout(() => setSaveStatus('idle'), 2000);
                        } catch (err) {
                          setSaveStatus('error');
                          setSaveError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                      disabled={saveStatus === 'saving'}
                      style={{
                        padding: '6px 12px',
                        background: '#2563eb',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >
                      {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? '✓ Saved!' : 'Save Brand'}
                    </button>
                  </div>
                  {saveStatus === 'error' && saveError && (
                    <div style={{ color: '#dc2626', fontSize: 11, marginTop: 4 }}>
                      Failed to save: {saveError}
                    </div>
                  )}
                </div>
              )}

              {/* Source URL */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                flexShrink: 0,
              }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#374151' }}>Source URL</h3>
                
                {/* Discovery: show source candidates */}
                {reviewItem && reviewItem.stage === 'discovery' && reviewSources.length > 0 && (
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    flexShrink: 0,
                    marginBottom: 12,
                  }}>
                    {/* Expected / consolidated name banner */}
                    {reviewItem.expectedName && (
                      <div style={{
                        background: '#f0f9ff',
                        border: '1px solid #bae6fd',
                        borderRadius: 6,
                        padding: '8px 12px',
                        marginBottom: 10,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: '#0369a1' }}>🔍 Searching for:</span>
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#0c4a6e' }}>{reviewItem.expectedName}</span>
                        {reviewItem.expectedName !== reviewItem.name && (
                          <span style={{ fontSize: 10, color: '#6b7280', fontStyle: 'italic' }}>
                            (consolidated from raw &ldquo;{reviewItem.name}&rdquo;)
                          </span>
                        )}
                      </div>
                    )}
                    <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                      Search results — click to select the correct product page:
                    </p>
                    {(() => {
                      // Group sources by their search method so the operator can
                      // see which results came from the bare UPC search (Pass 1)
                      // vs the consolidated-name search (Pass 2). Sources are
                      // already sorted by confidence descending in the backend.
                      const methodLabel = (method: string): { short: string; long: string; bg: string; text: string } => {
                        if (method === 'shopify_variant') {
                          return {
                            short: 'Variant',
                            long: 'Variant resolution',
                            bg: '#fef3c7',
                            text: '#92400e',
                          };
                        }
                        if (method === 'serper_name') {
                          return {
                            short: 'Name',
                            long: `Name search ("${reviewItem.expectedName || reviewItem.name}")`,
                            bg: '#ede9fe',
                            text: '#5b21b6',
                          };
                        }
                        if (method === 'serper_upc') {
                          return {
                            short: 'UPC',
                            long: `UPC search ("${reviewItem.upc}")`,
                            bg: '#dbeafe',
                            text: '#1e40af',
                          };
                        }
                        // Legacy/unknown method value (e.g. plain 'serper' from older records)
                        return {
                          short: 'Other',
                          long: 'Other search',
                          bg: '#f3f4f6',
                          text: '#374151',
                        };
                      };

                      type SourceGroup = {
                        method: string;
                        items: OnboardingSource[];
                      };

                      const groupOrder: string[] = ['shopify_variant', 'serper_upc', 'serper_name'];
                      const groups: SourceGroup[] = [];
                      for (const method of groupOrder) {
                        const items = reviewSources.filter(s => s.sourceMethod === method);
                        if (items.length > 0) groups.push({ method, items });
                      }
                      // Catch any sources whose method doesn't match the known set
                      // so we never silently drop them from the drawer.
                      const knownMethods = new Set(groupOrder);
                      const leftovers = reviewSources.filter(s => !knownMethods.has(s.sourceMethod));
                      if (leftovers.length > 0) {
                        groups.push({ method: 'other', items: leftovers });
                      }

                      if (groups.length === 0) {
                        return (
                          <div style={{
                            padding: 12,
                            border: '1px solid #e5e7eb',
                            borderRadius: 8,
                            background: '#f9fafb',
                            fontSize: 12,
                            color: '#6b7280',
                            fontStyle: 'italic',
                          }}>
                            No source candidates were returned for this product.
                          </div>
                        );
                      }

                      return (
                        <div style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 12,
                          flexShrink: 0,
                        }}>
                          {groups.map((group) => {
                            const label = methodLabel(group.method);
                            return (
                              <div
                                key={group.method}
                                style={{
                                  border: '1px solid #e5e7eb',
                                  borderRadius: 8,
                                  background: '#fff',
                                  overflow: 'hidden',
                                }}
                              >
                                {/* Group header */}
                                <div style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  padding: '6px 10px',
                                  background: '#f3f4f6',
                                  borderBottom: '1px solid #e5e7eb',
                                }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{
                                      fontSize: 10,
                                      fontWeight: 700,
                                      textTransform: 'uppercase',
                                      letterSpacing: '0.04em',
                                      padding: '2px 6px',
                                      borderRadius: 4,
                                      background: label.bg,
                                      color: label.text,
                                    }}>
                                      {label.short}
                                    </span>
                                    <span style={{ fontSize: 12, fontWeight: 600, color: '#374151' }}>
                                      {label.long}
                                    </span>
                                  </div>
                                  <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 500 }}>
                                    {group.items.length} result{group.items.length === 1 ? '' : 's'}
                                  </span>
                                </div>
                                {/* Group items */}
                                <div style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 6,
                                  padding: 8,
                                  background: '#f9fafb',
                                }}>
                                  {(() => {
                                    type RenderItem =
                                      | { type: 'standalone'; source: OnboardingSource }
                                      | { type: 'ambiguous_group'; baseUrl: string; sources: OnboardingSource[] };

                                    const renderItems: RenderItem[] = [];
                                    const seenBaseUrls = new Set<string>();

                                    for (const src of group.items) {
                                      let itemBaseUrl = '';
                                      let isAmb = false;
                                      if (src.metadataJson) {
                                        try {
                                          const meta = JSON.parse(src.metadataJson);
                                          isAmb = meta.variantResolution?.status === 'ambiguous';
                                          itemBaseUrl = meta.variantResolution?.baseUrl || '';
                                        } catch {}
                                      }

                                      if (isAmb && itemBaseUrl) {
                                        if (seenBaseUrls.has(itemBaseUrl)) continue;
                                        seenBaseUrls.add(itemBaseUrl);
                                        const groupVariants = group.items.filter(x => {
                                          if (!x.metadataJson) return false;
                                          try {
                                            const m = JSON.parse(x.metadataJson);
                                            return m.variantResolution?.status === 'ambiguous' && m.variantResolution?.baseUrl === itemBaseUrl;
                                          } catch {
                                            return false;
                                          }
                                        });
                                        renderItems.push({
                                          type: 'ambiguous_group',
                                          baseUrl: itemBaseUrl,
                                          sources: groupVariants
                                        });
                                      } else {
                                        renderItems.push({
                                          type: 'standalone',
                                          source: src
                                        });
                                      }
                                    }

                                    const handleSelect = async (sourceId: string, url: string) => {
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
                                    };

                                    return renderItems.map((item, idx) => {
                                      if (item.type === 'standalone') {
                                        const src = item.source;
                                        const srcLabel = methodLabel(src.sourceMethod);
                                        let isResolved = false;
                                        let variantTitle = '';
                                        let matchedSignals: string[] = [];
                                        if (src.metadataJson) {
                                          try {
                                            const meta = JSON.parse(src.metadataJson);
                                            isResolved = meta.variantResolution?.status === 'resolved';
                                            variantTitle = meta.variantResolution?.variantTitle || '';
                                            matchedSignals = meta.variantResolution?.matchedSignals || [];
                                          } catch {}
                                        }

                                        return (
                                          <div
                                            key={src.id}
                                            onClick={() => handleSelect(src.id, src.url)}
                                            style={{
                                              border: '1px solid #e5e7eb',
                                              borderRadius: 6,
                                              padding: 10,
                                              background: src.isSelected ? '#f0fdf4' : '#fff',
                                              borderColor: src.isSelected ? '#16a34a' : '#e5e7eb',
                                              cursor: 'pointer',
                                              textAlign: 'left',
                                              boxShadow: src.isSelected ? '0 1px 3px rgba(22, 163, 74, 0.1)' : '0 1px 2px rgba(0,0,0,0.05)',
                                              transition: 'all 0.2s ease-in-out',
                                            }}
                                          >
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, alignItems: 'center' }}>
                                              <strong style={{ fontSize: 13, color: src.isSelected ? '#166534' : '#111827' }}>
                                                {src.title || src.domain}
                                              </strong>
                                              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                {isResolved && (
                                                  <span style={{
                                                    fontSize: 9,
                                                    fontWeight: 700,
                                                    background: '#fef3c7',
                                                    color: '#92400e',
                                                    padding: '1px 5px',
                                                    borderRadius: 3,
                                                  }}>
                                                    Variant Resolved
                                                  </span>
                                                )}
                                                <span style={{
                                                  fontSize: 9,
                                                  fontWeight: 700,
                                                  textTransform: 'uppercase',
                                                  letterSpacing: '0.04em',
                                                  padding: '1px 5px',
                                                  borderRadius: 3,
                                                  background: srcLabel.bg,
                                                  color: srcLabel.text,
                                                }}>
                                                  {srcLabel.short}
                                                </span>
                                                <span style={{ fontSize: 11, fontWeight: 600, color: '#15803d' }}>
                                                  {src.isSelected ? '✓ Selected' : `${(src.confidence * 100).toFixed(0)}%`}
                                                </span>
                                              </span>
                                            </div>
                                            <p style={{ margin: '0 0 4px', fontSize: 11, color: '#6b7280', wordBreak: 'break-all' }}>
                                              {src.url}
                                            </p>
                                            {variantTitle && (
                                              <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#4b5563' }}>
                                                Variant: <span style={{ color: '#1e3a8a' }}>{variantTitle}</span>
                                              </p>
                                            )}
                                            {matchedSignals.length > 0 && (
                                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                                                {matchedSignals.map(sig => (
                                                  <span key={sig} style={{ fontSize: 9, background: '#f3f4f6', color: '#4b5563', padding: '1px 4px', borderRadius: 3 }}>
                                                    {sig}
                                                  </span>
                                                ))}
                                              </div>
                                            )}
                                            {src.snippet && (
                                              <p style={{ margin: 0, fontSize: 11, color: '#4b5563', fontStyle: 'italic' }}>
                                                &ldquo;{src.snippet.slice(0, 150)}{src.snippet.length > 150 ? '...' : ''}&rdquo;
                                              </p>
                                            )}
                                          </div>
                                        );
                                      } else {
                                        const baseDomain = new URL(item.baseUrl).hostname;
                                        return (
                                          <div
                                            key={`group-${idx}`}
                                            style={{
                                              border: '1px solid #cbd5e1',
                                              borderRadius: 8,
                                              background: '#f8fafc',
                                              overflow: 'hidden',
                                              boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                                            }}
                                          >
                                            <div style={{
                                              padding: '8px 12px',
                                              background: '#f1f5f9',
                                              borderBottom: '1px solid #e2e8f0',
                                              display: 'flex',
                                              justifyContent: 'space-between',
                                              alignItems: 'center',
                                            }}>
                                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left' }}>
                                                <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>
                                                  {baseDomain}
                                                </span>
                                                <span style={{ fontSize: 10, color: '#64748b', wordBreak: 'break-all' }}>
                                                  {item.baseUrl}
                                                </span>
                                              </div>
                                              <span style={{
                                                fontSize: 9,
                                                fontWeight: 700,
                                                background: '#fee2e2',
                                                color: '#b91c1c',
                                                padding: '2px 6px',
                                                borderRadius: 4,
                                              }}>
                                                Ambiguous Variants ({item.sources.length})
                                              </span>
                                            </div>
                                            <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                              {item.sources.map((v) => {
                                                let vTitle = '';
                                                let matchedSignals: string[] = [];
                                                if (v.metadataJson) {
                                                  try {
                                                    const meta = JSON.parse(v.metadataJson);
                                                    vTitle = meta.variantResolution?.variantTitle || '';
                                                    matchedSignals = meta.variantResolution?.matchedSignals || [];
                                                  } catch {}
                                                }
                                                return (
                                                  <div
                                                    key={v.id}
                                                    onClick={() => handleSelect(v.id, v.url)}
                                                    style={{
                                                      border: '1px solid #e2e8f0',
                                                      borderRadius: 6,
                                                      padding: 8,
                                                      background: v.isSelected ? '#f0fdf4' : '#fff',
                                                      borderColor: v.isSelected ? '#16a34a' : '#e2e8f0',
                                                      cursor: 'pointer',
                                                      display: 'flex',
                                                      justifyContent: 'space-between',
                                                      alignItems: 'center',
                                                      boxShadow: v.isSelected ? '0 1px 2px rgba(22, 163, 74, 0.05)' : 'none',
                                                      transition: 'all 0.15s ease-in-out',
                                                    }}
                                                  >
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left' }}>
                                                      <span style={{ fontSize: 12, fontWeight: 600, color: v.isSelected ? '#166534' : '#1e293b' }}>
                                                        {vTitle || v.title}
                                                      </span>
                                                      {matchedSignals.length > 0 && (
                                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                                                          {matchedSignals.map(sig => (
                                                            <span key={sig} style={{ fontSize: 8, background: '#f1f5f9', color: '#64748b', padding: '1px 3px', borderRadius: 2 }}>
                                                              {sig}
                                                            </span>
                                                          ))}
                                                        </div>
                                                      )}
                                                    </div>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                      <span style={{ fontSize: 11, fontWeight: 500, color: '#64748b' }}>
                                                        {(v.confidence * 100).toFixed(0)}%
                                                      </span>
                                                      <button
                                                        onClick={(e) => {
                                                          e.stopPropagation();
                                                          handleSelect(v.id, v.url);
                                                        }}
                                                        style={{
                                                          fontSize: 10,
                                                          fontWeight: 600,
                                                          padding: '2px 6px',
                                                          borderRadius: 4,
                                                          background: v.isSelected ? '#16a34a' : '#2563eb',
                                                          color: '#fff',
                                                          border: 'none',
                                                          cursor: 'pointer',
                                                        }}
                                                      >
                                                        {v.isSelected ? 'Selected' : 'Select'}
                                                      </button>
                                                    </div>
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          </div>
                                        );
                                      }
                                    });
                                  })()}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Manual URL input or Clickable URL block */}
                {reviewItem.stage === 'discovery' || showEditUrl ? (
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <input
                      type="text"
                      value={manualUrlInput}
                      onChange={(e) => setManualUrlInput(e.target.value)}
                      placeholder="Or paste product page URL manually"
                      style={{ flex: 1, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                    />
                    <button
                      onClick={async () => {
                        if (!manualUrlInput.trim()) return;
                        await setItemUrl(reviewItem.id, manualUrlInput);
                        const res = await getItemDetail(reviewItem.id);
                        setReviewItem(res.item);
                        setManualUrlInput(res.item.sourceUrl || '');
                        setShowEditUrl(false);
                      }}
                      style={{ padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
                    >
                      Set
                    </button>
                    {showEditUrl && (
                      <button
                        onClick={() => setShowEditUrl(false)}
                        style={{ padding: '8px 12px', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: '#4b5563' }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                ) : (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    background: '#f9fafb',
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid #e5e7eb',
                    flexShrink: 0,
                  }}>
                    {reviewItem.sourceUrl ? (
                      <a
                        href={reviewItem.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          fontSize: 13,
                          color: '#2563eb',
                          textDecoration: 'none',
                          fontWeight: 500,
                          wordBreak: 'break-all',
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
                      >
                        {reviewItem.sourceUrl} <span style={{ fontSize: 11, marginLeft: 2 }}>↗</span>
                      </a>
                    ) : (
                      <span style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>No URL set</span>
                    )}
                    <button
                      onClick={() => setShowEditUrl(true)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#6b7280',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        padding: '2px 6px',
                        borderRadius: 4,
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#e5e7eb'; e.currentTarget.style.color = '#374151'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; e.currentTarget.style.color = '#6b7280'; }}
                    >
                      ✏ Edit
                    </button>
                  </div>
                )}
              </div>

              {/* Extracted product data (shown for extraction+ stages) */}
              {reviewItem && reviewItem.stage !== 'discovery' && (reviewExtraction || curationFields.curatedTitle || classificationProposals.length > 0) && (
                <>
                  {/* Raw extraction results — shown in extraction stage */}
                  {reviewItem?.stage === 'extraction' && reviewExtraction && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
                      <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: '#1e293b' }}>
                        📋 Raw Extraction Results
                      </h3>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <tbody>
                          {reviewExtraction.title && (
                            <tr>
                              <td style={{ padding: '6px 8px', fontWeight: 600, color: '#475569', width: 120, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Title</td>
                              <td style={{ padding: '6px 8px', color: '#0f172a', borderBottom: '1px solid #f1f5f9', wordBreak: 'break-word' }}>{reviewExtraction.title}</td>
                            </tr>
                          )}
                          {reviewExtraction.brand && (
                            <tr>
                              <td style={{ padding: '6px 8px', fontWeight: 600, color: '#475569', width: 120, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Brand</td>
                              <td style={{ padding: '6px 8px', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{reviewExtraction.brand}</td>
                            </tr>
                          )}
                          {reviewExtraction.description && (
                            <tr>
                              <td style={{ padding: '6px 8px', fontWeight: 600, color: '#475569', width: 120, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>Description</td>
                              <td style={{ padding: '6px 8px', color: '#0f172a', borderBottom: '1px solid #f1f5f9', wordBreak: 'break-word' }}>{reviewExtraction.description.slice(0, 500)}{reviewExtraction.description.length > 500 ? '…' : ''}</td>
                            </tr>
                          )}
                          {reviewExtraction.customFields && Object.keys(reviewExtraction.customFields).length > 0 && (
                            Object.entries(reviewExtraction.customFields).map(([fieldName, value]) => (
                              <tr key={fieldName}>
                                <td style={{ padding: '6px 8px', fontWeight: 600, color: '#475569', width: 120, verticalAlign: 'top', borderBottom: '1px solid #f1f5f9' }}>{fieldName}</td>
                                <td style={{ padding: '6px 8px', color: '#0f172a', borderBottom: '1px solid #f1f5f9' }}>{value}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                      {reviewExtraction.fieldProvenance && Object.keys(reviewExtraction.fieldProvenance).length > 0 && (
                        <details style={{ fontSize: 11, color: '#94a3b8' }}>
                          <summary style={{ cursor: 'pointer', fontWeight: 500, color: '#64748b' }}>Field provenance (which source each field came from)</summary>
                          <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {Object.entries(reviewExtraction.fieldProvenance).map(([field, source]) => (
                              <span key={field} style={{ background: '#f1f5f9', padding: '1px 6px', borderRadius: 4, color: '#64748b' }}>
                                {field}: <strong>{source}</strong>
                              </span>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  )}

                  {/* Curated Title */}
                  {/* Curated Title — only shown in curation+ stages */}
                  {curationFields.curatedTitle && reviewItem?.stage !== 'extraction' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Extracted Title</h3>
                      <input
                        type="text"
                        value={curationFields.curatedTitle}
                        onChange={(e) => setCurationFields((p: any) => ({ ...p, curatedTitle: e.target.value, titleSource: 'manual' }))}
                        onBlur={(e) => {
                          const nextCuration = { ...curationFields, curatedTitle: e.target.value, titleSource: 'manual' as const };
                          saveChangesQuietly(reviewItem.id, editFields, nextCuration, classificationProposals);
                        }}
                        style={{ width: '100%', padding: '8px', border: '1px solid #c084fc', borderRadius: 6, fontSize: 14, fontWeight: 600, background: '#faf5ff', boxSizing: 'border-box' }}
                      />
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11 }}>
                        <span style={{ color: '#6b7280' }}>Source: {curationFields.titleSource}</span>
                        {curationFields.curatedAt && (
                          <span style={{ color: '#9ca3af' }}>· Curated {new Date(curationFields.curatedAt).toLocaleString()}</span>
                        )}
                        {curationFields.curationMethod && (
                          <span style={{ color: '#9ca3af' }}>· Method: {curationFields.curationMethod}</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Weight — shown in curation+ stages */}
                  {reviewItem?.stage !== 'extraction' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 }}>
                      <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Weight</h3>
                      <input
                        type="text"
                        value={curationFields.curatedWeight ?? ''}
                        onChange={(e) => setCurationFields((p: any) => ({ ...p, curatedWeight: e.target.value }))}
                        onBlur={(e) => {
                          const nextCuration = { ...curationFields, curatedWeight: e.target.value };
                          saveChangesQuietly(reviewItem.id, editFields, nextCuration, classificationProposals);
                        }}
                        placeholder="e.g. 15 lbs, 500g"
                        style={{ width: '100%', padding: '8px', border: '1px solid #c084fc', borderRadius: 6, fontSize: 14, fontWeight: 600, background: '#faf5ff', boxSizing: 'border-box' }}
                      />
                    </div>
                  )}



                  {/* Suggested Product Type — only in curation stage */}
                  {curationFields.suggestedProductType && (reviewItem?.stage === 'curation' || reviewItem?.stage === 'review') && (
                    <div>
                      <label style={{ fontSize: 11, fontWeight: 500, color: '#4b5563' }}>Suggested Product Type</label>
                      <div style={{ display: 'inline-block', fontSize: 12, fontWeight: 600, color: '#7c3aed', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 6, padding: '4px 10px', marginTop: 4 }}>
                        {curationFields.suggestedProductType}
                      </div>
                    </div>
                  )}

                  {/* Extracted Images Gallery */}
                  {(() => {
                    const primaryImage = editFields.primaryImage;
                    const additionalImages = editFields.additionalImages || [];
                    const allImages = [
                      ...(primaryImage ? [{ url: primaryImage, isPrimary: true }] : []),
                      ...additionalImages.map(img => ({ url: img, isPrimary: false }))
                    ];

                    const activeIndex = allImages.length > 0 ? Math.min(activeImageIdx, Math.max(0, allImages.length - 1)) : -1;
                    const activeImage = activeIndex !== -1 ? allImages[activeIndex] : null;
                    const activeImgSrc = activeImage
                      ? (activeImage.url.startsWith('products/') ? `/api/onboarding/${activeImage.url}` : activeImage.url)
                      : '';

                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flexShrink: 0 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Product Images & Variants</h3>
                          <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>
                            Select the primary catalog image or remove incorrect color variants below.
                          </p>
                        </div>

                        {allImages.length === 0 ? (
                          <div
                            style={{
                              position: 'relative',
                              width: '100%',
                              height: 120,
                              border: '1px dashed #d1d5db',
                              borderRadius: 12,
                              background: '#f9fafb',
                              display: 'flex',
                              justifyContent: 'center',
                              alignItems: 'center',
                              boxSizing: 'border-box',
                              padding: 16,
                              color: '#6b7280',
                              fontSize: 13,
                            }}
                          >
                            No images available. Add an image URL below to get started.
                          </div>
                        ) : (
                          <>
                            {/* Main Focused Image View */}
                            <div
                              style={{
                                position: 'relative',
                                width: '100%',
                                height: 320,
                                border: `1px solid ${activeImage?.isPrimary ? '#10b981' : '#e5e7eb'}`,
                                borderRadius: 12,
                                background: activeImage?.isPrimary ? '#f0fdf4' : '#f9fafb',
                                display: 'flex',
                                justifyContent: 'center',
                                alignItems: 'center',
                                boxShadow: activeImage?.isPrimary
                                  ? '0 4px 12px rgba(16, 185, 129, 0.08)'
                                  : '0 2px 8px rgba(0,0,0,0.03)',
                                padding: 16,
                                boxSizing: 'border-box',
                              }}
                            >
                              {activeImage && (
                                <img
                                  src={activeImgSrc}
                                  alt="Active product view"
                                  style={{
                                    maxWidth: '100%',
                                    maxHeight: '100%',
                                    objectFit: 'contain',
                                    borderRadius: 8,
                                  }}
                                />
                              )}
                              
                              {/* Image Status Pill overlay */}
                              {activeImage && (
                                <span
                                  style={{
                                    position: 'absolute',
                                    top: 12,
                                    left: 12,
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: activeImage.isPrimary ? '#065f46' : '#374151',
                                    background: activeImage.isPrimary ? '#d1fae5' : '#e5e7eb',
                                    padding: '4px 10px',
                                    borderRadius: 20,
                                    boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
                                  }}
                                >
                                  {activeImage.isPrimary ? '★ Primary Image' : 'Variant Image'}
                                </span>
                              )}
                            </div>

                            {/* Active Image Action Controls */}
                            {activeImage && (
                              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                                {!activeImage.isPrimary && (
                                  <button
                                    onClick={() => {
                                      const newPrimary = activeImage.url;
                                      const oldPrimary = editFields.primaryImage;
                                      const newAdditional = [
                                        ...(oldPrimary ? [oldPrimary] : []),
                                        ...additionalImages.filter(x => x !== newPrimary)
                                      ];
                                      const nextEdit = {
                                        ...editFields,
                                        primaryImage: newPrimary,
                                        additionalImages: newAdditional
                                      };
                                      setEditFields(nextEdit);
                                      saveChangesQuietly(reviewItem.id, nextEdit, curationFields, classificationProposals);
                                    }}
                                    style={{
                                      padding: '6px 16px',
                                      fontSize: 12,
                                      fontWeight: 600,
                                      background: '#10b981',
                                      color: '#fff',
                                      border: 'none',
                                      borderRadius: 6,
                                      cursor: 'pointer',
                                      transition: 'all 0.15s',
                                      boxShadow: '0 2px 4px rgba(16, 185, 129, 0.2)',
                                    }}
                                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#059669'; }}
                                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#10b981'; }}
                                  >
                                    Set as Primary Image
                                  </button>
                                )}
                                <button
                                  onClick={() => {
                                    let nextEdit;
                                    if (activeImage.isPrimary) {
                                      const newPrimary = additionalImages[0] || null;
                                      const newAdditional = additionalImages.slice(1);
                                      nextEdit = {
                                        ...editFields,
                                        primaryImage: newPrimary,
                                        additionalImages: newAdditional
                                      };
                                    } else {
                                      nextEdit = {
                                        ...editFields,
                                        additionalImages: additionalImages.filter(x => x !== activeImage.url)
                                      };
                                    }
                                    setEditFields(nextEdit);
                                    saveChangesQuietly(reviewItem.id, nextEdit, curationFields, classificationProposals);
                                    setActiveImageIdx(prev => Math.max(0, prev - 1));
                                  }}
                                  style={{
                                    padding: '6px 16px',
                                    fontSize: 12,
                                    fontWeight: 600,
                                    background: '#fff',
                                    border: '1px solid #fca5a5',
                                    color: '#dc2626',
                                    borderRadius: 6,
                                    cursor: 'pointer',
                                    transition: 'all 0.15s',
                                  }}
                                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#fee2e2'; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#fff'; }}
                                >
                                  Remove This Image
                                </button>
                              </div>
                            )}

                            {/* Thumbnails strip below */}
                            <div
                              style={{
                                display: 'flex',
                                gap: 10,
                                overflowX: 'auto',
                                padding: '4px 2px 8px 2px',
                                borderTop: '1px solid #f3f4f6',
                                scrollbarWidth: 'thin',
                              }}
                            >
                              {allImages.map((img, idx) => {
                                const isCurrent = idx === activeIndex;
                                const imgSrc = img.url.startsWith('products/') ? `/api/onboarding/${img.url}` : img.url;
                                return (
                                  <div
                                    key={idx}
                                    onClick={() => setActiveImageIdx(idx)}
                                    style={{
                                      position: 'relative',
                                      width: 64,
                                      height: 64,
                                      flexShrink: 0,
                                      border: isCurrent
                                        ? '2px solid #7c3aed'
                                        : img.isPrimary
                                        ? '2px solid #10b981'
                                        : '1px solid #e5e7eb',
                                      borderRadius: 8,
                                      padding: 2,
                                      background: '#fff',
                                      cursor: 'pointer',
                                      transition: 'all 0.15s',
                                      boxSizing: 'border-box',
                                      opacity: isCurrent ? 1 : 0.75,
                                    }}
                                    onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.opacity = '1'; }}
                                    onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.opacity = '0.75'; }}
                                  >
                                    <img
                                      src={imgSrc}
                                      alt={`Thumbnail ${idx + 1}`}
                                      style={{
                                        width: '100%',
                                        height: '100%',
                                        objectFit: 'contain',
                                        borderRadius: 6,
                                      }}
                                    />
                                    {img.isPrimary && (
                                      <div
                                        style={{
                                          position: 'absolute',
                                          bottom: -2,
                                          right: -2,
                                          width: 12,
                                          height: 12,
                                          borderRadius: '50%',
                                          background: '#10b981',
                                          border: '2px solid #fff',
                                        }}
                                      />
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        )}

                        {/* Add Image URL Manually */}
                        <div style={{ marginTop: 6, borderTop: '1px solid #f3f4f6', paddingTop: 12 }}>
                          <label style={{ fontSize: 11, fontWeight: 500, color: '#4b5563', display: 'block', marginBottom: 6 }}>
                            Add Image URL Manually
                          </label>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <input
                              type="text"
                              placeholder="https://example.com/image.jpg"
                              value={manualImageUrl}
                              onChange={(e) => setManualImageUrl(e.target.value)}
                              style={{
                                flex: 1,
                                padding: '8px 12px',
                                border: '1px solid #d1d5db',
                                borderRadius: 6,
                                fontSize: 13,
                                boxSizing: 'border-box',
                              }}
                            />
                            <button
                              onClick={() => {
                                if (!manualImageUrl.trim()) return;
                                const url = manualImageUrl.trim();
                                let nextEdit;
                                if (!editFields.primaryImage) {
                                  nextEdit = {
                                    ...editFields,
                                    primaryImage: url,
                                  };
                                  setActiveImageIdx(0);
                                } else {
                                  const additional = editFields.additionalImages || [];
                                  if (!additional.includes(url) && editFields.primaryImage !== url) {
                                    nextEdit = {
                                      ...editFields,
                                      additionalImages: [...additional, url],
                                    };
                                    setActiveImageIdx((editFields.primaryImage ? 1 : 0) + additional.length);
                                  } else {
                                    nextEdit = editFields;
                                  }
                                }
                                setEditFields(nextEdit);
                                if (reviewItem) {
                                  saveChangesQuietly(reviewItem.id, nextEdit, curationFields, classificationProposals);
                                }
                                setManualImageUrl('');
                              }}
                              style={{
                                padding: '8px 16px',
                                fontSize: 13,
                                fontWeight: 600,
                                background: '#7c3aed',
                                color: '#fff',
                                border: 'none',
                                borderRadius: 6,
                                cursor: 'pointer',
                                transition: 'background-color 0.15s',
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#6d28d9'; }}
                              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#7c3aed'; }}
                            >
                              Add URL
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Classification Proposals — only shown in curation+ stages */}
                  {reviewItem?.stage !== 'extraction' && classificationProposals.filter(p => p.targetId !== 'product_draft_projection').length > 0 && (
                    <div style={{ padding: 12, background: '#f5f3ff', borderRadius: 8, border: '1px solid #ddd6fe' }}>
                      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px', color: '#7c3aed' }}>🤖 AI Proposals</h3>
                      {classificationProposals
                        .filter(p => p.targetId !== 'product_draft_projection')
                        .map((p) => {
                        const sc: Record<string, string> = { pending: '#f59e0b', accepted: '#16a34a', rejected: '#dc2626', deferred: '#6b7280', stale: '#9ca3af' };
                        const tl: Record<string, string> = { primary_product_type: 'Product Type', category_page: 'Page', field_assignment: 'Product Field', configuration_gap: 'Gap', reviewable_abstention: 'Needs Review' };
                        const fieldMeta = fieldTargetForProposal(p);
                        const typeOptions = productTypeOptions();
                        const proposedValues = Array.isArray(p.proposedValue)
                          ? p.proposedValue.map(String)
                          : p.proposedValue != null
                            ? [String(p.proposedValue)]
                            : [];
                        const displayTarget = p.proposalType === 'field_assignment'
                          ? fieldMeta.label
                          : p.proposalType === 'primary_product_type'
                            ? 'Product Type'
                            : p.targetId;

                        return (
                          <div key={p.id} style={{ padding: '8px 0', borderBottom: '1px solid #ede9fe', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                              <span>
                                <strong style={{ color: '#5b21b6' }}>{tl[p.proposalType] || p.proposalType}</strong>
                                {displayTarget && <span style={{ marginLeft: 4 }}>{displayTarget}</span>}
                                <span style={{ color: sc[p.status], marginLeft: 8, fontWeight: 600 }}>● {p.status}</span>
                                <span style={{ color: '#6b7280', marginLeft: 8 }}>confidence {Math.round(p.confidence * 100)}%</span>
                              </span>
                              <div style={{ display: 'flex', gap: 3 }}>
                                <button onClick={() => updateProposal(p.id, { status: 'accepted' })} style={{ padding: '2px 6px', fontSize: 10, borderRadius: 4, border: '1px solid #16a34a', background: p.status === 'accepted' ? '#dcfce7' : '#fff', color: '#16a34a', cursor: 'pointer' }}>Accept</button>
                                <button onClick={() => updateProposal(p.id, { status: 'rejected' })} style={{ padding: '2px 6px', fontSize: 10, borderRadius: 4, border: '1px solid #dc2626', background: p.status === 'rejected' ? '#fee2e2' : '#fff', color: '#dc2626', cursor: 'pointer' }}>Reject</button>
                              </div>
                            </div>

                            {p.proposalType === 'field_assignment' && fieldMeta.values.length > 0 && (
                              fieldMeta.target?.selectionMode === 'multiple' ? (
                                <select
                                  multiple
                                  value={proposedValues}
                                  onChange={(e) => {
                                    const values = Array.from(e.currentTarget.selectedOptions).map(option => option.value);
                                    updateProposal(p.id, { proposedValue: values, status: values.length > 0 ? 'accepted' : p.status });
                                  }}
                                  style={{ width: '100%', minHeight: 90, border: '1px solid #c4b5fd', borderRadius: 6, padding: 6, fontSize: 12, background: '#fff' }}
                                >
                                  {fieldMeta.values.map(value => <option key={value} value={value}>{value}</option>)}
                                </select>
                              ) : (
                                <select
                                  value={proposedValues[0] ?? ''}
                                  onChange={(e) => updateProposal(p.id, { proposedValue: e.target.value, status: e.target.value ? 'accepted' : p.status })}
                                  style={{ width: '100%', border: '1px solid #c4b5fd', borderRadius: 6, padding: 6, fontSize: 12, background: '#fff' }}
                                >
                                  <option value="">Choose a value…</option>
                                  {fieldMeta.values.map(value => <option key={value} value={value}>{value}</option>)}
                                </select>
                              )
                            )}

                            {p.proposalType === 'primary_product_type' && typeOptions.length > 0 && (
                              <select
                                value={String(p.targetId ?? '')}
                                onChange={(e) => updateProposal(p.id, { targetId: e.target.value, proposedValue: { productTypeId: e.target.value }, status: e.target.value ? 'accepted' : p.status })}
                                style={{ width: '100%', border: '1px solid #c4b5fd', borderRadius: 6, padding: 6, fontSize: 12, background: '#fff' }}
                              >
                                <option value="">Choose a product type…</option>
                                {typeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                              </select>
                            )}

                            {p.proposalType === 'field_assignment' && fieldMeta.values.length === 0 && (
                              <input
                                type="text"
                                value={proposedValues.join(', ')}
                                onChange={(e) => updateProposal(p.id, { proposedValue: e.target.value, status: e.target.value ? 'accepted' : p.status })}
                                placeholder="Enter reviewed value"
                                style={{ width: '100%', border: '1px solid #c4b5fd', borderRadius: 6, padding: 6, fontSize: 12, boxSizing: 'border-box' }}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}



                  {/* Product Pages — only shown in curation+ stages */}
                  {reviewItem?.stage !== 'extraction' && storePages.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Product Pages</h3>
                      
                      {/* Selected Pages Area */}
                      {curationFields.suggestedPages && curationFields.suggestedPages.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                          {curationFields.suggestedPages.map((pageName) => (
                            <span 
                              key={pageName} 
                              style={{ 
                                display: 'inline-flex', 
                                alignItems: 'center', 
                                gap: 4, 
                                background: '#f3e8ff', 
                                border: '1px solid #d8b4fe', 
                                color: '#6b21a8', 
                                padding: '2px 8px', 
                                borderRadius: 16, 
                                fontSize: 12, 
                                fontWeight: 500 
                              }}
                            >
                              {pageName}
                              <button 
                                type="button"
                                onClick={() => {
                                  const nextPages = (curationFields.suggestedPages || []).filter((n: string) => n !== pageName);
                                  const nextCuration = { ...curationFields, suggestedPages: nextPages };
                                  setCurationFields(nextCuration);
                                  saveChangesQuietly(reviewItem.id, editFields, nextCuration, classificationProposals);
                                }}
                                style={{ 
                                  background: 'none', 
                                  border: 'none', 
                                  color: '#a855f7', 
                                  cursor: 'pointer', 
                                  padding: 0, 
                                  fontSize: 10,
                                  fontWeight: 'bold',
                                  lineHeight: 1
                                }}
                              >
                                ✕
                              </button>
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Page Search Input */}
                      <input 
                        type="text" 
                        placeholder="Search pages..." 
                        value={pageSearchQuery} 
                        onChange={(e) => setPageSearchQuery(e.target.value)} 
                        style={{ 
                          width: '100%', 
                          padding: '6px 10px', 
                          border: '1px solid #d1d5db', 
                          borderRadius: 6, 
                          fontSize: 12, 
                          marginBottom: 8, 
                          boxSizing: 'border-box' 
                        }} 
                      />

                      {/* Page List Container */}
                      <div style={{ maxHeight: 150, overflowY: 'auto', border: '1px solid #d1d5db', borderRadius: 6, padding: 8 }}>
                        {storePages
                          .filter(pageName => pageName.toLowerCase().includes(pageSearchQuery.toLowerCase()))
                          .map((pageName) => {
                            const isAssigned = curationFields.suggestedPages?.includes(pageName) ?? false;
                            return (
                              <label key={pageName} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 12, cursor: 'pointer' }}>
                                <input type="checkbox" checked={isAssigned} onChange={(e) => {
                                  let nextPages;
                                  if (e.target.checked) {
                                    nextPages = [...(curationFields.suggestedPages || []), pageName];
                                  } else {
                                    nextPages = (curationFields.suggestedPages || []).filter((n: string) => n !== pageName);
                                  }
                                  const nextCuration = { ...curationFields, suggestedPages: nextPages };
                                  setCurationFields(nextCuration);
                                  saveChangesQuietly(reviewItem.id, editFields, nextCuration, classificationProposals);
                                }} />
                                {pageName}
                              </label>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div style={{
              padding: '16px 24px 24px',
              borderTop: '1px solid #e5e7eb',
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
              alignItems: 'center',
              flexShrink: 0,
              background: '#fff'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 'auto' }}>
                {saveStatus === 'saving' && (
                  <span style={{ fontSize: 13, color: '#4b5563', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5, borderColor: '#4b5563', animation: 'spin 0.8s linear infinite', display: 'inline-block' }} />
                    Saving...
                  </span>
                )}
                {saveStatus === 'saved' && (
                  <span style={{ fontSize: 13, color: '#16a34a', fontWeight: 500 }}>
                    ✓ Saved
                  </span>
                )}
                {saveStatus === 'error' && (
                  <span style={{ fontSize: 13, color: '#dc2626', fontWeight: 500 }}>
                    Error: {saveError}
                  </span>
                )}
              </div>
               <button onClick={closeReview} style={{ padding: '8px 16px', background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: '#374151', fontWeight: 500 }}>
                {reviewItem && ['discovery', 'extraction', 'curation'].includes(reviewItem.stage) ? 'Close' : 'Cancel'}
              </button>
              {reviewItem && reviewItem.stage === 'review' && (
                <button onClick={handleApproveReview} style={{ padding: '8px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  ✓ Approve
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

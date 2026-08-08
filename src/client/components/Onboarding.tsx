import React, { useState, useEffect, useRef } from 'react';
import {
  getBatches,
  getBatch,
  deleteBatch,
  getBatchItems,
  startSourceDiscovery,
  startExtraction,
  startCuration,
  promoteBatchItems,
  uploadSpreadsheet,
  createBatch,
  getItemDetail,
  updateItem,
  retryItem,
  selectSource,
  setItemUrl,
  skipItem,
  resolveBrandDomains,
  getBrandSites,
  submitDecisions,
  completeReviewStage,
  bulkAssignBrand,
  bulkSkipItems,
  bulkRetryItems
} from '../onboarding-api';
import { OnboardingSettings } from './OnboardingSettings';
import { PipelineBoard } from './PipelineBoard';
import { ProfileBuilder } from './profile-builder/ProfileBuilder';
import { WeeklyReportModal } from './WeeklyReportModal';
import type { OnboardingBatch, OnboardingItem, OnboardingSource, ExtractionData, CurationData, ColumnMapping, BrandSite } from '../../shared/schemas/onboarding';
import type { ClassificationProposal, ClassificationEvidence } from '../../shared/schemas/classification';
import { matchExistingBrand } from '../../shared/brand-matcher';

export function Onboarding() {
  const [showSettings, setShowSettings] = useState(false);
  const [showWeeklyReportModal, setShowWeeklyReportModal] = useState(false);
  const [batches, setBatches] = useState<OnboardingBatch[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<OnboardingBatch | null>(null);
  const [items, setItems] = useState<OnboardingItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Upload modal states
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadHeaders, setUploadHeaders] = useState<string[]>([]);
  const [uploadMapping, setUploadMapping] = useState<Partial<ColumnMapping>>({});
  const [uploadTempRows, setUploadTempRows] = useState<Record<string, string>[]>([]);
  const [uploadRowsCount, setUploadRowsCount] = useState(0);
  const [uploadBatchName, setUploadBatchName] = useState('');
  const [uploadStep, setUploadStep] = useState<1 | 2>(1);
  const [detectedBrands, setDetectedBrands] = useState<string[]>([]);
  const [brandMappings, setBrandMappings] = useState<Record<string, string>>({});
  const [loadingBrands, setLoadingBrands] = useState(false);

  // Item review/edit drawer states
  const [reviewItemId, setReviewItemId] = useState<string | null>(null);
  const [reviewItem, setReviewItem] = useState<OnboardingItem | null>(null);
  const [reviewSources, setReviewSources] = useState<OnboardingSource[]>([]);
  const [reviewExtraction, setReviewExtraction] = useState<ExtractionData | null>(null);
  const [manualUrlInput, setManualUrlInput] = useState('');
  const [editFields, setEditFields] = useState<Partial<ExtractionData>>({});
  const [curationFields, setCurationFields] = useState<Partial<CurationData>>({});
  const [storePages, setStorePages] = useState<string[]>([]);
  const [classificationProposals, setClassificationProposals] = useState<ClassificationProposal[]>([]);
  const [classificationEvidence, setClassificationEvidence] = useState<ClassificationEvidence[]>([]);
  const [profileBuilderDomain, setProfileBuilderDomain] = useState<string | null>(null);
  const [profileBuilderSeed, setProfileBuilderSeed] = useState<{ url?: string; item?: any } | null>(null);

  // Custom Selector Editor state was removed; extractor profiles are
  // managed in OnboardingSettings ("Domain Extractor Profiles" section).

  // Selection state for promotion
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);

  // Brand/Domain Management states
  const [cachedBrandSites, setCachedBrandSites] = useState<BrandSite[]>([]);
  const [catalogBrands, setCatalogBrands] = useState<string[]>([]);
  const [activeEditBrandItem, setActiveEditBrandItem] = useState<OnboardingItem | null>(null);
  const [editBrandName, setEditBrandName] = useState('');
  const [editBrandDomain, setEditBrandDomain] = useState('');
  const [propagateBrandName, setPropagateBrandName] = useState(false);
  const [validationModalItems, setValidationModalItems] = useState<OnboardingItem[] | null>(null);
  const [drawerBrandName, setDrawerBrandName] = useState('');
  const [drawerBrandDomain, setDrawerBrandDomain] = useState('');
  const [showBulkBrandModal, setShowBulkBrandModal] = useState(false);
  const [bulkBrandName, setBulkBrandName] = useState('');
  const [bulkBrandDomain, setBulkBrandDomain] = useState('');
  const [lastSelectedItemId, setLastSelectedItemId] = useState<string | null>(null);

  // SSE reference
  const sseRef = useRef<EventSource | null>(null);

  const fetchBatchesList = async () => {
    try {
      const res = await getBatches();
      setBatches(res.batches);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const loadStorePages = async () => {
    try {
      const res = await fetch('/api/pages');
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.pages)) {
          setStorePages(data.pages.map((p: any) => p.name));
        }
      }
    } catch (err) {
      console.error('Failed to load store pages:', err);
    }
  };

  const loadBrandSites = async () => {
    try {
      const res = await getBrandSites();
      setCachedBrandSites(res.brandSites);
      if (res.catalogBrands) {
        setCatalogBrands(res.catalogBrands);
      }
    } catch (err) {
      console.error('Failed to load brand sites:', err);
    }
  };

  useEffect(() => {
    fetchBatchesList();
    loadStorePages();
    loadBrandSites();
  }, []);

  // SSE lifecycle handled by PipelineBoard now
  useEffect(() => {
    return () => {
      if (sseRef.current) {
        sseRef.current.close();
      }
    };
  }, []);

  const handleSelectBatch = async (batchId: string) => {
    setLoading(true);
    setError('');
    setSelectedBatchId(batchId);
    setSelectedItemIds([]);
    try {
      const batchRes = await getBatch(batchId);
      setSelectedBatch(batchRes.batch);
      
      const itemsRes = await getBatchItems(batchId);
      setItems(itemsRes.items);
      await loadBrandSites();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleBackToBatches = () => {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    setSelectedBatchId(null);
    setSelectedBatch(null);
    setItems([]);
    fetchBatchesList();
  };

  const handleDeleteBatch = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this batch and all its items?')) return;
    try {
      await deleteBatch(id);
      fetchBatchesList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // ─── SPREADSHEET UPLOAD & CREATION ──────────────────────────────────────────

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError('');
    setUploadStep(1);
    setDetectedBrands([]);
    setBrandMappings({});
    try {
      const res = await uploadSpreadsheet(file);
      setUploadFile(file);
      setUploadHeaders(res.headers);
      setUploadMapping(res.mapping);
      setUploadTempRows(res.tempRows);
      setUploadRowsCount(res.rowsCount);
      
      // Auto-name batch
      const baseName = file.name.replace(/\.[^/.]+$/, '');
      setUploadBatchName(baseName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleNextStep = async () => {
    if (!uploadMapping.upc || !uploadMapping.name) {
      alert('UPC and Product Name column mappings are required');
      return;
    }

    setLoadingBrands(true);
    try {
      // Fetch existing brands in the system
      const brandSitesRes = await getBrandSites();
      const existingBrands = brandSitesRes.brandSites.map(b => b.brandName);

      const brandCol = uploadMapping.brand;
      const nameCol = uploadMapping.name;

      const brandsSet = new Set<string>();
      for (const row of uploadTempRows) {
        let brandVal = '';
        if (brandCol && row[brandCol]) {
          brandVal = row[brandCol].trim();
        } else if (nameCol && row[nameCol]) {
          // Check if first word(s) matches an existing brand exactly
          const matched = matchExistingBrand(row[nameCol], existingBrands);
          if (matched) {
            brandVal = matched;
          }
        }
        
        // Filter out short noise/numeric tokens
        if (brandVal && brandVal.length > 1 && !/^\d+$/.test(brandVal)) {
          brandsSet.add(brandVal.toUpperCase());
        }
      }

      const uniqueBrands = Array.from(brandsSet).sort();
      setDetectedBrands(uniqueBrands);

      // Query backend to resolve domains
      if (uniqueBrands.length > 0) {
        const res = await resolveBrandDomains(uniqueBrands);
        const initialMappings: Record<string, string> = {};
        for (const brand of uniqueBrands) {
          initialMappings[brand] = res.mappings[brand] || '';
        }
        setBrandMappings(initialMappings);
      }

      setUploadStep(2);
    } catch (err) {
      alert('Failed to detect brands: ' + String(err));
    } finally {
      setLoadingBrands(false);
    }
  };

  const handleConfirmBatch = async () => {
    if (!uploadBatchName.trim()) {
      alert('Please enter a batch name');
      return;
    }
    if (!uploadMapping.upc || !uploadMapping.name) {
      alert('UPC and Product Name column mappings are required');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const res = await createBatch({
        name: uploadBatchName,
        fileName: uploadFile!.name,
        mapping: uploadMapping as ColumnMapping,
        rows: uploadTempRows,
        brandMappings,
      });

      setShowUploadModal(false);
      setUploadFile(null);
      setUploadHeaders([]);
      setUploadMapping({});
      setUploadTempRows([]);
      setUploadRowsCount(0);
      setUploadBatchName('');
      setUploadStep(1);
      setDetectedBrands([]);
      setBrandMappings({});
      
      fetchBatchesList();
      handleSelectBatch(res.batch.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // ─── PIPELINE ACTIONS ─────────────────────────────────────────────────────────

  const handleStartDiscovery = async () => {
    if (!selectedBatchId) return;
    
    const itemsToValidate = selectedItemIds.length > 0
      ? items.filter(item => selectedItemIds.includes(item.id))
      : items;

    // Check if any items are missing brands or domains
    const invalidItems = itemsToValidate.filter(item => {
      if (!item.brandHint || !item.brandHint.trim()) return true;
      
      const site = cachedBrandSites.find(b => b.brandName.toLowerCase() === item.brandHint!.toLowerCase().trim());
      if (!site || !site.domain || !site.domain.trim()) return true;
      
      return false;
    });

    if (invalidItems.length > 0) {
      setValidationModalItems(invalidItems);
      return;
    }

    setLoading(true);
    setError('');
    try {
      await startSourceDiscovery(selectedBatchId, selectedItemIds.length > 0 ? selectedItemIds : undefined);
      setSelectedItemIds([]);
      // Refresh details
      await handleSelectBatch(selectedBatchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSkipAndStartDiscovery = async () => {
    if (!selectedBatchId || !validationModalItems) return;
    setLoading(true);
    setError('');
    const itemsToSkip = [...validationModalItems];
    setValidationModalItems(null);
    try {
      // Mark all invalid items as skipped
      await Promise.all(
        itemsToSkip.map(item => updateItem(item.id, { status: 'skipped' }))
      );
      
      // Then start discovery
      await startSourceDiscovery(selectedBatchId, selectedItemIds.length > 0 ? selectedItemIds : undefined);
      setSelectedItemIds([]);
      await handleSelectBatch(selectedBatchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleStartExtraction = async () => {
    if (!selectedBatchId) return;
    setLoading(true);
    setError('');
    try {
      await startExtraction(selectedBatchId, selectedItemIds.length > 0 ? selectedItemIds : undefined);
      setSelectedItemIds([]);
      // Refresh details
      await handleSelectBatch(selectedBatchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleStartCuration = async () => {
    if (!selectedBatchId) return;
    setLoading(true);
    setError('');
    try {
      await startCuration(selectedBatchId, selectedItemIds.length > 0 ? selectedItemIds : undefined);
      setSelectedItemIds([]);
      handleSelectBatch(selectedBatchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handlePromoteSelected = async () => {
    if (!selectedBatchId || selectedItemIds.length === 0) return;
    if (!confirm(`Are you sure you want to promote ${selectedItemIds.length} approved items as product drafts?`)) return;
    setLoading(true);
    setError('');
    try {
      const res = await promoteBatchItems(selectedBatchId, selectedItemIds);
      alert(`Successfully promoted ${res.count} product drafts!`);
      handleSelectBatch(selectedBatchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // ─── REVIEW/DRAWER FLOW ──────────────────────────────────────────────────────

  const handleOpenReview = async (item: OnboardingItem) => {
    setReviewItemId(item.id);
    setReviewItem(item);
    setManualUrlInput(item.sourceUrl || '');
    setDrawerBrandName(item.brandHint ? item.brandHint : '');
    const site = cachedBrandSites.find(b => b.brandName.toLowerCase() === (item.brandHint || '').toLowerCase().trim());
    setDrawerBrandDomain(site?.domain || '');
    setReviewSources([]);
    setReviewExtraction(null);
    setEditFields({});

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
      const extractionData = res.extraction ?? res.item?.extractionData ?? null;
      if (extractionData) {
        setReviewExtraction(extractionData);
        setEditFields(extractionData);
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

  const handleCloseReview = () => {
    setReviewItemId(null);
    setReviewItem(null);
    setReviewSources([]);
    setReviewExtraction(null);
    setEditFields({});
    setCurationFields({});
    setClassificationProposals([]);
    setClassificationEvidence([]);
    setDrawerBrandName('');
    setDrawerBrandDomain('');

    // Refresh batch items list to show updated status
    if (selectedBatchId) {
      getBatchItems(selectedBatchId).then(res => setItems(res.items));
    }
  };

  const handleSaveItemEdit = async () => {
    if (!reviewItemId) return;

    // Step 1: Save editable data WITHOUT setting legacy status 'ready'
    try {
      await updateItem(reviewItemId, {
        extraction_data: editFields,
        curation_data: { ...curationFields, classificationProposals, classificationEvidence }
      });
    } catch (err) {
      alert('Error saving item data: ' + (err instanceof Error ? err.message : String(err)));
      return;
    }

    // Step 2: Submit classification decisions, when this run has proposals.
    try {
      if (classificationProposals.length > 0) {
        const decs = classificationProposals
          .filter(p => p.status === 'accepted' || p.status === 'rejected' || p.status === 'deferred')
          .map(p => ({ proposalId: p.id, decision: p.status as 'accepted' | 'rejected' | 'deferred', proposedValue: p.proposedValue, targetId: p.targetId }));
        if (decs.length > 0) {
          await submitDecisions(reviewItemId, decs);
        }
      }
    } catch (err) {
      // Edits are saved; decisions failed. The item remains in review for retry.
      alert('Item edits were saved, but recording decisions failed: ' + (err instanceof Error ? err.message : String(err)) + ' — item remains in review.');
      // Keep the drawer open so the user can retry. Refresh the batch list to
      // reflect any edits that were saved before the decision failure.
      if (selectedBatchId) {
        getBatchItems(selectedBatchId).then(res => setItems(res.items));
      }
      return;
    }

    // Step 3: Complete review stage (separate from decisions)
    try {
      // Always ask the server to complete review. Classified items with missing
      // decisions fail closed; legacy items use the server's explicit bypass.
      await completeReviewStage([reviewItemId]);
    } catch (err) {
      alert('Item saved and decisions recorded, but completing review failed: ' +
        (err instanceof Error ? err.message : String(err)) +
        ' — use the "Complete Review" action in the pipeline board.');
      // Fetch latest items to reflect saved changes
      if (selectedBatchId) {
        getBatchItems(selectedBatchId).then(res => setItems(res.items));
      }
      return;
    }

    // All three steps succeeded
    alert('Item approved and saved to queue.');
    handleCloseReview();
  };

  const handleSelectSourceUrl = async (source: OnboardingSource) => {
    if (!reviewItemId) return;
    try {
      await selectSource(reviewItemId, source.id);
      
      // Refresh detail
      const res = await getItemDetail(reviewItemId);
      setReviewItem(res.item);
      setManualUrlInput(res.item.sourceUrl || '');
      setReviewSources(res.sources);
      const extractionData = res.extraction ?? res.item?.extractionData ?? null;
      if (extractionData) {
        setReviewExtraction(extractionData);
        setEditFields(extractionData);
      }
    } catch (err) {
      alert('Failed to select source: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleSetManualUrl = async () => {
    if (!reviewItemId || !manualUrlInput.trim()) return;
    try {
      await setItemUrl(reviewItemId, manualUrlInput);
      
      // Refresh detail
      const res = await getItemDetail(reviewItemId);
      setReviewItem(res.item);
      setReviewSources(res.sources);
      const extractionData = res.extraction ?? res.item?.extractionData ?? null;
      if (extractionData) {
        setReviewExtraction(extractionData);
        setEditFields(extractionData);
      }

      alert('Source URL set successfully.');
    } catch (err) {
      alert('Failed to set URL: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleSkipItem = async (itemId: string) => {
    try {
      await skipItem(itemId);
      handleCloseReview();
    } catch (err) {
      alert('Error skipping item: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleRetryItem = async (itemId: string) => {
    try {
      await retryItem(itemId);
      handleCloseReview();
    } catch (err) {
      alert('Error retrying item: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleStartInlineEditBrand = (item: OnboardingItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveEditBrandItem(item);
    setEditBrandName(item.brandHint ? item.brandHint : '');
    setPropagateBrandName(false);
    
    const site = cachedBrandSites.find(b => b.brandName.toLowerCase() === (item.brandHint || '').toLowerCase().trim());
    setEditBrandDomain(site?.domain || '');
  };

  const handleSaveInlineBrandEdit = async (itemId: string) => {
    setLoading(true);
    try {
      await updateItem(itemId, {
        brandHint: editBrandName.trim() || null,
        brandDomain: editBrandDomain.trim() || null,
        propagateBrandName: propagateBrandName
      });
      if (selectedBatchId) {
        const itemsRes = await getBatchItems(selectedBatchId);
        setItems(itemsRes.items);
        await loadBrandSites();
      }
      setActiveEditBrandItem(null);
    } catch (err) {
      alert('Failed to update brand: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveDrawerBrand = async () => {
    if (!reviewItemId) return;
    try {
      await updateItem(reviewItemId, {
        brandHint: drawerBrandName.trim() || null,
        brandDomain: drawerBrandDomain.trim() || null,
      });
      if (selectedBatchId) {
        const itemsRes = await getBatchItems(selectedBatchId);
        setItems(itemsRes.items);
        await loadBrandSites();
      }
      alert('Brand details updated.');
    } catch (err) {
      alert('Failed to update brand: ' + (err instanceof Error ? err.message : String(err)));
    }
  };

  const handleSaveBulkBrand = async () => {
    if (!selectedBatchId || selectedItemIds.length === 0) return;
    setLoading(true);
    try {
      await bulkAssignBrand(
        selectedBatchId,
        selectedItemIds,
        bulkBrandName.trim() || null,
        bulkBrandDomain.trim() || null
      );
      if (selectedBatchId) {
        const itemsRes = await getBatchItems(selectedBatchId);
        setItems(itemsRes.items);
        await loadBrandSites();
      }
      setShowBulkBrandModal(false);
      setBulkBrandName('');
      setBulkBrandDomain('');
      setSelectedItemIds([]);
      alert(`Successfully assigned brand to ${selectedItemIds.length} items.`);
    } catch (err) {
      alert('Failed to bulk assign brand: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  const handleBulkSkip = async () => {
    if (!selectedBatchId || selectedItemIds.length === 0) return;
    if (!confirm(`Are you sure you want to skip the ${selectedItemIds.length} selected items?`)) return;
    setLoading(true);
    try {
      await bulkSkipItems(selectedBatchId, selectedItemIds);
      const itemsRes = await getBatchItems(selectedBatchId);
      setItems(itemsRes.items);
      setSelectedItemIds([]);
      alert(`Successfully skipped ${selectedItemIds.length} items.`);
    } catch (err) {
      alert('Failed to bulk skip: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  const handleBulkRetry = async () => {
    if (!selectedBatchId || selectedItemIds.length === 0) return;
    if (!confirm(`Are you sure you want to reset/retry the ${selectedItemIds.length} selected items?`)) return;
    setLoading(true);
    try {
      await bulkRetryItems(selectedBatchId, selectedItemIds);
      const itemsRes = await getBatchItems(selectedBatchId);
      setItems(itemsRes.items);
      setSelectedItemIds([]);
      alert(`Successfully reset ${selectedItemIds.length} items.`);
    } catch (err) {
      alert('Failed to bulk reset: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  const handleCheckboxClick = (item: OnboardingItem, e: React.MouseEvent<any>) => {
    e.stopPropagation();

    const isChecked = selectedItemIds.includes(item.id);
    const targetChecked = !isChecked;

    const selectableItems = items.filter(i => i.status !== 'promoted');
    const currentIndex = selectableItems.findIndex(i => i.id === item.id);

    if (e.shiftKey && lastSelectedItemId) {
      const lastIndex = selectableItems.findIndex(i => i.id === lastSelectedItemId);
      if (lastIndex !== -1) {
        const start = Math.min(currentIndex, lastIndex);
        const end = Math.max(currentIndex, lastIndex);
        const rangeIds = selectableItems.slice(start, end + 1).map(i => i.id);

        setSelectedItemIds(prev => {
          if (targetChecked) {
            return Array.from(new Set([...prev, ...rangeIds]));
          } else {
            return prev.filter(id => !rangeIds.includes(id));
          }
        });
        setLastSelectedItemId(item.id);
        return;
      }
    }

    setSelectedItemIds(prev =>
      targetChecked
        ? [...prev, item.id]
        : prev.filter(id => id !== item.id)
    );
    setLastSelectedItemId(item.id);
  };

  // ─── LAYOUTS AND RENDERING ───────────────────────────────────────────────────

  const renderBatchProgress = (batch: OnboardingBatch, itemsList?: OnboardingItem[]) => {
    const total = batch.totalItems || 1;
    
    let completed = batch.completedItems;
    let failed = batch.failedItems;
    let skipped = batch.skippedItems ?? 0;
    
    if (itemsList && itemsList.length > 0) {
      completed = itemsList.filter(i => i.stage === 'promotion' && i.stageStatus === 'completed').length;
      failed = itemsList.filter(i => i.stageStatus === 'failed').length;
      skipped = itemsList.filter(i => i.stageStatus === 'skipped').length;
    }
    
    const completedPercent = Math.round((completed / total) * 100);
    const failedPercent = Math.round((failed / total) * 100);
    const skippedPercent = Math.round((skipped / total) * 100);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6b7280' }}>
          <span>
            {completed} completed / {failed} failed
            {skipped > 0 && ` / ${skipped} skipped`} ({total} total)
          </span>
          <span>{completedPercent + failedPercent}%</span>
        </div>
        <div style={{ height: 6, width: '100%', background: '#e5e7eb', borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
          <div style={{ height: '100%', width: `${completedPercent}%`, background: '#16a34a' }} />
          <div style={{ height: '100%', width: `${failedPercent}%`, background: '#dc2626' }} />
          <div style={{ height: '100%', width: `${skippedPercent}%`, background: '#9ca3af' }} />
        </div>
      </div>
    );
  };

  const statusLabel = (s: string) => {
    const labels: Record<string, string> = {
      imported: 'Imported',
      discovering: 'Searching sources...',
      source_found: 'Source found',
      source_confirmed: 'Confirmed',
      extracting: 'Scraping page...',
      extracted: 'Scraped',
      needs_review: 'Needs review',
      ready: 'Ready',
      promoted: 'Promoted',
      failed: 'Failed',
      skipped: 'Skipped'
    };
    return labels[s] ?? s;
  };

  const statusStyle = (s: string): React.CSSProperties => {
    const colors: Record<string, { bg: string, text: string }> = {
      imported: { bg: '#f3f4f6', text: '#374151' },
      discovering: { bg: '#dbeafe', text: '#1e40af' },
      source_found: { bg: '#fef3c7', text: '#92400e' },
      source_confirmed: { bg: '#e0f2fe', text: '#0369a1' },
      extracting: { bg: '#eff6ff', text: '#1e40af' },
      extracted: { bg: '#f0fdf4', text: '#166534' },
      needs_review: { bg: '#ffedd5', text: '#c2410c' },
      ready: { bg: '#dcfce7', text: '#15803d' },
      promoted: { bg: '#dcfce7', text: '#15803d' },
      failed: { bg: '#fee2e2', text: '#991b1b' },
      skipped: { bg: '#e5e7eb', text: '#6b7280' }
    };
    const c = colors[s] ?? { bg: '#f3f4f6', text: '#374151' };
    return {
      background: c.bg,
      color: c.text,
      padding: '4px 8px',
      borderRadius: 12,
      fontSize: 11,
      fontWeight: 600,
      display: 'inline-block'
    };
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    titleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    title: { fontSize: 24, fontWeight: 600, margin: 0, color: '#111827' },
    btnRow: { display: 'flex', gap: 12 },
    primaryBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 },
    secondaryBtn: { background: '#fff', border: '1px solid #d1d5db', color: '#4b5563', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 },
    table: { width: '100%', borderCollapse: 'collapse', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' },
    th: { background: '#f9fafb', borderBottom: '2px solid #e5e7eb', textAlign: 'left', padding: '12px 16px', color: '#4b5563', fontWeight: 600, fontSize: 13 },
    td: { borderBottom: '1px solid #e5e7eb', padding: '12px 16px', fontSize: 14, color: '#374151' },
    card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 20, marginBottom: 20 },
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 },
    modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 },
    modalContent: { background: '#fff', padding: 24, borderRadius: 8, width: '100%', maxWidth: 600, boxSizing: 'border-box' },
    fieldGroup: { marginBottom: 16 },
    label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#4b5563', marginBottom: 6 },
    select: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14 }
  };

  if (showSettings) {
    return <OnboardingSettings onBack={() => setShowSettings(false)} />;
  }

  // ─── VIEW 1: BATCHES LIST ─────────────────────────────────────────────────────

  if (!selectedBatchId) {
    return (
      <div style={styles.container}>
        <div style={styles.titleRow}>
          <h1 style={styles.title}>Product Onboarding Pipeline</h1>
          <div style={styles.btnRow}>
            <button
              style={{ ...styles.secondaryBtn, background: '#eff6ff', color: '#2563eb', borderColor: '#bfdbfe' }}
              onClick={() => setShowWeeklyReportModal(true)}
            >
              📊 Generate Weekly Report
            </button>
            <button style={styles.secondaryBtn} onClick={() => setShowSettings(true)}>⚙️ Onboarding Settings</button>
            <button style={styles.primaryBtn} onClick={() => setShowUploadModal(true)}>+ Upload Weekly Spreadsheet</button>
          </div>
        </div>

        {error && <div style={{ color: '#dc2626', background: '#fef2f2', padding: 12, borderRadius: 6, marginBottom: 20 }}>{error}</div>}

        {batches.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 24px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <p style={{ fontSize: 16, color: '#6b7280', margin: '0 0 16px' }}>No onboarding batches uploaded yet.</p>
            <button onClick={() => setShowUploadModal(true)} style={{ ...styles.primaryBtn, margin: '0 auto' }}>Upload Spreadsheet to Start</button>
          </div>
        ) : (
          <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Batch Name</th>
                  <th style={styles.th}>Filename</th>
                  <th style={styles.th}>Uploaded At</th>
                  <th style={styles.th}>Status</th>
                  <th style={styles.th}>Progress</th>
                  <th style={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {batches.map(batch => (
                  <tr
                    key={batch.id}
                    onClick={() => handleSelectBatch(batch.id)}
                    style={{ cursor: 'pointer', transition: 'background 0.2s' }}
                    className="hover-row"
                  >
                    <td style={styles.td}><strong>{batch.name}</strong></td>
                    <td style={styles.td}>{batch.fileName}</td>
                    <td style={styles.td}>{batch.createdAt.slice(0, 19).replace('T', ' ')}</td>
                    <td style={styles.td}><span style={statusStyle(batch.status)}>{statusLabel(batch.status)}</span></td>
                    <td style={styles.td} onClick={(e) => e.stopPropagation()}>{renderBatchProgress(batch)}</td>
                    <td style={styles.td}>
                      <button
                        style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
                        onClick={(e) => handleDeleteBatch(batch.id, e)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ─── UPLOAD MODAL ──────────────────────────────────────────────────────── */}
        {showUploadModal && (
          <div style={styles.modalOverlay}>
            <div style={styles.modalContent}>
              <h2 style={{ margin: '0 0 16px' }}>Upload Onboarding Spreadsheet</h2>
              
              {!uploadFile ? (
                <div style={{ border: '2px dashed #d1d5db', borderRadius: 8, padding: 32, textAlign: 'center', background: '#f9fafb' }}>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleFileChange}
                    style={{ display: 'none' }}
                    id="file-upload-input"
                  />
                  <label htmlFor="file-upload-input" style={{ cursor: 'pointer', color: '#2563eb', fontWeight: 600 }}>
                    Click to browse files
                  </label>
                  <p style={{ margin: '8px 0 0', fontSize: 13, color: '#6b7280' }}>Accepts .xlsx, .xls, or .csv spreadsheets</p>
                </div>
              ) : (
                <div>
                  <p style={{ fontSize: 13, color: '#4b5563', margin: '0 0 16px 0' }}>
                    File: <strong>{uploadFile.name}</strong> ({uploadRowsCount} data rows found)
                  </p>

                  {uploadStep === 1 ? (
                    <div>
                      <div style={styles.fieldGroup}>
                        <label style={styles.label}>Onboarding Batch Name</label>
                        <input
                          style={{
                            ...styles.input,
                            width: '100%',
                            padding: 8,
                            border: '1px solid #d1d5db',
                            borderRadius: 6,
                            ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                          }}
                          type="text"
                          value={uploadBatchName}
                          onChange={(e) => setUploadBatchName(e.target.value)}
                          disabled={loadingBrands}
                        />
                      </div>

                      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '16px 0 8px' }}>Map Spreadsheet Columns</h3>
                      
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>UPC/SKU Column *</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.upc || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, upc: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- Select --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Product Name Column *</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.name || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, name: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- Select --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Merge Name With Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.nameMergeWith || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, nameMergeWith: e.target.value || null }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Price Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.price || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, price: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Quantity Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.quantity || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, quantity: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Brand Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.brand || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, brand: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Product Page URL Column (Optional)</label>
                          <select
                            style={{
                              ...styles.select,
                              ...(loadingBrands ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                            }}
                            value={uploadMapping.sourceUrl || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, sourceUrl: e.target.value }))}
                            disabled={loadingBrands}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>
                      </div>

                      <div style={{ ...styles.btnRow, marginTop: 24, justifyContent: 'flex-end' }}>
                        <button
                          style={{
                            ...styles.secondaryBtn,
                            marginRight: 8,
                            ...(loadingBrands ? { opacity: 0.5, cursor: 'not-allowed' } : {})
                          }}
                          onClick={() => { setUploadFile(null); setShowUploadModal(false); }}
                          disabled={loadingBrands}
                        >
                          Cancel
                        </button>
                        <button
                          style={{
                            ...styles.primaryBtn,
                            ...(loadingBrands ? { opacity: 0.7, cursor: 'not-allowed', background: '#3b82f6' } : {})
                          }}
                          onClick={handleNextStep}
                          disabled={loadingBrands}
                        >
                          {loadingBrands ? (
                            <>
                              <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                              Analyzing Brands...
                            </>
                          ) : (
                            'Next →'
                          )}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 8px 0' }}>Assign Brand Domains</h3>
                      <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px 0', lineHeight: '1.4' }}>
                        We detected <strong>{detectedBrands.length}</strong> distinct brand(s) in this batch.
                        Provide official domains (e.g. <code>brandname.com</code>) to search, or leave blank to fallback to retailer queries.
                      </p>

                      {detectedBrands.length === 0 ? (
                        <p style={{ fontSize: 13, color: '#6b7280', fontStyle: 'italic', padding: '12px 0' }}>
                          No brands detected in name/brand columns. Click Create Batch to proceed.
                        </p>
                      ) : (
                        <div style={{ maxHeight: '250px', overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, backgroundColor: '#f9fafb' }}>
                          {detectedBrands.map((brand) => (
                            <div key={brand} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, alignItems: 'center', marginBottom: 10 }}>
                              <span style={{ fontSize: 13, fontWeight: 600, color: '#374151', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={brand}>
                                {brand}
                              </span>
                              <input
                                style={{
                                  ...styles.input,
                                  padding: '6px 10px',
                                  border: '1px solid #d1d5db',
                                  borderRadius: 6,
                                  fontSize: 13,
                                  height: 'auto',
                                  width: '100%',
                                  boxSizing: 'border-box',
                                  ...(loading ? { backgroundColor: '#f3f4f6', cursor: 'not-allowed' } : {})
                                }}
                                type="text"
                                placeholder="e.g. brandname.com"
                                value={brandMappings[brand] || ''}
                                onChange={(e) => setBrandMappings(p => ({ ...p, [brand]: e.target.value }))}
                                disabled={loading}
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      <div style={{ ...styles.btnRow, marginTop: 24, justifyContent: 'space-between' }}>
                        <button
                          style={{
                            ...styles.secondaryBtn,
                            ...(loading ? { opacity: 0.5, cursor: 'not-allowed' } : {})
                          }}
                          onClick={() => setUploadStep(1)}
                          disabled={loading}
                        >
                          ← Back
                        </button>
                        <button
                          style={{
                            ...styles.primaryBtn,
                            ...(loading ? { opacity: 0.7, cursor: 'not-allowed', background: '#3b82f6' } : {})
                          }}
                          onClick={handleConfirmBatch}
                          disabled={loading}
                        >
                          {loading ? (
                            <>
                              <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                              Creating Batch...
                            </>
                          ) : (
                            'Create Batch'
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
        {showWeeklyReportModal && (
          <WeeklyReportModal onClose={() => setShowWeeklyReportModal(false)} />
        )}
      </div>
    );
  }

  // ─── VIEW 2: PIPELINE BOARD ───────────────────────────────────────────────

  if (selectedBatchId && selectedBatch) {
    return (
      <>
        <PipelineBoard
          batchId={selectedBatchId}
          batchName={selectedBatch.name}
          onBack={handleBackToBatches}
          cachedBrandSites={cachedBrandSites}
          _catalogBrands={catalogBrands}
          onRefreshBrandSites={loadBrandSites}
          onOpenProfileBuilder={(domain, item) => {
            setProfileBuilderDomain(domain);
            setProfileBuilderSeed({ url: item.sourceUrl ?? undefined, item });
          }}
          onOpenBrandSetup={() => {
            setShowSettings(true);
          }}
        />
        {profileBuilderDomain && (
          <ProfileBuilder
            mode="modal"
            initialDomain={profileBuilderDomain}
            initialProductUrl={profileBuilderSeed?.url}
            onCancel={() => { setProfileBuilderDomain(null); setProfileBuilderSeed(null); }}
          />
        )}
        {showWeeklyReportModal && (
          <WeeklyReportModal onClose={() => setShowWeeklyReportModal(false)} />
        )}
      </>
    );
  }

  // No batch selected or batch not loaded
  return null;
}

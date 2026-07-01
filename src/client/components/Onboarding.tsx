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
  getExtractorProfiles,
  saveExtractorProfile,
  testExtractorProfile,
  getBrandSites,
  submitDecisions
} from '../onboarding-api';
import type { ClassificationProposal, ClassificationEvidence } from '../../shared/schemas/classification';
import { OnboardingSettings } from './OnboardingSettings';
import type { OnboardingBatch, OnboardingItem, OnboardingSource, ExtractionData, CurationData, ColumnMapping } from '../../shared/schemas/onboarding';
import { matchExistingBrand } from '../../shared/brand-matcher';

export function Onboarding() {
  const [showSettings, setShowSettings] = useState(false);
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

  // Custom Selector Editor state
  const [titleSelector, setTitleSelector] = useState('');
  const [priceSelector, setPriceSelector] = useState('');
  const [descriptionSelector, setDescriptionSelector] = useState('');
  const [brandSelector, setBrandSelector] = useState('');
  const [imagesSelector, setImagesSelector] = useState('');
  const [testingSelectors, setTestingSelectors] = useState(false);
  const [selectorTestResults, setSelectorTestResults] = useState<any>(null);
  const [selectorTestError, setSelectorTestError] = useState('');

  // Selection state for promotion
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);

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

  useEffect(() => {
    fetchBatchesList();
    loadStorePages();
  }, []);

  // SSE setup when a batch is active
  const connectSSE = (batchId: string) => {
    if (sseRef.current) {
      sseRef.current.close();
    }

    const sse = new EventSource(`/api/onboarding/batches/${batchId}/events`);
    sseRef.current = sse;

    sse.addEventListener('item:status', (e: any) => {
      const event = JSON.parse(e.data);
      setItems(prev => prev.map(item => {
        if (item.id === event.itemId) {
          return { ...item, status: event.data.status, errorMessage: event.data.error || null, sourceUrl: event.data.sourceUrl || item.sourceUrl };
        }
        return item;
      }));
    });

    sse.addEventListener('batch:progress', (e: any) => {
      const event = JSON.parse(e.data);
      setSelectedBatch(prev => prev ? {
        ...prev,
        completedItems: event.data.completed,
        failedItems: event.data.failed,
      } : null);
    });

    sse.addEventListener('batch:complete', (e: any) => {
      const event = JSON.parse(e.data);
      setSelectedBatch(prev => prev ? {
        ...prev,
        status: event.data.status,
      } : null);
      fetchBatchesList();
    });
  };

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

      // Connect SSE if the batch is in a processing state
      if (['discovering', 'extracting'].includes(batchRes.batch.status)) {
        connectSSE(batchId);
      }
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
    try {
      await startSourceDiscovery(selectedBatchId);
      // Refresh details
      handleSelectBatch(selectedBatchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStartExtraction = async () => {
    if (!selectedBatchId) return;
    try {
      await startExtraction(selectedBatchId);
      // Refresh details
      handleSelectBatch(selectedBatchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStartCuration = async () => {
    if (!selectedBatchId) return;
    setLoading(true);
    setError('');
    try {
      await startCuration(selectedBatchId);
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
    setReviewSources([]);
    setReviewExtraction(null);
    setEditFields({});

    setSelectorTestResults(null);
    setSelectorTestError('');
    if (item.curationData?.classificationProposals) {
      setClassificationProposals(item.curationData.classificationProposals);
      setClassificationEvidence(item.curationData.classificationEvidence || []);
    } else {
      setClassificationProposals([]);
      setClassificationEvidence([]);
    }
    if (item.sourceUrl) {
      loadSelectorProfileForUrl(item.sourceUrl);
    }

    try {
      const res = await getItemDetail(item.id);
      setReviewSources(res.sources);
      if (res.extraction) {
        setReviewExtraction(res.extraction);
        setEditFields(res.extraction);
      }
      if (res.item?.curationData) {
        setCurationFields(res.item.curationData);
      } else if (item.curationData) {
        setCurationFields(item.curationData);
      } else {
        setCurationFields({
          curatedTitle: res.extraction?.title || item.name,
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
    // Reset selectors
    setTitleSelector('');
    setPriceSelector('');
    setDescriptionSelector('');
    setBrandSelector('');
    setImagesSelector('');
    setSelectorTestResults(null);
    setSelectorTestError('');
    
    // Refresh batch items list to show updated status
    if (selectedBatchId) {
      getBatchItems(selectedBatchId).then(res => setItems(res.items));
    }
  };

  const loadSelectorProfileForUrl = async (url: string) => {
    try {
      const parsedUrl = new URL(url);
      const domain = parsedUrl.hostname.replace(/^www\./, '');
      const res = await getExtractorProfiles();
      const profile = res.extractorProfiles.find(p => p.domain === domain);
      if (profile) {
        setTitleSelector(profile.titleSelector || '');
        setPriceSelector(profile.priceSelector || '');
        setDescriptionSelector(profile.descriptionSelector || '');
        setBrandSelector(profile.brandSelector || '');
        setImagesSelector(profile.imagesSelector || '');
      } else {
        setTitleSelector('');
        setPriceSelector('');
        setDescriptionSelector('');
        setBrandSelector('');
        setImagesSelector('');
      }
    } catch {
      setTitleSelector('');
      setPriceSelector('');
      setDescriptionSelector('');
      setBrandSelector('');
      setImagesSelector('');
    }
  };

  const handleTestSelectors = async () => {
    const url = manualUrlInput || reviewItem?.sourceUrl;
    if (!url) {
      alert('Please specify a confirmed product URL first.');
      return;
    }
    setTestingSelectors(true);
    setSelectorTestError('');
    setSelectorTestResults(null);
    try {
      const res = await testExtractorProfile({
        url,
        titleSelector: titleSelector || null,
        priceSelector: priceSelector || null,
        descriptionSelector: descriptionSelector || null,
        brandSelector: brandSelector || null,
        imagesSelector: imagesSelector || null,
      });
      if (res.success) {
        setSelectorTestResults(res.extracted);
      }
    } catch (err) {
      setSelectorTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestingSelectors(false);
    }
  };

  const handleSaveSelectorProfile = async () => {
    const url = manualUrlInput || reviewItem?.sourceUrl;
    if (!url) {
      alert('No product URL confirmed.');
      return;
    }
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      await saveExtractorProfile({
        domain,
        titleSelector: titleSelector || null,
        priceSelector: priceSelector || null,
        descriptionSelector: descriptionSelector || null,
        brandSelector: brandSelector || null,
        imagesSelector: imagesSelector || null,
      });
      alert(`Selector profile saved for ${domain}! These selectors will be applied to all future extractions from this domain.`);
    } catch (err) {
      alert('Failed to save selector profile: ' + String(err));
    }
  };

  const handleSaveItemEdit = async () => {
    if (!reviewItemId) return;
    try {
      // Clean provenance field names to match schema update
      await updateItem(reviewItemId, {
        status: 'ready', // mark ready on save/approve
        extraction_data: editFields,
        curation_data: { ...curationFields, classificationProposals, classificationEvidence }
      });
      if (classificationProposals.length > 0) {
        const decs = classificationProposals.filter(p => p.status === 'accepted' || p.status === 'rejected' || p.status === 'deferred').map(p => ({ proposalId: p.id, decision: p.status as 'accepted' | 'rejected' | 'deferred' }));
        if (decs.length > 0) { try { await submitDecisions(reviewItemId, decs); } catch (e) { console.warn(e); } }
      }
      alert('Item approved and saved to queue.');
      
      // Auto-select this item for promotion
      if (!selectedItemIds.includes(reviewItemId)) {
        setSelectedItemIds(prev => [...prev, reviewItemId]);
      }
      
      handleCloseReview();
    } catch (err) {
      alert('Error updating item: ' + (err instanceof Error ? err.message : String(err)));
    }
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
      if (res.extraction) {
        setReviewExtraction(res.extraction);
        setEditFields(res.extraction);
      }

      if (res.item.sourceUrl) {
        loadSelectorProfileForUrl(res.item.sourceUrl);
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
      if (res.extraction) {
        setReviewExtraction(res.extraction);
        setEditFields(res.extraction);
      }

      loadSelectorProfileForUrl(manualUrlInput);
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

  // ─── LAYOUTS AND RENDERING ───────────────────────────────────────────────────

  const renderBatchProgress = (batch: OnboardingBatch) => {
    const total = batch.totalItems || 1;
    const completedPercent = Math.round((batch.completedItems / total) * 100);
    const failedPercent = Math.round((batch.failedItems / total) * 100);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6b7280' }}>
          <span>{batch.completedItems} completed / {batch.failedItems} failed ({batch.totalItems} total)</span>
          <span>{completedPercent + failedPercent}%</span>
        </div>
        <div style={{ height: 6, width: '100%', background: '#e5e7eb', borderRadius: 3, overflow: 'hidden', display: 'flex' }}>
          <div style={{ height: '100%', width: `${completedPercent}%`, background: '#16a34a' }} />
          <div style={{ height: '100%', width: `${failedPercent}%`, background: '#dc2626' }} />
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
                          style={{ ...styles.input, width: '100%', padding: 8, border: '1px solid #d1d5db', borderRadius: 6 }}
                          type="text"
                          value={uploadBatchName}
                          onChange={(e) => setUploadBatchName(e.target.value)}
                        />
                      </div>

                      <h3 style={{ fontSize: 14, fontWeight: 600, margin: '16px 0 8px' }}>Map Spreadsheet Columns</h3>
                      
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>UPC/SKU Column *</label>
                          <select
                            style={styles.select}
                            value={uploadMapping.upc || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, upc: e.target.value }))}
                          >
                            <option value="">-- Select --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Product Name Column *</label>
                          <select
                            style={styles.select}
                            value={uploadMapping.name || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, name: e.target.value }))}
                          >
                            <option value="">-- Select --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Merge Name With Column (Optional)</label>
                          <select
                            style={styles.select}
                            value={uploadMapping.nameMergeWith || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, nameMergeWith: e.target.value || null }))}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Price Column (Optional)</label>
                          <select
                            style={styles.select}
                            value={uploadMapping.price || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, price: e.target.value }))}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Quantity Column (Optional)</label>
                          <select
                            style={styles.select}
                            value={uploadMapping.quantity || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, quantity: e.target.value }))}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Brand Column (Optional)</label>
                          <select
                            style={styles.select}
                            value={uploadMapping.brand || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, brand: e.target.value }))}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>

                        <div style={styles.fieldGroup}>
                          <label style={styles.label}>Product Page URL Column (Optional)</label>
                          <select
                            style={styles.select}
                            value={uploadMapping.sourceUrl || ''}
                            onChange={(e) => setUploadMapping(p => ({ ...p, sourceUrl: e.target.value }))}
                          >
                            <option value="">-- None --</option>
                            {uploadHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>
                      </div>

                      <div style={{ ...styles.btnRow, marginTop: 24, justifyContent: 'flex-end' }}>
                        <button style={{ ...styles.secondaryBtn, marginRight: 8 }} onClick={() => { setUploadFile(null); setShowUploadModal(false); }}>Cancel</button>
                        <button style={styles.primaryBtn} onClick={handleNextStep} disabled={loadingBrands}>
                          {loadingBrands ? 'Analyzing Brands...' : 'Next →'}
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
                                style={{ ...styles.input, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, height: 'auto', width: '100%', boxSizing: 'border-box' }}
                                type="text"
                                placeholder="e.g. brandname.com"
                                value={brandMappings[brand] || ''}
                                onChange={(e) => setBrandMappings(p => ({ ...p, [brand]: e.target.value }))}
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      <div style={{ ...styles.btnRow, marginTop: 24, justifyContent: 'space-between' }}>
                        <button style={styles.secondaryBtn} onClick={() => setUploadStep(1)}>← Back</button>
                        <button style={styles.primaryBtn} onClick={handleConfirmBatch}>Create Batch</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── VIEW 2: BATCH DETAIL QUEUE ──────────────────────────────────────────────

  const isBatchProcessing = selectedBatch && ['discovering', 'extracting'].includes(selectedBatch.status);
  const isBatchFinished = selectedBatch && ['review', 'completed'].includes(selectedBatch.status);

  return (
    <div style={styles.container}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <button style={{ ...styles.secondaryBtn, padding: '4px 8px', fontSize: 12, marginBottom: 8 }} onClick={handleBackToBatches}>← All Batches</button>
          <h1 style={{ ...styles.title, fontSize: 20 }}>
            Batch: {selectedBatch?.name}
            {selectedBatch && <span style={{ marginLeft: 12 }}><span style={statusStyle(selectedBatch.status)}>{statusLabel(selectedBatch.status)}</span></span>}
          </h1>
        </div>

        <div style={styles.btnRow}>
          {selectedBatch?.status === 'imported' && (
            <button style={styles.primaryBtn} onClick={handleStartDiscovery} disabled={loading}>
              🔍 Find Product Source URLs
            </button>
          )}

          {selectedBatch?.status === 'review' && items.some(item => ['source_found', 'source_confirmed'].includes(item.status)) && (
            <button style={styles.primaryBtn} onClick={handleStartExtraction} disabled={loading}>
              ⚡ Scrape Product Information
            </button>
          )}

          {selectedBatch?.status === 'review' && items.some(item => ['needs_review', 'curated'].includes(item.status)) && (
            <button style={{ ...styles.primaryBtn, background: '#8b5cf6' }} onClick={handleStartCuration} disabled={loading}>
              ✨ Refine & Classify Titles (OCR Curation)
            </button>
          )}

          {(selectedBatch?.status === 'review' || selectedBatch?.status === 'completed') && items.some(item => item.status === 'curated' || item.status === 'ready') && (
            <button
              style={{ ...styles.primaryBtn, background: '#16a34a' }}
              onClick={handlePromoteSelected}
              disabled={selectedItemIds.length === 0 || loading}
            >
              📥 Promote Selected Drafts ({selectedItemIds.length})
            </button>
          )}
        </div>
      </div>

      {error && <div style={{ color: '#dc2626', background: '#fef2f2', padding: 12, borderRadius: 6, marginBottom: 20 }}>{error}</div>}

      {selectedBatch && (
        <div style={{ ...styles.card, marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Batch Progress</h3>
          {renderBatchProgress(selectedBatch)}
        </div>
      )}

      {/* ─── ITEMS QUEUE ─── */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: 40 }}>
                <input
                  type="checkbox"
                  checked={selectedItemIds.length > 0 && selectedItemIds.length === items.filter(i => ['needs_review', 'ready'].includes(i.status)).length}
                  onChange={(e) => {
                    const reviewable = items.filter(i => ['needs_review', 'ready'].includes(i.status)).map(i => i.id);
                    setSelectedItemIds(e.target.checked ? reviewable : []);
                  }}
                />
              </th>
              <th style={styles.th}>Row</th>
              <th style={styles.th}>UPC/SKU</th>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Price</th>
              <th style={styles.th}>Source URL</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr
                key={item.id}
                style={{
                  background: selectedItemIds.includes(item.id) ? '#eff6ff' : '#fff',
                  cursor: 'pointer'
                }}
                onClick={() => handleOpenReview(item)}
              >
                <td style={styles.td} onClick={(e) => e.stopPropagation()}>
                  {['needs_review', 'ready'].includes(item.status) ? (
                    <input
                      type="checkbox"
                      checked={selectedItemIds.includes(item.id)}
                      onChange={(e) => {
                        setSelectedItemIds(prev =>
                          e.target.checked
                            ? [...prev, item.id]
                            : prev.filter(id => id !== item.id)
                        );
                      }}
                    />
                  ) : null}
                </td>
                <td style={styles.td}>{item.rowNumber}</td>
                <td style={styles.td}>
                  <strong>{item.upc}</strong>
                  {item.isDuplicate && (
                    <span style={{ marginLeft: 4, background: '#fef2f2', color: '#991b1b', fontSize: 10, padding: '1px 4px', borderRadius: 4, fontWeight: 600 }}>Duplicate</span>
                  )}
                </td>
                <td style={styles.td}>{item.name}</td>
                <td style={styles.td}>{item.price ? `$${item.price}` : '—'}</td>
                <td style={styles.td}>
                  {item.sourceUrl ? (
                    <a
                      href={item.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{ color: '#2563eb', textDecoration: 'none', wordBreak: 'break-all', fontSize: 13 }}
                    >
                      {item.sourceUrl.length > 40 ? item.sourceUrl.slice(0, 40) + '...' : item.sourceUrl}
                    </a>
                  ) : <span style={{ color: '#9ca3af', fontSize: 12 }}>None</span>}
                </td>
                <td style={styles.td}><span style={statusStyle(item.status)}>{statusLabel(item.status)}</span></td>
                <td style={styles.td} onClick={(e) => e.stopPropagation()}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontWeight: 600, fontSize: 13, padding: 0 }}
                      onClick={() => handleOpenReview(item)}
                    >
                      Review
                    </button>
                    {item.status === 'failed' && (
                      <button
                        style={{ background: 'none', border: 'none', color: '#16a34a', cursor: 'pointer', fontWeight: 600, fontSize: 13, padding: 0 }}
                        onClick={() => handleRetryItem(item.id)}
                      >
                        Retry
                      </button>
                    )}
                    {!['promoted', 'skipped'].includes(item.status) && (
                      <button
                        style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontWeight: 600, fontSize: 13, padding: 0 }}
                        onClick={() => handleSkipItem(item.id)}
                      >
                        Skip
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ─── DETAIL / REVIEW DRAWER ────────────────────────────────────────────── */}
      {reviewItemId && reviewItem && (
        <>
          <div className="drawer-backdrop" onClick={handleCloseReview} />
          <div className="drawer-container" style={{ maxWidth: 850 }}>
            <button className="drawer-close-btn" onClick={handleCloseReview}>✕</button>
            
            <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
              <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>Review Item: {reviewItem.name}</h2>
              <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6b7280' }}>
                Row {reviewItem.rowNumber} | UPC: <strong>{reviewItem.upc}</strong>
              </p>

              {reviewItem.errorMessage && (
                <div style={{ background: '#fee2e2', color: '#991b1b', padding: 12, borderRadius: 6, marginBottom: 20, fontSize: 14 }}>
                  <strong>Extraction Failure:</strong> {reviewItem.errorMessage}
                </div>
              )}

              {reviewItem.isDuplicate && (
                <div style={{ background: '#fffbeb', border: '1px solid #f59e0b', color: '#b45309', padding: 12, borderRadius: 6, marginBottom: 20, fontSize: 13 }}>
                  ⚠️ <strong>Duplicate Warning:</strong> This product SKU/UPC already exists in your local product catalog index.
                  If promoted, it will update/override the existing product instead of creating a new one.
                </div>
              )}

              {/* ─── STEP 1: SOURCE URL SELECTION ─── */}
              <div style={styles.card}>
                <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>Step 1: Confirmed Product Page URL</h3>
                
                <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                  <input
                    style={{ ...styles.input, flex: 1 }}
                    type="text"
                    placeholder="Enter manual manufacturer product page URL"
                    value={manualUrlInput}
                    onChange={(e) => setManualUrlInput(e.target.value)}
                  />
                  <button style={styles.secondaryBtn} onClick={handleSetManualUrl}>Set URL</button>
                </div>

                {reviewSources.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: 13, fontWeight: 600, color: '#4b5563', margin: '0 0 8px' }}>Google Search Discovery Matches</h4>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {reviewSources.map(src => (
                        <div
                          key={src.id}
                          style={{
                            border: '1px solid #e5e7eb',
                            borderRadius: 6,
                            padding: 12,
                            background: src.isSelected ? '#f0fdf4' : '#fff',
                            borderColor: src.isSelected ? '#16a34a' : '#e5e7eb',
                            cursor: 'pointer'
                          }}
                          onClick={() => handleSelectSourceUrl(src)}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <strong style={{ fontSize: 14, color: src.isSelected ? '#166534' : '#111827' }}>
                              {src.title || src.domain}
                            </strong>
                            <span style={{ fontSize: 11, fontWeight: 600, color: '#15803d' }}>
                              {(src.confidence * 100).toFixed(0)}% Match
                            </span>
                          </div>
                          <p style={{ margin: '0 0 4px', fontSize: 12, color: '#6b7280', wordBreak: 'break-all' }}>{src.url}</p>
                          {src.snippet && <p style={{ margin: 0, fontSize: 12, color: '#4b5563', fontStyle: 'italic' }}>"{src.snippet}"</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* ─── CUSTOM SELECTOR EDITOR ─── */}
              {(manualUrlInput || reviewItem.sourceUrl) && (
                <div style={styles.card}>
                  <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>Custom Site Selectors (Optional)</h3>
                  <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 16px 0', lineHeight: '1.4' }}>
                    Configure specific CSS selectors for the domain <strong>{(() => {
                      try {
                        return new URL(manualUrlInput || reviewItem.sourceUrl || '').hostname.replace(/^www\./, '');
                      } catch {
                        return '';
                      }
                    })()}</strong>. 
                    Once saved, these custom selectors will override heuristics for all future extractions from this site.
                  </p>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                    <div style={styles.fieldGroup}>
                      <label style={styles.label}>Title Selector</label>
                      <input
                        style={{ ...styles.input, fontSize: 13, padding: '6px 8px' }}
                        type="text"
                        placeholder="e.g. h1.product-title"
                        value={titleSelector}
                        onChange={(e) => setTitleSelector(e.target.value)}
                      />
                    </div>
                    
                    <div style={styles.fieldGroup}>
                      <label style={styles.label}>Price Selector</label>
                      <input
                        style={{ ...styles.input, fontSize: 13, padding: '6px 8px' }}
                        type="text"
                        placeholder="e.g. span.price"
                        value={priceSelector}
                        onChange={(e) => setPriceSelector(e.target.value)}
                      />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                    <div style={styles.fieldGroup}>
                      <label style={styles.label}>Description Selector</label>
                      <input
                        style={{ ...styles.input, fontSize: 13, padding: '6px 8px' }}
                        type="text"
                        placeholder="e.g. div.desc"
                        value={descriptionSelector}
                        onChange={(e) => setDescriptionSelector(e.target.value)}
                      />
                    </div>
                    
                    <div style={styles.fieldGroup}>
                      <label style={styles.label}>Brand Selector</label>
                      <input
                        style={{ ...styles.input, fontSize: 13, padding: '6px 8px' }}
                        type="text"
                        placeholder="e.g. a.brand"
                        value={brandSelector}
                        onChange={(e) => setBrandSelector(e.target.value)}
                      />
                    </div>
                  </div>

                  <div style={{ ...styles.fieldGroup, marginBottom: 16 }}>
                    <label style={styles.label}>Images Selector</label>
                    <input
                      style={{ ...styles.input, fontSize: 13, padding: '6px 8px' }}
                      type="text"
                      placeholder="e.g. .gallery img (selects all matching images)"
                      value={imagesSelector}
                      onChange={(e) => setImagesSelector(e.target.value)}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: 12 }}>
                    <button
                      style={{ ...styles.secondaryBtn, flex: 1 }}
                      onClick={handleTestSelectors}
                      disabled={testingSelectors}
                    >
                      {testingSelectors ? 'Testing Selectors...' : '🧪 Test Selectors'}
                    </button>
                    
                    <button
                      style={{ ...styles.primaryBtn, flex: 1 }}
                      onClick={handleSaveSelectorProfile}
                    >
                      💾 Save Selector Profile
                    </button>
                  </div>

                  {selectorTestError && (
                    <div style={{ marginTop: 12, padding: 8, background: '#fef2f2', border: '1px solid #fee2e2', borderRadius: 6, fontSize: 12, color: '#b91c1c' }}>
                      <strong>Test failed:</strong> {selectorTestError}
                    </div>
                  )}

                  {selectorTestResults && (
                    <div style={{ marginTop: 12, padding: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12 }}>
                      <strong style={{ display: 'block', marginBottom: 6, color: '#334155' }}>Test Extraction Results:</strong>
                      <ul style={{ margin: 0, paddingLeft: 16, color: '#475569', display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <li><strong>Title:</strong> {selectorTestResults.title || <span style={{ color: '#94a3b8' }}>not found</span>}</li>
                        <li><strong>Price:</strong> {selectorTestResults.price || <span style={{ color: '#94a3b8' }}>not found</span>}</li>
                        <li><strong>Brand:</strong> {selectorTestResults.brand || <span style={{ color: '#94a3b8' }}>not found</span>}</li>
                        <li><strong>Description:</strong> {selectorTestResults.description ? `${selectorTestResults.description.slice(0, 80)}...` : <span style={{ color: '#94a3b8' }}>not found</span>}</li>
                        <li><strong>Images found:</strong> {selectorTestResults.images?.length ?? 0}</li>
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* ─── STEP 2: FIELD EDITING ─── */}
              {reviewItem.status === 'needs_review' || reviewItem.status === 'ready' || reviewExtraction ? (
                <div style={styles.card}>
                  <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Step 2: Extracted Product Draft Details</h3>
                  
                  {curationFields.packagingOcrTitle && (
                    <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 6, fontSize: 13, color: '#5b21b6', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span>📷 Packaging OCR Title: <strong>"{curationFields.packagingOcrTitle}"</strong></span>
                      <button
                        type="button"
                        style={{ ...styles.secondaryBtn, padding: '2px 6px', fontSize: 11, background: '#fff', border: '1px solid #c084fc', color: '#7c3aed' }}
                        onClick={() => setCurationFields((p: any) => ({ ...p, curatedTitle: curationFields.packagingOcrTitle, titleSource: 'ocr' }))}
                      >
                        Use Packaging Title
                      </button>
                    </div>
                  )}

                  <div style={styles.fieldGroup}>
                    <label style={{ ...styles.label, color: '#6d28d9', fontWeight: 'bold' }}>Final Product Title (for Store Website)</label>
                    <input
                      style={{ ...styles.input, fontWeight: 'bold', borderColor: '#c084fc', background: '#faf5ff' }}
                      type="text"
                      value={curationFields.curatedTitle || ''}
                      onChange={(e) => setCurationFields((p: any) => ({ ...p, curatedTitle: e.target.value, titleSource: 'manual' }))}
                    />
                    <span style={{ fontSize: 11, color: '#6b7280', display: 'block', marginTop: 4 }}>
                      Title source: <strong style={{ color: '#7c3aed' }}>{curationFields.titleSource}</strong> (derived from OCR, Web scraping, or LLM)
                    </span>
                  </div>
                  
                  <div style={styles.fieldGroup}>
                    <label style={styles.label}>Raw Extracted Title (Reference)</label>
                    <input
                      style={{ ...styles.input, color: '#4b5563', background: '#f9fafb' }}
                      type="text"
                      value={editFields.title || ''}
                      onChange={(e) => setEditFields(p => ({ ...p, title: e.target.value }))}
                    />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div style={styles.fieldGroup}>
                      <label style={styles.label}>Brand Name</label>
                      <input
                        style={styles.input}
                        type="text"
                        value={editFields.brand || ''}
                        onChange={(e) => setEditFields(p => ({ ...p, brand: e.target.value }))}
                      />
                    </div>
                    
                    <div style={styles.fieldGroup}>
                      <label style={styles.label}>Price</label>
                      <input
                        style={styles.input}
                        type="text"
                        value={editFields.price || ''}
                        onChange={(e) => setEditFields(p => ({ ...p, price: e.target.value }))}
                      />
                    </div>
                  </div>

                  <div style={styles.fieldGroup}>
                    <label style={styles.label}>Product Description</label>
                    <textarea
                      style={{ ...styles.input, height: 100, fontFamily: 'inherit' }}
                      value={editFields.description || ''}
                      onChange={(e) => setEditFields(p => ({ ...p, description: e.target.value }))}
                    />
                  </div>

                  <div style={styles.fieldGroup}>
                    <label style={styles.label}>Assign Category Pages (ShopSite InThesePages)</label>
                    <div style={{ maxHeight: 120, overflowY: 'auto', border: '1px solid #d1d5db', borderRadius: 6, padding: 8, background: '#f9fafb' }}>
                      {storePages.length === 0 ? (
                        <span style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>
                          No pages available in page taxonomy. Define pages in settings or sync.
                        </span>
                      ) : (
                        storePages.map((pageName) => {
                          const isAssigned = curationFields.suggestedPages?.includes(pageName) ?? false;
                          return (
                            <label key={pageName} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={isAssigned}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setCurationFields((p: any) => ({
                                      ...p,
                                      suggestedPages: [...(p.suggestedPages || []), pageName]
                                    }));
                                  } else {
                                    setCurationFields((p: any) => ({
                                      ...p,
                                      suggestedPages: (p.suggestedPages || []).filter((name: string) => name !== pageName)
                                    }));
                                  }
                                }}
                              />
                              <span>{pageName}</span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <div style={styles.fieldGroup}>
                    <label style={styles.label}>Product Type Classification</label>
                    <input
                      style={styles.input}
                      type="text"
                      placeholder="e.g. Dry Dog Food, Supplements"
                      value={curationFields.suggestedProductType || ''}
                      onChange={(e) => setCurationFields((p: any) => ({ ...p, suggestedProductType: e.target.value }))}
                    />
                  </div>

                  {editFields.primaryImage && (
                    <div style={styles.fieldGroup}>
                      <label style={styles.label}>Extracted Images</label>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <div style={{ position: 'relative', border: '2px solid #2563eb', borderRadius: 4, overflow: 'hidden' }}>
                          <img
                            src={editFields.primaryImage.startsWith('products/') ? `/${editFields.primaryImage}` : editFields.primaryImage}
                            alt="Primary"
                            style={{ width: 80, height: 80, objectFit: 'cover' }}
                          />
                          <span style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: '#2563eb', color: '#fff', fontSize: 10, textAlign: 'center', fontWeight: 600 }}>Primary</span>
                        </div>
                        {editFields.additionalImages?.map((img, i) => (
                          <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 4, overflow: 'hidden' }}>
                            <img
                              src={img.startsWith('products/') ? `/${img}` : img}
                              alt={`Additional ${i}`}
                              style={{ width: 80, height: 80, objectFit: 'cover' }}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                                    {classificationProposals.length > 0 && (
                    <div style={{ marginTop: 16, padding: '12px 16px', background: '#f5f3ff', borderRadius: 8, border: '1px solid #ddd6fe' }}>
                      <h4 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: '#7c3aed' }}>🤖 AI Classification Proposals</h4>
                      {classificationProposals.map((p) => {
                        const sc = { pending: '#f59e0b', accepted: '#16a34a', rejected: '#dc2626', deferred: '#6b7280', stale: '#9ca3af' };
                        const tl = { primary_product_type: 'Product Type', category_page: 'Category Page', field_assignment: 'Field', configuration_gap: 'Config Gap', reviewable_abstention: 'Abstention' };
                        return (
                          <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #ede9fe', fontSize: 12 }}>
                            <div style={{ flex: 1 }}>
                              <span style={{ fontWeight: 600, color: '#5b21b6' }}>{(tl as any)[p.proposalType] || p.proposalType}</span>
                              {p.targetId && <span style={{ color: '#374151', marginLeft: 4 }}>{p.targetId}</span>}
                              <span style={{ color: (sc as any)[p.status], marginLeft: 8, fontWeight: 600 }}>● {p.status}</span>
                              {p.confidence > 0 && <span style={{ color: '#6b7280', marginLeft: 4, fontSize: 10 }}>{(p.confidence * 100).toFixed(0)}%</span>}
                              {p.isBulkAcceptable && <span style={{ background: '#dcfce7', color: '#16a34a', padding: '0 4px', borderRadius: 2, fontSize: 9, marginLeft: 4 }}>bulk</span>}
                            </div>
                            <div style={{ display: 'flex', gap: 3 }}>
                              <button type="button" style={{ padding: '2px 6px', fontSize: 10, borderRadius: 4, border: '1px solid #16a34a', background: p.status === 'accepted' ? '#dcfce7' : '#fff', color: '#16a34a', cursor: 'pointer' }} onClick={() => setClassificationProposals(prev => prev.map(x => x.id === p.id ? { ...x as any, status: 'accepted' } : x))}>Accept</button>
                              <button type="button" style={{ padding: '2px 6px', fontSize: 10, borderRadius: 4, border: '1px solid #dc2626', background: p.status === 'rejected' ? '#fee2e2' : '#fff', color: '#dc2626', cursor: 'pointer' }} onClick={() => setClassificationProposals(prev => prev.map(x => x.id === p.id ? { ...x as any, status: 'rejected' } : x))}>Reject</button>
                              <button type="button" style={{ padding: '2px 6px', fontSize: 10, borderRadius: 4, border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer' }} onClick={() => setClassificationProposals(prev => prev.map(x => x.id === p.id ? { ...x as any, status: 'deferred' } : x))}>Defer</button>
                            </div>
                          </div>
                        );
                      })}
                      {(() => { const safe = classificationProposals.filter(p => p.isBulkAcceptable && p.status === 'pending'); return safe.length > 0 ? (
                        <button type="button" style={{ marginTop: 8, padding: '4px 12px', fontSize: 11, borderRadius: 4, border: '1px solid #16a34a', background: '#dcfce7', color: '#16a34a', cursor: 'pointer', fontWeight: 600 }}
                          onClick={() => setClassificationProposals(prev => prev.map(x => x.isBulkAcceptable && x.status === 'pending' ? { ...x as any, status: 'accepted' } : x))}>
                          ✅ Bulk Accept {safe.length} Safe Proposal{safe.length > 1 ? 's' : ''}
                        </button>
                      ) : null; })()}
                      {classificationEvidence.length > 0 && (
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ fontSize: 11, color: '#6b7280', cursor: 'pointer' }}>Evidence ({classificationEvidence.length} items)</summary>
                          <div style={{ marginTop: 2, maxHeight: 150, overflowY: 'auto', fontSize: 10 }}>
                            {classificationEvidence.slice(0, 20).map((e: any) => (
                              <div key={e.id} style={{ padding: '2px 4px', color: '#4b5563', borderBottom: '1px solid #f3f4f6' }}>
                                <strong>{e.source}</strong>: {(e.snippet || '').slice(0, 80)}
                                {e.reliability && <span style={{ color: '#9ca3af', marginLeft: 4 }}>({e.reliability})</span>}
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  )}

<div style={{ ...styles.btnRow, marginTop: 24, justifyContent: 'flex-end' }}>
                    <button style={styles.secondaryBtn} onClick={handleCloseReview}>Cancel</button>
                    <button
                      style={{ ...styles.primaryBtn, background: '#16a34a' }}
                      onClick={handleSaveItemEdit}
                    >
                      ✓ Save & Approve Draft
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ textAlign: 'center', padding: 24, color: '#9ca3af', fontStyle: 'italic' }}>
                  No product page data scraped yet. Confirmed source URL is needed to run extraction.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

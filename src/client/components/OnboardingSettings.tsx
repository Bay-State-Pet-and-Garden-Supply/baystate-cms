import React, { useState, useEffect } from 'react';
import {
  getApiKeys,
  updateApiKey,
  deleteApiKey,
  getDeepseekModels,
  getOllamaModels,
  getOpenaiModels,
  getCurationTargets,
  saveCurationTargets,
  syncClassificationSeed,
  updateAttributeProfile,
  updateClassificationAttribute,
  getClassificationReadiness,

  type ApiKeyDisplay,
  type CurationTargetsResponse,
} from '../onboarding-api';
import { downloadPagesImport, activatePagesImport } from '../api';
import { readinessViewFromReport } from '../classification-readiness-view';
import type { CurationTargetConfig } from '../../shared/schemas/classification';
import { LlmTaskConfigPanel } from './LlmTaskConfigPanel';
import { LocalAiStatusPanel } from './LocalAiStatusPanel';
import { ProfileBuilder } from './profile-builder/ProfileBuilder';
import { getExtractionWorkerHealth } from '../onboarding-api';
import type { WorkerHealthResponse } from '../../shared/schemas/extraction-worker';
import { ViewHeader } from './common/ViewHeader';
import { colors } from '../theme';

type OnboardingSettingsTab = 'general' | 'llm' | 'curation' | 'profiles';

interface OnboardingSettingsProps {
  onBack: () => void;
  /** Initial tab to open (deep-linked, e.g. `?view=onboarding&settingsTab=curation`). */
  initialTab?: OnboardingSettingsTab;
}

function targetSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(slug) ? slug : `target-${slug || 'field'}`;
}

export function OnboardingSettings({ onBack, initialTab }: OnboardingSettingsProps) {
  const [keys, setKeys] = useState<ApiKeyDisplay[]>([]);
  const [_loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Provider key states
  const [serperKey, setSerperKey] = useState('');
  const [deepseekKey, setDeepseekKey] = useState('');
  const [deepseekBaseUrl, setDeepseekBaseUrl] = useState('');
  const [deepseekModel, setDeepseekModel] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
  const [openaiModel, setOpenaiModel] = useState('');
  const [ollamaKey, setOllamaKey] = useState('ollama-default');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState('http://localhost:11434/v1');
  const [ollamaModel, setOllamaModel] = useState('llama3');

  // Model lists
  const [deepseekModels, setDeepseekModels] = useState<string[]>([]);
  const [loadingDeepseekModels, setLoadingDeepseekModels] = useState(false);
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [loadingOpenaiModels, setLoadingOpenaiModels] = useState(false);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [loadingOllamaModels, setLoadingOllamaModels] = useState(false);

  // VLM states
  const [vlmEnabled, setVlmEnabled] = useState(false);
  const [vlmModel, setVlmModel] = useState('qwen2.5vl:latest');

  // Manager-selected curation classification targets.
  const [curationTargetState, setCurationTargetState] = useState<CurationTargetsResponse | null>(null);
  const [curationTargetsDraft, setCurationTargetsDraft] = useState<CurationTargetConfig[]>([]);
  const [curationTargetsLoading, setCurationTargetsLoading] = useState(false);
  const [curationTargetsSaving, setCurationTargetsSaving] = useState(false);
  // Classification readiness for the curation targets section.
  const [readinessView, setReadinessView] = useState<ReturnType<typeof readinessViewFromReport> | null>(null);

  // Lens & Curation Applicability UI states (PR5 C3-C7)
  const [curationViewMode, setCurationViewMode] = useState<'global' | 'by_product_type'>('global');
  const [selectedProductTypeId, setSelectedProductTypeId] = useState<string>('');
  const [showNonApplicable, setShowNonApplicable] = useState<boolean>(false);
  const [expandedAppliesToField, setExpandedAppliesToField] = useState<string | null>(null);
  const [inspectedCatalogField, setInspectedCatalogField] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState<boolean>(false);
  const [profileEditsDraft, setProfileEditsDraft] = useState<
    Record<string, { included: boolean; required: boolean; cardinality: 'single' | 'multiple' }>
  >({});
  const [savingProfile, setSavingProfile] = useState<boolean>(false);

  // Worker health & profile builder overlay state
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthResponse | null>(null);
  const [workspaceDomain, setWorkspaceDomain] = useState<string | null>(null);

  const [localDomain, setLocalDomain] = useState('');
  const [settingsTab, setSettingsTab] = useState<OnboardingSettingsTab>(initialTab ?? 'general');

  // ─── Model fetchers ─────────────────────────────────────────────────────

  const loadDeepseekModels = async (keyVal?: string) => {
    const key = keyVal || deepseekKey;
    if (!key || key.startsWith('••••')) return;
    setLoadingDeepseekModels(true);
    try {
      const res = await getDeepseekModels(key, deepseekBaseUrl);
      setDeepseekModels(res.models);
      if (res.models.length > 0 && !deepseekModel) {
        setDeepseekModel(res.models[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDeepseekModels(false);
    }
  };

  const loadOpenaiModels = async (keyVal?: string) => {
    const key = keyVal || openaiKey;
    if (!key || key.startsWith('••••')) return;
    setLoadingOpenaiModels(true);
    try {
      const res = await getOpenaiModels(key, openaiBaseUrl);
      setOpenaiModels(res.models);
      if (res.models.length > 0 && !openaiModel) {
        setOpenaiModel(res.models[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOpenaiModels(false);
    }
  };

  const loadOllamaModels = async (baseUrlVal?: string) => {
    const baseUrl = baseUrlVal || ollamaBaseUrl;
    setLoadingOllamaModels(true);
    try {
      const res = await getOllamaModels(baseUrl);
      setOllamaModels(res.models);
      if (res.models.length > 0 && !ollamaModel) {
        setOllamaModel(res.models[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingOllamaModels(false);
    }
  };

  // ─── Data loading ───────────────────────────────────────────────────────

  const loadCurationTargets = async () => {
    setCurationTargetsLoading(true);
    try {
      const res = await getCurationTargets();
      setCurationTargetState(res);
      setCurationTargetsDraft(res.targets);
      if (res.candidates.productTypes.length > 0 && !selectedProductTypeId) {
        setSelectedProductTypeId(res.candidates.productTypes[0].value);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCurationTargetsLoading(false);
    }
    try {
      const readiness = await getClassificationReadiness();
      setReadinessView(readinessViewFromReport(readiness.readiness));
    } catch {
      setReadinessView(readinessViewFromReport(null));
    }
  };

  const startEditingProfile = () => {
    if (!curationTargetState || !selectedProductTypeId) return;
    const initialDraft: Record<string, { included: boolean; required: boolean; cardinality: 'single' | 'multiple' }> = {};
    for (const item of curationTargetState.applicability) {
      if (!item.attributeId) continue;
      const isUniversal = item.scope === 'universal';
      const profileMatch = item.productTypes.find(pt => pt.productTypeId === selectedProductTypeId);
      initialDraft[item.attributeId] = {
        included: isUniversal || !!profileMatch,
        required: profileMatch?.required ?? false,
        cardinality: profileMatch?.cardinality ?? 'single',
      };
    }
    setProfileEditsDraft(initialDraft);
    setEditingProfile(true);
  };

  const handleSaveProfileEdits = async () => {
    if (!selectedProductTypeId) return;
    setSavingProfile(true);
    setError('');
    try {
      const edits = Object.entries(profileEditsDraft).map(([attributeId, state]) => ({
        attributeId,
        included: state.included,
        required: state.required,
        cardinality: state.cardinality,
      }));
      await updateAttributeProfile(selectedProductTypeId, edits);
      setEditingProfile(false);
      await loadCurationTargets();
      alert('Product Type attribute profile saved successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProfile(false);
    }
  };

  const targetForField = (catalogField: string) =>
    curationTargetsDraft.find(t => t.kind === 'product_field' && t.catalogField === catalogField);

  const upsertCurationTarget = (target: CurationTargetConfig) => {
    setCurationTargetsDraft(prev => {
      const idx = prev.findIndex(t => t.id === target.id || (target.kind === 'product_field' && t.catalogField === target.catalogField) || (target.kind === t.kind && target.kind !== 'product_field'));
      if (idx === -1) return [...prev, { ...target, sortOrder: prev.length }];
      const next = [...prev];
      next[idx] = { ...next[idx], ...target };
      return next.map((t, i) => ({ ...t, sortOrder: i }));
    });
  };

  const removeCurationTarget = (predicate: (target: CurationTargetConfig) => boolean) => {
    setCurationTargetsDraft(prev => prev.filter(target => !predicate(target)).map((target, index) => ({ ...target, sortOrder: index })));
  };

  const handleSaveCurationTargets = async () => {
    setCurationTargetsSaving(true);
    setError('');
    try {
      const res = await saveCurationTargets(curationTargetsDraft);
      setCurationTargetState(res);
      setCurationTargetsDraft(res.targets);
      alert('Curation targets saved. New curation runs will use this target list.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCurationTargetsSaving(false);
    }
  };

  const handleToggleUniversal = async (attributeId: string, makeUniversal: boolean) => {
    setCurationTargetsSaving(true);
    setError('');
    try {
      const res = await updateClassificationAttribute(attributeId, { isUniversal: makeUniversal });
      const updatedTargets = await getCurationTargets();
      setCurationTargetState(updatedTargets);
      setCurationTargetsDraft(updatedTargets.targets);
      alert(`Attribute updated to ${makeUniversal ? 'Universal (applies to ALL products)' : 'Profiled (scoped to product types)'}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCurationTargetsSaving(false);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    setError('');
    try {
      const keysRes = await getApiKeys();

      setKeys(keysRes.keys);

      void loadCurationTargets();

      // Populate form fields from DB
      const serper = keysRes.keys.find(k => k.service === 'serper');
      if (serper) setSerperKey(serper.apiKey);

      const deepseek = keysRes.keys.find(k => k.service === 'deepseek');
      if (deepseek) {
        setDeepseekKey(deepseek.apiKey);
        setDeepseekBaseUrl(deepseek.baseUrl || 'https://api.deepseek.com');
        setDeepseekModel(deepseek.model || 'deepseek-v4-flash');
        if (deepseek.apiKey && !deepseek.apiKey.startsWith('••••')) {
          getDeepseekModels(deepseek.apiKey, deepseek.baseUrl || 'https://api.deepseek.com')
            .then(res => setDeepseekModels(res.models)).catch(() => { });
        }
      }

      const openai = keysRes.keys.find(k => k.service === 'openai');
      if (openai) {
        setOpenaiKey(openai.apiKey);
        setOpenaiBaseUrl(openai.baseUrl || 'https://api.openai.com/v1');
        setOpenaiModel(openai.model || 'gpt-4o-mini');
        if (openai.apiKey && !openai.apiKey.startsWith('••••')) {
          getOpenaiModels(openai.apiKey, openai.baseUrl || 'https://api.openai.com/v1')
            .then(res => setOpenaiModels(res.models)).catch(() => { });
        }
      }

      const ollama = keysRes.keys.find(k => k.service === 'ollama');
      if (ollama) {
        setOllamaKey(ollama.apiKey);
        setOllamaBaseUrl(ollama.baseUrl || 'http://localhost:11434/v1');
        setOllamaModel(ollama.model || 'llama3');
        getOllamaModels(ollama.baseUrl || 'http://localhost:11434/v1')
          .then(res => setOllamaModels(res.models)).catch(() => { });
      }

      const ollamaVlm = keysRes.keys.find(k => k.service === 'ollama_vlm');
      if (ollamaVlm) {
        setVlmEnabled(ollamaVlm.apiKey === 'enabled');
        setVlmModel(ollamaVlm.model || 'qwen2.5vl:latest');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Fetch extraction worker health on mount
  useEffect(() => {
    getExtractionWorkerHealth().then(setWorkerHealth).catch(() => setWorkerHealth(null));
  }, []);

  // ─── Handlers ──────────────────────────────────────────────────────────

  const handleSaveApiKey = async (service: string, keyVal: string, base?: string, model?: string) => {
    if (!keyVal || keyVal.startsWith('••••')) {
      alert('Please enter a valid API key (the current value appears to be masked).');
      return;
    }
    setError('');
    try {
      await updateApiKey(service, keyVal, base || null, model || null);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteApiKey = async (service: string) => {
    if (!confirm(`Are you sure you want to delete API settings for ${service}?`)) return;
    setError('');
    try {
      await deleteApiKey(service);
      alert(`API Settings for ${service} cleared.`);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const [syncingSeed, setSyncingSeed] = useState(false);

  const handleSyncSeed = async () => {
    if (!confirm('Sync latest taxonomy seed (60+ Product Types across 10 Departments) into your workspace?')) return;
    setSyncingSeed(true);
    setError('');
    try {
      const res = await syncClassificationSeed();
      setCurationTargetState(res);
      alert(`Taxonomy seed synchronized! ${res.candidates.productTypes.length} Product Types active.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingSeed(false);
    }
  };

  const [syncingPages, setSyncingPages] = useState(false);

  const handleSyncPages = async () => {
    if (!confirm('Download the live Pages database from ShopSite and activate it as the verified page import?')) return;
    setSyncingPages(true);
    setError('');
    try {
      const res = await downloadPagesImport();
      const preview = res.preview;
      await activatePagesImport({
        sourceHash: preview.sourceHash,
        parserFormatVersion: preview.parserFormatVersion,
        records: preview.records,
      });
      const warningNote = preview.warnings.length > 0 ? ` · ${preview.warnings.length} name-only excluded` : '';
      alert(`Pages synced! ${preview.counts.verified} verified pages activated from ShopSite${warningNote}.`);
      await loadCurationTargets();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncingPages(false);
    }
  };

  // ─── Shared styles ──────────────────────────────────────────────────────

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    title: { fontSize: 24, fontWeight: 600, margin: 0 },
    backBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 14 },
    section: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24, marginBottom: 24 },
    sectionTitle: { fontSize: 18, fontWeight: 600, margin: '0 0 16px 0', color: '#111827' },
    subsection: { border: '1px solid #e5e7eb', borderRadius: 6, padding: 16, marginBottom: 12 },
    subsectionHeader: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
    providerBadge: {
      display: 'inline-block',
      fontSize: 10,
      fontWeight: 700,
      padding: '2px 8px',
      borderRadius: 3,
      textTransform: 'uppercase' as const,
    },
    formGroup: { marginBottom: 12 },
    label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#4b5563', marginBottom: 6 },
    input: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' as const },
    select: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' as const, background: '#fff' },
    inputRow: { display: 'flex', gap: 8 },
    buttonRow: { display: 'flex', gap: 12, marginTop: 12 },
    primaryBtn: { background: colors.uniformGreen, color: colors.feedBagCream, border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 },
    secondaryBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13 },
    deleteBtn: { background: 'none', border: '1px solid #dc2626', color: '#dc2626', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 },
    table: { width: '100%', borderCollapse: 'collapse' as const, marginTop: 12, fontSize: 14 },
    th: { borderBottom: '2px solid #e5e7eb', textAlign: 'left' as const, padding: '8px 12px', color: '#4b5563', fontWeight: 600 },
    td: { borderBottom: '1px solid #e5e7eb', padding: '8px 12px' },
    error: { color: '#dc2626', padding: 12, background: '#fef2f2', borderRadius: 6, marginBottom: 20, fontSize: 14 },
    hint: { fontSize: 13, color: '#6b7280', margin: '0 0 16px' },
    savedHint: { fontSize: 12, color: '#16a34a', margin: '4px 0 0' },
    checkboxLabel: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#4b5563' },
    empty: { fontSize: 14, color: '#9ca3af', fontStyle: 'italic' as const },
  };

  const savedKey = (service: string) => keys.find(k => k.service === service);

  // ─── Provider subsection renderer ───────────────────────────────────────

  const renderProviderSubsection = (
    label: string,
    color: string,
    service: string,
    keyState: string,
    setKeyState: (v: string) => void,
    baseUrlState: string,
    setBaseUrlState: (v: string) => void,
    modelState: string,
    setModelState: (v: string) => void,
    models: string[],
    loadingModels: boolean,
    loadModels: () => void,
    defaultModel: string,
    keyPlaceholder: string,
    needsKey: boolean,
  ) => {
    const isSaved = !!savedKey(service);
    return (
      <div key={service} style={styles.subsection}>
        <div style={styles.subsectionHeader}>
          <span style={{ ...styles.providerBadge, background: color }}>{label}</span>
          {isSaved && <span style={{ fontSize: 12, color: '#16a34a' }}>✓ Configured</span>}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {needsKey && (
            <div style={styles.formGroup}>
              <label style={styles.label}>API Key</label>
              <input
                style={styles.input}
                type="password"
                placeholder={keyPlaceholder}
                value={keyState.startsWith('••••') ? '' : keyState}
                onChange={(e) => setKeyState(e.target.value)}
              />
            </div>
          )}
          <div style={styles.formGroup}>
            <label style={styles.label}>Base URL</label>
            <input
              style={styles.input}
              type="text"
              value={baseUrlState}
              onChange={(e) => setBaseUrlState(e.target.value)}
            />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'end' }}>
          <div style={styles.formGroup}>
            <label style={styles.label}>Model</label>
            <div style={styles.inputRow}>
              <select
                style={{ ...styles.select, flex: 1 }}
                value={modelState}
                onChange={(e) => setModelState(e.target.value)}
                disabled={loadingModels}
              >
                {models.length === 0 ? (
                  <option value={defaultModel}>{defaultModel} (default)</option>
                ) : (
                  models.map(m => <option key={m} value={m}>{m}</option>)
                )}
              </select>
              <button
                style={styles.secondaryBtn}
                onClick={loadModels}
                disabled={loadingModels || (needsKey && (!keyState || keyState.startsWith('••••')))}
              >
                {loadingModels ? 'Loading…' : 'Fetch'}
              </button>
            </div>
          </div>
        </div>
        <div style={styles.buttonRow}>
          <button
            style={styles.primaryBtn}
            onClick={() => handleSaveApiKey(service, keyState, baseUrlState, modelState)}
          >
            Save {label}
          </button>
          {isSaved && (
            <button
              style={styles.deleteBtn}
              onClick={() => handleDeleteApiKey(service)}
            >
              Delete
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={styles.container}>
      <ViewHeader
        title="Onboarding Pipeline Settings"
        description="Configure discovery sources, AI model routing, curation targets, and site extractor profiles."
        actions={<button style={styles.backBtn} onClick={onBack}>← Back to Batches</button>}
      />

      {error && <div style={styles.error}>{error}</div>}

      {/* ─── Tab Bar ─── */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '1px solid #dee2e6' }}>
        {[
          { id: 'general', label: 'General' },
          { id: 'llm', label: 'LLM Providers' },
          { id: 'curation', label: 'Curation' },
          { id: 'profiles', label: 'Extractor Profiles' },
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => setSettingsTab(tab.id as any)}
            style={{
              padding: '10px 20px',
              border: 'none',
              background: settingsTab === tab.id ? '#fff' : 'transparent',
              borderBottom: settingsTab === tab.id ? '2px solid #007bff' : '2px solid transparent',
              fontWeight: settingsTab === tab.id ? 600 : 400,
              cursor: 'pointer',
              fontSize: 14,
              color: settingsTab === tab.id ? '#007bff' : '#495057',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div style={{ display: settingsTab === 'general' ? 'block' : 'none' }}>
      {/* ─── SOURCE DISCOVERY ─── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Source Discovery</h2>
        <div style={styles.formGroup}>
          <label style={styles.label}>Serper.dev API Key (Google Search API)</label>
          <input
            style={styles.input}
            type="password"
            placeholder="Enter Serper.dev API key"
            value={serperKey.startsWith('••••') ? '' : serperKey}
            onChange={(e) => setSerperKey(e.target.value)}
          />
          {savedKey('serper') && (
            <p style={styles.savedHint}>✓ API key configured: {savedKey('serper')?.apiKey}</p>
          )}
        </div>
        <div style={styles.buttonRow}>
          <button
            style={styles.primaryBtn}
            onClick={() => handleSaveApiKey('serper', serperKey)}
          >
            Save Serper Key
          </button>
          <button
            style={styles.deleteBtn}
            onClick={() => handleDeleteApiKey('serper')}
          >
            Delete Key
          </button>
        </div>
      </div>
      </div>

      <div style={{ display: settingsTab === 'llm' ? 'block' : 'none' }}>
      {/* ─── LLM PROVIDERS ─── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>LLM Providers</h2>
        <p style={styles.hint}>
          Configure API keys and default models for each language model provider. Provider
          credentials are used by the Model Routing section below to direct tasks to the
          correct model.
        </p>

        {renderProviderSubsection(
          'DeepSeek', '#1e40af', 'deepseek',
          deepseekKey, setDeepseekKey,
          deepseekBaseUrl, setDeepseekBaseUrl,
          deepseekModel, setDeepseekModel,
          deepseekModels, loadingDeepseekModels,
          () => loadDeepseekModels(deepseekKey),
          'deepseek-v4-flash', 'sk-...', true,
        )}

        {renderProviderSubsection(
          'OpenAI', '#10a37f', 'openai',
          openaiKey, setOpenaiKey,
          openaiBaseUrl, setOpenaiBaseUrl,
          openaiModel, setOpenaiModel,
          openaiModels, loadingOpenaiModels,
          () => loadOpenaiModels(openaiKey),
          'gpt-4o-mini', 'sk-...', true,
        )}

        {renderProviderSubsection(
          'Ollama', '#6366f1', 'ollama',
          ollamaKey, setOllamaKey,
          ollamaBaseUrl, setOllamaBaseUrl,
          ollamaModel, setOllamaModel,
          ollamaModels, loadingOllamaModels,
          () => loadOllamaModels(ollamaBaseUrl),
          'llama3.2:3b', 'ollama-default', false,
        )}

        {/* ─── Ollama VLM ─── */}
        <div style={{ ...styles.subsection, marginBottom: 0 }}>
          <div style={styles.subsectionHeader}>
            <span style={{ ...styles.providerBadge, background: '#9333ea' }}>Ollama VLM</span>
            <span style={{ fontSize: 12, color: '#6b7280' }}>Packaging OCR</span>
            {vlmEnabled && savedKey('ollama_vlm') && (
              <span style={{ fontSize: 12, color: '#16a34a' }}>✓ Enabled</span>
            )}
          </div>
          <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px' }}>
            Uses a local vision model (e.g. Qwen2.5-VL) to perform OCR on product packaging
            images, aligning CMS product titles with the physical package.
          </p>
          <div style={styles.formGroup}>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={vlmEnabled}
                onChange={(e) => setVlmEnabled(e.target.checked)}
              />
              Enable packaging title OCR via local VLM
            </label>
          </div>
          {vlmEnabled && (
            <>
              <div style={styles.formGroup}>
                <label style={styles.label}>Vision Model</label>
                <select
                  style={styles.select}
                  value={vlmModel}
                  onChange={(e) => setVlmModel(e.target.value)}
                >
                  {ollamaModels.length === 0 ? (
                    <>
                      <option value="qwen2.5vl:latest">qwen2.5vl:latest</option>
                      <option value="glm-ocr:latest">glm-ocr:latest</option>
                    </>
                  ) : (
                    ollamaModels.map(m => <option key={m} value={m}>{m}</option>)
                  )}
                </select>
              </div>
              <div style={styles.buttonRow}>
                <button
                  style={styles.primaryBtn}
                  onClick={() => handleSaveApiKey('ollama_vlm', 'enabled', ollamaBaseUrl, vlmModel)}
                >
                  Save Vision Settings
                </button>
              </div>
            </>
          )}
          {!vlmEnabled && savedKey('ollama_vlm') && (
            <div style={styles.buttonRow}>
              <button
                style={styles.deleteBtn}
                onClick={() => {
                  handleDeleteApiKey('ollama_vlm');
                  setVlmEnabled(false);
                }}
              >
                Disable Vision Settings
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ─── AI MODEL ROUTING ─── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>AI Model Routing</h2>
        <p style={styles.hint}>
          Configure which AI model handles each task. Provider credentials live in the
          LLM Providers section above. Profile generation and revision are required to be
          configured explicitly — the system will not silently fall back to another model.
        </p>
        <LocalAiStatusPanel />
        <LlmTaskConfigPanel onChange={() => setError('')} />
      </div>
      </div>

      <div style={{ display: settingsTab === 'curation' ? 'block' : 'none' }}>
      {/* ─── CURATION TARGETS ─── */}
      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h2 style={{ ...styles.sectionTitle, margin: 0 }}>
            {curationViewMode === 'global' ? 'Global Curation Targets' : 'Curation by Product Type'}
          </h2>
          <div style={{ display: 'flex', gap: 8 }}>
            {curationViewMode === 'global' ? (
              <>
                <button type="button" style={styles.secondaryBtn} onClick={loadCurationTargets} disabled={curationTargetsLoading}>
                  {curationTargetsLoading ? 'Refreshing…' : 'Refresh'}
                </button>
                <button type="button" style={styles.primaryBtn} onClick={handleSaveCurationTargets} disabled={curationTargetsSaving}>
                  {curationTargetsSaving ? 'Saving…' : 'Save Targets'}
                </button>
              </>
            ) : (
              <>
                {!editingProfile ? (
                  <button type="button" style={styles.primaryBtn} onClick={startEditingProfile} disabled={!selectedProductTypeId}>
                    Edit Profile
                  </button>
                ) : (
                  <>
                    <button type="button" style={styles.secondaryBtn} onClick={() => setEditingProfile(false)} disabled={savingProfile}>
                      Cancel
                    </button>
                    <button type="button" style={styles.primaryBtn} onClick={handleSaveProfileEdits} disabled={savingProfile}>
                      {savingProfile ? 'Saving…' : 'Save Profile Edits'}
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {/* View Lens Navigation */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 14, borderBottom: '1px solid #e5e7eb', paddingBottom: 10 }}>
          <button
            type="button"
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
              background: curationViewMode === 'global' ? '#2563eb' : '#f3f4f6',
              color: curationViewMode === 'global' ? '#fff' : '#4b5563',
            }}
            onClick={() => setCurationViewMode('global')}
          >
            Global Targets
          </button>
          <button
            type="button"
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              border: 'none',
              cursor: 'pointer',
              background: curationViewMode === 'by_product_type' ? '#2563eb' : '#f3f4f6',
              color: curationViewMode === 'by_product_type' ? '#fff' : '#4b5563',
            }}
            onClick={() => {
              setCurationViewMode('by_product_type');
              if (curationTargetState?.candidates.productTypes.length && !selectedProductTypeId) {
                setSelectedProductTypeId(curationTargetState.candidates.productTypes[0].value);
              }
            }}
          >
            By Product Type
          </button>

          <button
            type="button"
            disabled={syncingSeed}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              border: '1px solid #d1d5db',
              cursor: syncingSeed ? 'not-allowed' : 'pointer',
              background: '#ffffff',
              color: '#374151',
              marginLeft: 'auto',
            }}
            onClick={handleSyncSeed}
            title="Synchronize the latest 60+ product types & taxonomy seed into active workspace"
          >
            {syncingSeed ? 'Syncing Taxonomy…' : '🔄 Sync Seed Taxonomy'}
          </button>
        </div>

        <p style={styles.hint}>
          {curationViewMode === 'global'
            ? 'Enable the outputs Curation is allowed to populate. Product-field targets are further restricted by the current Product Type\'s Attribute Profile.'
            : 'Inspect and edit effective curation attributes for each Product Type. Profile entries define per-type applicability, cardinality, and required state.'}
        </p>

        {curationViewMode === 'global' && (
          <div style={{ marginBottom: 14, padding: 12, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 13 }}>
            <div style={{ color: '#1e40af', fontWeight: 600, marginBottom: 2 }}>
              ℹ️ Managing Curation in v2 Workspaces
            </div>
            <div style={{ color: '#1e3a8a', lineHeight: 1.4 }}>
              In v2 classification workspaces, field targets and attribute requirements are managed per Product Type via the{' '}
              <button
                type="button"
                onClick={() => {
                  setCurationViewMode('by_product_type');
                  if (curationTargetState?.candidates.productTypes.length && !selectedProductTypeId) {
                    setSelectedProductTypeId(curationTargetState.candidates.productTypes[0].value);
                  }
                }}
                style={{ background: 'none', border: 'none', color: '#2563eb', textDecoration: 'underline', cursor: 'pointer', fontWeight: 600, padding: 0 }}
              >
                By Product Type
              </button>{' '}
              tab, or globally via field mappings in Catalog Workbench.
            </div>
          </div>
        )}

        {/* Configuration Health Findings (C5) */}
        {curationTargetState?.findings && curationTargetState.findings.length > 0 && (
          <div style={{ marginBottom: 14, padding: 12, background: '#fffbe8', border: '1px solid #fde047', borderRadius: 8, fontSize: 13 }}>
            <div style={{ color: '#854d0e', fontWeight: 600, marginBottom: 4 }}>
              ⚠ Configuration Health Findings ({curationTargetState.findings.length})
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, color: '#713f12' }}>
              {curationTargetState.findings.map((f, idx) => (
                <li key={idx} style={{ marginBottom: 2 }}>
                  <code style={{ fontSize: 11, background: '#fef08a', padding: '1px 4px', borderRadius: 4 }}>{f.code}</code> {f.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {readinessView && !readinessView.isReady && (
          <div style={{ marginBottom: 12, padding: 12, background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 8, fontSize: 13 }}>
            <div style={{ color: '#9a3412', fontWeight: 600 }}>⚠ Classification is not ready</div>
            {readinessView.capabilities.page.reason && (
              <div style={{ color: '#7c2d12', marginTop: 2 }}>Category Pages: {readinessView.capabilities.page.reason}</div>
            )}
            <div style={{ color: '#7c2d12', marginTop: 2 }}>{readinessView.summary.join(' ')}</div>
          </div>
        )}

        {!curationTargetState ? (
          <p style={styles.empty}>{curationTargetsLoading ? 'Loading curation targets…' : 'No curation target data loaded yet.'}</p>
        ) : curationViewMode === 'global' ? (
          /* GLOBAL TARGETS LENS */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={styles.subsection}>
              <div style={styles.subsectionHeader}>
                <span style={{ ...styles.providerBadge, background: '#7c3aed', color: '#fff' }}>Pages</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{curationTargetState.candidates.pages.length} synced pages</span>
                <button
                  type="button"
                  disabled={syncingPages}
                  onClick={handleSyncPages}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    border: '1px solid #d1d5db',
                    background: '#f9fafb',
                    color: '#374151',
                    cursor: syncingPages ? 'not-allowed' : 'pointer',
                    opacity: syncingPages ? 0.6 : 1,
                  }}
                >
                  {syncingPages ? 'Syncing…' : 'Sync pages from ShopSite'}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>Always enabled · Multi-select</span>
              </div>
            </div>
            <div style={styles.subsection}>
              <div style={styles.subsectionHeader}>
                <span style={{ ...styles.providerBadge, background: '#2563eb', color: '#fff' }}>Product Fields</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{curationTargetState.candidates.productFields.length} custom fields from field registry</span>
              </div>
              {curationTargetState.candidates.productFields.length === 0 ? (
                <p style={styles.empty}>No ProductField entries are available yet. Sync products from ShopSite first.</p>
              ) : (
                <>
                  <table style={styles.table}>
                    <thead>
                      <tr>
                        <th style={styles.th}>Curate</th>
                        <th style={styles.th}>Field</th>
                        <th style={styles.th}>Attribute</th>
                        <th style={styles.th}>Input type</th>
                        <th style={styles.th}>Applies to</th>
                        <th style={styles.th}>Configuration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {curationTargetState.candidates.productFields
                        .filter(field => field.catalogField !== 'ProductField16')
                        .map(field => {
                          const target = targetForField(field.catalogField);
                          const checked = !!target?.enabled;
                          const appl = curationTargetState.applicability?.find(a => a.catalogField === field.catalogField);
                          const isInspected = inspectedCatalogField === field.catalogField;
                          const isControlled = appl?.valueMode === 'controlled';

                          return (
                            <React.Fragment key={field.catalogField}>
                              <tr>
                                <td style={styles.td}>
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        upsertCurationTarget({
                                          id: target?.id ?? targetSlug(`target-${field.catalogField}`),
                                          kind: 'product_field',
                                          label: field.label,
                                          mandatory: target?.mandatory ?? false,
                                          enabled: true,
                                          selectionMode: target?.selectionMode ?? 'single',
                                          attributeId: target?.attributeId ?? field.attributeId ?? targetSlug(`field-${field.catalogField}`),
                                          catalogField: field.catalogField,
                                          optionSource: isControlled ? (target?.optionSource ?? 'live_store') : 'configured',
                                          required: false,
                                          sortOrder: target?.sortOrder ?? curationTargetsDraft.length,
                                        });
                                       } else if (target) {
                                         upsertCurationTarget({
                                           ...target,
                                           enabled: false,
                                         });
                                       } else {
                                         removeCurationTarget(t => t.kind === 'product_field' && t.catalogField === field.catalogField);
                                       }
                                    }}
                                  />
                                </td>
                                <td style={styles.td}>
                                  <strong>{field.label}</strong>
                                  <div style={{ fontSize: 11, color: '#6b7280' }}>{field.catalogField}</div>
                                </td>
                                <td style={styles.td}>
                                  {appl?.attributeName ? (
                                    <button
                                      type="button"
                                      onClick={() => setInspectedCatalogField(isInspected ? null : field.catalogField)}
                                      style={{ background: 'none', border: 'none', padding: 0, textAlign: 'left', cursor: 'pointer' }}
                                    >
                                      <span style={{ fontWeight: 600, fontSize: 12, color: '#2563eb', textDecoration: 'underline' }}>
                                        {appl.attributeName}
                                      </span>
                                      <div style={{ fontSize: 10, color: '#6b7280', fontFamily: 'monospace' }}>{appl.attributeId}</div>
                                    </button>
                                  ) : (
                                    <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>Unmapped</span>
                                  )}
                                </td>
                                <td style={styles.td}>
                                  {appl?.valueMode === 'controlled' ? (
                                    <span style={{ background: '#e0e7ff', color: '#3730a3', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                                      Select
                                    </span>
                                  ) : appl?.valueMode === 'measured' ? (
                                    <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                                      Measurement
                                    </span>
                                  ) : appl?.valueMode === 'freeText' ? (
                                    <span style={{ background: '#f3f4f6', color: '#374151', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                                      Free text
                                    </span>
                                  ) : (
                                    <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>—</span>
                                  )}
                                </td>
                                <td style={styles.td}>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                                    {appl?.scope === 'universal' ? (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ background: '#dcfce7', color: '#166534', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600 }}>
                                          Universal
                                        </span>
                                        {appl?.attributeId && (
                                          <button
                                            type="button"
                                            disabled={curationTargetsSaving}
                                            onClick={() => handleToggleUniversal(appl.attributeId!, false)}
                                            title="Click to change attribute scope to Profiled (scoped to specific Product Types)"
                                            style={{ background: '#ffffff', color: '#4b5563', border: '1px solid #d1d5db', borderRadius: 6, padding: '1px 6px', fontSize: 10, fontWeight: 500, cursor: curationTargetsSaving ? 'not-allowed' : 'pointer' }}
                                          >
                                            Set Profiled
                                          </button>
                                        )}
                                      </div>
                                    ) : appl?.scope === 'profiled' ? (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                          <button
                                            type="button"
                                            onClick={() => setExpandedAppliesToField(expandedAppliesToField === field.catalogField ? null : field.catalogField)}
                                            style={{ background: '#eff6ff', color: '#1e40af', border: '1px solid #bfdbfe', borderRadius: 12, padding: '2px 8px', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
                                          >
                                            {appl.productTypes.length} product {appl.productTypes.length === 1 ? 'type' : 'types'} {expandedAppliesToField === field.catalogField ? '▲' : '▼'}
                                          </button>
                                          {appl?.attributeId && (
                                            <button
                                              type="button"
                                              disabled={curationTargetsSaving}
                                              onClick={() => handleToggleUniversal(appl.attributeId!, true)}
                                              title="Click to make this attribute Universal (applies to ALL products store-wide)"
                                              style={{ background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 6, padding: '1px 6px', fontSize: 10, fontWeight: 600, cursor: curationTargetsSaving ? 'not-allowed' : 'pointer' }}
                                            >
                                              ⚡ Make Universal
                                            </button>
                                          )}
                                        </div>
                                        {expandedAppliesToField === field.catalogField && (
                                          <div style={{ marginTop: 4, padding: 6, background: '#f8fafc', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                            {appl.productTypes.map(pt => (
                                              <div key={pt.productTypeId} style={{ color: '#334155' }}>
                                                • <strong>{pt.productTypeName}</strong> {pt.required ? '(required)' : ''} {pt.conditional ? '[conditional]' : ''}
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    ) : appl?.scope === 'unused' ? (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, border: '1px solid #fde68a' }}>
                                          ⚠ Not used by any Product Type
                                        </span>
                                        {appl?.attributeId && (
                                          <button
                                            type="button"
                                            disabled={curationTargetsSaving}
                                            onClick={() => handleToggleUniversal(appl.attributeId!, true)}
                                            title="Click to make this attribute Universal (applies to ALL products store-wide)"
                                            style={{ background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 6, padding: '1px 6px', fontSize: 10, fontWeight: 600, cursor: curationTargetsSaving ? 'not-allowed' : 'pointer' }}
                                          >
                                            ⚡ Make Universal
                                          </button>
                                        )}
                                      </div>
                                    ) : (
                                      <span style={{ fontSize: 11, color: '#9ca3af' }}>Unmapped</span>
                                    )}
                                  </div>
                                </td>
                                <td style={styles.td}>
                                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                    <span style={{ fontSize: 12, color: '#374151' }}>
                                      {appl?.valueMode === 'controlled'
                                        ? `${appl.allowedValuesCount} allowed values`
                                        : appl?.valueMode === 'measured'
                                        ? `Unit: ${appl.canonicalUnit ?? 'lb'}`
                                        : '—'}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => setInspectedCatalogField(isInspected ? null : field.catalogField)}
                                      style={{ background: isInspected ? '#3b82f6' : '#f1f5f9', color: isInspected ? '#fff' : '#475569', border: '1px solid #cbd5e1', borderRadius: 4, padding: '2px 6px', fontSize: 11, cursor: 'pointer' }}
                                    >
                                      {isInspected ? 'Close ✕' : 'Inspect 🔍'}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                              {isInspected && (
                                <tr>
                                  <td colSpan={6} style={{ background: '#f8fafc', padding: 12, borderBottom: '2px solid #e2e8f0' }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                                      <div style={{ fontWeight: 600, color: '#1e293b', borderBottom: '1px solid #cbd5e1', paddingBottom: 4 }}>
                                        Attribute Inspector: {appl?.attributeName ?? field.label} ({field.catalogField})
                                      </div>
                                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                                        <div>
                                          <span style={{ color: '#64748b' }}>Input Type:</span>{' '}
                                          <strong>{appl?.valueMode ? (appl.valueMode === 'controlled' ? 'Select (Controlled)' : appl.valueMode === 'measured' ? 'Measurement' : 'Free text') : 'Unknown'}</strong>
                                        </div>
                                        <div>
                                          <span style={{ color: '#64748b' }}>Canonical Unit:</span>{' '}
                                          <strong>{appl?.canonicalUnit ?? '—'}</strong>
                                        </div>
                                        <div>
                                          <span style={{ color: '#64748b' }}>Default Cardinality:</span>{' '}
                                          <strong>{target?.selectionMode ?? 'single'}</strong>
                                        </div>
                                        <div>
                                          <span style={{ color: '#64748b' }}>Catalog Field:</span>{' '}
                                          <code>{field.catalogField}</code>
                                        </div>
                                      </div>
                                      <div style={{ marginTop: 4, padding: 8, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 6 }}>
                                        <div style={{ fontWeight: 600, fontSize: 11, color: '#475569', marginBottom: 2 }}>
                                          Historical Catalog Values (Diagnostic Reference Only)
                                        </div>
                                        <div style={{ fontSize: 11, color: '#334155' }}>
                                          {appl?.historicalValues && appl.historicalValues.length > 0
                                            ? appl.historicalValues.join(', ')
                                            : 'No historical values found in synced catalog.'}
                                        </div>
                                        <div style={{ fontSize: 10, color: '#64748b', fontStyle: 'italic', marginTop: 4 }}>
                                          Note: Historical values are displayed for diagnostic catalog analysis only and are not selectable options.
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                    </tbody>
                  </table>
                  <p style={{ fontSize: 11, color: '#6b7280', margin: '8px 0 0', fontStyle: 'italic' }}>
                    Note: Product Type profile cardinality overrides default selection when defined.
                  </p>
                </>
              )}
            </div>
          </div>
        ) : (
          /* BY PRODUCT TYPE LENS (C4 & C7) */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, background: '#f8fafc', padding: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: '#334155' }}>Product Type:</label>
                <select
                  style={{ ...styles.select, minWidth: 200 }}
                  value={selectedProductTypeId}
                  disabled={editingProfile}
                  onChange={(e) => setSelectedProductTypeId(e.target.value)}
                >
                  {curationTargetState.candidates.productTypes.map(pt => (
                    <option key={pt.value} value={pt.value}>
                      {pt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                {!editingProfile && (
                  <label style={{ fontSize: 12, color: '#475569', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={showNonApplicable}
                      onChange={(e) => setShowNonApplicable(e.target.checked)}
                    />
                    Show non-applicable attributes
                  </label>
                )}
                {editingProfile && (
                  <span style={{ fontSize: 12, color: '#2563eb', fontWeight: 600 }}>
                    Editing Attribute Profile for {curationTargetState.candidates.productTypes.find(pt => pt.value === selectedProductTypeId)?.label}
                  </span>
                )}
              </div>
            </div>

            <div style={styles.subsection}>
              <div style={styles.subsectionHeader}>
                <span style={{ ...styles.providerBadge, background: '#059669', color: '#fff' }}>Effective Curation Fields</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>
                  {curationTargetState.candidates.productTypes.find(pt => pt.value === selectedProductTypeId)?.label}
                </span>
              </div>

              <table style={styles.table}>
                <thead>
                  <tr>
                    {editingProfile && <th style={styles.th}>Include</th>}
                    <th style={styles.th}>Attribute</th>
                    <th style={styles.th}>Catalog Destination</th>
                    <th style={styles.th}>Required</th>
                    <th style={styles.th}>Cardinality</th>
                    <th style={styles.th}>Conditions</th>
                    <th style={styles.th}>Global Target Status</th>
                  </tr>
                </thead>
                <tbody>
                  {curationTargetState.applicability
                    .filter(item => {
                      if (!item.attributeId) return false;
                      if (editingProfile) return true;
                      const isUniversal = item.scope === 'universal';
                      const profileMatch = item.productTypes.find(pt => pt.productTypeId === selectedProductTypeId);
                      const isApplicable = isUniversal || !!profileMatch;
                      return isApplicable || showNonApplicable;
                    })
                    .map(item => {
                      const isUniversal = item.scope === 'universal';
                      const profileMatch = item.productTypes.find(pt => pt.productTypeId === selectedProductTypeId);
                      const isApplicable = isUniversal || !!profileMatch;
                      const target = targetForField(item.catalogField);
                      const targetEnabled = !!target?.enabled;
                      const draftState = profileEditsDraft[item.attributeId!];

                      return (
                        <tr key={item.catalogField} style={{ opacity: !isApplicable && !editingProfile ? 0.6 : 1 }}>
                          {editingProfile && (
                            <td style={styles.td}>
                              {isUniversal ? (
                                <span style={{ fontSize: 11, color: '#166534', fontWeight: 600 }}>Universal</span>
                              ) : (
                                <input
                                  type="checkbox"
                                  checked={!!draftState?.included}
                                  onChange={(e) => {
                                    setProfileEditsDraft(prev => ({
                                      ...prev,
                                      [item.attributeId!]: {
                                        ...prev[item.attributeId!],
                                        included: e.target.checked,
                                      },
                                    }));
                                  }}
                                />
                              )}
                            </td>
                          )}

                          <td style={styles.td}>
                            <strong>{item.attributeName}</strong>
                            <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>{item.attributeId}</div>
                          </td>

                          <td style={styles.td}>
                            <code>{item.catalogField}</code>
                          </td>

                          <td style={styles.td}>
                            {editingProfile && !isUniversal ? (
                              <input
                                type="checkbox"
                                disabled={!draftState?.included}
                                checked={!!draftState?.required}
                                onChange={(e) => {
                                  setProfileEditsDraft(prev => ({
                                    ...prev,
                                    [item.attributeId!]: {
                                      ...prev[item.attributeId!],
                                      required: e.target.checked,
                                    },
                                  }));
                                }}
                              />
                            ) : (
                              <span style={{ fontSize: 12, color: profileMatch?.required ? '#dc2626' : '#6b7280', fontWeight: profileMatch?.required ? 600 : 400 }}>
                                {isApplicable ? (profileMatch?.required ? 'Required' : 'Optional') : '—'}
                              </span>
                            )}
                          </td>

                          <td style={styles.td}>
                            {editingProfile && !isUniversal ? (
                              <select
                                style={{ ...styles.select, minWidth: 110 }}
                                disabled={!draftState?.included}
                                value={draftState?.cardinality ?? 'single'}
                                onChange={(e) => {
                                  setProfileEditsDraft(prev => ({
                                    ...prev,
                                    [item.attributeId!]: {
                                      ...prev[item.attributeId!],
                                      cardinality: e.target.value as 'single' | 'multiple',
                                    },
                                  }));
                                }}
                              >
                                <option value="single">Single</option>
                                <option value="multiple">Multiple</option>
                              </select>
                            ) : (
                              <span style={{ fontSize: 12, color: '#374151' }}>
                                {isApplicable ? (profileMatch?.cardinality ?? 'single') : '—'}
                              </span>
                            )}
                          </td>

                          <td style={styles.td}>
                            {isUniversal ? (
                              <span style={{ fontSize: 11, background: '#dcfce7', color: '#166534', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>
                                Universal
                              </span>
                            ) : profileMatch?.conditional ? (
                              <span style={{ fontSize: 11, background: '#fef3c7', color: '#92400e', padding: '2px 6px', borderRadius: 4, fontWeight: 600 }}>
                                Conditional
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, color: '#9ca3af' }}>None</span>
                            )}
                          </td>

                          <td style={styles.td}>
                            {targetEnabled ? (
                              <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>✓ Enabled</span>
                            ) : (
                              <span style={{ fontSize: 12, color: '#dc2626' }}>✕ Disabled</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      </div>

      <div style={{ display: settingsTab === 'profiles' ? 'block' : 'none' }}>
      {/* ── Profile Builder Landing ── */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: 24 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px', color: '#111827' }}>
          Profile Builder
        </h2>
        <p style={{ fontSize: 14, color: '#6b7280', margin: '0 0 20px', lineHeight: 1.5 }}>
          Build a domain extractor profile by entering a product URL and assigning CSS selectors.
          The profile defines how product data is extracted from a specific e-commerce domain.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="text"
            value={localDomain}
            onChange={(e) => setLocalDomain(e.target.value)}
            placeholder="Enter domain (e.g. acmepet.com)"
            style={{
              flex: 1,
              maxWidth: 400,
              padding: '8px 12px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontSize: 14,
              fontFamily: 'monospace',
            }}
          />
          <button
            type="button"
            onClick={() => {
              if (localDomain.trim()) {
                setWorkspaceDomain(localDomain.trim().toLowerCase().replace(/^www\\./, ''));
              }
            }}
            disabled={!localDomain.trim()}
            style={{
              background: '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '8px 20px',
              fontSize: 14,
              fontWeight: 600,
              cursor: localDomain.trim() ? 'pointer' : 'not-allowed',
              opacity: localDomain.trim() ? 1 : 0.6,
            }}
          >
            Open Profile Builder
          </button>
        </div>
      </div>
      </div>

      {/* ── Profile Builder (inline) ── */}
      {workspaceDomain && (
        <div style={{ marginBottom: 24, background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: 20 }}>
          <ProfileBuilder
            mode="inline"
            initialDomain={workspaceDomain}
            onCancel={() => setWorkspaceDomain(null)}
          />
        </div>
      )}
    </div>
  );
}

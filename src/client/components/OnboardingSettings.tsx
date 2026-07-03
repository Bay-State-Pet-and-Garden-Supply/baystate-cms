import React, { useState, useEffect } from 'react';
import {
  getApiKeys,
  updateApiKey,
  deleteApiKey,
  getDeepseekModels,
  getOllamaModels,
  getOpenaiModels,
  getExtractorProfiles,
  testExtractorProfile,
  getDomainDiagnostics,
  generateProfileForDomain,
  saveDomainConfig,
  getLatestProposalForDomain,
  getProfileGenerationDetail,
  getCurationTargets,
  saveCurationTargets,

  type ApiKeyDisplay,
  type DomainConfigPayload,
  type CurationTargetsResponse,
} from '../onboarding-api';
import type {
  DomainDiagnosticsEntry,
  DomainHealthStatus,
  ExtractorProfile,

  ProfileGenerationGeneration,
} from '../../shared/schemas/onboarding';
import type { CurationTargetConfig } from '../../shared/schemas/classification';
import { LlmTaskConfigPanel } from './LlmTaskConfigPanel';
import { ProfileProposalDrawer } from './ProfileProposalDrawer';
import { ProfileBuilderWorkspace } from './ProfileBuilderWorkspace';
import { ProfileRetryPreview } from './ProfileRetryPreview';
import { getExtractionWorkerHealth } from '../onboarding-api';
import type { WorkerHealthResponse } from '../../shared/schemas/extraction-worker';

interface OnboardingSettingsProps {
  onBack: () => void;
}



// ─── Domain diagnostics helpers ───────────────────────────────────────────────

const DOMAIN_HEALTH_BADGE_COLORS: Record<DomainHealthStatus, { bg: string; fg: string; border: string }> = {
  ok: { bg: '#dcfce7', fg: '#166534', border: '#16a34a' },
  blocked: { bg: '#fee2e2', fg: '#991b1b', border: '#dc2626' },
  offline: { bg: '#e5e7eb', fg: '#374151', border: '#6b7280' },
  mismatch: { bg: '#fef3c7', fg: '#92400e', border: '#f59e0b' },
  unknown: { bg: '#f3f4f6', fg: '#6b7280', border: '#d1d5db' },
};

function domainHealthBadgeStyle(status: DomainHealthStatus): React.CSSProperties {
  const palette = DOMAIN_HEALTH_BADGE_COLORS[status];
  return {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 700,
    padding: '2px 10px',
    borderRadius: 999,
    textTransform: 'uppercase' as const,
    background: palette.bg,
    color: palette.fg,
    border: `1px solid ${palette.border}`,
    letterSpacing: 0.4,
  };
}

function formatOptionalIsoDate(iso: string | null): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  return new Date(parsed).toISOString().slice(0, 10);
}

function targetSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(slug) ? slug : `target-${slug || 'field'}`;
}

function deriveProfileHealth(entry: DomainDiagnosticsEntry): { label: string; color: string } {
  if (entry.hasActiveProfile && entry.latestGenerationStatus !== 'rejected' && entry.latestGenerationStatus !== 'failed') {
    return { label: 'Healthy', color: '#28a745' };
  }
  if (entry.hasActiveProfile && (entry.latestGenerationStatus === 'rejected' || entry.latestGenerationStatus === 'failed')) {
    return { label: 'Needs review', color: '#ffc107' };
  }
  if (!entry.hasActiveProfile && (entry.latestGenerationStatus === 'proposed' || entry.latestGenerationStatus === 'validated')) {
    return { label: 'Proposed', color: '#17a2b8' };
  }
  return { label: 'None', color: '#6c757d' };
}

export function OnboardingSettings({ onBack }: OnboardingSettingsProps) {
  const [keys, setKeys] = useState<ApiKeyDisplay[]>([]);
  // Accordion / editing state for unified domain table
  // Cached extractor profiles (keyed by domain) for pre-populating
  // selector fields when expanding a domain that has an active profile.
  const [profiles, setProfiles] = useState<Record<string, ExtractorProfile>>({});
  const [expandedDomain, setExpandedDomain] = useState<string | null>(null);
  const [editingDomainData, setEditingDomainData] = useState<Record<string, {
    titleSelector: string | null;
    priceSelector: string | null;
    descriptionSelector: string | null;
    brandSelector: string | null;
    imagesSelector: string | null;
    sitemapProductUrlPattern: string | null;
    brands: Array<{
      id?: string;
      brandName: string;
      urlPattern?: string | null;
      successCount?: number;
    }>;
    sampleTestUrl: string;
  }>>({});
  const [domainSaving, setDomainSaving] = useState<string | null>(null);
  const [domainTesting, setDomainTesting] = useState<string | null>(null);
  const [domainTestResults, setDomainTestResults] = useState<Record<string, any>>({});
  const [domainTestErrors, setDomainTestErrors] = useState<Record<string, string>>({});
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

  // Domain diagnostics state (read-only snapshot of every known domain).
  const [domainDiagnostics, setDomainDiagnostics] = useState<DomainDiagnosticsEntry[]>([]);
  const [domainDiagnosticsGeneratedAt, setDomainDiagnosticsGeneratedAt] = useState<string | null>(null);
  const [domainDiagnosticsLoading, setDomainDiagnosticsLoading] = useState(false);

  // Manager-selected curation classification targets.
  const [curationTargetState, setCurationTargetState] = useState<CurationTargetsResponse | null>(null);
  const [curationTargetsDraft, setCurationTargetsDraft] = useState<CurationTargetConfig[]>([]);
  const [curationTargetsLoading, setCurationTargetsLoading] = useState(false);
  const [curationTargetsSaving, setCurationTargetsSaving] = useState(false);

  // On-demand AI profile generation state.
  const [generatingProfileDomain, setGeneratingProfileDomain] = useState<string | null>(null);

  // Profile proposal drawer state
  const [drawerState, setDrawerState] = useState<{
    domain: string;
    proposal: ProfileGenerationGeneration;
    revisionId: string | null;
    testUrl: string;
  } | null>(null);

  // Worker health & profile builder overlay state
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthResponse | null>(null);
  const [workspaceDomain, setWorkspaceDomain] = useState<string | null>(null);

  // Profile Retry Preview overlay state
  const [retryPreviewDomain, setRetryPreviewDomain] = useState<string | null>(null);
  const [settingsTab, setSettingsTab] = useState<'general' | 'llm' | 'curation' | 'profiles'>('general');

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

  const loadDomainDiagnostics = async () => {
    setDomainDiagnosticsLoading(true);
    try {
      const res = await getDomainDiagnostics();
      setDomainDiagnostics(res.entries);
      setDomainDiagnosticsGeneratedAt(res.generatedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDomainDiagnosticsLoading(false);
    }
  };

  const loadCurationTargets = async () => {
    setCurationTargetsLoading(true);
    try {
      const res = await getCurationTargets();
      setCurationTargetState(res);
      setCurationTargetsDraft(res.targets);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCurationTargetsLoading(false);
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

  const handleGenerateProfile = async (domain: string) => {
    setGeneratingProfileDomain(domain);
    setError('');
    try {
      const result = await generateProfileForDomain(domain);
      if (result.success && result.generationId) {
        const note = result.existing
          ? `An existing open proposal was found for ${domain}.`
          : `Profile proposal generated for ${domain} from ${result.anchorUrl ?? 'sitemap sample'}.`;
        alert(`${note} You can now preview and approve it in the domain configuration panel below.`);
        void loadDomainDiagnostics();
      } else {
        setError(
          `Profile generation for ${domain} returned no proposal. Check that the LLM is configured (Settings → AI Model Routing → profile_generation).`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGeneratingProfileDomain(null);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    setError('');
    try {
      const keysRes = await getApiKeys();

      setKeys(keysRes.keys);

      // Pull diagnostics, curation targets, and extractor profiles in parallel.
      // These run alongside the other reads and never block the page
      // on their own failures.
      void loadDomainDiagnostics();
      void loadCurationTargets();
      getExtractorProfiles()
        .then(res => {
          const map: Record<string, ExtractorProfile> = {};
          for (const p of res.extractorProfiles) {
            map[p.domain] = p;
          }
          setProfiles(map);
        })
        .catch(() => {});

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

  const handleSaveDomain = async (domain: string) => {
    const data = editingDomainData[domain];
    if (!data) return;
    setDomainSaving(domain);
    try {
      await saveDomainConfig(domain, {
        titleSelector: data.titleSelector || null,
        priceSelector: data.priceSelector || null,
        descriptionSelector: data.descriptionSelector || null,
        brandSelector: data.brandSelector || null,
        imagesSelector: data.imagesSelector || null,
        sitemapProductUrlPattern: data.sitemapProductUrlPattern || null,
        brands: data.brands,
      });
      await loadDomainDiagnostics();
      setExpandedDomain(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDomainSaving(null);
    }
  };

  const updateDomainField = (domain: string, field: string, value: string) => {
    setEditingDomainData(prev => ({
      ...prev,
      [domain]: { ...prev[domain], [field]: value },
    }));
  };

  const handleBrandFieldChange = (domain: string, brandIndex: number, field: string, value: string | number) => {
    setEditingDomainData(prev => {
      const current = prev[domain];
      if (!current) return prev;
      const newBrands = [...(current.brands || [])];
      newBrands[brandIndex] = { ...newBrands[brandIndex], [field]: value };
      return { ...prev, [domain]: { ...current, brands: newBrands } };
    });
  };

  const handleAddBrand = (domain: string) => {
    setEditingDomainData(prev => {
      const current = prev[domain];
      if (!current) return prev;
      return {
        ...prev,
        [domain]: {
          ...current,
          brands: [...current.brands, { brandName: '', successCount: 0 }],
        },
      };
    });
  };

  const handleDeleteBrand = (domain: string, brandIndex: number) => {
    setEditingDomainData(prev => {
      const current = prev[domain];
      if (!current) return prev;
      return {
        ...prev,
        [domain]: {
          ...current,
          brands: (current.brands || []).filter((_, i) => i !== brandIndex),
        },
      };
    });
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
    primaryBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 },
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
      <div style={styles.header}>
        <h1 style={styles.title}>Onboarding Pipeline Settings</h1>
        <button style={styles.backBtn} onClick={onBack}>← Back to Batches</button>
      </div>

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
        <LlmTaskConfigPanel onChange={() => setError('')} />
      </div>
      </div>

      <div style={{ display: settingsTab === 'curation' ? 'block' : 'none' }}>
      {/* ─── CURATION TARGETS ─── */}
      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h2 style={{ ...styles.sectionTitle, margin: 0 }}>Curation Classification Targets</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={styles.secondaryBtn} onClick={loadCurationTargets} disabled={curationTargetsLoading}>
              {curationTargetsLoading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button type="button" style={styles.primaryBtn} onClick={handleSaveCurationTargets} disabled={curationTargetsSaving}>
              {curationTargetsSaving ? 'Saving…' : 'Save Targets'}
            </button>
          </div>
        </div>
        <p style={styles.hint}>
          Choose exactly which classifications the curation stage should fill. Product fields use the existing values in the synced live catalog as controlled options; pages can be single- or multi-select.
        </p>

        {!curationTargetState ? (
          <p style={styles.empty}>{curationTargetsLoading ? 'Loading curation targets…' : 'No curation target data loaded yet.'}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={styles.subsection}>
              <div style={styles.subsectionHeader}>
                <span style={{ ...styles.providerBadge, background: '#7c3aed', color: '#fff' }}>Pages</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{curationTargetState.candidates.pages.length} synced pages</span>
              </div>
              {(() => {
                const pageTarget = curationTargetsDraft.find(t => t.kind === 'page');
                const enabled = !!pageTarget?.enabled;
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    <label style={styles.checkboxLabel}>
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => {
                          if (e.target.checked) {
                            upsertCurationTarget({
                              id: pageTarget?.id ?? 'category-pages',
                              kind: 'page',
                              label: 'Category Pages',
                              enabled: true,
                              selectionMode: pageTarget?.selectionMode ?? 'multiple',
                              attributeId: null,
                              catalogField: null,
                              optionSource: 'live_store',
                              required: false,
                              sortOrder: pageTarget?.sortOrder ?? curationTargetsDraft.length,
                            });
                          } else {
                            removeCurationTarget(t => t.kind === 'page');
                          }
                        }}
                      />
                      Let curator assign ShopSite pages
                    </label>
                    <select
                      style={{ ...styles.select, width: 180 }}
                      value={pageTarget?.selectionMode ?? 'multiple'}
                      disabled={!enabled}
                      onChange={(e) => pageTarget && upsertCurationTarget({ ...pageTarget, selectionMode: e.target.value as 'single' | 'multiple' })}
                    >
                      <option value="single">Single select</option>
                      <option value="multiple">Multi-select</option>
                    </select>
                  </div>
                );
              })()}
            </div>

            {curationTargetState.candidates.productTypes.length > 0 && (
              <div style={styles.subsection}>
                <div style={styles.subsectionHeader}>
                  <span style={{ ...styles.providerBadge, background: '#9333ea', color: '#fff' }}>Optional</span>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>Internal Product Type ({curationTargetState.candidates.productTypes.length} configured)</span>
                </div>
                {(() => {
                  const typeTarget = curationTargetsDraft.find(t => t.kind === 'product_type');
                  return (
                    <label style={styles.checkboxLabel}>
                      <input
                        type="checkbox"
                        checked={!!typeTarget?.enabled}
                        onChange={(e) => {
                          if (e.target.checked) {
                            upsertCurationTarget({
                              id: typeTarget?.id ?? 'primary-product-type',
                              kind: 'product_type',
                              label: 'Product Type',
                              enabled: true,
                              selectionMode: 'single',
                              attributeId: null,
                              catalogField: null,
                              optionSource: 'configured',
                              required: false,
                              sortOrder: typeTarget?.sortOrder ?? curationTargetsDraft.length,
                            });
                          } else {
                            removeCurationTarget(t => t.kind === 'product_type');
                          }
                        }}
                      />
                      Also classify the internal Product Type
                    </label>
                  );
                })()}
              </div>
            )}

            <div style={styles.subsection}>
              <div style={styles.subsectionHeader}>
                <span style={{ ...styles.providerBadge, background: '#2563eb', color: '#fff' }}>Product Fields</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{curationTargetState.candidates.productFields.length} custom fields from field registry</span>
              </div>
              {curationTargetState.candidates.productFields.length === 0 ? (
                <p style={styles.empty}>No ProductField entries are available yet. Sync products from ShopSite first.</p>
              ) : (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Curate</th>
                      <th style={styles.th}>Field</th>
                      <th style={styles.th}>Existing options</th>
                      <th style={styles.th}>Selection</th>
                    </tr>
                  </thead>
                  <tbody>
                    {curationTargetState.candidates.productFields.map(field => {
                      const target = targetForField(field.catalogField);
                      const checked = !!target?.enabled;
                      return (
                        <tr key={field.catalogField}>
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
                                    enabled: true,
                                    selectionMode: target?.selectionMode ?? 'single',
                                    attributeId: target?.attributeId ?? field.attributeId ?? targetSlug(`field-${field.catalogField}`),
                                    catalogField: field.catalogField,
                                    optionSource: target?.optionSource ?? 'live_store',
                                    required: false,
                                    sortOrder: target?.sortOrder ?? curationTargetsDraft.length,
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
                            <span style={{ fontSize: 12, color: field.values.length > 0 ? '#374151' : '#dc2626' }}>
                              {field.values.length > 0
                                ? `${field.values.length} values · ${field.values.slice(0, 4).join(', ')}${field.values.length > 4 ? '…' : ''}`
                                : 'No existing values found'}
                            </span>
                          </td>
                          <td style={styles.td}>
                            <select
                              style={{ ...styles.select, minWidth: 150 }}
                              value={target?.selectionMode ?? 'single'}
                              disabled={!checked || !target}
                              onChange={(e) => target && upsertCurationTarget({ ...target, selectionMode: e.target.value as 'single' | 'multiple' })}
                            >
                              <option value="single">Single select</option>
                              <option value="multiple">Multi-select</option>
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>
      </div>

      <div style={{ display: settingsTab === 'profiles' ? 'block' : 'none' }}>
      {/* ─── DOMAIN CONFIGURATION ─── */}
      <div id="domain-configuration" style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ ...styles.sectionTitle, margin: 0 }}>
            Domain Configuration ({domainDiagnostics.length})
          </h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={styles.secondaryBtn}
              onClick={loadDomainDiagnostics}
              disabled={domainDiagnosticsLoading}
            >
              {domainDiagnosticsLoading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              style={styles.primaryBtn}
              onClick={() => {
                const d = prompt('Enter domain (e.g. example.com):');
                if (d) {
                  const normalizedDomain = d.toLowerCase().replace(/^www\./, '').trim();
                  if (normalizedDomain) {
                    setEditingDomainData(prev => ({
                      ...prev,
                      [normalizedDomain]: {
                        titleSelector: null,
                        priceSelector: null,
                        descriptionSelector: null,
                        brandSelector: null,
                        imagesSelector: null,
                        sitemapProductUrlPattern: null,
                        brands: [],
                        sampleTestUrl: '',
                      },
                    }));
                    setExpandedDomain(normalizedDomain);
                  }
                }
              }}
            >
              + Add Domain
            </button>
          </div>
        </div>
        <p style={styles.hint}>
          Manage extractor profiles, brand associations, sitemaps, and domain health in one place.
        </p>

        {/* Extraction worker health indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, padding: '8px 12px', background: '#f8f9fa', borderRadius: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: workerHealth?.ok ? '#28a745' : '#dc3545', display: 'inline-block' }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>Extraction Worker</span>
          <span style={{ fontSize: 12, color: '#666' }}>{workerHealth?.ok ? `v${workerHealth.version}` : 'Unavailable'}</span>
        </div>

        {domainDiagnostics.length === 0 ? (
          <p style={styles.empty}>No domains configured yet. Click "+ Add Domain" to get started.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Domain</th>
                <th style={styles.th}>Health</th>
                <th style={styles.th}>Profile</th>
                <th style={styles.th}>Profile Health</th>
                <th style={styles.th}>Brands</th>
                <th style={styles.th}>Sitemap</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {domainDiagnostics.map((entry) => {
                const isExpanded = expandedDomain === entry.domain;
                const brandLabel = entry.brandAssociations.length === 0
                  ? '—'
                  : entry.brandAssociations.length === 1
                    ? entry.brandAssociations[0].brandName.toUpperCase()
                    : `${entry.brandAssociations.length} brands · ${entry.brandAssociations[0].brandName.toUpperCase()}`;
                const sitemapLabel = entry.sitemapFetchedAt
                  ? `${entry.sitemapUrlsCount} URLs · ${entry.sitemapStale ? 'stale' : 'valid'}`
                  : '—';

                return (
                  <React.Fragment key={entry.domain}>
                    {/* Collapsed row */}
                    <tr
                      onClick={() => {
                        setDrawerState(null);
                        setWorkspaceDomain(entry.domain);
                      }}
                      style={{ cursor: 'pointer', background: isExpanded ? '#f0f7ff' : undefined }}
                    >
                      <td style={styles.td}>
                        <strong>{entry.domain}</strong>
                        <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 8 }}>
                          {isExpanded ? '▲' : '▼'}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <span style={domainHealthBadgeStyle(entry.healthStatus)}>
                          {entry.healthStatus}
                        </span>
                      </td>
                      <td style={styles.td}>
                        {entry.hasActiveProfile ? (
                          <span style={{ ...styles.providerBadge, background: '#dcfce7', color: '#166534' }}>Active</span>
                        ) : (
                          <span style={styles.empty}>No profile</span>
                        )}
                      </td>
                      <td style={styles.td}>{brandLabel}</td>
                      <td style={styles.td}>
                        <span style={{
                          fontSize: 13,
                          color: entry.sitemapStale ? '#dc2626' : entry.sitemapFetchedAt ? '#16a34a' : '#9ca3af',
                        }}>
                          {sitemapLabel}
                        </span>
                      </td>
                      {/* Profile Health column */}
                      <td style={styles.td}>
                        <span style={{
                          display: 'inline-block',
                          fontSize: 11,
                          fontWeight: 700,
                          padding: '2px 10px',
                          borderRadius: 999,
                          textTransform: 'uppercase' as const,
                          background: (() => { const h = deriveProfileHealth(entry); return h.color === '#28a745' ? '#dcfce7' : h.color === '#ffc107' ? '#fef3c7' : h.color === '#17a2b8' ? '#e0f2fe' : '#f3f4f6'; })(),
                          color: deriveProfileHealth(entry).color,
                          letterSpacing: 0.4,
                        }}>
                          {deriveProfileHealth(entry).label}
                        </span>
                      </td>
                      {/* Actions column */}
                      <td style={styles.td}>
                        <button
                          onClick={(e) => { e.stopPropagation(); setDrawerState(null); setWorkspaceDomain(entry.domain); }}
                          style={{ padding: '4px 8px', fontSize: 12, cursor: 'pointer', border: '1px solid #007bff', borderRadius: 4, color: '#007bff', background: '#fff' }}
                        >
                          Open Profile Builder
                        </button>
                      </td>
                    </tr>

                    {/* Expanded accordion detail panel */}
                    {isExpanded && (
                      <tr>
                        <td colSpan={7} style={{ background: '#f9fafb', padding: 20, borderBottom: '2px solid #2563eb' }}>
                          <DomainDetailPanel
                            entry={entry}
                            editingData={editingDomainData[entry.domain]}
                            saving={domainSaving === entry.domain}
                            testing={domainTesting === entry.domain}
                            testResults={domainTestResults[entry.domain]}
                            testError={domainTestErrors[entry.domain]}
                            generatingProfile={generatingProfileDomain === entry.domain}
                            onFieldChange={(field, value) => updateDomainField(entry.domain, field, value)}
                            onBrandFieldChange={(brandIndex, field, value) => handleBrandFieldChange(entry.domain, brandIndex, field, value)}
                            onTest={async () => {
                              const data = editingDomainData[entry.domain];
                              if (!data?.sampleTestUrl) {
                                setDomainTestErrors(prev => ({ ...prev, [entry.domain]: 'Enter a sample URL to test' }));
                                return;
                              }
                              setDomainTesting(entry.domain);
                              setDomainTestErrors(prev => ({ ...prev, [entry.domain]: '' }));
                              try {
                                const res = await testExtractorProfile({
                                  url: data.sampleTestUrl,
                                  titleSelector: data.titleSelector,
                                  priceSelector: data.priceSelector,
                                  descriptionSelector: data.descriptionSelector,
                                  brandSelector: data.brandSelector,
                                  imagesSelector: data.imagesSelector,
                                });
                                if (res.success) {
                                  setDomainTestResults(prev => ({ ...prev, [entry.domain]: res.extracted }));
                                }
                              } catch (err) {
                                setDomainTestErrors(prev => ({ ...prev, [entry.domain]: err instanceof Error ? err.message : String(err) }));
                              } finally {
                                setDomainTesting(null);
                              }
                            }}
                            onSave={() => handleSaveDomain(entry.domain)}
                            onGenerateProfile={() => handleGenerateProfile(entry.domain)}
                            onAddBrand={() => handleAddBrand(entry.domain)}
                            onDeleteBrand={(brandIndex) => handleDeleteBrand(entry.domain, brandIndex)}
                            onReviewProposal={(proposal, revisionId) => {
                              setDrawerState({
                                domain: entry.domain,
                                proposal,
                                revisionId,
                                testUrl: (editingDomainData[entry.domain]?.sampleTestUrl || '') as string,
                              });
                              setWorkspaceDomain(null);
                            }}
                            onCancel={() => setExpandedDomain(null)}
                            onShowRetryPreview={() => { setDrawerState(null); setWorkspaceDomain(null); setRetryPreviewDomain(entry.domain); }}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}

        {domainDiagnosticsGeneratedAt && (
          <p style={{ ...styles.savedHint, marginTop: 12 }}>
            Snapshot generated at {formatOptionalIsoDate(domainDiagnosticsGeneratedAt)}
            {domainDiagnosticsGeneratedAt.includes('T')
              ? ` ${domainDiagnosticsGeneratedAt.slice(11, 19)}`
              : ''}
          </p>
        )}
      </div>
      </div>

      {/* ── Profile Proposal Drawer ── */}
      {drawerState && (
        <ProfileProposalDrawer
          domain={drawerState.domain}
          proposal={drawerState.proposal}
          revisionId={drawerState.revisionId}
          testUrl={drawerState.testUrl}
          activeProfile={profiles[drawerState.domain] ?? null}
          onClose={() => setDrawerState(null)}
          onTestUrlChange={(url) => {
            updateDomainField(drawerState.domain, 'sampleTestUrl', url);
          }}
          onChange={() => {
            setDrawerState(null);
            loadDomainDiagnostics();
          }}
        />
      )}

      {/* ── Profile Builder Workspace Overlay ── */}
      {workspaceDomain && (
        <ProfileBuilderWorkspace
          domain={workspaceDomain}
          onClose={() => setWorkspaceDomain(null)}
        />
      )}

      {/* ── Profile Retry Preview Overlay ── */}
      {retryPreviewDomain && (
        <ProfileRetryPreview
          domain={retryPreviewDomain}
          onClose={() => setRetryPreviewDomain(null)}
        />
      )}
    </div>
  );
}

// ─── Domain Detail Panel Subcomponent ──────────────────────────────────────────



interface DomainDetailPanelProps {
  entry: DomainDiagnosticsEntry;
  editingData: (DomainConfigPayload & { sampleTestUrl: string }) | undefined;
  saving: boolean;
  testing: boolean;
  testResults: any;
  testError: string;
  generatingProfile: boolean;
  onFieldChange: (field: string, value: string) => void;
  onBrandFieldChange: (brandIndex: number, field: string, value: string | number) => void;
  onTest: () => void;
  onSave: () => void;
  onGenerateProfile: () => void;
  onAddBrand: () => void;
  onDeleteBrand: (index: number) => void;
  onCancel: () => void;
  onReviewProposal?: (proposal: ProfileGenerationGeneration, revisionId: string | null) => void;
  onShowRetryPreview?: () => void;
}

function DomainDetailPanel(props: DomainDetailPanelProps) {
  const {
    entry,
    editingData,
    saving,
    testing,
    testResults: _testResults,
    testError,
    generatingProfile,
    onFieldChange,
    onBrandFieldChange,
    onTest,
    onSave,
    onGenerateProfile,
    onAddBrand,
    onDeleteBrand,
    onCancel,
    onReviewProposal,
    onShowRetryPreview,
  } = props;

  // ── AI Proposal fetch (for compact summary) ───────────────────────────
  const [proposal, setProposal] = useState<ProfileGenerationGeneration | null>(null);
  const [proposalRevisionId, setProposalRevisionId] = useState<string | null>(null);
  const [proposalLoading, setProposalLoading] = useState<boolean>(true);

  // Fetch the latest open proposal for this domain on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setProposalLoading(true);
      try {
        const p = await getLatestProposalForDomain(entry.domain);
        if (!cancelled) {
          setProposal(p);
          if (p) {
            try {
              const detail = await getProfileGenerationDetail(p.id);
              if (!cancelled) {
                const revs = detail.revisions.slice().sort(
                  (a, b) => b.revisionNumber - a.revisionNumber,
                );
                setProposalRevisionId(revs.length > 0 ? revs[0].id : null);
              }
            } catch {
              // Non-critical; revision fetching failure is ignored.
            }
          }
        }
      } catch {
        if (!cancelled) setProposal(null);
      } finally {
        if (!cancelled) setProposalLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [entry.domain]);

  const panelStyles = {
    sectionLabel: { fontSize: 14, fontWeight: 600, color: '#111827', margin: '0 0 8px 0' } as React.CSSProperties,
    fieldRow: { display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12, alignItems: 'center', marginBottom: 8 } as React.CSSProperties,
    fieldLabel: { fontSize: 13, fontWeight: 500, color: '#4b5563' } as React.CSSProperties,
    fieldInput: { width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 13, boxSizing: 'border-box' as const },
    divider: { borderTop: '1px solid #e5e7eb', margin: '12px 0' } as React.CSSProperties,
  };

  const brandData = editingData?.brands || [];


  return (
    <div>
      {/* ── Sitemap & Health summary ── */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 16, fontSize: 13, color: '#4b5563', flexWrap: 'wrap' }}>
        <div>
          <strong>Sitemap:</strong>{' '}
          {entry.sitemapFetchedAt
            ? `${entry.sitemapUrlsCount} URLs · fetched ${formatOptionalIsoDate(entry.sitemapFetchedAt)} · ` +
              (entry.sitemapStale
                ? <span style={{ color: '#dc2626', fontWeight: 600 }}>stale</span>
                : <span style={{ color: '#16a34a', fontWeight: 600 }}>valid</span>)
            : 'Never cached'}
        </div>
        <div>
          <strong>Health:</strong>{' '}
          <span style={domainHealthBadgeStyle(entry.healthStatus)}>{entry.healthStatus}</span>
          {entry.healthCheckedAt && ` · checked ${formatOptionalIsoDate(entry.healthCheckedAt)}`}
        </div>
        {entry.generationCount > 0 && (
          <div>
            <strong>AI Profiles:</strong> {entry.generationCount} generation{entry.generationCount > 1 ? 's' : ''}
            {entry.latestGenerationStatus && ` · ${entry.latestGenerationStatus}`}
          </div>
        )}
      </div>

      {/* ── Brand Associations ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h3 style={panelStyles.sectionLabel}>Brand Associations</h3>
        <button
          type="button"
          style={{ background: 'none', border: '1px solid #2563eb', color: '#2563eb', borderRadius: 4, padding: '2px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
          onClick={onAddBrand}
        >
          + Add Brand
        </button>
      </div>

      {brandData.length === 0 ? (
        <p style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>No brand associations for this domain.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 12 }}>
          <thead>
            <tr>
              <th style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left', padding: '4px 8px', color: '#4b5563', fontWeight: 600 }}>Brand Name</th>
              <th style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left', padding: '4px 8px', color: '#4b5563', fontWeight: 600 }}>Hits</th>
              <th style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left', padding: '4px 8px', color: '#4b5563', fontWeight: 600 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {brandData.map((brand, idx) => (
              <tr key={idx}>
                <td style={{ borderBottom: '1px solid #e5e7eb', padding: '4px 8px' }}>
                  <input
                    type="text"
                    style={panelStyles.fieldInput}
                    value={brand.brandName}
                    onChange={(e) => onBrandFieldChange(idx, 'brandName', e.target.value)}
                    placeholder="Brand name"
                  />
                </td>
                <td style={{ borderBottom: '1px solid #e5e7eb', padding: '4px 8px' }}>
                  <input
                    type="number"
                    style={{ ...panelStyles.fieldInput, width: 60 }}
                    value={brand.successCount || 0}
                    onChange={(e) => onBrandFieldChange(idx, 'successCount', parseInt(e.target.value) || 0)}
                  />
                </td>
                <td style={{ borderBottom: '1px solid #e5e7eb', padding: '4px 8px' }}>
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}
                    onClick={() => onDeleteBrand(idx)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={panelStyles.divider} />

      {/* ── Profile Selectors ── */}
      <h3 style={panelStyles.sectionLabel}>Extractor Profile Selectors</h3>
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
        CSS selectors for extracting product details. Empty fields fall back to default heuristics.
      </p>
      {[
        ['titleSelector', 'Title'],
        ['priceSelector', 'Price'],
        ['descriptionSelector', 'Description'],
        ['brandSelector', 'Brand'],
        ['imagesSelector', 'Images'],
        ['sitemapProductUrlPattern', 'Sitemap URL Pattern'],
      ].map(([field, label]) => (
        <div key={field} style={panelStyles.fieldRow}>
          <label style={panelStyles.fieldLabel}>{label}</label>
          <input
            type="text"
            style={panelStyles.fieldInput}
            value={(editingData as any)?.[field] || ''}
            onChange={(e) => onFieldChange(field, e.target.value)}
            placeholder={field === 'titleSelector' ? 'h1.product-title' : field === 'priceSelector' ? '.price-current' : ''}
          />
        </div>
      ))}

      {/* Test selectors */}
      <div style={{ ...panelStyles.fieldRow, marginTop: 12 }}>
        <label style={panelStyles.fieldLabel}>Test URL</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            style={{ ...panelStyles.fieldInput, flex: 1 }}
            value={editingData?.sampleTestUrl || ''}
            onChange={(e) => onFieldChange('sampleTestUrl', e.target.value)}
            placeholder="https://example.com/product/123"
          />
          <button
            type="button"
            style={{
              background: '#6b7280',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
            onClick={onTest}
            disabled={testing}
          >
            {testing ? 'Testing…' : 'Test Selectors'}
          </button>

        </div>
      </div>

      {testError && (
        <div style={{ color: '#dc2626', fontSize: 12, marginTop: 4, marginLeft: 172 }}>{testError}</div>
      )}



      {/* ── Compact AI Proposal summary ── */}
      <div style={panelStyles.divider} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ ...panelStyles.sectionLabel, margin: 0 }}>
          🤖 AI Proposal
        </h3>
        {proposalLoading ? (
          <span style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</span>
        ) : proposal ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span
              style={{
                display: 'inline-block',
                fontSize: 10,
                fontWeight: 700,
                padding: '2px 8px',
                borderRadius: 999,
                textTransform: 'uppercase',
                background:
                  proposal.status === 'validated' || proposal.status === 'promoted'
                    ? '#dcfce7'
                    : proposal.status === 'rejected'
                      ? '#fee2e2'
                      : '#fef3c7',
                color:
                  proposal.status === 'validated' || proposal.status === 'promoted'
                    ? '#16a34a'
                    : proposal.status === 'rejected'
                      ? '#dc2626'
                      : '#d97706',
              }}
            >
              {proposal.status}
            </span>
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              confidence {proposal.confidence.toFixed(2)} ·{' '}
              {proposal.sourceUrl.slice(0, 60)}…
            </span>
            <button
              type="button"
              onClick={() => onReviewProposal?.(proposal, proposalRevisionId)}
              style={{
                background: '#9333ea',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                padding: '6px 14px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Review Proposal →
            </button>
          </div>
        ) : (
          <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
            No AI proposal yet. Click "🤖 Generate Profile" above to create one.
          </span>
        )}
      </div>

      <div style={panelStyles.divider} />

      <div style={panelStyles.divider} />

      {/* ── Actions ── */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          style={{
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '8px 20px',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 14,
          }}
          onClick={onSave}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save Domain'}
        </button>
        <button
          type="button"
          style={{
            background: 'none',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            padding: '8px 16px',
            cursor: 'pointer',
            fontSize: 13,
          }}
          onClick={onCancel}
        >
          Cancel
        </button>
        <div style={{ flex: 1 }} />
        {onShowRetryPreview && (
          <button
            type="button"
            onClick={onShowRetryPreview}
            style={{
              background: '#f59e0b',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              padding: '8px 16px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            title="Show items blocked in Extraction due to profile issues"
          >
            Show Blocked Items
          </button>
        )}
        <button
          type="button"
          onClick={onGenerateProfile}
          disabled={generatingProfile}
          style={{
            background: generatingProfile ? '#dbeafe' : (entry.sitemapUrlsCount > 0 ? '#2563eb' : '#9ca3af'),
            color: generatingProfile ? '#1e40af' : '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '8px 16px',
            fontSize: 13,
            fontWeight: 600,
            cursor: generatingProfile ? 'not-allowed' : (entry.sitemapUrlsCount > 0 ? 'pointer' : 'not-allowed'),
          }}
          title={entry.sitemapUrlsCount > 0 ? 'Generate AI profile for this domain' : 'No cached sitemap URLs — run discovery first'}
        >
          {generatingProfile ? 'Generating…' : '🤖 Generate Profile'}
        </button>
      </div>
    </div>
  );
}

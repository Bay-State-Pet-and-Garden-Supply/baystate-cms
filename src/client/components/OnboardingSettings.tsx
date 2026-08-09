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
  getClassificationReadiness,

  type ApiKeyDisplay,
  type CurationTargetsResponse,
} from '../onboarding-api';
import { readinessViewFromReport } from '../classification-readiness-view';
import type { CurationTargetConfig } from '../../shared/schemas/classification';
import { LlmTaskConfigPanel } from './LlmTaskConfigPanel';
import { LocalAiStatusPanel } from './LocalAiStatusPanel';
import { ProfileBuilder } from './profile-builder/ProfileBuilder';
import { getExtractionWorkerHealth } from '../onboarding-api';
import type { WorkerHealthResponse } from '../../shared/schemas/extraction-worker';

interface OnboardingSettingsProps {
  onBack: () => void;
}

function targetSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(slug) ? slug : `target-${slug || 'field'}`;
}

export function OnboardingSettings({ onBack }: OnboardingSettingsProps) {
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

  // Worker health & profile builder overlay state
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthResponse | null>(null);
  const [workspaceDomain, setWorkspaceDomain] = useState<string | null>(null);

  const [localDomain, setLocalDomain] = useState('');
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
    try {
      const readiness = await getClassificationReadiness();
      setReadinessView(readinessViewFromReport(readiness.readiness));
    } catch {
      setReadinessView(readinessViewFromReport(null));
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
        <LocalAiStatusPanel />
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
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={styles.subsection}>
              <div style={styles.subsectionHeader}>
                <span style={{ ...styles.providerBadge, background: '#7c3aed', color: '#fff' }}>Pages</span>
                <span style={{ fontSize: 12, color: '#6b7280' }}>{curationTargetState.candidates.pages.length} synced pages</span>
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
                    {curationTargetState.candidates.productFields
                      .filter(field => field.catalogField !== 'ProductField16')
                      .map(field => {
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
                                    mandatory: target?.mandatory ?? false,
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

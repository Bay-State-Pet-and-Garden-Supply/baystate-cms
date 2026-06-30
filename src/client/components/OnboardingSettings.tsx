import React, { useState, useEffect } from 'react';
import {
  getApiKeys,
  updateApiKey,
  deleteApiKey,
  getBrandSites,
  deleteBrandSite,
  getDeepseekModels,
  getOllamaModels,
  getExtractorProfiles,
  deleteExtractorProfile,
  saveExtractorProfile,
  type ApiKeyDisplay
} from '../onboarding-api';
import type { BrandSite, ExtractorProfile } from '../../shared/schemas/onboarding';

interface OnboardingSettingsProps {
  onBack: () => void;
}

export function OnboardingSettings({ onBack }: OnboardingSettingsProps) {
  const [keys, setKeys] = useState<ApiKeyDisplay[]>([]);
  const [brandSites, setBrandSites] = useState<BrandSite[]>([]);
  const [extractorProfiles, setExtractorProfiles] = useState<ExtractorProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // State for forms
  const [serperKey, setSerperKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
  const [openaiModel, setOpenaiModel] = useState('');

  const [deepseekKey, setDeepseekKey] = useState('');
  const [deepseekBaseUrl, setDeepseekBaseUrl] = useState('');
  const [deepseekModel, setDeepseekModel] = useState('');

  const [ollamaKey, setOllamaKey] = useState('ollama-default');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState('http://localhost:11434/v1');
  const [ollamaModel, setOllamaModel] = useState('llama3');

  const [activeProvider, setActiveProvider] = useState<'openai' | 'deepseek' | 'ollama'>('deepseek');

  const [deepseekModels, setDeepseekModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [loadingOllamaModels, setLoadingOllamaModels] = useState(false);
  
  const [vlmEnabled, setVlmEnabled] = useState(false);
  const [vlmModel, setVlmModel] = useState('qwen2.5vl:latest');

  const loadDeepseekModels = async (keyVal?: string) => {
    const key = keyVal || deepseekKey;
    if (!key || key.startsWith('••••')) return;
    setLoadingModels(true);
    try {
      const res = await getDeepseekModels(key, deepseekBaseUrl);
      setDeepseekModels(res.models);
      if (res.models.length > 0 && !deepseekModel) {
        setDeepseekModel(res.models[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingModels(false);
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

  const fetchData = async () => {
    setLoading(true);
    setError('');
    try {
      const keysRes = await getApiKeys();
      const brandSitesRes = await getBrandSites();
      const extractorRes = await getExtractorProfiles();

      setKeys(keysRes.keys);
      setBrandSites(brandSitesRes.brandSites);
      setExtractorProfiles(extractorRes.extractorProfiles);

      // Populate form fields from DB
      const serper = keysRes.keys.find(k => k.service === 'serper');
      if (serper) setSerperKey(serper.apiKey);

      const openai = keysRes.keys.find(k => k.service === 'openai');
      if (openai) {
        setOpenaiKey(openai.apiKey);
        setOpenaiBaseUrl(openai.baseUrl || '');
        setOpenaiModel(openai.model || 'gpt-4o-mini');
      }

      const deepseek = keysRes.keys.find(k => k.service === 'deepseek');
      if (deepseek) {
        setDeepseekKey(deepseek.apiKey);
        setDeepseekBaseUrl(deepseek.baseUrl || 'https://api.deepseek.com');
        setDeepseekModel(deepseek.model || 'deepseek-v4-flash');
        // Fetch available models using the saved key on mount
        if (deepseek.apiKey && !deepseek.apiKey.startsWith('••••')) {
          getDeepseekModels().then(res => setDeepseekModels(res.models)).catch(() => { });
        }
      }

      const ollama = keysRes.keys.find(k => k.service === 'ollama');
      if (ollama) {
        setOllamaKey(ollama.apiKey);
        setOllamaBaseUrl(ollama.baseUrl || 'http://localhost:11434/v1');
        setOllamaModel(ollama.model || 'llama3');
        getOllamaModels(ollama.baseUrl || 'http://localhost:11434/v1').then(res => setOllamaModels(res.models)).catch(() => { });
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

  const handleSaveApiKey = async (service: string, keyVal: string, base?: string, model?: string) => {
    if (!keyVal) {
      alert('API Key is required');
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
    if (!confirm(`Are you sure you want to delete API keys for ${service}?`)) return;
    setError('');
    try {
      await deleteApiKey(service);
      alert(`API Settings for ${service} cleared.`);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteBrand = async (id: string) => {
    if (!confirm('Are you sure you want to delete this cached brand site?')) return;
    try {
      await deleteBrandSite(id);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteProfile = async (id: string) => {
    if (!confirm('Are you sure you want to delete this custom extractor profile?')) return;
    try {
      await deleteExtractorProfile(id);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    title: { fontSize: 24, fontWeight: 600, margin: 0 },
    backBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 14 },
    section: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24, marginBottom: 24 },
    sectionTitle: { fontSize: 18, fontWeight: 600, margin: '0 0 16px 0', color: '#111827' },
    formGroup: { marginBottom: 16 },
    label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#4b5563', marginBottom: 6 },
    input: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' },
    buttonRow: { display: 'flex', gap: 12, marginTop: 12 },
    primaryBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 },
    deleteBtn: { background: 'none', border: '1px solid #dc2626', color: '#dc2626', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 },
    table: { width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 14 },
    th: { borderBottom: '2px solid #e5e7eb', textAlign: 'left', padding: '8px 12px', color: '#4b5563', fontWeight: 600 },
    td: { borderBottom: '1px solid #e5e7eb', padding: '8px 12px' },
    cardGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
    error: { color: '#dc2626', padding: 12, background: '#fef2f2', borderRadius: 6, marginBottom: 20, fontSize: 14 }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Onboarding Pipeline Settings</h1>
        <button style={styles.backBtn} onClick={onBack}>← Back to Batches</button>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* ─── SEARCH / DISCOVERY API KEY ─── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Source Discovery Settings</h2>
        <div style={styles.formGroup}>
          <label style={styles.label}>Serper.dev API Key (Google Search API)</label>
          <input
            style={styles.input}
            type="password"
            placeholder="Enter Serper.dev API key"
            value={serperKey.startsWith('••••') ? '' : serperKey}
            onChange={(e) => setSerperKey(e.target.value)}
          />
          {keys.find(k => k.service === 'serper') && (
            <p style={{ fontSize: 12, color: '#16a34a', margin: '4px 0 0' }}>✓ API key configured: {keys.find(k => k.service === 'serper')?.apiKey}</p>
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

      {/* ─── AI EXTRACTION PROVIDERS ─── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>AI Extraction Provider (Optional - for future phases)</h2>
        <div style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
          <button
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: activeProvider === 'deepseek' ? '2px solid #2563eb' : '1px solid #d1d5db',
              background: activeProvider === 'deepseek' ? '#eff6ff' : '#fff',
              cursor: 'pointer',
              fontWeight: 600,
            }}
            onClick={() => setActiveProvider('deepseek')}
          >
            DeepSeek (Recommended)
          </button>
          <button
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: activeProvider === 'openai' ? '2px solid #2563eb' : '1px solid #d1d5db',
              background: activeProvider === 'openai' ? '#eff6ff' : '#fff',
              cursor: 'pointer',
              fontWeight: 600,
            }}
            onClick={() => setActiveProvider('openai')}
          >
            OpenAI
          </button>
          <button
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: activeProvider === 'ollama' ? '2px solid #2563eb' : '1px solid #d1d5db',
              background: activeProvider === 'ollama' ? '#eff6ff' : '#fff',
              cursor: 'pointer',
              fontWeight: 600,
            }}
            onClick={() => setActiveProvider('ollama')}
          >
            Ollama (Local)
          </button>
        </div>

        {activeProvider === 'deepseek' && (
          <div>
            <div style={styles.formGroup}>
              <label style={styles.label}>DeepSeek API Key</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  style={{ ...styles.input, flex: 1 }}
                  type="password"
                  placeholder="sk-..."
                  value={deepseekKey.startsWith('••••') ? '' : deepseekKey}
                  onChange={(e) => setDeepseekKey(e.target.value)}
                />
                <button
                  style={styles.secondaryBtn}
                  onClick={() => loadDeepseekModels(deepseekKey)}
                  disabled={loadingModels || !deepseekKey}
                >
                  {loadingModels ? 'Loading...' : 'Fetch Models'}
                </button>
              </div>
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>DeepSeek Model</label>
              <select
                style={styles.input}
                value={deepseekModel}
                onChange={(e) => setDeepseekModel(e.target.value)}
                disabled={loadingModels}
              >
                {deepseekModels.length === 0 ? (
                  <option value="deepseek-v4-flash">deepseek-v4-flash (default)</option>
                ) : (
                  deepseekModels.map(m => <option key={m} value={m}>{m}</option>)
                )}
              </select>
            </div>
            <div style={styles.buttonRow}>
              <button
                style={styles.primaryBtn}
                onClick={() => handleSaveApiKey('deepseek', deepseekKey, 'https://api.deepseek.com/', deepseekModel)}
              >
                Save DeepSeek
              </button>
            </div>
            {keys.find(k => k.service === 'deepseek') && (
              <p style={{ fontSize: 12, color: '#16a34a', margin: '4px 0 0' }}>
                ✓ API key configured: {keys.find(k => k.service === 'deepseek')?.apiKey}
              </p>
            )}
          </div>
        )}

        {activeProvider === 'openai' && (
          <div>
            <div style={styles.formGroup}>
              <label style={styles.label}>OpenAI API Key</label>
              <input
                style={styles.input}
                type="password"
                placeholder="sk-..."
                value={openaiKey.startsWith('••••') ? '' : openaiKey}
                onChange={(e) => setOpenaiKey(e.target.value)}
              />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>OpenAI Base URL (Optional - leave empty for default)</label>
              <input
                style={styles.input}
                type="text"
                placeholder="https://api.openai.com/v1"
                value={openaiBaseUrl}
                onChange={(e) => setOpenaiBaseUrl(e.target.value)}
              />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>OpenAI Model</label>
              <input
                style={styles.input}
                type="text"
                value={openaiModel}
                onChange={(e) => setOpenaiModel(e.target.value)}
              />
            </div>
            <div style={styles.buttonRow}>
              <button
                style={styles.primaryBtn}
                onClick={() => handleSaveApiKey('openai', openaiKey, openaiBaseUrl, openaiModel)}
              >
                Save OpenAI
              </button>
            </div>
          </div>
        )}

        {activeProvider === 'ollama' && (
          <div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Ollama Base URL</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  style={{ ...styles.input, flex: 1 }}
                  type="text"
                  value={ollamaBaseUrl}
                  onChange={(e) => setOllamaBaseUrl(e.target.value)}
                />
                <button
                  style={styles.backBtn}
                  onClick={() => loadOllamaModels(ollamaBaseUrl)}
                  disabled={loadingOllamaModels}
                >
                  {loadingOllamaModels ? 'Loading...' : 'Fetch Models'}
                </button>
              </div>
            </div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Ollama Model</label>
              <select
                style={styles.input}
                value={ollamaModel}
                onChange={(e) => setOllamaModel(e.target.value)}
                disabled={loadingOllamaModels}
              >
                {ollamaModels.length === 0 ? (
                  <option value="llama3.2:3b">llama3.2:3b (default)</option>
                ) : (
                  ollamaModels.map(m => <option key={m} value={m}>{m}</option>)
                )}
              </select>
            </div>
            <div style={styles.buttonRow}>
              <button
                style={styles.primaryBtn}
                onClick={() => handleSaveApiKey('ollama', ollamaKey, ollamaBaseUrl, ollamaModel)}
              >
                Save Ollama
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─── LOCAL VLM OCR PACKAGING ALIGNMENT ─── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Packaging-Aligned Titles (Local OCR)</h2>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px' }}>
          Uses a local vision model (e.g. Qwen2.5-VL) to perform OCR on the product packaging image.
          Allows aligning the CMS product title with the physical package.
        </p>

        <div style={styles.formGroup}>
          <label style={{ ...styles.label, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={vlmEnabled}
              onChange={(e) => setVlmEnabled(e.target.checked)}
            />
            <span>Enable packaging title OCR via local VLM</span>
          </label>
        </div>

        {vlmEnabled && (
          <div>
            <div style={styles.formGroup}>
              <label style={styles.label}>Ollama Vision Model</label>
              <select
                style={styles.input}
                value={vlmModel}
                onChange={(e) => setVlmModel(e.target.value)}
              >
                {ollamaModels.length === 0 ? (
                  <>
                    <option value="qwen2.5vl:latest">qwen2.5vl:latest (detected)</option>
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
          </div>
        )}
        {!vlmEnabled && keys.find(k => k.service === 'ollama_vlm') && (
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

      {/* ─── CACHED BRAND SITES ─── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Cached Brand Sites ({brandSites.length})</h2>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px' }}>
          Mappings between manufacturer brands and their domains. These are auto-learned when you confirm sources
          and are used to speed up source discovery searches.
        </p>

        {brandSites.length === 0 ? (
          <p style={{ fontSize: 14, color: '#9ca3af', fontStyle: 'italic' }}>No cached domains yet.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Brand Name</th>
                <th style={styles.th}>Domain</th>
                <th style={styles.th}>Hits</th>
                <th style={styles.th}>Last Used</th>
                <th style={styles.th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {brandSites.map((site) => (
                <tr key={site.id}>
                  <td style={styles.td}><strong>{site.brandName.toUpperCase()}</strong></td>
                  <td style={styles.td}>{site.domain}</td>
                  <td style={styles.td}>{site.successCount}</td>
                  <td style={styles.td}>{site.lastUsedAt?.slice(0, 10) ?? '—'}</td>
                  <td style={styles.td}>
                    <button
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#dc2626',
                        cursor: 'pointer',
                        fontWeight: 600,
                        fontSize: 12,
                        padding: 0
                      }}
                      onClick={() => handleDeleteBrand(site.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ─── CUSTOM EXTRACTOR PROFILES ─── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Custom Extractor Profiles ({extractorProfiles.length})</h2>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 16px' }}>
          Site-scoped CSS selector mappings. These override standard extraction heuristics to ensure precise product detail extraction.
        </p>

        {extractorProfiles.length === 0 ? (
          <p style={{ fontSize: 14, color: '#9ca3af', fontStyle: 'italic' }}>No custom selector profiles configured yet.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Domain</th>
                <th style={styles.th}>Title Selector</th>
                <th style={styles.th}>Price</th>
                <th style={styles.th}>Description</th>
                <th style={styles.th}>Images</th>
                <th style={styles.th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {extractorProfiles.map((prof) => (
                <tr key={prof.id}>
                  <td style={styles.td}><strong>{prof.domain}</strong></td>
                  <td style={styles.td}><code style={{ fontSize: 12 }}>{prof.titleSelector || '—'}</code></td>
                  <td style={styles.td}><code style={{ fontSize: 12 }}>{prof.priceSelector || '—'}</code></td>
                  <td style={styles.td}><code style={{ fontSize: 12 }}>{prof.descriptionSelector || '—'}</code></td>
                  <td style={styles.td}><code style={{ fontSize: 12 }}>{prof.imagesSelector || '—'}</code></td>
                  <td style={styles.td}>
                    <button
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#dc2626',
                        cursor: 'pointer',
                        fontWeight: 600,
                        fontSize: 12,
                        padding: 0
                      }}
                      onClick={() => handleDeleteProfile(prof.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

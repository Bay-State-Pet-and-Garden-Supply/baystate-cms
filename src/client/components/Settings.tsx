import React, { useState, useEffect, useRef } from 'react';
import { listFieldRegistry, updateFieldRegistryEntry, getConnection, saveConnection, testConnection } from '../api';
import { ViewHeader } from './common/ViewHeader';
import { AiComputePanel } from './AiComputePanel';
import { colors } from '../theme';

/** Store Settings tab (deep-linked via `?view=settings&tab=ai|catalog`). */
type SettingsTab = 'general' | 'ai' | 'catalog';

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI Compute' },
  { id: 'catalog', label: 'Catalog' },
];

function getInitialSettingsTab(): SettingsTab {
  const tab = new URLSearchParams(window.location.search).get('tab');
  if (tab === 'ai' || tab === 'catalog') return tab;
  return 'general';
}

export function Settings() {
  const [fieldRegistry, setFieldRegistry] = useState<any[]>([]);
  const [loadingFields, setLoadingFields] = useState(false);
  const [savingFields, setSavingFields] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(getInitialSettingsTab);
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});

  // Connection settings state
  const [cgiBaseUrl, setCgiBaseUrl] = useState('');
  const [merchantId, setMerchantId] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfigured, setPasswordConfigured] = useState(false);
  const [savingConn, setSavingConn] = useState(false);
  const [connResult, setConnResult] = useState('');
  const [connError, setConnError] = useState('');

  const [error, setError] = useState('');

  const loadFieldRegistry = async () => {
    setLoadingFields(true);
    try {
      const res = await listFieldRegistry();
      setFieldRegistry(res.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingFields(false);
    }
  };

  const loadConnection = async () => {
    try {
      const res = await getConnection();
      if (res.connection) {
        setCgiBaseUrl(res.connection.cgiBaseUrl || '');
        setMerchantId(res.connection.merchantId || '');
        setPasswordConfigured(res.connection.passwordConfigured);
      }
    } catch (err) {
      console.error('Failed to load connection settings:', err);
    }
  };

  useEffect(() => {
    void loadFieldRegistry();
    void loadConnection();
  }, []);

  // App owns browser history for view navigation. Keep the local tab state in
  // sync when Back/Forward changes the URL while Settings stays mounted.
  useEffect(() => {
    const handlePopState = () => {
      const tab = new URLSearchParams(window.location.search).get('tab');
      setSettingsTab(tab === 'ai' || tab === 'catalog' ? tab : 'general');
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleSettingsTabChange = (next: SettingsTab) => {
    if (next === settingsTab) return;
    setSettingsTab(next);
    // Keep the URL as the source of truth for the active tab so deep links
    // (`?view=settings&tab=ai`) stay live. replaceState avoids history spam.
    const url = new URL(window.location.href);
    if (next === 'general') {
      url.searchParams.delete('tab');
    } else {
      url.searchParams.set('tab', next);
    }
    window.history.replaceState(null, '', url.toString());
  };

  const focusSettingsTab = (next: SettingsTab) => {
    tabRefs.current[next]?.focus();
  };

  const handleTablistKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const focusedTab = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]')?.dataset.settingsTab as SettingsTab | undefined;
    if (event.key === 'Enter' || event.key === ' ') {
      if (!focusedTab) return;
      event.preventDefault();
      handleSettingsTabChange(focusedTab);
      focusSettingsTab(focusedTab);
      return;
    }

    const currentTab = focusedTab ?? settingsTab;
    const currentIndex = SETTINGS_TABS.findIndex((tab) => tab.id === currentTab);
    let nextIndex: number | null = null;

    if (event.key === 'ArrowLeft') {
      nextIndex = currentIndex === 0 ? SETTINGS_TABS.length - 1 : currentIndex - 1;
    } else if (event.key === 'ArrowRight') {
      nextIndex = currentIndex === SETTINGS_TABS.length - 1 ? 0 : currentIndex + 1;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = SETTINGS_TABS.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = SETTINGS_TABS[nextIndex].id;
    handleSettingsTabChange(nextTab);
    focusSettingsTab(nextTab);
  };
  const handleSaveConnection = async () => {
    if (!cgiBaseUrl.trim() || !merchantId.trim()) {
      setConnError('CGI URL and merchant ID are required.');
      return;
    }
    setSavingConn(true);
    setConnError('');
    setConnResult('');
    try {
      await saveConnection(cgiBaseUrl.trim(), merchantId.trim(), password);
      const test = await testConnection();
      setConnResult(`Connection settings saved. ${test.message}`);
      setPasswordConfigured(true);
      setPassword('');
    } catch (err) {
      setConnError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingConn(false);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24, maxWidth: 1200, margin: '0 auto' },
    title: { fontSize: 24, fontWeight: 600, margin: '0 0 24px 0', color: '#111827' },
    section: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24, marginBottom: 24, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
    sectionTitle: { fontSize: 18, fontWeight: 600, margin: '0 0 16px 0', color: '#111827' },
    input: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' as const, marginBottom: 12 },
    select: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' as const, background: '#fff' },
    primaryBtn: { background: colors.uniformGreen, color: colors.feedBagCream, border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    secondaryBtn: { background: '#4b5563', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    table: { width: '100%', borderCollapse: 'collapse' as const, marginTop: 12, fontSize: 14 },
    th: { borderBottom: '2px solid #e5e7eb', textAlign: 'left' as const, padding: '8px 12px', color: '#4b5563', fontWeight: 600 },
    td: { borderBottom: '1px solid #e5e7eb', padding: '8px 12px', verticalAlign: 'middle' },
    error: { color: '#dc2626', padding: 12, background: '#fef2f2', borderRadius: 6, marginBottom: 20, fontSize: 14 },
    success: { color: '#16a34a', padding: 12, background: '#f0fdf4', borderRadius: 6, marginBottom: 20, fontSize: 14 },
    hint: { fontSize: 13, color: '#6b7280', margin: '0 0 16px' },
    empty: { fontSize: 14, color: '#9ca3af', fontStyle: 'italic' as const },
    tabBar: { display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 20 },
    tab: { padding: '8px 16px', fontSize: 14, fontWeight: 500, color: '#4b5563', background: 'transparent', border: 'none', borderBottom: '2px solid transparent', cursor: 'pointer' },
    tabActive: { color: '#111827', fontWeight: 600, borderBottom: `2px solid ${colors.uniformGreen}` },
  };

  return (
    <div style={styles.container}>
      <ViewHeader
        title="Store Settings"
        description="Manage ShopSite CGI API connection, merchant credentials, global AI compute & provider routing, and catalog Field Registry definitions."
      />

      {/* Store Settings tab bar (General / AI Compute / Catalog) */}
      <div
        style={styles.tabBar}
        role="tablist"
        aria-label="Store Settings sections"
        onKeyDown={handleTablistKeyDown}
      >
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            ref={(node) => {
              tabRefs.current[t.id] = node;
            }}
            type="button"
            role="tab"
            id={`settings-tab-${t.id}`}
            data-settings-tab={t.id}
            aria-selected={settingsTab === t.id}
            aria-controls={`settings-tabpanel-${t.id}`}
            tabIndex={settingsTab === t.id ? 0 : -1}
            style={{ ...styles.tab, ...(settingsTab === t.id ? styles.tabActive : {}) }}
            onClick={() => handleSettingsTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* Connection & Credentials Section (General) */}
      <div
        role="tabpanel"
        id="settings-tabpanel-general"
        aria-labelledby="settings-tab-general"
        hidden={settingsTab !== 'general'}
        style={{ display: settingsTab === 'general' ? 'block' : 'none' }}
      >
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>ShopSite Connection & Credentials</h2>
        <p style={styles.hint}>
          Configure your store's direct ShopSite CGI endpoint and credentials.
          Credentials can also be set via environment variables (<code>SHOPSITE_CGI_URL</code>, <code>SHOPSITE_MERCHANT_ID</code>, <code>SHOPSITE_PASSWORD</code>).
        </p>

        {connError && <div style={styles.error}>{connError}</div>}
        {connResult && <div style={styles.success}>{connResult}</div>}

        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>ShopSite CGI Base URL</label>
        <input
          style={styles.input}
          placeholder="https://store.example.com/cgi-bin/bo/db_xml.cgi"
          value={cgiBaseUrl}
          onChange={(e) => setCgiBaseUrl(e.target.value)}
        />

        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>Merchant / User ID</label>
        <input
          style={styles.input}
          placeholder="Merchant ID"
          value={merchantId}
          onChange={(e) => setMerchantId(e.target.value)}
        />

        <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
          {passwordConfigured ? 'Password (configured - leave blank to keep existing)' : 'Password'}
        </label>
        <input
          style={styles.input}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          <button
            type="button"
            style={styles.primaryBtn}
            onClick={handleSaveConnection}
            disabled={savingConn}
          >
            {savingConn ? 'Testing Connection...' : 'Save & Test Connection'}
          </button>
        </div>
      </div>
      </div>

      {/* AI Compute Section — canonical global AI infrastructure surface */}
      <div
        role="tabpanel"
        id="settings-tabpanel-ai"
        aria-labelledby="settings-tab-ai"
        hidden={settingsTab !== 'ai'}
        style={{ display: settingsTab === 'ai' ? 'block' : 'none' }}
      >
        <AiComputePanel onChange={() => setError('')} />
      </div>

      {/* Catalog Field Display Labels Section (Catalog) */}
      <div
        role="tabpanel"
        id="settings-tabpanel-catalog"
        aria-labelledby="settings-tab-catalog"
        hidden={settingsTab !== 'catalog'}
        style={{ display: settingsTab === 'catalog' ? 'block' : 'none' }}
      >
      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <h2 style={{ ...styles.sectionTitle, margin: 0 }}>Catalog Field Display Labels</h2>
          </div>
          <button
            type="button"
            style={styles.primaryBtn}
            onClick={async () => {
              setSavingFields(true);
              try {
                for (const entry of fieldRegistry) {
                  await updateFieldRegistryEntry(entry.id, entry);
                }
                alert('Display labels saved successfully.');
                void loadFieldRegistry();
              } catch (err) {
                alert('Failed to save display labels: ' + (err instanceof Error ? err.message : String(err)));
              } finally {
                setSavingFields(false);
              }
            }}
            disabled={savingFields || loadingFields}
          >
            {savingFields ? 'Saving...' : 'Save Labels'}
          </button>
        </div>
        <p style={styles.hint}>
          Customize how ShopSite XML fields appear throughout the CMS editors. Labels, types, and groupings configured here
          affect the Product Detail editor, Catalog Health reports, and the Catalog Workbench.
          Product attribute mapping for the onboarding pipeline is configured in <strong>Onboarding Settings → Curation</strong>.
        </p>

        {loadingFields ? (
          <p style={styles.empty}>Loading field registry...</p>
        ) : fieldRegistry.length === 0 ? (
          <p style={styles.empty}>No fields discovered yet. Sync catalog products to populate.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={{ ...styles.th, width: '15%' }}>XML Field</th>
                  <th style={{ ...styles.th, width: '25%' }}>Display Label</th>
                  <th style={{ ...styles.th, width: '15%' }}>Data Type</th>
                  <th style={{ ...styles.th, width: '10%' }}>Editable</th>
                  <th style={{ ...styles.th, width: '10%' }}>Required</th>
                  <th style={{ ...styles.th, width: '25%' }}>UI Group</th>
                </tr>
              </thead>
              <tbody>
                {fieldRegistry.map((entry, idx) => (
                  <tr key={entry.id}>
                    <td style={styles.td}>
                      <strong>{entry.xmlField}</strong>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>({entry.kind})</div>
                    </td>
                    <td style={styles.td}>
                      <input
                        style={styles.input}
                        type="text"
                        value={entry.label || ''}
                        onChange={(e) => {
                          const next = [...fieldRegistry];
                          next[idx] = { ...entry, label: e.target.value };
                          setFieldRegistry(next);
                        }}
                      />
                    </td>
                    <td style={styles.td}>
                      <select
                        style={styles.select}
                        value={entry.dataType}
                        onChange={(e) => {
                          const next = [...fieldRegistry];
                          next[idx] = { ...entry, dataType: e.target.value };
                          setFieldRegistry(next);
                        }}
                      >
                        {['string', 'number', 'boolean', 'html', 'image', 'list', 'raw_xml'].map(t => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td style={styles.td}>
                      <input
                        type="checkbox"
                        checked={entry.editable}
                        onChange={(e) => {
                          const next = [...fieldRegistry];
                          next[idx] = { ...entry, editable: e.target.checked };
                          setFieldRegistry(next);
                        }}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        type="checkbox"
                        checked={entry.required}
                        disabled={!entry.editable}
                        onChange={(e) => {
                          const next = [...fieldRegistry];
                          next[idx] = { ...entry, required: e.target.checked };
                          setFieldRegistry(next);
                        }}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        style={styles.input}
                        type="text"
                        value={entry.uiGroup || ''}
                        onChange={(e) => {
                          const next = [...fieldRegistry];
                          next[idx] = { ...entry, uiGroup: e.target.value || null };
                          setFieldRegistry(next);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

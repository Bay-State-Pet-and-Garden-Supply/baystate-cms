import React, { useState, useEffect } from 'react';
import { initWorkspace, openWorkspace, pickDirectory, bootstrapFromXml, bootstrapFromFile, bootstrapFromPull, getBootstrapStatus, getConnection, saveConnection, testConnection, getRecentWorkspaces, removeRecentWorkspace, type RecentWorkspace } from '../api';

interface Props {
  onComplete: () => void;
  onUpdated?: () => void;
}

export function SetupWizard({ onComplete, onUpdated: _onUpdated }: Props) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('My Store');
  const [workspacePath, setWorkspacePath] = useState('');
  const [xmlInput, setXmlInput] = useState('');
  const [filePath, setFilePath] = useState('');
  const [cgiBaseUrl, setCgiBaseUrl] = useState('');
  const [merchantId, setMerchantId] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [polling, setPolling] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [passwordConfigured, setPasswordConfigured] = useState(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);

  useEffect(() => {
    if (step === 0) {
      loadRecents();
    }
  }, [step]);

  const loadRecents = async () => {
    try {
      const res = await getRecentWorkspaces();
      if (res.success && res.workspaces) {
        setRecentWorkspaces(res.workspaces);
      }
    } catch (err) {
      console.error('Failed to load recent workspaces:', err);
    }
  };

  const handleOpenRecent = async (path: string) => {
    setLoading(true);
    setError('');
    setResult('');
    try {
      const res = await openWorkspace(path);
      setResult(`Workspace "${res.workspace.name}" opened.`);
      if (res.workspace.bootstrapStatus === 'complete' && res.workspace.baselineCommit) {
        onComplete();
        return;
      }
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveRecent = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    if (confirm('Are you sure you want to remove this workspace from your recent list?')) {
      try {
        await removeRecentWorkspace(path);
        loadRecents();
      } catch (err) {
        setError(`Failed to remove workspace: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  useEffect(() => {
    if (step === 1) {
      const loadConnectionSettings = async () => {
        try {
          const res = await getConnection();
          if (res.connection) {
            setCgiBaseUrl(res.connection.cgiBaseUrl || '');
            setMerchantId(res.connection.merchantId || '');
            setPasswordConfigured(res.connection.passwordConfigured);
          }
        } catch (err) {
          console.error('Failed to load saved connection settings:', err);
        }
      };
      loadConnectionSettings();
    }
  }, [step]);

  const startPollingStatus = (successPrefix: string) => {
    setPolling(true);
    setLoading(true);
    setStatusMessage('Initializing catalog import in the background...');
    
    const interval = setInterval(async () => {
      try {
        const res = await getBootstrapStatus();
        if (res.bootstrapStatus === 'complete') {
          clearInterval(interval);
          setPolling(false);
          setLoading(false);
          setResult(`${successPrefix} Baseline commit: ${res.baselineCommit || 'N/A'}`);
          setStep(2);
        } else if (res.bootstrapStatus === 'failed') {
          clearInterval(interval);
          setPolling(false);
          setLoading(false);
          setError(res.error || 'Bootstrap failed in the background. Check server logs.');
        } else if (res.bootstrapStatus === 'running') {
          setStatusMessage('Importing products from ShopSite, parsing XML, and writing Git catalog files...');
        }
      } catch (err) {
        clearInterval(interval);
        setPolling(false);
        setLoading(false);
        setError(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, 2000);
  };

  const handlePickDirectory = async () => {
    setError('');
    try {
      const res = await pickDirectory();
      if (res.success && res.path) {
        setWorkspacePath(res.path);
      } else if (res.error !== 'cancelled') {
        setError(res.message || 'Failed to select directory');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleInit = async () => {
    if (!name.trim() || !workspacePath.trim()) {
      setError('Name and path are required');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await initWorkspace(name.trim(), workspacePath.trim());
      setResult(`Workspace "${res.workspace.name}" created.`);
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleOpen = async () => {
    if (!workspacePath.trim()) {
      setError('Workspace path is required');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await openWorkspace(workspacePath.trim());
      setResult(`Workspace "${res.workspace.name}" opened.`);
      // If workspace is already bootstrapped, enter the app immediately
      if (res.workspace.bootstrapStatus === 'complete' && res.workspace.baselineCommit) {
        onComplete();
        return;
      }
      setStep(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveConnection = async () => {
    if (!cgiBaseUrl.trim() || !merchantId.trim() || (!password && !passwordConfigured)) {
      setError('CGI URL, merchant/user ID, and password are required to enable direct sync. You can skip this and use XML import/export fallback.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await saveConnection(cgiBaseUrl.trim(), merchantId.trim(), password);
      const test = await testConnection();
      setResult(`Connection saved. ${test.message}`);
      setPasswordConfigured(true);
      setPassword(''); // Clear password field after save
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleBootstrapFromPull = async () => {
    setLoading(true);
    setError('');
    setResult('');
    try {
      await bootstrapFromPull();
      startPollingStatus('Bootstrap complete! Products successfully imported from ShopSite.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  const handleBootstrapXml = async () => {
    if (!xmlInput.trim()) {
      setError('XML content is required');
      return;
    }
    setLoading(true);
    setError('');
    setResult('');
    try {
      await bootstrapFromXml(xmlInput.trim());
      startPollingStatus('Bootstrap complete! Products successfully imported from pasted XML.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  const handleFileBootstrap = async () => {
    if (!filePath.trim()) {
      setError('File path is required');
      return;
    }
    setLoading(true);
    setError('');
    setResult('');
    try {
      await bootstrapFromFile(filePath.trim());
      startPollingStatus('Bootstrap complete! Products successfully imported from XML file.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { maxWidth: 600, margin: '0 auto', padding: 24 },
    input: { width: '100%', padding: 8, margin: '8px 0', fontSize: 14, border: '1px solid #ccc', borderRadius: 4 },
    textarea: { width: '100%', height: 150, padding: 8, margin: '8px 0', fontSize: 13, border: '1px solid #ccc', borderRadius: 4, fontFamily: 'monospace' },
    button: { padding: '10px 20px', fontSize: 14, cursor: 'pointer', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 4, margin: '4px' },
    secondary: { padding: '10px 20px', fontSize: 14, cursor: 'pointer', background: '#6b7280', color: '#fff', border: 'none', borderRadius: 4, margin: '4px' },
    title: { fontSize: 24, fontWeight: 600, marginBottom: 8 },
    error: { color: '#dc2626', padding: '8px 12px', background: '#fef2f2', borderRadius: 4, margin: '8px 0' },
    result: { color: '#16a34a', padding: '8px 12px', background: '#f0fdf4', borderRadius: 4, margin: '8px 0', whiteSpace: 'pre-wrap' as any },
    section: { marginTop: 16, padding: 16, border: '1px solid #e5e7eb', borderRadius: 8 },
    heading: { fontSize: 18, fontWeight: 500, marginBottom: 8 },
    inputContainer: { display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' },
    inputWithButton: { flex: 1, padding: 8, fontSize: 14, border: '1px solid #ccc', borderRadius: 4, margin: 0 },
    pickerButton: { padding: '8px 16px', fontSize: 14, cursor: 'pointer', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 4, whiteSpace: 'nowrap' },
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>ShopSite CMS Setup</h1>

      {error && <div style={styles.error}>{error}</div>}
      {result && <div style={styles.result}>{result}</div>}
      {polling && (
        <div style={{ color: '#2563eb', padding: '12px', background: '#eff6ff', borderRadius: 4, margin: '8px 0', fontWeight: 500 }}>
          ⏳ {statusMessage}
        </div>
      )}

      {step === 0 && (
        <div>
          {recentWorkspaces.length > 0 && (
            <div style={styles.section}>
              <h2 style={styles.heading}>Recent Workspaces</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {recentWorkspaces.map(ws => (
                  <div
                    key={ws.path}
                    onClick={() => handleOpenRecent(ws.path)}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '12px 16px',
                      border: '1px solid #e5e7eb',
                      borderRadius: 6,
                      background: '#fff',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.borderColor = '#2563eb';
                      e.currentTarget.style.background = '#f8fafc';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.borderColor = '#e5e7eb';
                      e.currentTarget.style.background = '#fff';
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontWeight: 600, color: '#1f2937', fontSize: 14 }}>📁 {ws.name}</span>
                      <span style={{ fontSize: 12, color: '#6b7280', wordBreak: 'break-all' }}>{ws.path}</span>
                    </div>
                    <button
                      onClick={(e) => handleRemoveRecent(e, ws.path)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#9ca3af',
                        fontSize: 18,
                        cursor: 'pointer',
                        padding: '4px 8px',
                        borderRadius: 4,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.background = '#fee2e2'; }}
                      onMouseLeave={e => { e.currentTarget.style.color = '#9ca3af'; e.currentTarget.style.background = 'none'; }}
                      title="Remove from recent list"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={styles.section}>
            <h2 style={styles.heading}>Create New Workspace</h2>
            <input
              style={styles.input}
              placeholder="Workspace name"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <div style={styles.inputContainer}>
              <input
                style={styles.inputWithButton}
                placeholder="Workspace folder path (e.g., /home/user/my-store)"
                value={workspacePath}
                onChange={e => setWorkspacePath(e.target.value)}
              />
              <button style={styles.pickerButton} onClick={handlePickDirectory} type="button">
                Choose Folder...
              </button>
            </div>
            <button style={styles.button} onClick={handleInit} disabled={loading}>
              {loading ? 'Creating...' : 'Create Workspace'}
            </button>
          </div>

          <div style={styles.section}>
            <h2 style={styles.heading}>Open Existing Workspace</h2>
            <div style={styles.inputContainer}>
              <input
                style={styles.inputWithButton}
                placeholder="Workspace folder path"
                value={workspacePath}
                onChange={e => setWorkspacePath(e.target.value)}
              />
              <button style={styles.pickerButton} onClick={handlePickDirectory} type="button">
                Choose Folder...
              </button>
            </div>
            <button style={styles.secondary} onClick={handleOpen} disabled={loading}>
              {loading ? 'Opening...' : 'Open Workspace'}
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <p>Workspace is ready. Configure direct sync if available, or import products from XML/export fallback.</p>

          <div style={styles.section}>
            <h2 style={styles.heading}>Optional Direct Sync Connection</h2>
            <p style={{ fontSize: 13, color: '#4b5563' }}>
              Basic auth works for some ShopSite environments, but authentication is store-specific. If this fails, you can still use XML import/export fallback.
            </p>
            <input
              style={styles.input}
              placeholder="ShopSite CGI URL or script path (e.g., https://store.example.com/cgi-bin/bo/db_xml.cgi)"
              value={cgiBaseUrl}
              onChange={e => setCgiBaseUrl(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder="Merchant/user ID"
              value={merchantId}
              onChange={e => setMerchantId(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder={passwordConfigured ? "Password (configured - leave blank to keep, or enter new one)" : "Password"}
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
            <button style={styles.secondary} onClick={handleSaveConnection} disabled={loading}>
              {loading ? 'Testing...' : 'Save & Test Connection'}
            </button>
            <button style={styles.button} onClick={handleBootstrapFromPull} disabled={loading}>
              {loading ? 'Bootstrapping...' : 'Bootstrap Catalog from ShopSite'}
            </button>
          </div>

          <div style={styles.section}>
            <h2 style={styles.heading}>Paste ShopSite XML</h2>
            <textarea
              style={styles.textarea}
              placeholder="Paste your ShopSite products XML here..."
              value={xmlInput}
              onChange={e => setXmlInput(e.target.value)}
            />
            <button style={styles.button} onClick={handleBootstrapXml} disabled={loading}>
              {loading ? 'Importing...' : 'Import from XML'}
            </button>
          </div>

          <div style={styles.section}>
            <h2 style={styles.heading}>Load from XML File</h2>
            <input
              style={styles.input}
              placeholder="Path to XML file on disk"
              value={filePath}
              onChange={e => setFilePath(e.target.value)}
            />
            <button style={styles.secondary} onClick={handleFileBootstrap} disabled={loading}>
              {loading ? 'Loading...' : 'Load from File'}
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <p>Bootstrap complete! You can now manage products.</p>
          <button style={styles.button} onClick={onComplete}>
            Open Catalog
          </button>
        </div>
      )}


    </div>
  );
}

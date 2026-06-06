import React, { useState } from 'react';
import { initWorkspace, openWorkspace, bootstrapFromXml, bootstrapFromFile, saveConnection, testConnection } from '../api';

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
    if (!cgiBaseUrl.trim() || !merchantId.trim() || !password) {
      setError('CGI URL, merchant/user ID, and password are required to enable direct sync. You can skip this and use XML import/export fallback.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await saveConnection(cgiBaseUrl.trim(), merchantId.trim(), password);
      const test = await testConnection();
      setResult(`Connection saved. ${test.message}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
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
    try {
      const res = await bootstrapFromXml(xmlInput.trim());
      if (res.success) {
        setResult(`Bootstrap complete! ${res.productCount} product(s) imported. Commit: ${res.commitHash}`);
        if (res.warnings.length > 0) {
          setResult(prev => prev + `\nWarnings: ${res.warnings.join(', ')}`);
        }
        setStep(2);
      } else {
        setError(`Bootstrap failed: ${res.errors.join('; ')}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
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
    try {
      const res = await bootstrapFromFile(filePath.trim());
      if (res.success) {
        setResult(`Bootstrap complete! ${res.productCount} product(s) imported. Commit: ${res.commitHash}`);
        setStep(2);
      } else {
        setError(`Bootstrap failed: ${res.errors.join('; ')}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
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
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>ShopSite CMS Setup</h1>

      {error && <div style={styles.error}>{error}</div>}
      {result && <div style={styles.result}>{result}</div>}

      {step === 0 && (
        <div>
          <div style={styles.section}>
            <h2 style={styles.heading}>Create New Workspace</h2>
            <input
              style={styles.input}
              placeholder="Workspace name"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            <input
              style={styles.input}
              placeholder="Workspace folder path (e.g., /home/user/my-store)"
              value={workspacePath}
              onChange={e => setWorkspacePath(e.target.value)}
            />
            <button style={styles.button} onClick={handleInit} disabled={loading}>
              {loading ? 'Creating...' : 'Create Workspace'}
            </button>
          </div>

          <div style={styles.section}>
            <h2 style={styles.heading}>Open Existing Workspace</h2>
            <input
              style={styles.input}
              placeholder="Workspace folder path"
              value={workspacePath}
              onChange={e => setWorkspacePath(e.target.value)}
            />
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
              placeholder="Password"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
            <button style={styles.secondary} onClick={handleSaveConnection} disabled={loading}>
              {loading ? 'Testing...' : 'Save & Test Connection'}
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

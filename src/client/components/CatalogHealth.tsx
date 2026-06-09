import React, { useState, useEffect } from 'react';
import { 
  runCatalogHealthCheck, 
  getCatalogHealthReport, 
  getHealthConfig, 
  saveHealthConfig, 
  type CatalogHealthReport, 
  type CatalogHealthIssue, 
  type HealthRuleConfig 
} from '../api';

const STYLE_RULES = `
  .health-container {
    padding: 32px 24px;
    max-width: 1200px;
    margin: 0 auto;
    color: #1f2937;
    animation: fadeIn 0.4s ease-out;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .health-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 32px;
    gap: 16px;
    flex-wrap: wrap;
  }
  .health-title-group h1 {
    font-size: 28px;
    font-weight: 800;
    color: #111827;
    margin: 0 0 6px 0;
    letter-spacing: -0.6px;
  }
  .health-title-group p {
    color: #6b7280;
    margin: 0;
    font-size: 14px;
    font-weight: 500;
  }
  .header-buttons {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .btn-primary {
    background: linear-gradient(135deg, #4f46e5 0%, #6366f1 100%);
    color: white;
    border: none;
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 0 4px 12px rgba(79, 70, 229, 0.25);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .btn-primary:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 6px 16px rgba(79, 70, 229, 0.35);
    filter: brightness(1.05);
  }
  .btn-primary:active:not(:disabled) {
    transform: translateY(1px);
  }
  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    box-shadow: none;
  }
  .btn-secondary {
    background: white;
    color: #374151;
    border: 1px solid #e5e7eb;
    padding: 10px 18px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .btn-secondary:hover:not(:disabled) {
    background: #f9fafb;
    border-color: #cbd5e1;
    color: #111827;
  }
  .btn-secondary.active {
    background: #f5f3ff;
    border-color: #c7d2fe;
    color: #4f46e5;
  }
  
  /* KPI Cards */
  .health-kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 20px;
    margin-bottom: 32px;
  }
  .health-kpi-card {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 24px;
    position: relative;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
    transition: all 0.2s;
  }
  .health-kpi-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 20px rgba(0, 0, 0, 0.03);
    border-color: #cbd5e1;
  }
  .kpi-score-ring {
    position: absolute;
    top: 24px;
    right: 24px;
    width: 50px;
    height: 50px;
  }
  .kpi-label {
    font-size: 12px;
    font-weight: 700;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 8px;
  }
  .kpi-value {
    font-size: 32px;
    font-weight: 800;
    color: #111827;
    line-height: 1.1;
    margin-bottom: 8px;
  }
  .kpi-subtext {
    font-size: 13px;
    color: #6b7280;
    font-weight: 500;
  }

  /* Configuration Panel */
  .settings-panel {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 32px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.03);
    animation: slideDown 0.25s ease-out;
  }
  @keyframes slideDown {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .settings-title-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    padding-bottom: 12px;
    border-bottom: 1px solid #f3f4f6;
  }
  .settings-title-row h2 {
    font-size: 18px;
    font-weight: 800;
    color: #111827;
    margin: 0;
    letter-spacing: -0.4px;
  }
  .rules-grid {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 24px;
    max-height: 400px;
    overflow-y: auto;
    padding-right: 8px;
  }
  .rule-config-row {
    display: grid;
    grid-template-columns: 2fr 1fr;
    align-items: center;
    gap: 16px;
    padding: 12px 16px;
    border: 1px solid #f3f4f6;
    background: #fafafa;
    border-radius: 10px;
    transition: all 0.2s;
  }
  .rule-config-row:hover {
    border-color: #cbd5e1;
    background: #f8fafc;
  }
  @media (max-width: 640px) {
    .rule-config-row {
      grid-template-columns: 1fr;
      align-items: flex-start;
      gap: 12px;
    }
  }
  .rule-info h4 {
    margin: 0 0 4px 0;
    font-size: 13.5px;
    font-weight: 700;
    color: #1f2937;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .rule-info p {
    margin: 0;
    font-size: 12px;
    color: #6b7280;
  }
  .rule-default-badge {
    font-size: 10px;
    background: #e2e8f0;
    color: #475569;
    padding: 1px 6px;
    border-radius: 4px;
    font-weight: 500;
  }
  .severity-select-wrapper {
    display: flex;
    justify-content: flex-end;
    width: 100%;
  }
  .severity-select {
    padding: 8px 12px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background-color: white;
    font-size: 13px;
    font-weight: 600;
    color: #374151;
    outline: none;
    cursor: pointer;
    transition: all 0.15s;
    width: 100%;
    max-width: 160px;
    box-sizing: border-box;
  }
  .severity-select:focus {
    border-color: #4f46e5;
    box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12);
  }
  .settings-actions {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding-top: 16px;
    border-top: 1px solid #f3f4f6;
  }

  /* Filters */
  .filter-section {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .search-input-wrapper {
    position: relative;
    flex-grow: 1;
    max-width: 400px;
  }
  .search-input {
    width: 100%;
    padding: 8px 12px 8px 36px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    font-size: 14px;
    transition: all 0.15s;
    outline: none;
    box-sizing: border-box;
  }
  .search-input:focus {
    border-color: #4f46e5;
    box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12);
  }
  .search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: #9ca3af;
    pointer-events: none;
  }
  .filter-tabs {
    display: flex;
    gap: 8px;
  }
  .filter-btn {
    background: #f3f4f6;
    border: 1px solid transparent;
    color: #4b5563;
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .filter-btn:hover {
    background: #e5e7eb;
    color: #1f2937;
  }
  .filter-btn.active {
    background: #e0e7ff;
    color: #4f46e5;
    border-color: #c7d2fe;
  }

  /* Issue Cards */
  .issues-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .product-issue-card {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.01);
    transition: all 0.2s;
  }
  .product-issue-card:hover {
    border-color: #cbd5e1;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.02);
  }
  .product-card-header {
    padding: 16px 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    background: #fafafa;
    user-select: none;
  }
  .product-card-header:hover {
    background: #f5f5f5;
  }
  .product-title-area {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .product-badge-blocker {
    background: #fef2f2;
    color: #dc2626;
    border: 1px solid #fee2e2;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .product-badge-warning {
    background: #fffbeb;
    color: #d97706;
    border: 1px solid #fef3c7;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .product-badge-info {
    background: #f0fdf4;
    color: #16a34a;
    border: 1px solid #dcfce7;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .product-meta h3 {
    margin: 0 0 2px 0;
    font-size: 15px;
    font-weight: 700;
    color: #111827;
  }
  .product-meta span {
    font-size: 12px;
    color: #6b7280;
    font-weight: 500;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .btn-edit-product {
    background: white;
    border: 1px solid #d1d5db;
    color: #374151;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .btn-edit-product:hover {
    background: #f9fafb;
    border-color: #cbd5e1;
    color: #111827;
  }
  .chevron-icon {
    transition: transform 0.2s ease;
    color: #6b7280;
  }
  .chevron-icon.open {
    transform: rotate(180deg);
  }
  .product-card-body {
    padding: 16px 20px;
    border-top: 1px solid #f3f4f6;
    background: white;
    display: flex;
    flex-direction: column;
    gap: 10px;
    animation: slideDown 0.2s ease-out;
  }
  .issue-row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 8px 12px;
    border-radius: 6px;
  }
  .issue-row.blocker {
    background: #fff5f5;
    border-left: 4px solid #f87171;
  }
  .issue-row.warning {
    background: #fffbeb;
    border-left: 4px solid #fbbf24;
  }
  .issue-row.info {
    background: #f0fdf4;
    border-left: 4px solid #4ade80;
  }
  .issue-icon {
    margin-top: 2px;
    flex-shrink: 0;
  }
  .issue-text {
    flex-grow: 1;
  }
  .issue-msg {
    font-size: 13px;
    font-weight: 600;
    color: #1f2937;
    margin: 0 0 2px 0;
  }
  .issue-code {
    font-size: 11px;
    font-family: monospace;
    font-weight: 600;
    color: #6b7280;
  }
  .issue-field {
    margin-left: 8px;
    background: rgba(0, 0, 0, 0.05);
    padding: 1px 4px;
    border-radius: 4px;
  }

  /* Empty state */
  .empty-state {
    text-align: center;
    padding: 48px 24px;
    background: white;
    border: 1px dashed #d1d5db;
    border-radius: 12px;
    color: #6b7280;
  }
  .empty-state h3 {
    margin: 0 0 8px 0;
    color: #111827;
    font-size: 16px;
    font-weight: 700;
  }
  .empty-state p {
    margin: 0;
    font-size: 14px;
  }
`;

interface CatalogHealthProps {
  onSelectProduct: (sku: string) => void;
}

export function CatalogHealth({ onSelectProduct }: CatalogHealthProps) {
  const [report, setReport] = useState<CatalogHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'blockers' | 'warnings' | 'healthy'>('all');
  const [expandedProducts, setExpandedProducts] = useState<Record<string, boolean>>({});

  // Configuration States
  const [showSettings, setShowSettings] = useState(false);
  const [rules, setRules] = useState<HealthRuleConfig[]>([]);
  const [savingSettings, setSavingSettings] = useState(false);

  const fetchReport = async () => {
    try {
      setLoading(true);
      const data = await getCatalogHealthReport();
      setReport(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load health report');
    } finally {
      setLoading(false);
    }
  };

  const fetchConfig = async () => {
    try {
      const data = await getHealthConfig();
      setRules(data.rules);
    } catch (err) {
      console.error('Failed to load health rules config:', err);
    }
  };

  useEffect(() => {
    fetchReport();
    fetchConfig();
  }, []);

  const handleRunScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const data = await runCatalogHealthCheck();
      setReport(data);
      // Automatically expand products with issues in the new scan
      const newExp: Record<string, boolean> = {};
      data.issues.forEach(i => {
        newExp[i.sku] = true;
      });
      setExpandedProducts(newExp);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Catalog health check failed');
    } finally {
      setScanning(false);
    }
  };

  const handleSeverityChange = (code: string, severity: 'blocker' | 'warning' | 'info' | 'disabled') => {
    setRules(prev => prev.map(r => r.code === code ? { ...r, severity } : r));
  };

  const handleSaveConfig = async () => {
    setSavingSettings(true);
    setError(null);
    try {
      await saveHealthConfig(rules);
      setShowSettings(false);
      // Immediately run a catalog health check scan using the new configuration
      await handleRunScan();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save health settings');
    } finally {
      setSavingSettings(false);
    }
  };

  const handleRestoreDefaults = () => {
    setRules(prev => prev.map(r => ({ ...r, severity: r.defaultSeverity })));
  };

  const toggleProduct = (sku: string, e: React.MouseEvent) => {
    // If click is on the "Edit Product" button, don't toggle
    if ((e.target as HTMLElement).closest('.btn-edit-product')) {
      return;
    }
    setExpandedProducts(prev => ({ ...prev, [sku]: !prev[sku] }));
  };

  if (loading && !report) {
    return (
      <div style={{ textAlign: 'center', padding: 100 }}>
        <style>{STYLE_RULES}</style>
        <div style={{ display: 'inline-block', width: 40, height: 40, border: '4px solid #f3f4f6', borderTopColor: '#4f46e5', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        <p style={{ marginTop: 16, color: '#6b7280', fontWeight: 600 }}>Loading Catalog Health stats...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const { totalProducts = 0, healthyProducts = 0, unhealthyProducts = 0, totalErrors = 0, totalWarnings = 0, issues = [] } = report || {};

  // Calculate health score percentage
  const healthScore = totalProducts > 0 ? Math.round((healthyProducts / totalProducts) * 100) : 100;

  // Group issues by SKU
  const issuesByProduct: Record<string, { title: string; sku: string; issues: CatalogHealthIssue[] }> = {};
  issues.forEach(issue => {
    if (!issuesByProduct[issue.sku]) {
      issuesByProduct[issue.sku] = {
        sku: issue.sku,
        title: issue.title,
        issues: [],
      };
    }
    issuesByProduct[issue.sku].issues.push(issue);
  });

  // Filter products based on search and selected filter tab
  const productSkus = Object.keys(issuesByProduct);
  const filteredProductsList = productSkus
    .map(sku => issuesByProduct[sku])
    .filter(prod => {
      const matchesSearch = prod.sku.toLowerCase().includes(search.toLowerCase()) || 
                            prod.title.toLowerCase().includes(search.toLowerCase());
      if (!matchesSearch) return false;

      if (filterType === 'blockers') {
        return prod.issues.some(i => i.severity === 'blocker');
      }
      if (filterType === 'warnings') {
        return prod.issues.some(i => i.severity === 'warning');
      }
      return true;
    });

  return (
    <div className="health-container">
      <style>{STYLE_RULES}</style>

      {/* Header */}
      <header className="health-header">
        <div className="health-title-group">
          <h1>Catalog Health Monitor</h1>
          <p>Analyze catalog integrity, check for missing core fields, and validate custom registry definitions.</p>
        </div>
        <div className="header-buttons">
          <button 
            className={`btn-secondary ${showSettings ? 'active' : ''}`}
            onClick={() => setShowSettings(!showSettings)}
            disabled={scanning}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
            Configure Rules
          </button>
          <button className="btn-primary" onClick={handleRunScan} disabled={scanning || savingSettings}>
            {scanning ? (
              <>
                <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid #e5e7eb', borderTopColor: '#374151', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                Scanning...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 8H18" />
                </svg>
                Scan Catalog
              </>
            )}
          </button>
        </div>
      </header>

      {/* Rules Config Panel */}
      {showSettings && (
        <section className="settings-panel">
          <div className="settings-title-row">
            <h2>Configure Catalog Validation Rules</h2>
            <button className="btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={handleRestoreDefaults}>
              Reset to Defaults
            </button>
          </div>

          <div className="rules-grid">
            {rules.map(rule => (
              <div key={rule.code} className="rule-config-row">
                <div className="rule-info">
                  <h4>
                    {rule.name}
                    <span className="rule-default-badge">Default: {rule.defaultSeverity}</span>
                  </h4>
                  <p>{rule.description}</p>
                </div>
                <div className="severity-select-wrapper">
                  <select
                    className="severity-select"
                    value={rule.severity}
                    onChange={(e) => handleSeverityChange(rule.code, e.target.value as any)}
                  >
                    <option value="blocker">Blocker</option>
                    <option value="warning">Warning</option>
                    <option value="info">Info</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>
              </div>
            ))}
          </div>

          <div className="settings-actions">
            <button className="btn-secondary" onClick={() => setShowSettings(false)} disabled={savingSettings}>
              Cancel
            </button>
            <button className="btn-primary" onClick={handleSaveConfig} disabled={savingSettings}>
              {savingSettings ? 'Saving...' : 'Save & Re-Scan'}
            </button>
          </div>
        </section>
      )}

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fee2e2', padding: '12px 16px', borderRadius: 8, color: '#991b1b', fontSize: 13, fontWeight: 600, marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* KPI Row */}
      <section className="health-kpi-grid">
        <div className="health-kpi-card" style={{ background: 'linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%)' }}>
          <div className="kpi-label">Health Score</div>
          <div className="kpi-value" style={{ color: healthScore > 90 ? '#10b981' : healthScore > 75 ? '#f59e0b' : '#dc2626' }}>
            {healthScore}%
          </div>
          <div className="kpi-subtext">
            {healthScore === 100 ? 'Catalog is fully compliant' : `${healthyProducts} of ${totalProducts} SKUs healthy`}
          </div>
          {/* Circular mini badge */}
          <div className="kpi-score-ring">
            <svg width="50" height="50" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#e2e8f0" strokeWidth="3" />
              <circle cx="18" cy="18" r="15.9155" fill="none" 
                      stroke={healthScore > 90 ? '#10b981' : healthScore > 75 ? '#f59e0b' : '#dc2626'} 
                      strokeWidth="3"
                      strokeDasharray={`${healthScore} ${100 - healthScore}`}
                      strokeDashoffset="0"
                      transform="rotate(-90 18 18)"
              />
            </svg>
          </div>
        </div>

        <div className="health-kpi-card">
          <div className="kpi-label">Total Products</div>
          <div className="kpi-value">{totalProducts}</div>
          <div className="kpi-subtext">Indexed in SQLite database</div>
        </div>

        <div className="health-kpi-card" style={totalErrors > 0 ? { borderLeft: '4px solid #ef4444' } : {}}>
          <div className="kpi-label">Blockers</div>
          <div className="kpi-value" style={{ color: totalErrors > 0 ? '#ef4444' : '#111827' }}>{totalErrors}</div>
          <div className="kpi-subtext">Must fix before sync/publish</div>
        </div>

        <div className="health-kpi-card" style={totalWarnings > 0 ? { borderLeft: '4px solid #f59e0b' } : {}}>
          <div className="kpi-label">Warnings</div>
          <div className="kpi-value" style={{ color: totalWarnings > 0 ? '#f59e0b' : '#111827' }}>{totalWarnings}</div>
          <div className="kpi-subtext">Optimizations & field audits</div>
        </div>
      </section>

      {/* Filter and Search Bar */}
      <section className="filter-section">
        <div className="search-input-wrapper">
          <svg className="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            className="search-input"
            placeholder="Search by SKU or name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            id="health-search-input"
          />
        </div>

        <div className="filter-tabs">
          <button 
            className={`filter-btn ${filterType === 'all' ? 'active' : ''}`}
            onClick={() => setFilterType('all')}
          >
            All Issues ({productSkus.length})
          </button>
          <button 
            className={`filter-btn ${filterType === 'blockers' ? 'active' : ''}`}
            onClick={() => setFilterType('blockers')}
            style={{ display: totalErrors > 0 ? 'inline-block' : 'none' }}
          >
            Blockers Only
          </button>
          <button 
            className={`filter-btn ${filterType === 'warnings' ? 'active' : ''}`}
            onClick={() => setFilterType('warnings')}
            style={{ display: totalWarnings > 0 ? 'inline-block' : 'none' }}
          >
            Warnings Only
          </button>
        </div>
      </section>

      {/* Issues List */}
      <section className="issues-list">
        {filteredProductsList.length > 0 ? (
          filteredProductsList.map(prod => {
            const blockersCount = prod.issues.filter(i => i.severity === 'blocker').length;
            const warningsCount = prod.issues.filter(i => i.severity === 'warning').length;
            const infosCount = prod.issues.filter(i => i.severity === 'info').length;
            const isOpen = expandedProducts[prod.sku] ?? false;

            return (
              <div key={prod.sku} className="product-issue-card">
                <div className="product-card-header" onClick={(e) => toggleProduct(prod.sku, e)}>
                  <div className="product-title-area">
                    {blockersCount > 0 ? (
                      <span className="product-badge-blocker">{blockersCount} Blockers</span>
                    ) : warningsCount > 0 ? (
                      <span className="product-badge-warning">{warningsCount} Warnings</span>
                    ) : (
                      <span className="product-badge-info">{infosCount} Infos</span>
                    )}
                    <div className="product-meta">
                      <h3>{prod.title}</h3>
                      <span>SKU: {prod.sku}</span>
                    </div>
                  </div>

                  <div className="header-actions">
                    <button 
                      className="btn-edit-product"
                      onClick={() => onSelectProduct(prod.sku)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 113 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                      Edit Product
                    </button>
                    <svg 
                      className={`chevron-icon ${isOpen ? 'open' : ''}`} 
                      width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>

                {isOpen && (
                  <div className="product-card-body">
                    {prod.issues.map((issue, idx) => (
                      <div key={idx} className={`issue-row ${issue.severity}`}>
                        <div className="issue-icon">
                          {issue.severity === 'blocker' && (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="12" y1="8" x2="12" y2="12" />
                              <line x1="12" y1="16" x2="12.01" y2="16" />
                            </svg>
                          )}
                          {issue.severity === 'warning' && (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5">
                              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                              <line x1="12" y1="9" x2="12" y2="13" />
                              <line x1="12" y1="17" x2="12.01" y2="17" />
                            </svg>
                          )}
                          {issue.severity === 'info' && (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5">
                              <circle cx="12" cy="12" r="10" />
                              <line x1="12" y1="16" x2="12" y2="12" />
                              <line x1="12" y1="9" x2="12.01" y2="9" />
                            </svg>
                          )}
                        </div>
                        <div className="issue-text">
                          <p className="issue-msg">{issue.message}</p>
                          <span className="issue-code">
                            Code: {issue.code}
                            {issue.fieldPath && (
                              <span className="issue-field">Field: {issue.fieldPath}</span>
                            )}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="empty-state">
            <h3>No Catalog Issues Detected</h3>
            <p>
              {search 
                ? "No products matching your search have issues." 
                : "Your catalog is 100% healthy! All products have their required core and custom fields."}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

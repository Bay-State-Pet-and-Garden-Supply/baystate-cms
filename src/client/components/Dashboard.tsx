import React, { useState, useEffect } from 'react';
import { getDashboardStats, checkDrift, type DashboardStats } from '../api';

const STYLE_RULES = `
  .dashboard-container {
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
  .dashboard-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 32px;
    gap: 16px;
    flex-wrap: wrap;
  }
  .dashboard-title-group h1 {
    font-size: 28px;
    font-weight: 800;
    color: #111827;
    margin: 0 0 6px 0;
    letter-spacing: -0.6px;
  }
  .dashboard-title-group p {
    color: #6b7280;
    margin: 0;
    font-size: 14px;
    font-weight: 500;
  }
  .header-actions {
    display: flex;
    gap: 12px;
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

  /* KPI Grid */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 20px;
    margin-bottom: 32px;
  }
  .kpi-card {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 24px;
    position: relative;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    cursor: pointer;
  }
  .kpi-card:hover {
    transform: translateY(-4px);
    box-shadow: 0 12px 24px rgba(0, 0, 0, 0.04), 0 4px 12px rgba(0, 0, 0, 0.02);
    border-color: #cbd5e1;
  }
  .kpi-icon-container {
    position: absolute;
    top: 24px;
    right: 24px;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.3s ease;
  }
  .kpi-card:hover .kpi-icon-container {
    transform: scale(1.08) rotate(3deg);
  }
  .kpi-label {
    font-size: 12px;
    font-weight: 600;
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
    margin-bottom: 12px;
  }
  .kpi-subtext {
    font-size: 13px;
    color: #6b7280;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* Two Column Layout */
  .dashboard-layout {
    display: grid;
    grid-template-columns: 8fr 7fr;
    gap: 28px;
  }
  @media (max-width: 960px) {
    .dashboard-layout {
      grid-template-columns: 1fr;
    }
  }

  .dashboard-panel {
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 24px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
    display: flex;
    flex-direction: column;
  }
  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 1px solid #f3f4f6;
  }
  .panel-header h2 {
    font-size: 16px;
    font-weight: 700;
    color: #111827;
    margin: 0;
    letter-spacing: -0.2px;
  }
  .panel-header-action {
    background: none;
    border: none;
    font-size: 13px;
    font-weight: 600;
    color: #4f46e5;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 6px;
    transition: background-color 0.15s;
  }
  .panel-header-action:hover {
    background: #f5f3ff;
  }

  /* Donut sync chart */
  .chart-section {
    background: linear-gradient(to bottom right, #ffffff, #fcfcff);
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 28px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
  }
  .chart-content {
    display: flex;
    align-items: center;
    justify-content: space-around;
    gap: 24px;
    flex-wrap: wrap;
    margin-top: 12px;
  }
  .donut-container {
    position: relative;
    width: 140px;
    height: 140px;
  }
  .donut-svg {
    transform: rotate(-90deg);
  }
  .donut-center-text {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
  }
  .donut-number {
    font-size: 24px;
    font-weight: 800;
    color: #111827;
    line-height: 1;
  }
  .donut-label {
    font-size: 11px;
    color: #6b7280;
    font-weight: 600;
    margin-top: 2px;
  }
  .chart-legend {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex-grow: 1;
    max-width: 280px;
  }
  .legend-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 13px;
    font-weight: 500;
    color: #4b5563;
  }
  .legend-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .legend-dot {
    width: 12px;
    height: 12px;
    border-radius: 4px;
  }
  .legend-value {
    font-weight: 700;
    color: #111827;
  }

  /* Sync Jobs List */
  .jobs-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .job-card {
    border: 1px solid #f3f4f6;
    background: #f9fafb;
    border-radius: 10px;
    padding: 14px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    transition: all 0.2s;
  }
  .job-card:hover {
    border-color: #cbd5e1;
    background: #f8fafc;
  }
  .job-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .job-title {
    font-size: 13px;
    font-weight: 700;
    color: #1f2937;
  }
  .job-meta {
    font-size: 11px;
    color: #6b7280;
    display: flex;
    gap: 8px;
  }
  .job-status-badge {
    padding: 4px 10px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  /* Activity Feed / Timeline */
  .activity-timeline {
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-height: 480px;
    overflow-y: auto;
    padding-right: 8px;
  }
  .activity-item {
    display: flex;
    gap: 16px;
    position: relative;
  }
  .activity-item::before {
    content: '';
    position: absolute;
    left: 20px;
    top: 40px;
    bottom: -24px;
    width: 2px;
    background: #f3f4f6;
  }
  .activity-item:last-child::before {
    display: none;
  }
  .activity-icon-outer {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    z-index: 2;
    box-shadow: 0 2px 6px rgba(0,0,0,0.03);
  }
  .activity-content {
    flex-grow: 1;
    padding-top: 6px;
  }
  .activity-msg {
    font-size: 13px;
    line-height: 1.5;
    color: #374151;
    margin: 0 0 4px 0;
  }
  .activity-msg strong {
    color: #111827;
  }
  .activity-date {
    font-size: 11px;
    color: #9ca3af;
    font-weight: 500;
  }

  /* Empty state */
  .empty-state {
    padding: 32px;
    text-align: center;
    color: #9ca3af;
    font-size: 14px;
  }
`;

interface DashboardProps {
  onNavigate: (view: 'setup' | 'catalog' | 'changesets' | 'drift' | 'syncjobs' | 'health') => void;
}

export function Dashboard({ onNavigate }: DashboardProps) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkingDrift, setCheckingDrift] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const fetchStats = async () => {
    try {
      setLoading(true);
      const data = await getDashboardStats();
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch dashboard metrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const handleDriftCheck = async () => {
    setCheckingDrift(true);
    setMessage(null);
    try {
      const result = await checkDrift();
      if (result.success) {
        setMessage(`Drift check completed! Found ${result.driftCount} drifted product(s).`);
        await fetchStats();
      } else {
        setError('Drift check finished with errors.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Drift check failed');
    } finally {
      setCheckingDrift(false);
    }
  };

  // Helper to format dates
  const formatTimeAgo = (isoString: string) => {
    try {
      const date = new Date(isoString);
      const now = new Date();
      const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
      
      if (seconds < 5) return 'Just now';
      if (seconds < 60) return `${seconds}s ago`;
      
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      
      const days = Math.floor(hours / 24);
      if (days === 1) return 'Yesterday';
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return isoString;
    }
  };

  // Helper to get audit log styles/icons
  const getActivityMeta = (action: string) => {
    switch (action.toLowerCase()) {
      case 'drift_check':
        return {
          bg: '#fef3c7',
          color: '#d97706',
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          )
        };
      case 'approved':
        return {
          bg: '#d1fae5',
          color: '#059669',
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )
        };
      case 'kept_local':
      case 'accepted_remote':
      case 'resolved':
        return {
          bg: '#e0e7ff',
          color: '#4f46e5',
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          )
        };
      default:
        return {
          bg: '#f3f4f6',
          color: '#4b5563',
          icon: (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )
        };
    }
  };

  const getJobStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case 'succeeded':
        return <span className="job-status-badge badge-success">Succeeded</span>;
      case 'failed':
        return <span className="job-status-badge badge-error">Failed</span>;
      case 'running':
        return <span className="job-status-badge badge-running">Running</span>;
      default:
        return <span className="job-status-badge badge-warning">{status}</span>;
    }
  };

  if (loading && !stats) {
    return (
      <div className="dashboard-container" style={{ textAlign: 'center', padding: 100 }}>
        <style>{STYLE_RULES}</style>
        <div style={{ display: 'inline-block', width: 40, height: 40, border: '4px solid #f3f4f6', borderTopColor: '#4f46e5', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        <p style={{ marginTop: 16, color: '#6b7280', fontWeight: 600 }}>Loading Commander metrics...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="dashboard-container" style={{ padding: 40, background: '#fef2f2', borderRadius: 12, border: '1px solid #fee2e2', margin: 24 }}>
        <style>{STYLE_RULES}</style>
        <h2 style={{ color: '#991b1b', fontSize: 18, margin: '0 0 8px 0' }}>Dashboard Load Error</h2>
        <p style={{ color: '#b91c1c', margin: '0 0 16px 0' }}>{error}</p>
        <button className="btn-secondary" onClick={fetchStats}>Retry Load</button>
      </div>
    );
  }

  const { metrics, connection, recentSyncJobs, recentActivities } = stats!;
  const total = metrics.totalProducts;
  const synced = metrics.syncedProducts;
  const drifted = metrics.driftedProducts;
  const notSynced = metrics.notSyncedProducts;

  // Circle Math for Donut Chart (Radius = 15.9155 makes Circumference = 100)
  const pctSynced = total > 0 ? (synced / total) * 100 : 0;
  const pctDrifted = total > 0 ? (drifted / total) * 100 : 0;
  const pctNotSynced = total > 0 ? (notSynced / total) * 100 : 0;

  return (
    <div className="dashboard-container">
      <style>{STYLE_RULES}</style>

      {/* Header */}
      <header className="dashboard-header">
        <div className="dashboard-title-group">
          <h1>Store Overview</h1>
          <p>Control center for catalog data, remote sync pipelines, and local database drifts.</p>
        </div>
        <div className="header-actions">
          <button 
            className="btn-secondary" 
            onClick={handleDriftCheck}
            disabled={checkingDrift || !connection}
            title={!connection ? "Configure a ShopSite connection to check remote drift" : "Check if local catalog drifts from remote store"}
          >
            {checkingDrift ? (
              <>
                <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid #e5e7eb', borderTopColor: '#374151', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                Checking...
              </>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 8H18" />
                </svg>
                Check Remote Drift
              </>
            )}
          </button>
          <button className="btn-primary" onClick={() => onNavigate('catalog')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Edit Catalog
          </button>
        </div>
      </header>

      {message && (
        <div style={{ background: '#ecfdf5', border: '1px solid #d1fae5', padding: '12px 16px', borderRadius: 8, color: '#065f46', fontSize: 13, fontWeight: 600, marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{message}</span>
          <button style={{ background: 'none', border: 'none', color: '#047857', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setMessage(null)}>✕</button>
        </div>
      )}

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fee2e2', padding: '12px 16px', borderRadius: 8, color: '#991b1b', fontSize: 13, fontWeight: 600, marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button style={{ background: 'none', border: 'none', color: '#b91c1c', cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* KPI Cards Grid */}
      <section className="kpi-grid">
        {/* Total Products */}
        <div className="kpi-card" onClick={() => onNavigate('catalog')}>
          <div className="kpi-icon-container" style={{ background: '#e0e7ff', color: '#4f46e5' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          </div>
          <div className="kpi-label">Total Products</div>
          <div className="kpi-value">{total}</div>
          <div className="kpi-subtext">
            <span>{synced} In-Sync</span>
            <span style={{ color: '#d1d5db' }}>•</span>
            <span>{notSynced} Staged</span>
          </div>
        </div>

        {/* Catalog Health */}
        <div className="kpi-card" onClick={() => onNavigate('health')} style={metrics.productsWithWarnings > 0 ? { borderColor: '#fca5a5', background: '#fff5f5' } : {}}>
          <div className="kpi-icon-container" style={metrics.productsWithWarnings > 0 ? { background: '#fee2e2', color: '#dc2626' } : { background: '#ecfdf5', color: '#10b981' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4" />
            </svg>
          </div>
          <div className="kpi-label">Catalog Health</div>
          <div className="kpi-value" style={metrics.productsWithWarnings > 0 ? { color: '#b91c1c' } : { color: '#047857' }}>
            {total > 0 ? Math.round(((total - metrics.productsWithWarnings) / total) * 100) : 100}%
          </div>
          <div className="kpi-subtext">
            <span>{metrics.productsWithWarnings} SKU(s) with issues</span>
          </div>
        </div>

        {/* Pending Change Sets */}
        <div className="kpi-card" onClick={() => onNavigate('changesets')}>
          <div className="kpi-icon-container" style={{ background: '#ecfdf5', color: '#059669' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div className="kpi-label">Active Drafts</div>
          <div className="kpi-value">{metrics.draftChangeSets}</div>
          <div className="kpi-subtext">
            <span>Pending change sets</span>
          </div>
        </div>

        {/* Open Drifts */}
        <div className="kpi-card" onClick={() => onNavigate('drift')} style={metrics.openDrifts > 0 ? { borderColor: '#fcd34d', background: '#fffbeb' } : {}}>
          <div className="kpi-icon-container" style={metrics.openDrifts > 0 ? { background: '#fef3c7', color: '#d97706' } : { background: '#f3f4f6', color: '#4b5563' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div className="kpi-label">Catalog Drift</div>
          <div className="kpi-value" style={metrics.openDrifts > 0 ? { color: '#b45309' } : {}}>{metrics.openDrifts}</div>
          <div className="kpi-subtext">
            <span>{metrics.openDrifts > 0 ? 'Drifted from remote store' : 'Synced with remote'}</span>
          </div>
        </div>

        {/* Integration Connection */}
        <div className="kpi-card" onClick={() => onNavigate('setup')}>
          {connection ? (
            <>
              <div className="kpi-icon-container" style={connection.lastTestStatus === 'success' ? { background: '#e0f2fe', color: '#0284c7' } : { background: '#fee2e2', color: '#dc2626' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </div>
              <div className="kpi-label">Sync Connection</div>
              <div className="kpi-value" style={{ fontSize: 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 10, marginBottom: 12 }}>
                {connection.cgiBaseUrl.replace(/^https?:\/\//, '').split('/')[0]}
              </div>
              <div className="kpi-subtext">
                <span className={`badge-status ${connection.lastTestStatus === 'success' ? 'badge-success' : 'badge-error'}`} style={{ padding: '2px 6px', fontSize: 10 }}>
                  {connection.lastTestStatus === 'success' ? 'CONNECTED' : 'FAILED'}
                </span>
                {connection.lastTestedAt && <span style={{ fontSize: 11 }}>{formatTimeAgo(connection.lastTestedAt)}</span>}
              </div>
            </>
          ) : (
            <>
              <div className="kpi-icon-container" style={{ background: '#f3f4f6', color: '#9ca3af' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              </div>
              <div className="kpi-label">Sync Connection</div>
              <div className="kpi-value" style={{ fontSize: 20, fontWeight: 700, marginTop: 6, marginBottom: 16 }}>Offline Mode</div>
              <div className="kpi-subtext">
                <span>Configure connection in Setup</span>
              </div>
            </>
          )}
        </div>
      </section>

      {/* Sync Status Donut Panel */}
      <section className="chart-section">
        <div className="panel-header" style={{ borderBottom: 'none', marginBottom: 0 }}>
          <h2>Catalog Integration Status</h2>
        </div>
        <div className="chart-content">
          <div className="donut-container">
            <svg className="donut-svg" width="140" height="140" viewBox="0 0 36 36">
              {/* Background circle */}
              <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#f3f4f6" strokeWidth="3.5" />
              
              {/* Segments stacked */}
              {total > 0 ? (
                <>
                  {/* Synced segment */}
                  {pctSynced > 0 && (
                    <circle 
                      cx="18" cy="18" r="15.9155" fill="none" stroke="#10b981" strokeWidth="3.5"
                      strokeDasharray={`${pctSynced} ${100 - pctSynced}`}
                      strokeDashoffset="0"
                    />
                  )}
                  {/* Drifted segment */}
                  {pctDrifted > 0 && (
                    <circle 
                      cx="18" cy="18" r="15.9155" fill="none" stroke="#f59e0b" strokeWidth="3.5"
                      strokeDasharray={`${pctDrifted} ${100 - pctDrifted}`}
                      strokeDashoffset={-pctSynced}
                    />
                  )}
                  {/* Not Synced segment */}
                  {pctNotSynced > 0 && (
                    <circle 
                      cx="18" cy="18" r="15.9155" fill="none" stroke="#6366f1" strokeWidth="3.5"
                      strokeDasharray={`${pctNotSynced} ${100 - pctNotSynced}`}
                      strokeDashoffset={-(pctSynced + pctDrifted)}
                    />
                  )}
                </>
              ) : (
                <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#d1d5db" strokeWidth="3.5" strokeDasharray="100 0" />
              )}
            </svg>
            <div className="donut-center-text">
              <div className="donut-number">{total}</div>
              <div className="donut-label">SKUs</div>
            </div>
          </div>

          <div className="chart-legend">
            <div className="legend-item">
              <div className="legend-left">
                <span className="legend-dot" style={{ background: '#10b981' }} />
                <span>Synced with ShopSite</span>
              </div>
              <span className="legend-value">{synced} ({total > 0 ? Math.round(pctSynced) : 0}%)</span>
            </div>
            <div className="legend-item">
              <div className="legend-left">
                <span className="legend-dot" style={{ background: '#f59e0b' }} />
                <span>Drifted (needs reconcile)</span>
              </div>
              <span className="legend-value">{drifted} ({total > 0 ? Math.round(pctDrifted) : 0}%)</span>
            </div>
            <div className="legend-item">
              <div className="legend-left">
                <span className="legend-dot" style={{ background: '#6366f1' }} />
                <span>Staged (local drafts)</span>
              </div>
              <span className="legend-value">{notSynced} ({total > 0 ? Math.round(pctNotSynced) : 0}%)</span>
            </div>
          </div>
        </div>
      </section>

      {/* Two Column details section */}
      <div className="dashboard-layout">
        {/* Recent Sync Operations */}
        <div className="dashboard-panel">
          <div className="panel-header">
            <h2>Recent Sync Operations</h2>
            <button className="panel-header-action" onClick={() => onNavigate('syncjobs')}>View All Jobs</button>
          </div>
          {recentSyncJobs.length > 0 ? (
            <div className="jobs-list">
              {recentSyncJobs.map(job => (
                <div key={job.id} className="job-card">
                  <div className="job-info">
                    <div className="job-title">
                      {job.kind === 'push_publish' && '🚀 Push & Publish to ShopSite'}
                      {job.kind === 'upload_only' && '📤 XML Upload'}
                      {job.kind === 'pull_drift' && '🔍 Drift Verification'}
                      {job.kind === 'bootstrap' && '⚙️ Initial Catalog Bootstrap'}
                      {job.kind === 'full_reconcile' && '🔄 Complete Re-sync'}
                      {!['push_publish', 'upload_only', 'pull_drift', 'bootstrap', 'full_reconcile'].includes(job.kind) && `⚙️ Job: ${job.kind}`}
                    </div>
                    <div className="job-meta">
                      {job.startedAt && <span>Started {formatTimeAgo(job.startedAt)}</span>}
                      {job.productCount > 0 && <span>• {job.productCount} SKUs</span>}
                    </div>
                    {job.errorSummary && (
                      <div style={{ color: '#dc2626', fontSize: 11, fontWeight: 600, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 300 }}>
                        ⚠️ {job.errorSummary}
                      </div>
                    )}
                  </div>
                  <div>
                    {getJobStatusBadge(job.status)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">No sync operations have run in this workspace.</div>
          )}
        </div>

        {/* Workspace Activity Feed */}
        <div className="dashboard-panel">
          <div className="panel-header">
            <h2>Workspace Activity Log</h2>
          </div>
          {recentActivities.length > 0 ? (
            <div className="activity-timeline">
              {recentActivities.map(act => {
                const meta = getActivityMeta(act.action);
                return (
                  <div key={act.id} className="activity-item">
                    <div className="activity-icon-outer" style={{ background: meta.bg, color: meta.color }}>
                      {meta.icon}
                    </div>
                    <div className="activity-content">
                      <p className="activity-msg">
                        {act.message.replace(/"([^"]+)"/g, '<strong>$1</strong>')}
                      </p>
                      <span className="activity-date">{formatTimeAgo(act.createdAt)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">No activities recorded. Start editing the catalog or running drift checks!</div>
          )}
        </div>
      </div>
    </div>
  );
}

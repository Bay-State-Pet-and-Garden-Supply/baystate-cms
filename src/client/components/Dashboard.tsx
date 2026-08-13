import React, { useState, useEffect } from 'react';
import { getDashboardStats, checkDrift, type DashboardStats } from '../api';
import { colors, fonts, rounded, themeStyles } from '../theme';
import { ViewHeader } from './common/ViewHeader';

interface DashboardProps {
  onNavigate: (view: 'setup' | 'catalog' | 'changesets' | 'drift' | 'syncjobs' | 'health' | 'onboarding') => void;
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

  // Keyboard Navigation Hotkeys (g c -> Catalog, r -> Drift Check, g o -> Onboarding)
  useEffect(() => {
    let keyBuffer = '';
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['input', 'textarea', 'select'].includes((e.target as HTMLElement)?.tagName?.toLowerCase())) {
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        if (!checkingDrift && stats?.connection) {
          handleDriftCheck();
        }
      } else {
        keyBuffer += e.key.toLowerCase();
        if (keyBuffer.endsWith('gc')) {
          onNavigate('catalog');
          keyBuffer = '';
        } else if (keyBuffer.endsWith('go')) {
          onNavigate('onboarding');
          keyBuffer = '';
        } else if (keyBuffer.length > 5) {
          keyBuffer = keyBuffer.slice(-2);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [checkingDrift, stats]);

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

  const getJobStatusBadge = (status: string) => {
    switch (status.toLowerCase()) {
      case 'succeeded':
        return <span className="badge badge-primary" style={{ backgroundColor: colors.seedlingGreen }}>SUCCEEDED</span>;
      case 'failed':
        return <span className="badge badge-featured">FAILED</span>;
      case 'running':
        return <span className="badge badge-sale">RUNNING</span>;
      default:
        return <span className="badge badge-preorder">{status.toUpperCase()}</span>;
    }
  };

  if (loading && !stats) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 24px', fontFamily: fonts.body, color: colors.ledgerCharcoal }}>
        <div style={{ display: 'inline-block', width: 36, height: 36, border: `4px solid ${colors.cardBorder}`, borderTopColor: colors.uniformGreen, borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
        <p style={{ marginTop: 16, fontWeight: 600, fontSize: 14 }}>Loading Store Operations Overview...</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div style={{ padding: 32, background: colors.whiteSurface, borderRadius: rounded.lg, border: `1px solid ${colors.signetBurgundy}`, margin: 24 }}>
        <h2 style={{ color: colors.signetBurgundy, fontFamily: fonts.display, fontSize: 18, margin: '0 0 8px 0' }}>Dashboard Load Error</h2>
        <p style={{ color: colors.ledgerCharcoal, margin: '0 0 16px 0', fontSize: 14 }}>{error}</p>
        <button className="btn btn-primary" onClick={fetchStats}>Retry Load</button>
      </div>
    );
  }

  const { metrics, connection, recentSyncJobs, recentActivities } = stats!;
  const total = metrics.totalProducts;
  const synced = metrics.syncedProducts;
  const drifted = metrics.driftedProducts;
  const notSynced = metrics.notSyncedProducts;
  const pctSynced = total > 0 ? Math.round((synced / total) * 100) : 100;
  const healthPct = total > 0 ? Math.round(((total - metrics.productsWithWarnings) / total) * 100) : 100;

  return (
    <div style={{ padding: '24px', maxWidth: 1380, margin: '0 auto', fontFamily: fonts.body }}>
      {/* Header Section */}
      <ViewHeader
        title="Store Operations Overview"
        description="Bay State Pet & Garden Supply — 429 Winthrop St catalog management & ShopSite 15 sync pipeline."
        actions={
          <>
            <button 
              className="btn btn-secondary" 
              onClick={handleDriftCheck}
              disabled={checkingDrift || !connection}
              title={!connection ? "Configure ShopSite connection in Setup" : "Check remote ShopSite catalog drift (Hotkey: R)"}
            >
              {checkingDrift ? 'Checking Drift...' : 'Check Remote Drift (R)'}
            </button>
            <button className="btn btn-primary" onClick={() => onNavigate('catalog')}>
              Edit Catalog (G C)
            </button>
          </>
        }
      />

      {/* Action Messages */}
      {message && (
        <div style={{ backgroundColor: colors.feedBagCream, border: `1px solid ${colors.seedlingGreen}`, padding: '12px 16px', borderRadius: rounded.md, color: colors.uniformGreen, fontSize: 13, fontWeight: 600, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{message}</span>
          <button style={{ background: 'none', border: 'none', color: colors.uniformGreen, cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setMessage(null)}>✕</button>
        </div>
      )}

      {error && (
        <div style={{ backgroundColor: '#fee2e2', border: `1px solid ${colors.signetBurgundy}`, padding: '12px 16px', borderRadius: rounded.md, color: colors.signetBurgundy, fontSize: 13, fontWeight: 600, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{error}</span>
          <button style={{ background: 'none', border: 'none', color: colors.signetBurgundy, cursor: 'pointer', fontWeight: 'bold' }} onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* 1. Streamlined Catalog & Sync Status Bar */}
      <section style={{ ...themeStyles.card, padding: '20px 24px', marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: `1px solid ${colors.cardBorder}`, paddingBottom: 12 }}>
          <h2 style={{ fontFamily: fonts.display, fontSize: 16, fontWeight: 700, margin: 0, color: colors.ledgerCharcoal }}>
            Catalog Inventory & Sync Metrics
          </h2>
          <span style={{ fontSize: 11, fontWeight: 600, color: colors.mulchBrown, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Hotkeys: <code style={{ fontFamily: fonts.mono, background: colors.feedBagCream, padding: '2px 4px', borderRadius: rounded.xs }}>G C</code> Catalog · <code style={{ fontFamily: fonts.mono, background: colors.feedBagCream, padding: '2px 4px', borderRadius: rounded.xs }}>G O</code> Onboarding · <code style={{ fontFamily: fonts.mono, background: colors.feedBagCream, padding: '2px 4px', borderRadius: rounded.xs }}>R</code> Drift
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 20 }}>
          {/* Metric 1: Total SKUs */}
          <div style={{ cursor: 'pointer' }} onClick={() => onNavigate('catalog')}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: colors.mulchBrown, letterSpacing: '0.05em', marginBottom: 4 }}>Total Inventory</div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: fonts.body, color: colors.ledgerCharcoal, lineHeight: 1.1 }}>{total} <span style={{ fontSize: 13, fontWeight: 500, color: colors.mulchBrown }}>SKUs</span></div>
            <div style={{ fontSize: 12, color: colors.seedlingGreen, marginTop: 4, fontWeight: 500 }}>{synced} In-Sync with ShopSite</div>
          </div>

          {/* Metric 2: Remote Sync Ratio */}
          <div style={{ cursor: 'pointer' }} onClick={() => onNavigate('drift')}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: colors.mulchBrown, letterSpacing: '0.05em', marginBottom: 4 }}>Sync Coverage</div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: fonts.body, color: drifted > 0 ? colors.signetBurgundy : colors.uniformGreen, lineHeight: 1.1 }}>
              {pctSynced}%
            </div>
            <div style={{ fontSize: 12, color: drifted > 0 ? colors.signetBurgundy : colors.mulchBrown, marginTop: 4, fontWeight: 500 }}>
              {drifted > 0 ? `⚠️ ${drifted} Drifted Product(s)` : `${notSynced} Staged Local Drafts`}
            </div>
          </div>

          {/* Metric 3: Active Change Sets */}
          <div style={{ cursor: 'pointer' }} onClick={() => onNavigate('changesets')}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: colors.mulchBrown, letterSpacing: '0.05em', marginBottom: 4 }}>Active Change Sets</div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: fonts.body, color: colors.ledgerCharcoal, lineHeight: 1.1 }}>{metrics.draftChangeSets}</div>
            <div style={{ fontSize: 12, color: colors.mulchBrown, marginTop: 4, fontWeight: 500 }}>Draft change sets for review</div>
          </div>

          {/* Metric 4: Catalog Health */}
          <div style={{ cursor: 'pointer' }} onClick={() => onNavigate('health')}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: colors.mulchBrown, letterSpacing: '0.05em', marginBottom: 4 }}>Catalog Health</div>
            <div style={{ fontSize: 26, fontWeight: 700, fontFamily: fonts.body, color: healthPct >= 95 ? colors.uniformGreen : colors.signetBurgundy, lineHeight: 1.1 }}>
              {healthPct}%
            </div>
            <div style={{ fontSize: 12, color: metrics.productsWithWarnings > 0 ? colors.signetBurgundy : colors.seedlingGreen, marginTop: 4, fontWeight: 500 }}>
              {metrics.productsWithWarnings > 0 ? `⚠️ ${metrics.productsWithWarnings} SKU(s) with warnings` : 'All health audits passing'}
            </div>
          </div>
        </div>
      </section>

      {/* 2. Onboarding & Curation Pipeline Progress Widget */}
      <section style={{ ...themeStyles.card, padding: '20px 24px', marginBottom: 24, backgroundColor: colors.feedBagCream }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h2 style={{ fontFamily: fonts.display, fontSize: 16, fontWeight: 700, margin: '0 0 2px 0', color: colors.ledgerCharcoal }}>
              Spreadsheet & Package Onboarding Pipeline
            </h2>
            <p style={{ margin: 0, fontSize: 12, color: colors.mulchBrown }}>5-Stage automated product ingestion: Discovery → Extraction → Curation → Review → Promotion</p>
          </div>
          <button className="btn btn-outline" style={{ height: '2.2rem', fontSize: '0.7rem' }} onClick={() => onNavigate('onboarding')}>
            Open Pipeline →
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, background: colors.whiteSurface, padding: 16, borderRadius: rounded.md, border: `1px solid ${colors.cardBorder}` }}>
          <div style={{ padding: 10, borderRight: `1px solid ${colors.cardBorder}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: colors.uniformGreen, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Stage 1</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 2 }}>Discovery</div>
            <div style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 4 }}>URL Search</div>
          </div>

          <div style={{ padding: 10, borderRight: `1px solid ${colors.cardBorder}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: colors.uniformGreen, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Stage 2</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 2 }}>Extraction</div>
            <div style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 4 }}>Profile Scrape</div>
          </div>

          <div style={{ padding: 10, borderRight: `1px solid ${colors.cardBorder}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: colors.uniformGreen, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Stage 3</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 2 }}>Curation</div>
            <div style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 4 }}>OCR & Synthesis</div>
          </div>

          <div style={{ padding: 10, borderRight: `1px solid ${colors.cardBorder}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: colors.signetBurgundy, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Stage 4</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 2 }}>Review</div>
            <div style={{ fontSize: 11, color: colors.signetBurgundy, marginTop: 4, fontWeight: 600 }}>Active Drawer</div>
          </div>

          <div style={{ padding: 10 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: colors.uniformGreen, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Stage 5</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 2 }}>Promotion</div>
            <div style={{ fontSize: 11, color: colors.seedlingGreen, marginTop: 4, fontWeight: 600 }}>CMS Drafts</div>
          </div>
        </div>
      </section>

      {/* 3. Two-Column Workspace Operational Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 24 }}>
        {/* Left Column: Recent Sync Operations */}
        <section style={themeStyles.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${colors.cardBorder}` }}>
            <h2 style={{ fontFamily: fonts.display, fontSize: 16, fontWeight: 700, margin: 0, color: colors.ledgerCharcoal }}>
              Recent Sync Operations
            </h2>
            <button className="btn btn-outline" style={{ height: '2.1rem', fontSize: '0.7rem' }} onClick={() => onNavigate('syncjobs')}>
              View All Jobs
            </button>
          </div>

          {recentSyncJobs.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12, marginBottom: 8 }}>
              {recentSyncJobs.slice(0, 5).map(job => (
                <div key={job.id} style={{ margin: '2px 0', padding: '14px 18px', borderRadius: rounded.md, border: `1px solid ${colors.cardBorder}`, backgroundColor: colors.feedBagCream, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, boxShadow: '0 1px 2px rgba(33, 20, 20, 0.03)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {job.kind === 'push_publish' && 'Push & Publish to ShopSite'}
                      {job.kind === 'upload_only' && 'XML Upload'}
                      {job.kind === 'pull_drift' && 'Drift Verification'}
                      {job.kind === 'bootstrap' && 'Catalog Bootstrap'}
                      {job.kind === 'full_reconcile' && 'Complete Re-sync'}
                      {!['push_publish', 'upload_only', 'pull_drift', 'bootstrap', 'full_reconcile'].includes(job.kind) && `Job: ${job.kind}`}
                    </div>
                    <div style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 4, fontFamily: fonts.mono }}>
                      {job.productCount} product(s) · {job.completedAt ? formatTimeAgo(job.completedAt) : 'In progress'}
                    </div>
                  </div>
                  <div style={{ flexShrink: 0 }}>
                    {getJobStatusBadge(job.status)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: '32px 16px', margin: '12px 0', textAlign: 'center', color: colors.mulchBrown, fontSize: 13 }}>
              No recent sync jobs recorded.
            </div>
          )}
        </section>

        {/* Right Column: Workspace Activity Log */}
        <section style={themeStyles.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${colors.cardBorder}` }}>
            <h2 style={{ fontFamily: fonts.display, fontSize: 16, fontWeight: 700, margin: 0, color: colors.ledgerCharcoal }}>
              Workspace Activity Log
            </h2>
          </div>

          {recentActivities.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 360, overflowY: 'auto', paddingRight: 10, marginTop: 12, marginBottom: 8 }}>
              {recentActivities.slice(0, 6).map(act => (
                <div 
                  key={act.id} 
                  style={{ 
                    display: 'flex', 
                    gap: 14, 
                    alignItems: 'flex-start', 
                    margin: '2px 0',
                    padding: '12px 16px',
                    backgroundColor: colors.feedBagCream,
                    borderRadius: rounded.md,
                    border: `1px solid ${colors.cardBorder}`,
                    boxShadow: '0 1px 2px rgba(33, 20, 20, 0.03)',
                  }}
                >
                  <div style={{ 
                    width: 8, 
                    height: 8, 
                    borderRadius: '50%', 
                    backgroundColor: colors.uniformGreen, 
                    marginTop: 5, 
                    flexShrink: 0,
                    boxShadow: `0 0 0 2px ${colors.whiteSurface}`,
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: colors.ledgerCharcoal, lineHeight: 1.5, wordBreak: 'break-word' }}>
                      {act.message}
                    </div>
                    <div style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 4, fontFamily: fonts.mono }}>
                      {formatTimeAgo(act.createdAt)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: '32px 16px', margin: '12px 0', textAlign: 'center', color: colors.mulchBrown, fontSize: 13 }}>
              No recent workspace activities recorded.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

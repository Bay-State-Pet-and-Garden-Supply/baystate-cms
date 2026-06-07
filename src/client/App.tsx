import React, { useState, useEffect } from 'react';
import { getWorkspace, closeWorkspace, type Workspace } from './api';
import { SetupWizard } from './components/SetupWizard';
import { Catalog } from './components/Catalog';
import { ProductDetail } from './components/ProductDetail';
import { ChangeSetReview } from './components/ChangeSetReview';
import { DriftView } from './components/DriftView';
import { SyncJobsView } from './components/SyncJobsView';
import { Dashboard } from './components/Dashboard';

type View = 'setup' | 'dashboard' | 'catalog' | 'product' | 'changesets' | 'drift' | 'syncjobs';

function App() {
  const [view, setView] = useState<View>('setup');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    getWorkspace().then(res => {
      if (res.workspace) {
        setWorkspace(res.workspace);
        const needsSetup = res.workspace.bootstrapStatus !== 'complete'
          || !res.workspace.baselineCommit;
        setView(needsSetup ? 'setup' : 'dashboard');
      }
      setReady(true);
    }).catch(() => {
      setReady(true);
    });
  }, []);

  const handleSetupComplete = () => {
    getWorkspace().then(res => {
      if (res.workspace) setWorkspace(res.workspace);
    });
    setView('dashboard');
  };

  const handleSetupUpdated = () => {
    getWorkspace().then(res => {
      if (res.workspace) {
        setWorkspace(res.workspace);
        const needsSetup = res.workspace.bootstrapStatus !== 'complete'
          || !res.workspace.baselineCommit;
        setView(needsSetup ? 'setup' : 'dashboard');
      }
    });
  };

  const handleSwitchWorkspace = async () => {
    if (confirm('Are you sure you want to switch to a different workspace? This will close the current workspace.')) {
      try {
        await closeWorkspace();
        setWorkspace(null);
        setView('setup');
      } catch (err) {
        console.error('Failed to close workspace:', err);
        alert('Failed to close workspace: ' + (err instanceof Error ? err.message : String(err)));
      }
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    app: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', minHeight: '100vh', background: '#f9fafb' },
    nav: { background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '8px 24px', display: 'flex', gap: 16, alignItems: 'center' },
    navLink: { background: 'none', border: 'none', fontSize: 14, cursor: 'pointer', color: '#6b7280', padding: '8px 0' },
    navLinkActive: { background: 'none', border: 'none', fontSize: 14, cursor: 'pointer', color: '#2563eb', padding: '8px 0', borderBottom: '2px solid #2563eb', fontWeight: 600 },
    navBrand: { fontSize: 16, fontWeight: 600, color: '#111827', marginRight: 24 },
    navSpacer: { flex: 1 },
    navStatus: { fontSize: 12, color: '#9ca3af' },
    main: { maxWidth: 1200, margin: '0 auto' },
    loading: { padding: 40, textAlign: 'center' as any, color: '#6b7280' },
  };

  if (!ready) {
    return <div style={styles.loading}>Loading ShopSite CMS...</div>;
  }

  return (
    <div style={styles.app}>
      <nav style={styles.nav}>
        <span style={styles.navBrand}>ShopSite CMS</span>
        {workspace && workspace.bootstrapStatus === 'complete' && workspace.baselineCommit && (
          <>
            <button
              style={view === 'dashboard' ? styles.navLinkActive : styles.navLink}
              onClick={() => setView('dashboard')}
            >
              Overview
            </button>
            <button
              style={view === 'catalog' ? styles.navLinkActive : styles.navLink}
              onClick={() => setView('catalog')}
            >
              Catalog
            </button>
            <button
              style={view === 'changesets' ? styles.navLinkActive : styles.navLink}
              onClick={() => setView('changesets')}
            >
              Change Sets
            </button>
            <button
              style={view === 'drift' ? styles.navLinkActive : styles.navLink}
              onClick={() => setView('drift')}
            >
              Drift
            </button>
            <button
              style={view === 'syncjobs' ? styles.navLinkActive : styles.navLink}
              onClick={() => setView('syncjobs')}
            >
              Sync Jobs
            </button>
          </>
        )}
        <div style={styles.navSpacer} />
        <span style={styles.navStatus}>
          {workspace ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              📁 {workspace.name}
              <button
                style={{
                  background: 'none',
                  border: '1px solid #d1d5db',
                  borderRadius: 4,
                  padding: '2px 8px',
                  fontSize: 12,
                  cursor: 'pointer',
                  color: '#4b5563',
                }}
                onClick={handleSwitchWorkspace}
              >
                Switch
              </button>
            </span>
          ) : '⚙️ No workspace'}
        </span>
      </nav>

      <main style={styles.main}>
        {view === 'setup' && (
          <SetupWizard
            onComplete={handleSetupComplete}
            onUpdated={handleSetupUpdated}
          />
        )}

        {view === 'dashboard' && workspace && (
          <Dashboard onNavigate={(targetView) => setView(targetView)} />
        )}

        {view === 'catalog' && workspace && (
          <Catalog
            onSelectProduct={(sku) => { setSelectedSku(sku); setView('product'); }}
            onShowChangeSets={() => setView('changesets')}
          />
        )}

        {view === 'product' && selectedSku && (
          <ProductDetail sku={selectedSku} onBack={() => setView('catalog')} />
        )}

        {view === 'changesets' && <ChangeSetReview />}

        {view === 'drift' && <DriftView />}

        {view === 'syncjobs' && <SyncJobsView />}
      </main>
    </div>
  );
}

export default App;

import React, { useState, useEffect, useRef } from 'react';
import { getWorkspace, closeWorkspace, type Workspace } from './api';
import { SetupWizard } from './components/SetupWizard';
import { Catalog } from './components/Catalog';
import { ProductDetail } from './components/ProductDetail';
import { ChangeSetReview } from './components/ChangeSetReview';
import { DriftView } from './components/DriftView';
import { SyncJobsView } from './components/SyncJobsView';
import { Dashboard } from './components/Dashboard';
import { CatalogHealth } from './components/CatalogHealth';
import { Onboarding } from './components/Onboarding';
import { StoreManagerAssistant } from './components/StoreManagerAssistant';
import { Settings } from './components/Settings';
import { AgentLab } from './components/agent-lab/AgentLab';

type View = 'setup' | 'dashboard' | 'catalog' | 'product' | 'changesets' | 'drift' | 'syncjobs' | 'health' | 'onboarding' | 'assistant' | 'settings' | 'agentlab';

function App() {
  const [view, setView] = useState<View>('setup');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [selectedSku, setSelectedSku] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const hasPushedHistory = useRef(false);

  const handleNavigate = (newView: View, replace = false) => {
    setView(newView);
    const url = new URL(window.location.href);
    if (newView === 'setup') {
      url.searchParams.delete('view');
    } else {
      url.searchParams.set('view', newView);
    }
    if (replace) {
      window.history.replaceState({ view: newView }, '', url.toString());
    } else {
      window.history.pushState({ view: newView }, '', url.toString());
    }
  };

  useEffect(() => {
    getWorkspace().then(res => {
      if (res.workspace) {
        setWorkspace(res.workspace);
        const needsSetup = res.workspace.bootstrapStatus !== 'complete'
          || !res.workspace.baselineCommit;
        
        if (needsSetup) {
          setView('setup');
        } else {
          // Parse view and product SKU from query params on initial load
          const params = new URLSearchParams(window.location.search);
          const sku = params.get('product');
          const urlView = params.get('view') as View | null;
          
          if (sku) {
            setSelectedSku(sku);
            setView(urlView || 'catalog'); // default background view to catalog
          } else if (urlView) {
            setView(urlView);
          } else {
            setView('dashboard');
          }
        }
      }
      setReady(true);
    }).catch(() => {
      setReady(true);
    });
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const sku = params.get('product');
      setSelectedSku(sku);
      
      const urlView = params.get('view') as View | null;
      if (urlView) {
        setView(urlView);
      } else {
        if (workspace && (workspace.bootstrapStatus !== 'complete' || !workspace.baselineCommit)) {
          setView('setup');
        } else {
          setView('dashboard');
        }
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [workspace]);

  useEffect(() => {
    if (selectedSku) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [selectedSku]);

  const handleOpenProduct = (sku: string) => {
    setSelectedSku(sku);
    hasPushedHistory.current = true;
    const url = new URL(window.location.href);
    url.searchParams.set('product', sku);
    window.history.pushState({ sku }, '', url.toString());
  };

  const handleCloseProduct = () => {
    if (hasPushedHistory.current) {
      window.history.back();
    } else {
      const url = new URL(window.location.href);
      url.searchParams.delete('product');
      window.history.replaceState(null, '', url.toString());
      setSelectedSku(null);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCloseProduct();
      }
    };
    if (selectedSku) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedSku]);

  const handleSetupComplete = () => {
    getWorkspace().then(res => {
      if (res.workspace) setWorkspace(res.workspace);
    });
    handleNavigate('dashboard', true);
  };

  const handleSetupUpdated = () => {
    getWorkspace().then(res => {
      if (res.workspace) {
        setWorkspace(res.workspace);
        const needsSetup = res.workspace.bootstrapStatus !== 'complete'
          || !res.workspace.baselineCommit;
        handleNavigate(needsSetup ? 'setup' : 'dashboard', true);
      }
    });
  };

  const handleSwitchWorkspace = async () => {
    if (confirm('Are you sure you want to switch to a different workspace? This will close the current workspace.')) {
      try {
        await closeWorkspace();
        setWorkspace(null);
        handleNavigate('setup', true);
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
              onClick={() => handleNavigate('dashboard')}
            >
              Overview
            </button>
            <button
              style={view === 'catalog' ? styles.navLinkActive : styles.navLink}
              onClick={() => handleNavigate('catalog')}
            >
              Catalog
            </button>
            <button
              style={view === 'onboarding' ? styles.navLinkActive : styles.navLink}
              onClick={() => handleNavigate('onboarding')}
            >
              Onboarding
            </button>
            <button
              style={{ ...styles.navLink, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              onClick={() => handleNavigate('agentlab')}
            >
              🤖 Agent Lab
              <span style={{ display: 'inline-block', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 8, background: '#fef3c7', color: '#92400e' }}>Experimental</span>
            </button>
            <button
              style={view === 'changesets' ? styles.navLinkActive : styles.navLink}
              onClick={() => handleNavigate('changesets')}
            >
              Change Sets
            </button>
            <button
              style={view === 'health' ? styles.navLinkActive : styles.navLink}
              onClick={() => handleNavigate('health')}
            >
              Catalog Health
            </button>
            <button
              style={view === 'assistant' ? styles.navLinkActive : styles.navLink}
              onClick={() => handleNavigate('assistant')}
            >
              Store Manager
            </button>
            <button
              style={view === 'drift' ? styles.navLinkActive : styles.navLink}
              onClick={() => handleNavigate('drift')}
            >
              Drift
            </button>
            <button
              style={view === 'syncjobs' ? styles.navLinkActive : styles.navLink}
              onClick={() => handleNavigate('syncjobs')}
            >
              Sync Jobs
            </button>
            <button
              style={view === 'settings' ? styles.navLinkActive : styles.navLink}
              onClick={() => handleNavigate('settings')}
            >
              Settings
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

      <main style={(view === 'onboarding' || view === 'assistant' || view === 'changesets' || view === 'agentlab') ? { ...styles.main, maxWidth: 'none', margin: 0 } : styles.main}>
        {view === 'setup' && (
          <SetupWizard
            onComplete={handleSetupComplete}
            onUpdated={handleSetupUpdated}
          />
        )}

        {view === 'dashboard' && workspace && (
          <Dashboard onNavigate={(targetView) => handleNavigate(targetView)} />
        )}

        {view === 'catalog' && workspace && (
          <Catalog
            onSelectProduct={handleOpenProduct}
            onShowChangeSets={() => handleNavigate('changesets')}
          />
        )}

        {view === 'changesets' && <ChangeSetReview />}

        {view === 'onboarding' && <Onboarding />}

        {view === 'agentlab' && <AgentLab />}

        {view === 'health' && workspace && (
          <CatalogHealth onSelectProduct={handleOpenProduct} />
        )}

        {view === 'assistant' && workspace && (
          <StoreManagerAssistant onSelectProduct={handleOpenProduct} />
        )}

        {view === 'drift' && <DriftView />}

        {view === 'syncjobs' && <SyncJobsView />}

        {view === 'settings' && <Settings />}
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .spinner {
          display: inline-block;
          width: 20px;
          height: 20px;
          border: 2px solid rgba(0, 0, 0, 0.15);
          border-radius: 50%;
          border-top-color: currentColor;
          animation: spin 0.8s linear infinite;
        }
        .drawer-backdrop {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(15, 23, 42, 0.45);
          backdrop-filter: blur(8px);
          z-index: 1000;
          animation: fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
        .drawer-container {
          position: fixed;
          top: 0;
          right: 0;
          bottom: 0;
          width: 100%;
          max-width: 850px;
          background: #ffffff;
          z-index: 1001;
          box-shadow: -10px 0 30px -5px rgba(15, 23, 42, 0.15);
          animation: slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
          display: flex;
          flex-direction: column;
          height: 100vh;
        }
        .drawer-close-btn {
          position: absolute;
          top: 20px;
          left: -54px;
          width: 38px;
          height: 38px;
          border-radius: 50%;
          background: #ffffff;
          border: 1px solid #e2e8f0;
          box-shadow: -4px 4px 12px rgba(15, 23, 42, 0.08);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          z-index: 1002;
          color: #64748b;
          font-size: 14px;
          font-weight: bold;
        }
        .drawer-close-btn:hover {
          transform: scale(1.08) rotate(90deg);
          color: #0f172a;
          border-color: #cbd5e1;
          box-shadow: -4px 4px 16px rgba(15, 23, 42, 0.12);
        }
        .drawer-body {
          flex: 1;
          overflow-y: auto;
          height: 100%;
        }
        @media (max-width: 950px) {
          .drawer-container {
            max-width: 100%;
          }
          .drawer-close-btn {
            left: auto;
            right: 24px;
            top: 24px;
            background: rgba(255, 255, 255, 0.95);
            border-color: #cbd5e1;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
          }
          .drawer-close-btn:hover {
            transform: scale(1.08) rotate(90deg);
          }
        }
      ` }} />

      {selectedSku && (
        <>
          <div 
            className="drawer-backdrop" 
            onClick={handleCloseProduct}
          />
          <div className="drawer-container">
            <button 
              className="drawer-close-btn" 
              onClick={handleCloseProduct}
              title="Close Panel"
            >
              ✕
            </button>
            <div className="drawer-body">
              <ProductDetail sku={selectedSku} onBack={handleCloseProduct} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default App;

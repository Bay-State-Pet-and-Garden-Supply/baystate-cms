import React, { useState, useEffect } from 'react';
import { checkDrift, listDrift, resolveDrift, fullReconcile, type DriftItem } from '../api';

export function DriftView() {
  const [drifts, setDrifts] = useState<DriftItem[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [driftXml, setDriftXml] = useState('');

  const fetchDrift = async () => {
    try {
      const res = await listDrift();
      setDrifts(res.drifts);
      setOpenCount(res.openCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { fetchDrift(); }, []);

  const handleCheckDrift = async () => {
    if (!driftXml.trim()) {
      setError('Paste remote ShopSite product XML to check for drift.');
      return;
    }
    setLoading(true);
    setError('');
    setResult('');
    try {
      const res = await checkDrift(driftXml);
      setResult(`Drift check complete: ${res.driftCount} product(s) differ from remote.`);
      await fetchDrift();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleResolve = async (id: string, action: 'keep_local' | 'accept_remote' | 'create_change_set') => {
    setLoading(true);
    setError('');
    try {
      const res = await resolveDrift(id, action);
      setResult(`Resolved: ${res.action} for SKU "${res.sku}"`);
      await fetchDrift();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleReconcile = async () => {
    setLoading(true);
    setError('');
    setResult('');
    try {
      const res = await fullReconcile();
      setResult(`Full reconcile complete: ${res.reindexedCount} products reindexed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    title: { fontSize: 24, fontWeight: 600, marginBottom: 16 },
    section: { border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 16 },
    label: { fontSize: 13, fontWeight: 600, marginBottom: 4 },
    textarea: { width: '100%', minHeight: 80, padding: 8, fontSize: 12, border: '1px solid #e5e7eb', borderRadius: 4, fontFamily: 'monospace' },
    btn: { padding: '8px 16px', fontSize: 13, cursor: 'pointer', border: 'none', borderRadius: 4, marginRight: 8 },
    error: { color: '#dc2626', padding: 8, background: '#fef2f2', borderRadius: 4, margin: '8px 0', fontSize: 13 },
    result: { color: '#16a34a', padding: 8, background: '#f0fdf4', borderRadius: 4, margin: '8px 0', fontSize: 13, whiteSpace: 'pre-wrap' as any },
    table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
    th: { padding: '8px 12px', textAlign: 'left' as any, borderBottom: '2px solid #e5e7eb', fontWeight: 600 },
    td: { padding: '8px 12px', borderBottom: '1px solid #e5e7eb' },
    badge: {
      padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, color: '#fff',
    } as React.CSSProperties,
    actionBtn: { padding: '4px 10px', fontSize: 11, cursor: 'pointer', border: 'none', borderRadius: 3, margin: '2px', color: '#fff' },
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Drift Detection</h1>
      <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>
        Detects products that have changed in ShopSite since you last pulled.
        {openCount > 0 && <span style={{ color: '#dc2626', marginLeft: 8 }}>⚠ {openCount} open drift item(s).</span>}
      </p>

      {error && <div style={styles.error}>{error}</div>}
      {result && <div style={styles.result}>{result}</div>}

      <div style={styles.section}>
        <div style={styles.label}>Check for Drift</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
          Paste the raw ShopSite product XML from your store (db_xml.cgi output) to detect remote changes.
        </div>
        <textarea
          style={styles.textarea}
          value={driftXml}
          onChange={(e) => setDriftXml(e.target.value)}
          placeholder="Paste ShopSite products XML here..."
        />
        <div style={{ marginTop: 8 }}>
          <button style={{ ...styles.btn, background: '#2563eb', color: '#fff' }} onClick={handleCheckDrift} disabled={loading}>
            {loading ? 'Checking...' : 'Check Drift'}
          </button>
        </div>
      </div>

      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={styles.label}>Drift Items ({drifts.length})</div>
          <button style={{ ...styles.btn, background: '#6b7280', color: '#fff', fontSize: 11 }} onClick={handleReconcile} disabled={loading}>
            Full Reindex
          </button>
        </div>

        {drifts.length === 0 ? (
          <p style={{ color: '#9ca3af', fontSize: 13 }}>No drift items yet. Run a drift check to detect remote changes.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>SKU</th>
                <th style={styles.th}>Local Name</th>
                <th style={styles.th}>Remote Name</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {drifts.map(d => (
                <tr key={d.id}>
                  <td style={styles.td}><strong>{d.sku}</strong></td>
                  <td style={styles.td}>{d.localProductName ?? '—'}</td>
                  <td style={styles.td}>{d.remoteProductName ?? '—'}</td>
                  <td style={styles.td}><span style={{...styles.badge, background: d.status === 'open' ? '#dc2626' : d.status === 'kept_local' ? '#16a34a' : d.status === 'accepted_remote' ? '#7c3aed' : '#6b7280'}}>{d.status}</span></td>
                  <td style={styles.td}>
                    {d.status === 'open' && (
                      <>
                        <button style={{ ...styles.actionBtn, background: '#16a34a' }} onClick={() => handleResolve(d.id, 'keep_local')}>
                          Keep Local
                        </button>
                        <button style={{ ...styles.actionBtn, background: '#7c3aed' }} onClick={() => handleResolve(d.id, 'accept_remote')}>
                          Accept Remote
                        </button>
                        <button style={{ ...styles.actionBtn, background: '#2563eb' }} onClick={() => handleResolve(d.id, 'create_change_set')}>
                          Reconcile
                        </button>
                      </>
                    )}
                    {d.status !== 'open' && <span style={{ fontSize: 12, color: '#9ca3af' }}>Resolved</span>}
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

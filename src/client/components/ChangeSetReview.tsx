import React, { useState, useEffect } from 'react';
import { listChangeSets, getChangeSet, validateChangeSet, approveChangeSet, discardChangeSet, exportChangeSet, pushPublish, uploadOnly, type ChangeSet, type ChangeSetItem, type ValidationResult } from '../api';

export function ChangeSetReview() {
  const [changeSets, setChangeSets] = useState<ChangeSet[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<ChangeSetItem[]>([]);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const fetch = async () => {
    try {
      const res = await listChangeSets();
      setChangeSets(res.changeSets);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { fetch(); }, []);

  const handleSelect = async (id: string) => {
    setSelected(id);
    setValidation(null);
    setResult('');
    try {
      const res = await getChangeSet(id);
      setItems(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const selectedChangeSet = changeSets.find(cs => cs.id === selected);
  const isDraft = selectedChangeSet?.status === 'draft';
  const isApproved = selectedChangeSet?.status === 'approved';

  const handleValidate = async () => {
    if (!selected) return;
    setLoading(true);
    setError('');
    try {
      const res = await validateChangeSet(selected);
      setValidation(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!selected) return;
    setLoading(true);
    setError('');
    try {
      const res = await approveChangeSet(selected);
      if (res.success) {
        setResult(`Approved! Commit: ${res.commitHash}`);
        await fetch();
      } else {
        setError(res.errors.join('; '));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    if (!selected) return;
    setLoading(true);
    setError('');
    try {
      const res = await exportChangeSet(selected);
      if (res.success) {
        setResult(`Export created: ${res.xmlPath}\nManifest: ${res.manifestPath}`);
      } else {
        setError('Export failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handlePushPublish = async () => {
    if (!selected) return;
    setLoading(true);
    setError('');
    setResult('');
    try {
      const res = await pushPublish(selected);
      if (res.success) {
        setResult(`Push & Publish started! Job: ${res.jobId}, ${res.productCount} product(s).`);
        if (res.warnings.length > 0) {
          setResult(r => r + '\nWarnings: ' + res.warnings.join('; '));
        }
        await fetch();
      } else {
        setError('Push & Publish failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleUploadOnly = async () => {
    if (!selected) return;
    setLoading(true);
    setError('');
    setResult('');
    try {
      const res = await uploadOnly(selected);
      if (res.success) {
        setResult(`Upload completed! Job: ${res.jobId}, ${res.productCount} product(s). Changes may not be visible until publication.`);
        await fetch();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDiscard = async () => {
    if (!selected) return;
    setLoading(true);
    setError('');
    try {
      await discardChangeSet(selected);
      setResult('Change set discarded.');
      setSelected(null);
      setItems([]);
      setValidation(null);
      await fetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const badgeStyle = (s: string): React.CSSProperties => ({
    padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, color: '#fff',
    background: s === 'draft' ? '#f59e0b' : s === 'approved' ? '#16a34a' : s === 'pushed' ? '#2563eb' : s === 'discarded' ? '#6b7280' : '#9ca3af',
  });

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24 },
    title: { fontSize: 24, fontWeight: 600, marginBottom: 16 },
    row: { display: 'flex', gap: 24 },
    col: { flex: 1 },
    list: { border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' },
    listItem: { padding: '12px 16px', borderBottom: '1px solid #e5e7eb', cursor: 'pointer', fontSize: 14 },
    activeItem: { padding: '12px 16px', borderBottom: '1px solid #e5e7eb', cursor: 'pointer', fontSize: 14, background: '#eff6ff' },
    detailCard: { border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 },
    btn: { padding: '8px 16px', fontSize: 13, cursor: 'pointer', border: 'none', borderRadius: 4, margin: '4px' },
    error: { color: '#dc2626', padding: 8, background: '#fef2f2', borderRadius: 4, margin: '8px 0', fontSize: 13 },
    result: { color: '#16a34a', padding: 8, background: '#f0fdf4', borderRadius: 4, margin: '8px 0', fontSize: 13, whiteSpace: 'pre-wrap' as any },
    validationBox: { background: '#f9fafb', borderRadius: 4, padding: 12, marginTop: 8, fontSize: 13 },
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Change Sets</h1>
      {error && <div style={styles.error}>{error}</div>}
      {result && <div style={styles.result}>{result}</div>}

      <div style={styles.row}>
        <div style={styles.col}>
          <div style={styles.list}>
            {changeSets.length === 0 && <p style={{ padding: 16, color: '#9ca3af' }}>No change sets yet.</p>}
            {changeSets.map(cs => (
              <div
                key={cs.id}
                style={selected === cs.id ? styles.activeItem : styles.listItem}
                onClick={() => handleSelect(cs.id)}
              >
                <div><strong>{cs.title}</strong> <span style={badgeStyle(cs.status)}>{cs.status}</span></div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  {cs.createdAt.slice(0, 10)} — {cs.baseCommit.slice(0, 8)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ flex: 2 }}>
          {selected && (
            <div style={styles.detailCard}>
              <h3 style={{ margin: '0 0 8px' }}>Items ({items.length})</h3>
              <ul style={{ margin: '0 0 16px', padding: '0 0 0 20px', fontSize: 14 }}>
                {items.map(i => (
                  <li key={i.sku}>
                    <strong>{i.sku}</strong> — {i.operation}
                    {i.validationStatus !== 'unknown' && (
                      <span style={{ marginLeft: 8, color: i.validationStatus === 'blocked' ? '#dc2626' : i.validationStatus === 'valid' ? '#16a34a' : '#f59e0b' }}>
                        [{i.validationStatus}]
                      </span>
                    )}
                  </li>
                ))}
              </ul>

              {validation && (
                <div style={styles.validationBox}>
                  <strong>Validation:</strong>
                  <span style={{ marginLeft: 8, color: validation.canApprove ? '#16a34a' : '#dc2626' }}>
                    {validation.blockers} blocker(s), {validation.warnings} warning(s)
                  </span>
                  {validation.canApprove ? ' ✅ Can approve' : ' ❌ Blocked'}
                  {validation.items.map(item =>
                    item.results.map(r => (
                      <div key={`${item.sku}-${r.code}`} style={{ marginLeft: 16, color: r.severity === 'blocker' ? '#dc2626' : '#f59e0b' }}>
                        {item.sku}: [{r.code}] {r.message}
                      </div>
                    ))
                  )}
                </div>
              )}

              <div style={{ marginTop: 12, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {isDraft && (
                  <>
                    <button style={{ ...styles.btn, background: '#2563eb', color: '#fff' }} onClick={handleValidate} disabled={loading}>
                      {loading ? '...' : 'Validate'}
                    </button>
                    <button style={{ ...styles.btn, background: '#16a34a', color: '#fff' }} onClick={handleApprove} disabled={loading}>
                      Approve & Commit
                    </button>
                    <button style={{ ...styles.btn, background: '#dc2626', color: '#fff' }} onClick={handleDiscard} disabled={loading}>
                      Discard
                    </button>
                  </>
                )}
                {isApproved && (
                  <>
                    <button style={{ ...styles.btn, background: '#7c3aed', color: '#fff' }} onClick={handleExport} disabled={loading}>
                      Export Package
                    </button>
                    <div style={{ marginTop: 8, padding: '8px 0', borderTop: '1px solid #e5e7eb' }}>
                      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>ShopSite Sync (Direct)</div>
                      <button style={{ ...styles.btn, background: '#059669', color: '#fff' }} onClick={handlePushPublish} disabled={loading}>
                        Push & Publish
                      </button>
                      <button style={{ ...styles.btn, background: '#0284c7', color: '#fff' }} onClick={handleUploadOnly} disabled={loading}>
                        Upload Only
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { listChangeSets, getChangeSet, validateChangeSet, approveChangeSet, discardChangeSet, exportChangeSet, pushPublish, uploadOnly, type ChangeSet, type ChangeSetItem, type ValidationResult } from '../api';

export function ChangeSetReview() {
  const [changeSets, setChangeSets] = useState<ChangeSet[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [items, setItems] = useState<ChangeSetItem[]>([]);
  const [selectedItemSku, setSelectedItemSku] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);

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
    setSelectedItemSku(null);
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

  const selectedItem = items.find(i => i.sku === selectedItemSku);

  const flattenObject = (obj: any, prefix = ''): Record<string, any> => {
    let res: Record<string, any> = {};
    for (const key in obj) {
      const propName = prefix ? `${prefix}.${key}` : key;
      if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
        Object.assign(res, flattenObject(obj[key], propName));
      } else {
        res[propName] = obj[key];
      }
    }
    return res;
  };

  const computeDiff = (base: string | null, draft: string) => {
    try {
      const b = base ? JSON.parse(base) : {};
      const d = JSON.parse(draft);
      const fb = flattenObject(b);
      const fd = flattenObject(d);
      const allKeys = Array.from(new Set([...Object.keys(fb), ...Object.keys(fd)])).sort();
      return allKeys.map(key => {
        const bv = fb[key];
        const dv = fd[key];
        if (!(key in fb)) return { key, status: 'added', baseVal: undefined, draftVal: dv };
        if (!(key in fd)) return { key, status: 'removed', baseVal: bv, draftVal: undefined };
        if (JSON.stringify(bv) !== JSON.stringify(dv)) return { key, status: 'changed', baseVal: bv, draftVal: dv };
        return null;
      }).filter(Boolean) as Array<{ key: string; status: 'added' | 'removed' | 'changed'; baseVal: any; draftVal: any }>;
    } catch (e) {
      return [];
    }
  };

  const handleValidate = async () => {
    if (!selected) return;
    setLoading(true);
    setActiveAction('validate');
    setError('');
    try {
      const res = await validateChangeSet(selected);
      setValidation(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  const handleApprove = async () => {
    if (!selected) return;
    setLoading(true);
    setActiveAction('approve');
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
      setActiveAction(null);
    }
  };

  const handleExport = async () => {
    if (!selected) return;
    setLoading(true);
    setActiveAction('export');
    setError('');
    try {
      const res = await exportChangeSet(selected);
      if (res.success) {
        setResult(`Export created: ${res.xmlPath}\nManifest: ${res.manifestPath}`);
        // Trigger images ZIP download
        window.open(`/api/export/change-set/${selected}/images-zip`, '_blank');
      } else {
        setError('Export failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  const handlePushPublish = async () => {
    if (!selected) return;
    setLoading(true);
    setActiveAction('pushPublish');
    setError('');
    setResult('');
    try {
      const res = await pushPublish(selected);
      if (res.success) {
        setResult(`Push & Publish started! Job: ${res.jobId}, ${res.productCount} product(s).`);
        if (res.warnings.length > 0) {
          setResult(r => r + '\nWarnings: ' + res.warnings.join('; '));
        }
        // Trigger images ZIP download
        window.open(`/api/export/change-set/${selected}/images-zip`, '_blank');
        await fetch();
      } else {
        setError('Push & Publish failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  const handleUploadOnly = async () => {
    if (!selected) return;
    setLoading(true);
    setActiveAction('uploadOnly');
    setError('');
    setResult('');
    try {
      const res = await uploadOnly(selected);
      if (res.success) {
        setResult(`Upload completed! Job: ${res.jobId}, ${res.productCount} product(s). Changes may not be visible until publication.`);
        // Trigger images ZIP download
        window.open(`/api/export/change-set/${selected}/images-zip`, '_blank');
        await fetch();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setActiveAction(null);
    }
  };

  const handleDiscard = async () => {
    if (!selected) return;
    setLoading(true);
    setActiveAction('discard');
    setError('');
    try {
      await discardChangeSet(selected);
      setResult('Change set discarded.');
      setSelected(null);
      setItems([]);
      setSelectedItemSku(null);
      setValidation(null);
      await fetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setActiveAction(null);
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
    diffContainer: { marginTop: 16, border: '1px solid #e5e7eb', borderRadius: 4, overflow: 'hidden', background: '#fff' },
    diffLine: { padding: '4px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 12, display: 'flex', gap: 8, fontFamily: 'monospace' },
    diffAdded: { background: '#f0fdf4', color: '#166534' },
    diffRemoved: { background: '#fef2f2', color: '#991b1b' },
    diffChanged: { background: '#fffbeb', color: '#92400e' },
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

        <div style={{ flex: 3 }}>
          {selected && (
            <div style={styles.detailCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h3 style={{ margin: '0 0 4px' }}>{selectedChangeSet?.title}</h3>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                    Status: <span style={{ fontWeight: 600 }}>{selectedChangeSet?.status}</span> |
                    Base: <code>{selectedChangeSet?.baseCommit.slice(0, 8)}</code>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {isDraft && (
                    <>
                      <button style={{ ...styles.btn, background: '#2563eb', color: '#fff' }} onClick={handleValidate} disabled={loading}>
                        {activeAction === 'validate' ? 'Validating...' : 'Validate'}
                      </button>
                      <button style={{ ...styles.btn, background: '#16a34a', color: '#fff' }} onClick={handleApprove} disabled={loading}>
                        {activeAction === 'approve' ? 'Approving...' : 'Approve & Commit'}
                      </button>
                      <button style={{ ...styles.btn, background: '#dc2626', color: '#fff' }} onClick={handleDiscard} disabled={loading}>
                        {activeAction === 'discard' ? 'Discarding...' : 'Discard'}
                      </button>
                    </>
                  )}
                  {isApproved && (
                    <>
                      <button style={{ ...styles.btn, background: '#7c3aed', color: '#fff' }} onClick={handleExport} disabled={loading}>
                        {activeAction === 'export' ? 'Exporting...' : 'Export Package'}
                      </button>
                      <button style={{ ...styles.btn, background: '#059669', color: '#fff' }} onClick={handlePushPublish} disabled={loading}>
                        {activeAction === 'pushPublish' ? 'Publishing...' : 'Push & Publish'}
                      </button>
                    </>
                  )}
                </div>
              </div>

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

              <div style={{ display: 'flex', gap: 16, marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 16 }}>
                <div style={{ width: 240, borderRight: '1px solid #e5e7eb', paddingRight: 16 }}>
                  <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>Modified Items ({items.length})</h4>
                  <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                    {items.map(i => (
                      <div
                        key={i.sku}
                        onClick={() => setSelectedItemSku(i.sku)}
                        style={{
                          padding: '8px 12px',
                          cursor: 'pointer',
                          borderRadius: 4,
                          fontSize: 13,
                          marginBottom: 2,
                          background: selectedItemSku === i.sku ? '#eff6ff' : 'transparent',
                          border: selectedItemSku === i.sku ? '1px solid #bfdbfe' : '1px solid transparent'
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>{i.sku}</div>
                        <div style={{ fontSize: 11, color: '#6b7280' }}>
                          {i.operation}
                          {i.validationStatus !== 'unknown' && (
                            <span style={{ marginLeft: 4, color: i.validationStatus === 'blocked' ? '#dc2626' : i.validationStatus === 'valid' ? '#16a34a' : '#f59e0b' }}>
                              [{i.validationStatus}]
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ flex: 1 }}>
                  {selectedItem ? (
                    <div>
                      <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>Changes for <strong>{selectedItem.sku}</strong></h4>
                      <div style={styles.diffContainer}>
                        {selectedItem.operation === 'create' && <div style={{...styles.diffLine, ...styles.diffAdded}}>+ (New Product)</div>}
                        {selectedItem.operation === 'archive' && <div style={{...styles.diffLine, ...styles.diffRemoved}}>- (Archived Product)</div>}
                        
                        {computeDiff(selectedItem.baseJson, selectedItem.draftJson).map(diff => (
                          <div key={diff.key} style={{
                            ...styles.diffLine,
                            ...(diff.status === 'added' ? styles.diffAdded : diff.status === 'removed' ? styles.diffRemoved : styles.diffChanged)
                          }}>
                            <span style={{ minWidth: 20, textAlign: 'center' }}>
                              {diff.status === 'added' ? '+' : diff.status === 'removed' ? '-' : '~'}
                            </span>
                            <span style={{ fontWeight: 600, color: '#4b5563' }}>{diff.key}:</span>
                            {diff.status === 'added' && <span>{String(diff.draftVal)}</span>}
                            {diff.status === 'removed' && <span style={{ textDecoration: 'line-through' }}>{String(diff.baseVal)}</span>}
                            {diff.status === 'changed' && (
                              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <span style={{ textDecoration: 'line-through', opacity: 0.6 }}>{String(diff.baseVal)}</span>
                                <span>→</span>
                                <span>{String(diff.draftVal)}</span>
                              </span>
                            )}
                          </div>
                        ))}
                        {computeDiff(selectedItem.baseJson, selectedItem.draftJson).length === 0 && (
                          <div style={{ padding: 16, textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>
                            No field-level changes detected in JSON.
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 13, border: '1px dashed #e5e7eb', borderRadius: 4 }}>
                      Select an item to view changes
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

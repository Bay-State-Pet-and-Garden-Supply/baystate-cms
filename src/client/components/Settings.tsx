import React, { useState, useEffect } from 'react';
import { listFieldRegistry, updateFieldRegistryEntry } from '../api';

export function Settings() {
  const [fieldRegistry, setFieldRegistry] = useState<any[]>([]);
  const [loadingFields, setLoadingFields] = useState(false);
  const [savingFields, setSavingFields] = useState(false);

  const [error, setError] = useState('');

  const loadFieldRegistry = async () => {
    setLoadingFields(true);
    try {
      const res = await listFieldRegistry();
      setFieldRegistry(res.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingFields(false);
    }
  };

  useEffect(() => {
    void loadFieldRegistry();
  }, []);

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24, maxWidth: 1200, margin: '0 auto' },
    title: { fontSize: 24, fontWeight: 600, margin: '0 0 24px 0', color: '#111827' },
    section: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24, marginBottom: 24, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
    sectionTitle: { fontSize: 18, fontWeight: 600, margin: '0 0 16px 0', color: '#111827' },
    input: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' as const },
    select: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' as const, background: '#fff' },
    primaryBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    table: { width: '100%', borderCollapse: 'collapse' as const, marginTop: 12, fontSize: 14 },
    th: { borderBottom: '2px solid #e5e7eb', textAlign: 'left' as const, padding: '8px 12px', color: '#4b5563', fontWeight: 600 },
    td: { borderBottom: '1px solid #e5e7eb', padding: '8px 12px', verticalAlign: 'middle' },
    error: { color: '#dc2626', padding: 12, background: '#fef2f2', borderRadius: 6, marginBottom: 20, fontSize: 14 },
    hint: { fontSize: 13, color: '#6b7280', margin: '0 0 16px' },
    empty: { fontSize: 14, color: '#9ca3af', fontStyle: 'italic' as const },
  };

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Workspace Settings</h1>

      {error && <div style={styles.error}>{error}</div>}

      {/* Catalog Field Display Labels Section */}
      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div>
            <h2 style={{ ...styles.sectionTitle, margin: 0 }}>Catalog Field Display Labels</h2>
          </div>
          <button
            type="button"
            style={styles.primaryBtn}
            onClick={async () => {
              setSavingFields(true);
              try {
                for (const entry of fieldRegistry) {
                  await updateFieldRegistryEntry(entry.id, entry);
                }
                alert('Display labels saved successfully.');
                void loadFieldRegistry();
              } catch (err) {
                alert('Failed to save display labels: ' + (err instanceof Error ? err.message : String(err)));
              } finally {
                setSavingFields(false);
              }
            }}
            disabled={savingFields || loadingFields}
          >
            {savingFields ? 'Saving...' : 'Save Labels'}
          </button>
        </div>
        <p style={styles.hint}>
          Customize how ShopSite XML fields appear throughout the CMS editors. Labels, types, and groupings configured here
          affect the Product Detail editor, Catalog Health reports, and the Catalog Workbench.
          Product attribute mapping for the onboarding pipeline is configured in <strong>Onboarding Settings → Curation</strong>.
        </p>

        {loadingFields ? (
          <p style={styles.empty}>Loading field registry...</p>
        ) : fieldRegistry.length === 0 ? (
          <p style={styles.empty}>No fields discovered yet. Sync catalog products to populate.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={{ ...styles.th, width: '15%' }}>XML Field</th>
                  <th style={{ ...styles.th, width: '25%' }}>Display Label</th>
                  <th style={{ ...styles.th, width: '15%' }}>Data Type</th>
                  <th style={{ ...styles.th, width: '10%' }}>Editable</th>
                  <th style={{ ...styles.th, width: '10%' }}>Required</th>
                  <th style={{ ...styles.th, width: '25%' }}>UI Group</th>
                </tr>
              </thead>
              <tbody>
                {fieldRegistry.map((entry, idx) => (
                  <tr key={entry.id}>
                    <td style={styles.td}>
                      <strong>{entry.xmlField}</strong>
                      <div style={{ fontSize: 11, color: '#6b7280' }}>({entry.kind})</div>
                    </td>
                    <td style={styles.td}>
                      <input
                        style={styles.input}
                        type="text"
                        value={entry.label || ''}
                        onChange={(e) => {
                          const next = [...fieldRegistry];
                          next[idx] = { ...entry, label: e.target.value };
                          setFieldRegistry(next);
                        }}
                      />
                    </td>
                    <td style={styles.td}>
                      <select
                        style={styles.select}
                        value={entry.dataType}
                        onChange={(e) => {
                          const next = [...fieldRegistry];
                          next[idx] = { ...entry, dataType: e.target.value };
                          setFieldRegistry(next);
                        }}
                      >
                        {['string', 'number', 'boolean', 'html', 'image', 'list', 'raw_xml'].map(t => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td style={styles.td}>
                      <input
                        type="checkbox"
                        checked={entry.editable}
                        onChange={(e) => {
                          const next = [...fieldRegistry];
                          next[idx] = { ...entry, editable: e.target.checked };
                          setFieldRegistry(next);
                        }}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        type="checkbox"
                        checked={entry.required}
                        disabled={!entry.editable}
                        onChange={(e) => {
                          const next = [...fieldRegistry];
                          next[idx] = { ...entry, required: e.target.checked };
                          setFieldRegistry(next);
                        }}
                      />
                    </td>
                    <td style={styles.td}>
                      <input
                        style={styles.input}
                        type="text"
                        value={entry.uiGroup || ''}
                        onChange={(e) => {
                          const next = [...fieldRegistry];
                          next[idx] = { ...entry, uiGroup: e.target.value || null };
                          setFieldRegistry(next);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { listFieldRegistry, updateFieldRegistryEntry } from '../api';
import { getClassificationConfig, saveClassificationConfig } from '../onboarding-api';

export function Settings() {
  const [fieldRegistry, setFieldRegistry] = useState<any[]>([]);
  const [loadingFields, setLoadingFields] = useState(false);
  const [savingFields, setSavingFields] = useState(false);

  const [classificationConfig, setClassificationConfig] = useState<any | null>(null);
  const [loadingClassification, setLoadingClassification] = useState(false);
  const [savingClassification, setSavingClassification] = useState(false);

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

  const loadClassification = async () => {
    setLoadingClassification(true);
    try {
      const res = await getClassificationConfig();
      setClassificationConfig(res.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingClassification(false);
    }
  };

  useEffect(() => {
    void loadFieldRegistry();
    void loadClassification();
  }, []);

  const styles: Record<string, React.CSSProperties> = {
    container: { padding: 24, maxWidth: 1200, margin: '0 auto' },
    title: { fontSize: 24, fontWeight: 600, margin: '0 0 24px 0', color: '#111827' },
    section: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 24, marginBottom: 24, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
    sectionTitle: { fontSize: 18, fontWeight: 600, margin: '0 0 16px 0', color: '#111827' },
    formGroup: { marginBottom: 12 },
    label: { display: 'block', fontSize: 13, fontWeight: 500, color: '#4b5563', marginBottom: 6 },
    input: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' as const },
    select: { width: '100%', padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' as const, background: '#fff' },
    primaryBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 14 },
    secondaryBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13, color: '#4b5563' },
    deleteBtn: { background: 'none', border: '1px solid #dc2626', color: '#dc2626', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 12 },
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

      {/* Dynamic Field Registry Section */}
      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ ...styles.sectionTitle, margin: 0 }}>Store Catalog Field Registry</h2>
          <button
            type="button"
            style={styles.primaryBtn}
            onClick={async () => {
              setSavingFields(true);
              try {
                for (const entry of fieldRegistry) {
                  await updateFieldRegistryEntry(entry.id, entry);
                }
                alert('Field registry saved successfully.');
                void loadFieldRegistry();
              } catch (err) {
                alert('Failed to save field registry: ' + (err instanceof Error ? err.message : String(err)));
              } finally {
                setSavingFields(false);
              }
            }}
            disabled={savingFields || loadingFields}
          >
            {savingFields ? 'Saving...' : 'Save Field Registry'}
          </button>
        </div>
        <p style={styles.hint}>
          Discovered custom/core fields in the current store XML. Edit labels to give them clear names in the curation and product editing screens.
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

      {/* Product Attributes & Mappings Section */}
      <div style={styles.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ ...styles.sectionTitle, margin: 0 }}>Product Attribute Mappings</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={styles.secondaryBtn}
              onClick={() => {
                if (!classificationConfig) return;
                const newAttr = {
                  id: 'new_attribute_' + Math.random().toString(36).slice(2, 6),
                  name: 'New Attribute',
                  description: '',
                  valueMode: 'freeText',
                  canonicalUnit: null,
                  allowedValues: [],
                  valueAliases: [],
                  visualEvidenceEligibility: 'eligible',
                  isClaim: false,
                  isCompositionAttribute: false,
                  group: 'Details'
                };
                const newMapping = {
                  id: newAttr.id + '-mapping',
                  attributeId: newAttr.id,
                  catalogField: 'ProductField1',
                  serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' },
                  isStale: false
                };
                setClassificationConfig({
                  ...classificationConfig,
                  attributes: [...(classificationConfig.attributes || []), newAttr],
                  attributeMappings: [...(classificationConfig.attributeMappings || []), newMapping],
                });
              }}
              disabled={loadingClassification || !classificationConfig}
            >
              + Add Attribute
            </button>
            <button
              type="button"
              style={styles.primaryBtn}
              onClick={async () => {
                if (!classificationConfig) return;
                setSavingClassification(true);
                try {
                  const updatedConfig = {
                    ...classificationConfig,
                    manifest: {
                      ...classificationConfig.manifest,
                      updatedAt: new Date().toISOString(),
                    }
                  };
                  await saveClassificationConfig(updatedConfig);
                  alert('Attribute mappings saved successfully.');
                  void loadClassification();
                } catch (err) {
                  alert('Failed to save attribute mappings: ' + (err instanceof Error ? err.message : String(err)));
                } finally {
                  setSavingClassification(false);
                }
              }}
              disabled={savingClassification || loadingClassification || !classificationConfig}
            >
              {savingClassification ? 'Saving...' : 'Save Mappings'}
            </button>
          </div>
        </div>
        <p style={styles.hint}>
          Link high-level product attributes (like Brand, Flavor, or Color) to their respective ShopSite XML columns.
        </p>

        {loadingClassification || !classificationConfig ? (
          <p style={styles.empty}>Loading classification mappings...</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={{ ...styles.th, width: '20%' }}>Attribute Name & ID</th>
                  <th style={{ ...styles.th, width: '20%' }}>Target ShopSite Field</th>
                  <th style={{ ...styles.th, width: '15%' }}>Value Mode</th>
                  <th style={{ ...styles.th, width: '35%' }}>Allowed Values (Controlled Mode)</th>
                  <th style={{ ...styles.th, width: '10%' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(classificationConfig.attributes || []).map((attr: any, idx: number) => {
                  const mappingIdx = (classificationConfig.attributeMappings || []).findIndex(
                    (m: any) => m.attributeId === attr.id
                  );
                  const mapping = mappingIdx !== -1 ? classificationConfig.attributeMappings[mappingIdx] : null;

                  return (
                    <tr key={attr.id}>
                      <td style={styles.td}>
                        <input
                          style={{ ...styles.input, marginBottom: 4 }}
                          type="text"
                          value={attr.name || ''}
                          onChange={(e) => {
                            const nextAttrs = [...classificationConfig.attributes];
                            nextAttrs[idx] = { ...attr, name: e.target.value };
                            setClassificationConfig({ ...classificationConfig, attributes: nextAttrs });
                          }}
                        />
                        <div style={{ fontSize: 11, color: '#6b7280' }}>ID: {attr.id}</div>
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.select}
                          value={mapping?.catalogField || ''}
                          onChange={(e) => {
                            const nextMappings = [...classificationConfig.attributeMappings];
                            if (mappingIdx !== -1) {
                              nextMappings[mappingIdx] = { ...mapping, catalogField: e.target.value };
                            } else {
                              nextMappings.push({
                                id: attr.id + '-mapping',
                                attributeId: attr.id,
                                catalogField: e.target.value,
                                serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' },
                                isStale: false
                              });
                            }
                            setClassificationConfig({ ...classificationConfig, attributeMappings: nextMappings });
                          }}
                        >
                          <option value="">-- Select Field --</option>
                          {fieldRegistry.map(f => (
                            <option key={f.xmlField} value={f.xmlField}>
                              {f.label} ({f.xmlField})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.select}
                          value={attr.valueMode}
                          onChange={(e) => {
                            const nextAttrs = [...classificationConfig.attributes];
                            nextAttrs[idx] = { ...attr, valueMode: e.target.value };
                            setClassificationConfig({ ...classificationConfig, attributes: nextAttrs });
                          }}
                        >
                          <option value="controlled">Controlled</option>
                          <option value="freeText">Free Text</option>
                          <option value="measured">Measured</option>
                        </select>
                      </td>
                      <td style={styles.td}>
                        {attr.valueMode === 'controlled' ? (
                          <textarea
                            style={{ ...styles.input, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                            rows={2}
                            placeholder="Comma-separated values (e.g. Purina, Tuffy, Mazuri)"
                            value={(attr.allowedValues || []).join(', ')}
                            onChange={(e) => {
                              const nextAttrs = [...classificationConfig.attributes];
                              nextAttrs[idx] = {
                                ...attr,
                                allowedValues: e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                              };
                              setClassificationConfig({ ...classificationConfig, attributes: nextAttrs });
                            }}
                          />
                        ) : (
                          <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
                            N/A for {attr.valueMode} mode
                          </span>
                        )}
                      </td>
                      <td style={styles.td}>
                        <button
                          type="button"
                          style={styles.deleteBtn}
                          onClick={() => {
                            if (!confirm(`Are you sure you want to delete attribute ${attr.name}?`)) return;
                            const nextAttrs = classificationConfig.attributes.filter((a: any) => a.id !== attr.id);
                            const nextMappings = classificationConfig.attributeMappings.filter(
                              (m: any) => m.attributeId !== attr.id
                            );
                            setClassificationConfig({
                              ...classificationConfig,
                              attributes: nextAttrs,
                              attributeMappings: nextMappings
                            });
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

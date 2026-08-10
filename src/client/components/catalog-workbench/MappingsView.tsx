import React, { useState, useEffect } from 'react';
import { listAttributeMappings, listCatalogFields, updateFieldMappings, type FieldMappingEditPayload } from '../../api';
import { getClassificationConfig } from '../../onboarding-api';
import type { AttributeMappingView, CatalogFieldSummary } from './types';

/**
 * Editable mirror of ShopSite's Extra Fields configuration.
 *
 * Each row is a Catalog Field (ProductFieldN). The ShopSite-side label is
 * shown read-only from the catalog fields view (labels are owned exclusively
 * by the Catalog Fields surface / field-metadata service), and the field can
 * be linked to a configured Product Attribute or left unmapped. Saving applies
 * the mapping edits to the active classification bundle (mappings.json),
 * refreshes the promotion cache, and commits the scoped change.
 */

interface AttributeOption {
  id: string;
  name: string;
}

interface EditorRow {
  catalogField: string;
  /** Registry label (ShopSite-side name). */
  label: string;
  /** Current mapping, when the field is mapped. */
  mapping: AttributeMappingView | null;
  /** Draft attribute selection ('' = unmapped). */
  attributeId: string;
  /** Draft serialization. */
  serialization: {
    kind: 'scalar' | 'delimited' | 'measured';
    prefix: string;
    suffix: string;
    delimiter: string;
    escapePolicy: 'reject' | 'backslash';
    unit: string;
    valueUnitSeparator: string;
  };
}

const DEFAULT_SERIALIZATION = {
  kind: 'scalar' as const,
  prefix: '',
  suffix: '',
  delimiter: ', ',
  escapePolicy: 'reject' as const,
  unit: '',
  valueUnitSeparator: ' ',
};

function serializationToEditor(raw: unknown): EditorRow['serialization'] {
  const shape = (raw ?? {}) as {
    kind?: string; format?: string; separator?: string;
    prefix?: string; suffix?: string; delimiter?: string;
    escapePolicy?: string; unit?: string; valueUnitSeparator?: string;
  };
  const kind = shape.kind === 'delimited' || shape.kind === 'measured' ? shape.kind
    : shape.format === 'measured' ? 'measured'
    : shape.format === 'delimited' ? 'delimited'
    : 'scalar';
  return {
    kind,
    prefix: shape.prefix ?? '',
    suffix: shape.suffix ?? '',
    delimiter: shape.delimiter ?? shape.separator ?? ', ',
    escapePolicy: shape.escapePolicy === 'backslash' ? 'backslash' : 'reject',
    unit: shape.unit ?? '',
    valueUnitSeparator: shape.valueUnitSeparator ?? ' ',
  };
}

function editorToSerialization(editor: EditorRow['serialization']): FieldMappingEditPayload['serialization'] {
  if (editor.kind === 'delimited') {
    return { kind: 'delimited', delimiter: editor.delimiter || ', ', escapePolicy: editor.escapePolicy, prefix: editor.prefix, suffix: editor.suffix };
  }
  if (editor.kind === 'measured') {
    return { kind: 'measured', unit: editor.unit || 'lb', valueUnitSeparator: editor.valueUnitSeparator || ' ', prefix: editor.prefix, suffix: editor.suffix };
  }
  return { kind: 'scalar', prefix: editor.prefix, suffix: editor.suffix };
}

function fieldNumber(catalogField: string): number {
  const match = /^ProductField(\d+)$/.exec(catalogField);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function MappingsView() {
  const [rows, setRows] = useState<EditorRow[]>([]);
  const [attributes, setAttributes] = useState<AttributeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [mappingsRes, fieldsRes, configRes] = await Promise.all([
        listAttributeMappings(),
        listCatalogFields(),
        getClassificationConfig(),
      ]);
      const mappings = mappingsRes.mappings;
      const mappingByField = new Map(mappings.map(m => [m.catalogField, m]));
      const attrs: AttributeOption[] = (configRes.config?.attributes ?? []).map((a: any) => ({ id: a.id, name: a.name }));

      // Rows: every registered ProductField plus any mapped field not in the registry.
      const fieldSet = new Map<string, CatalogFieldSummary>();
      for (const field of fieldsRes.fields) {
        if (/^ProductField\d+$/.test(field.xmlField)) fieldSet.set(field.xmlField, field);
      }
      for (const mapping of mappings) {
        if (!fieldSet.has(mapping.catalogField)) {
          fieldSet.set(mapping.catalogField, {
            xmlField: mapping.catalogField,
            label: mapping.catalogField,
            kind: 'custom',
            dataType: 'string',
            uiGroup: null,
            nonEmptyCount: 0,
            distinctCount: 0,
            inferredValueMode: 'unknown',
            mappedAttributeId: mapping.attributeId,
            isCurationTarget: false,
            isStale: mapping.isStale,
            warning: null,
          } as CatalogFieldSummary);
        }
      }

      const nextRows = [...fieldSet.entries()]
        .map(([catalogField, field]) => {
          const mapping = mappingByField.get(catalogField) ?? null;
          return {
            catalogField,
            label: mapping ? (field.label === catalogField ? mapping.attributeName : field.label) : field.label,
            mapping,
            attributeId: mapping?.attributeId ?? '',
            serialization: mapping ? serializationToEditor(mapping.serialization) : { ...DEFAULT_SERIALIZATION },
          } as EditorRow;
        })
        .sort((a, b) => fieldNumber(a.catalogField) - fieldNumber(b.catalogField));

      setRows(nextRows);
      setAttributes(attrs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const updateRow = (catalogField: string, patch: Partial<EditorRow>) => {
    setRows(prev => prev.map(row => (row.catalogField === catalogField ? { ...row, ...patch } : row)));
  };

  const buildEdits = (): FieldMappingEditPayload[] => {
    const edits: FieldMappingEditPayload[] = [];
    for (const row of rows) {
      const mapping = row.mapping;
      const attributeChanged = (row.attributeId || null) !== (mapping?.attributeId ?? null);
      const serializationChanged = mapping
        ? JSON.stringify(serializationToEditor(mapping.serialization)) !== JSON.stringify(row.serialization)
        : false;
      if (!attributeChanged && !serializationChanged) continue;
      edits.push({
        catalogField: row.catalogField,
        attributeId: row.attributeId === '' ? null : row.attributeId,
        serialization: attributeChanged || serializationChanged ? editorToSerialization(row.serialization) : undefined,
      });
    }
    return edits;
  };

  const handleSave = async () => {
    const edits = buildEdits();
    if (edits.length === 0) {
      setSavedMessage('No changes to save.');
      return;
    }
    setSaving(true);
    setError('');
    setSavedMessage('');
    try {
      await updateFieldMappings(edits);
      setSavedMessage(`Saved ${edits.length} field mapping change${edits.length === 1 ? '' : 's'}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setError('');
    setSavedMessage('');
    load();
  };

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading attribute mappings...</div>;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
          Mirrors ShopSite's <strong>Extra Fields</strong> configuration. Link each Catalog Field to a Product Attribute
          (or leave it unmapped) and set how its value is serialized. ShopSite-side field names are managed in{' '}
          <strong>Catalog → Fields</strong>; saving here validates the bundle and applies to future promotions.
        </p>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button type="button" style={styles.secondaryBtn} onClick={handleReset}>Reset</button>
          <button type="button" style={styles.primaryBtn} onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}
      {savedMessage && <div style={styles.saved}>{savedMessage}</div>}

      {rows.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          <p>No Catalog Fields available.</p>
          <p style={{ fontSize: 12 }}>Sync products from ShopSite first to populate the field registry.</p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={th}>Field</th>
                <th style={th}>ShopSite Field Name</th>
                <th style={th}>Product Attribute</th>
                <th style={th}>Serialization</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.catalogField}>
                  <td style={td}>
                    <code style={{ fontSize: 11, color: '#059669' }}>{row.catalogField}</code>
                  </td>
                  <td style={td}>
                    <span style={{ fontSize: 13, color: '#1e293b' }}>{row.label || row.catalogField}</span>
                  </td>
                  <td style={td}>
                    <select
                      style={{ ...styles.select, minWidth: 190 }}
                      value={row.attributeId}
                      onChange={(e) => updateRow(row.catalogField, { attributeId: e.target.value })}
                    >
                      <option value="">— Unmapped —</option>
                      {attributes.map(attr => (
                        <option key={attr.id} value={attr.id}>{attr.name} ({attr.id})</option>
                      ))}
                    </select>
                  </td>
                  <td style={td}>
                    <SerializationEditor
                      value={row.serialization}
                      onChange={(serialization) => updateRow(row.catalogField, { serialization })}
                    />
                  </td>
                  <td style={td}>
                    {row.mapping?.isStale ? (
                      <span style={{ color: '#dc2626', fontSize: 11, fontWeight: 600 }}>stale</span>
                    ) : row.mapping ? (
                      <span style={{ color: '#059669', fontSize: 11, fontWeight: 600 }}>active</span>
                    ) : (
                      <span style={{ color: '#9ca3af', fontSize: 11 }}>unmapped</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SerializationEditor({ value, onChange }: {
  value: EditorRow['serialization'];
  onChange: (next: EditorRow['serialization']) => void;
}) {
  const inputStyle: React.CSSProperties = { ...styles.input, width: 72, fontSize: 11, padding: '4px 6px' };
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        style={{ ...styles.select, width: 92, fontSize: 11, padding: '4px 6px' }}
        value={value.kind}
        onChange={(e) => onChange({ ...value, kind: e.target.value as EditorRow['serialization']['kind'] })}
      >
        <option value="scalar">scalar</option>
        <option value="delimited">delimited</option>
        <option value="measured">measured</option>
      </select>
      <input style={inputStyle} placeholder="prefix" value={value.prefix} onChange={(e) => onChange({ ...value, prefix: e.target.value })} />
      <input style={inputStyle} placeholder="suffix" value={value.suffix} onChange={(e) => onChange({ ...value, suffix: e.target.value })} />
      {value.kind === 'delimited' && (
        <input style={inputStyle} placeholder="delimiter" value={value.delimiter} onChange={(e) => onChange({ ...value, delimiter: e.target.value })} />
      )}
      {value.kind === 'measured' && (
        <>
          <input style={inputStyle} placeholder="unit" value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value })} />
          <input style={inputStyle} placeholder="sep" value={value.valueUnitSeparator} onChange={(e) => onChange({ ...value, valueUnitSeparator: e.target.value })} />
        </>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  input: { border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13 },
  select: { border: '1px solid #d1d5db', borderRadius: 6, padding: '6px 8px', fontSize: 13, background: '#fff' },
  primaryBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 },
  secondaryBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontSize: 13 },
  error: { color: '#dc2626', padding: 12, background: '#fef2f2', borderRadius: 6, marginBottom: 16, fontSize: 13 },
  saved: { color: '#16a34a', padding: 12, background: '#f0fdf4', borderRadius: 6, marginBottom: 16, fontSize: 13 },
};

const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', borderBottom: '2px solid #e5e7eb', fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 12px', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' };

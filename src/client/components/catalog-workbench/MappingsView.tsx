import React, { useState, useEffect } from 'react';
import { listAttributeMappings, listCatalogFields } from '../../api';
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

function fieldNumber(catalogField: string): number {
  const match = /^ProductField(\d+)$/.exec(catalogField);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function MappingsView() {
  const [rows, setRows] = useState<EditorRow[]>([]);
  const [attributes, setAttributes] = useState<AttributeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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


  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading attribute mappings...</div>;
  }

  return (
    <div>
      <div style={{ marginBottom: 16, padding: 10, background: '#fef9c3', border: '1px solid #fde047', borderRadius: 6, fontSize: 12, color: '#713f12', lineHeight: 1.4 }}>
        🔒 Taxonomy frozen — field mappings are read-only. Changes require a new immutable taxonomy release.
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>
          Mirrors ShopSite's <strong>Extra Fields</strong> configuration. Read-only view of how each Catalog Field maps to a
          Product Attribute and its serialization. ShopSite-side field names are managed in{' '}
          <strong>Catalog → Fields</strong>.
        </p>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button type="button" style={styles.secondaryBtn} onClick={load}>Refresh</button>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

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
                      disabled
                      title="Taxonomy frozen — read-only"
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

function SerializationEditor({ value }: {
  value: EditorRow['serialization'];
}) {
  const [showAdvanced, setShowAdvanced] = useState(Boolean(value.prefix || value.suffix));
  const inputStyle: React.CSSProperties = { ...styles.input, width: 72, fontSize: 11, padding: '4px 6px' };
  
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <select
        style={{ ...styles.select, width: 95, fontSize: 11, padding: '4px 6px' }}
        value={value.kind}
        disabled
        title="Taxonomy frozen — read-only"
      >
        <option value="scalar">scalar</option>
        <option value="delimited">delimited</option>
        <option value="measured">measured</option>
      </select>

      {value.kind === 'delimited' && (
        <input style={inputStyle} placeholder="delimiter" value={value.delimiter} disabled title="Taxonomy frozen — read-only" />
      )}
      {value.kind === 'measured' && (
        <>
          <input style={inputStyle} placeholder="unit" value={value.unit} disabled title="Taxonomy frozen — read-only" />
          <input style={inputStyle} placeholder="sep" value={value.valueUnitSeparator} disabled title="Taxonomy frozen — read-only" />
        </>
      )}

      {(showAdvanced || value.prefix || value.suffix) ? (
        <>
          <input style={inputStyle} placeholder="prefix" value={value.prefix} disabled title="Taxonomy frozen — read-only" />
          <input style={inputStyle} placeholder="suffix" value={value.suffix} disabled title="Taxonomy frozen — read-only" />
          <button type="button" onClick={() => setShowAdvanced(false)} style={{ background: 'none', border: 'none', color: '#999', fontSize: 11, cursor: 'pointer', padding: 0 }}>×</button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setShowAdvanced(true)}
          style={{ background: 'none', border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 4, color: '#525252', fontSize: 10, cursor: 'pointer', padding: '2px 6px' }}
          title="Show Prefix / Suffix (read-only)"
        >
          + Format
        </button>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  input: { border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 4, padding: '6px 8px', fontSize: 13, background: '#fff' },
  select: { border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 4, padding: '6px 8px', fontSize: 13, background: '#fff' },
  secondaryBtn: { background: 'none', border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 4, padding: '8px 16px', cursor: 'pointer', fontSize: 13, color: '#211414', fontWeight: 600 },
  error: { color: 'var(--color-danger-text, #760c19)', padding: 12, background: 'var(--color-danger-bg, #fee2e2)', borderRadius: 6, marginBottom: 16, fontSize: 13, border: '1px solid var(--color-danger-border, #fca5a5)' },
};

const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', borderBottom: '2px solid var(--color-card-border, #E8E6D9)', fontSize: 11, fontWeight: 700, color: 'var(--color-uniform-green, #14532D)', textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '10px 12px', borderBottom: '1px solid var(--color-card-border, #E8E6D9)', verticalAlign: 'top' };

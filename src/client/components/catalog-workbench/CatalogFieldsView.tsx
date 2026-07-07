import React, { useState, useEffect } from 'react';
import { listCatalogFields, listFieldRegistry, listAttributeMappings } from '../../api';
import { getCurationTargets } from '../../onboarding-api';
import type { CatalogFieldSummary } from './types';
import { CatalogFieldDrawer } from './CatalogFieldDrawer';

interface CatalogFieldsViewProps {
  onSelectProduct: (sku: string) => void;
}

const TABLE_STYLE: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
};

const TH_STYLE: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  borderBottom: '2px solid #e5e7eb',
  fontSize: 11,
  fontWeight: 700,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  whiteSpace: 'nowrap',
};

const TD_STYLE: React.CSSProperties = {
  padding: '10px 12px',
  borderBottom: '1px solid #f1f5f9',
  cursor: 'pointer',
};

export function CatalogFieldsView({ onSelectProduct }: CatalogFieldsViewProps) {
  const [fields, setFields] = useState<CatalogFieldSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerField, setDrawerField] = useState<string | null>(null);
  const [drawerLabel, setDrawerLabel] = useState('');
  const [sortKey, setSortKey] = useState<string>('xmlField');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await listCatalogFields();
        if (!cancelled) setFields(res.fields);
      } catch {
        // Fallback: use field registry + mappings + curation targets
        if (cancelled) return;
        try {
          const [reg, mappingsRes, targetsRes] = await Promise.allSettled([
            listFieldRegistry(),
            listAttributeMappings().catch(() => ({ mappings: [] })),
            getCurationTargets().catch(() => ({ targets: [], candidates: { productFields: [], pages: [] } })),
          ]);

          const regEntries = reg.status === 'fulfilled' ? reg.value.entries : [];
          const mappings = mappingsRes.status === 'fulfilled' ? mappingsRes.value.mappings : [];
          const curationFields = new Set(
            (targetsRes.status === 'fulfilled' ? (targetsRes.value as any)?.targets ?? [] : [])
              .filter((t: any) => t.kind === 'product_field' && t.catalogField)
              .map((t: any) => t.catalogField)
          );
          const mappedFields = new Map(mappings.map((m: any) => [m.catalogField, m.attributeId]));
          const fallbackFields: CatalogFieldSummary[] = regEntries.map(r => ({
            xmlField: r.xmlField,
            label: r.label || r.xmlField,
            kind: r.kind as any,
            dataType: r.dataType as any,
            uiGroup: r.uiGroup,
            nonEmptyCount: 0,
            distinctCount: 0,
            inferredValueMode: 'unknown' as const,
            mappedAttributeId: mappedFields.get(r.xmlField) ?? null,
            isCurationTarget: curationFields.has(r.xmlField),
            isStale: false,
            warning: (!r.label || r.label === r.xmlField) ? 'Unlabeled field' : null,
          }));
          if (!cancelled) setFields(fallbackFields);
        } catch {
          if (!cancelled) setFields([]);
        }
      }
      if (!cancelled) setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sorted = [...fields].sort((a, b) => {
    let cmp: number;
    const av = (a as any)[sortKey];
    const bv = (b as any)[sortKey];
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const openDrawer = (field: CatalogFieldSummary) => {
    setDrawerField(field.xmlField);
    setDrawerLabel(field.label);
  };

  const SortIcon = ({ col }: { col: string }) => (
    <span style={{ marginLeft: 4, opacity: sortKey === col ? 1 : 0.3 }}>
      {sortKey === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );

  return (
    <div>
      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading catalog fields...</div>
      ) : fields.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          No catalog fields found. Sync products from ShopSite first.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={TABLE_STYLE}>
            <thead>
              <tr>
                <th style={TH_STYLE} onClick={() => handleSort('xmlField')}>Field <SortIcon col="xmlField" /></th>
                <th style={TH_STYLE} onClick={() => handleSort('label')}>Label <SortIcon col="label" /></th>
                <th style={TH_STYLE} onClick={() => handleSort('kind')}>Kind <SortIcon col="kind" /></th>
                <th style={TH_STYLE} onClick={() => handleSort('dataType')}>Type <SortIcon col="dataType" /></th>
                <th style={TH_STYLE} onClick={() => handleSort('nonEmptyCount')}># Non-empty <SortIcon col="nonEmptyCount" /></th>
                <th style={TH_STYLE} onClick={() => handleSort('distinctCount')}>Distinct <SortIcon col="distinctCount" /></th>
                <th style={TH_STYLE} onClick={() => handleSort('inferredValueMode')}>Mode <SortIcon col="inferredValueMode" /></th>
                <th style={TH_STYLE}>Mapped</th>
                <th style={TH_STYLE}>Curation</th>
                <th style={TH_STYLE}>Status</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(f => (
                <tr key={f.xmlField} style={{ cursor: 'pointer' }} onClick={() => openDrawer(f)}>
                  <td style={TD_STYLE}><code>{f.xmlField}</code></td>
                  <td style={TD_STYLE}>
                    <strong>{f.label}</strong>
                    {f.warning && <span style={{ marginLeft: 6, color: '#d97706', fontSize: 11 }}>⚠️</span>}
                  </td>
                  <td style={TD_STYLE}><KindBadge kind={f.kind} /></td>
                  <td style={TD_STYLE}><code style={{ fontSize: 11 }}>{f.dataType}</code></td>
                  <td style={TD_STYLE}>{f.nonEmptyCount.toLocaleString()}</td>
                  <td style={TD_STYLE}>{f.distinctCount.toLocaleString()}</td>
                  <td style={TD_STYLE}><ModeBadge mode={f.inferredValueMode} /></td>
                  <td style={TD_STYLE}>
                    {f.mappedAttributeId ? (
                      <span style={{ fontSize: 11, color: '#059669' }}>✓ mapped</span>
                    ) : (
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>—</span>
                    )}
                  </td>
                  <td style={TD_STYLE}>
                    {f.isCurationTarget ? (
                      <span style={{ fontSize: 11, color: '#7c3aed' }}>curated</span>
                    ) : (
                      <span style={{ fontSize: 11, color: '#9ca3af' }}>—</span>
                    )}
                  </td>
                  <td style={TD_STYLE}>
                    {f.isStale ? (
                      <span style={{ fontSize: 11, color: '#dc2626' }}>stale</span>
                    ) : f.warning ? (
                      <span style={{ fontSize: 11, color: '#d97706' }}>warning</span>
                    ) : (
                      <span style={{ fontSize: 11, color: '#059669' }}>ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {drawerField && (
        <CatalogFieldDrawer
          xmlField={drawerField}
          label={drawerLabel}
          onClose={() => setDrawerField(null)}
          onSelectProduct={onSelectProduct}
        />
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    core: { bg: '#dcfce7', fg: '#166534' },
    system: { bg: '#fef3c7', fg: '#92400e' },
    custom: { bg: '#e0e7ff', fg: '#3730a3' },
  };
  const c = colors[kind] ?? { bg: '#f1f5f9', fg: '#475569' };
  return (
    <span style={{ background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
      {kind}
    </span>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    controlled: { bg: '#dcfce7', fg: '#166534' },
    freeText: { bg: '#fef3c7', fg: '#92400e' },
    measured: { bg: '#e0e7ff', fg: '#3730a3' },
    unknown: { bg: '#f1f5f9', fg: '#6b7280' },
  };
  const c = colors[mode] ?? { bg: '#f1f5f9', fg: '#6b7280' };
  return (
    <span style={{ background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
      {mode}
    </span>
  );
}

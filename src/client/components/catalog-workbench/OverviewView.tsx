import React, { useState, useEffect } from 'react';
import {
  getCatalogSchemaSummary,
  getCatalogHealthReport,
  type CatalogHealthReport,
} from '../../api';
import type { CatalogSchemaSummary } from './types';

const KPI_STYLE: React.CSSProperties = {
  background: 'var(--color-white-surface, #ffffff)',
  border: '1px solid var(--color-card-border, #E8E6D9)',
  borderRadius: 'var(--rounded-lg, 8px)',
  padding: '16px 20px',
  minWidth: 170,
  flex: '1 1 160px',
  boxShadow: 'var(--shadow-sm, 0 1px 3px rgba(33, 20, 20, 0.06))',
};

const KPI_VALUE: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  color: 'var(--color-uniform-green, #14532D)',
  marginBottom: 4,
};

const KPI_LABEL: React.CSSProperties = {
  fontSize: 12,
  color: '#525252',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

export function OverviewView() {
  const [summary, setSummary] = useState<CatalogSchemaSummary | null>(null);
  const [health, setHealth] = useState<CatalogHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      getCatalogSchemaSummary(),
      getCatalogHealthReport(),
    ]).then(([s, h]) => {
      if (cancelled) return;
      const errs: string[] = [];
      if (s.status === 'fulfilled') setSummary(s.value);
      else errs.push('schema-summary');
      if (h.status === 'fulfilled') setHealth(h.value);
      else errs.push('health-check');
      setErrors(errs);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading overview...</div>;
  }

  const healthFindings: Array<{ id: string; code?: string; message: string }> = (health?.issues ?? []).map((i: any) => ({
    id: i.id ?? i.code ?? `issue-${Math.random()}`,
    code: i.code,
    message: i.message ?? i.title ?? 'Unknown issue',
  }));

  return (
    <div>
      {errors.length > 0 && (
        <div style={{ padding: '10px 14px', marginBottom: 16, background: 'var(--color-warning-bg, #fef3c7)', border: '1px solid var(--color-warning-border, #fde68a)', borderRadius: 6, fontSize: 13, color: 'var(--color-warning-text, #78350f)' }}>
          Some data sources unavailable: {errors.join(', ')}. Some cards may show limited data.
        </div>
      )}

      {/* KPI Cards */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        <KpiCard value={summary?.productCount ?? 0} label="Products" />
        <KpiCard value={summary?.categoryPageCount ?? 0} label="Product Pages" />
        <KpiCard value={summary?.catalogFieldCount ?? 0} label="Catalog Fields" warn={summary?.unlabeledFieldCount ?? 0} />
        <KpiCard value={summary?.unmappedAttributeCount ?? 0} label="Unmapped Attributes" warn={summary?.unmappedAttributeCount ?? 0} />
        <KpiCard value={summary?.staleMappingCount ?? 0} label="Stale Mappings" warn={summary?.staleMappingCount ?? 0} />
        <KpiCard value={summary?.fieldsMissingFromLatestPull?.length ?? 0} label="Missing In Pull" warn={summary?.fieldsMissingFromLatestPull?.length ?? 0} />
      </div>

      {/* Needs Attention */}
      {(healthFindings.length > 0 || (summary && summary.fieldsMissingFromLatestPull.length > 0)) && (
        <div style={{ background: 'var(--color-white-surface, #fff)', border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 'var(--rounded-lg, 8px)', padding: 20, marginBottom: 24, boxShadow: 'var(--shadow-sm)' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: 'var(--color-signet-burgundy, #760C19)' }}>⚠️ Needs Attention</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {healthFindings.slice(0, 10).map(f => (
              <div key={f.id ?? f.code} style={{ fontSize: 13, color: 'var(--color-ledger-charcoal, #211414)', padding: '8px 12px', background: 'var(--color-danger-bg, #fee2e2)', borderRadius: 6, border: '1px solid var(--color-danger-border, #fca5a5)' }}>
                {f.message}
              </div>
            ))}
            {(summary?.fieldsMissingFromLatestPull ?? []).slice(0, 5).map(f => (
              <div key={`missing-${f}`} style={{ fontSize: 13, color: 'var(--color-ledger-charcoal, #211414)', padding: '8px 12px', background: 'var(--color-danger-bg, #fee2e2)', borderRadius: 6, border: '1px solid var(--color-danger-border, #fca5a5)' }}>
                Field <strong>{f}</strong> is mapped but not present in live ShopSite pull.
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick Summary */}
      {summary && (
        <div style={{ background: 'var(--color-white-surface, #fff)', border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 'var(--rounded-lg, 8px)', padding: 20, boxShadow: 'var(--shadow-sm)' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: 'var(--color-uniform-green, #14532D)' }}>Schema Summary</h3>
          <div style={{ fontSize: 13, color: '#404040', lineHeight: 1.8 }}>
            {summary.lastPullAt && <div>📡 Last ShopSite pull: {new Date(summary.lastPullAt).toLocaleString()}</div>}
            <div>📦 {summary.productCount} products, {summary.categoryPageCount} product pages</div>
            <div>🏷️ {summary.catalogFieldCount} catalog fields ({summary.unlabeledFieldCount} unlabeled)</div>
            <div>🔗 {summary.unmappedAttributeCount} product attributes without a Catalog Field mapping</div>
            <div>⚠️ {summary.staleMappingCount} stale attribute mappings (field absent from latest pull)</div>
            {summary.fieldsMissingFromLatestPull.length > 0 && (
              <div>❌ {summary.fieldsMissingFromLatestPull.length} mapped fields missing in latest pull</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({ value, label, warn }: { value: number; label: string; warn?: number }) {
  const isWarn = warn !== undefined && warn > 0;
  return (
    <div style={KPI_STYLE}>
      <div style={{ ...KPI_VALUE, color: isWarn ? 'var(--color-signet-burgundy, #760C19)' : 'var(--color-uniform-green, #14532D)' }}>
        {value.toLocaleString()}
        {isWarn && <span style={{ fontSize: 12, fontWeight: 500, marginLeft: 6 }}>({warn})</span>}
      </div>
      <div style={KPI_LABEL}>{label}</div>
    </div>
  );
}

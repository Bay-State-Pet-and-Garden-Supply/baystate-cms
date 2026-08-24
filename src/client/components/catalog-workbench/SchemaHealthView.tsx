import React, { useState, useEffect } from 'react';
import { getCatalogSchemaHealth, getCatalogHealthReport } from '../../api';
import type { SchemaHealthFinding, CatalogSchemaHealthReport } from './types';
import { StatusBadge, type StatusBadgeVariant } from '../settings/StatusBadge';
import { KeyValueList } from '../settings/KeyValueList';
import { FrozenBanner } from '../settings/FrozenBanner';

interface SchemaHealthViewProps {
  onSelectProduct: (sku: string) => void;
}

export function SchemaHealthView({ onSelectProduct }: SchemaHealthViewProps) {
  const [schemaHealth, setSchemaHealth] = useState<CatalogSchemaHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await getCatalogSchemaHealth();
        if (!cancelled) setSchemaHealth(res);
      } catch {
        // Fallback to existing catalog health check
        try {
          const res = await getCatalogHealthReport();
          if (!cancelled) {
            const findings: SchemaHealthFinding[] = (res.issues ?? []).map((i: any) => ({
              id: i.code ?? `issue-${Math.random()}`,
              severity: (i.severity === 'error' ? 'blocker' : i.severity) as any,
              code: i.code ?? 'HEALTH_ISSUE',
              message: i.message ?? i.title ?? 'Unknown issue',
              fieldPath: i.fieldPath ?? null,
              relatedTab: 'health' as const,
              relatedId: i.sku ?? undefined,
            }));
            setSchemaHealth({
              findings,
              summary: {
                blockers: findings.filter(f => f.severity === 'blocker').length,
                warnings: findings.filter(f => f.severity === 'warning').length,
                infos: findings.filter(f => f.severity === 'info').length,
              },
            });
          }
        } catch {
          if (!cancelled) setSchemaHealth({ findings: [], summary: { blockers: 0, warnings: 0, infos: 0 } });
        }
      }
      if (!cancelled) setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Analyzing catalog schema health...</div>;
  }

  const findings = schemaHealth?.findings ?? [];
  const summary = schemaHealth?.summary ?? { blockers: 0, warnings: 0, infos: 0 };
  const filtered = filter === 'all' ? findings : findings.filter(f => f.severity === filter);

  const severityColor = (s: string) => ({
    blocker: { bg: 'var(--color-danger-bg, #fee2e2)', border: 'var(--color-danger-border, #fca5a5)', fg: 'var(--color-signet-burgundy, #760C19)', label: 'Blocker' },
    warning: { bg: 'var(--color-warning-bg, #fef3c7)', border: 'var(--color-warning-border, #fde68a)', fg: 'var(--color-warning-text, #78350f)', label: 'Warning' },
    info: { bg: 'rgba(20, 83, 45, 0.08)', border: 'rgba(20, 83, 45, 0.2)', fg: 'var(--color-uniform-green, #14532D)', label: 'Info' },
  }[s] ?? { bg: '#f5f5f5', border: 'var(--color-card-border, #E8E6D9)', fg: '#525252', label: s });

  return (
    <div>
      <FrozenBanner note="Schema health reads the active taxonomy release and live catalog evidence; findings are informational." />
      <p style={{ fontSize: 13, color: '#525252', marginBottom: 12 }}>
        Schema health checks across Catalog Fields, Attribute Mappings, Category Page assignments, and classification configuration.
      </p>

      <div style={{ marginBottom: 16 }}>
        <KeyValueList
          stacked={false}
          items={[
            { label: 'Total Findings', value: findings.length },
            { label: 'Blockers', value: summary.blockers },
            { label: 'Warnings', value: summary.warnings },
            { label: 'Info', value: summary.infos },
          ]}
        />
      </div>

      {/* Summary bar */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        {[
          { key: 'all', label: 'All', count: findings.length },
          { key: 'blocker', label: 'Blockers', count: summary.blockers },
          { key: 'warning', label: 'Warnings', count: summary.warnings },
          { key: 'info', label: 'Info', count: summary.infos },
        ].map(s => (
          <button
            key={s.key}
            onClick={() => setFilter(s.key)}
            style={{
              padding: '10px 16px',
              borderRadius: 'var(--rounded-lg, 8px)',
              border: filter === s.key ? '2px solid var(--color-uniform-green, #14532D)' : '1px solid var(--color-card-border, #E8E6D9)',
              background: filter === s.key ? 'rgba(20, 83, 45, 0.08)' : '#fff',
              cursor: 'pointer',
              flex: 1,
              textAlign: 'center',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <div style={{ fontSize: 22, fontWeight: 700, color: s.key === 'blocker' ? 'var(--color-signet-burgundy, #760C19)' : s.key === 'warning' ? 'var(--color-warning-text, #78350f)' : 'var(--color-uniform-green, #14532D)' }}>
              {s.count}
            </div>
            <div style={{ fontSize: 11, color: '#525252', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{s.label}</div>
          </button>
        ))}
      </div>

      {findings.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#737373', background: '#fff', border: '1px solid var(--color-card-border, #E8E6D9)', borderRadius: 8 }}>
          <p style={{ fontSize: 24, margin: '0 0 8px' }}>✅</p>
          <p style={{ fontWeight: 600 }}>No schema health issues found.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(f => {
            const colors = severityColor(f.severity);
            const badgeVariant: StatusBadgeVariant = f.severity === 'blocker' ? 'blocker' : f.severity === 'warning' ? 'warning' : 'info';
            return (
              <div
                key={f.id}
                style={{
                  padding: '12px 16px',
                  background: colors.bg,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <StatusBadge variant={badgeVariant} />
                  <code style={{ fontSize: 10, color: '#666' }}>{f.code}</code>
                  {f.relatedId && <span style={{ fontSize: 10, color: '#666' }}>· {f.relatedTab}:{f.relatedId}</span>}
                </div>
                <div style={{ color: 'var(--color-ledger-charcoal, #211414)', fontWeight: 600 }}>{f.message}</div>
                {f.relatedId && f.relatedTab === 'health' && onSelectProduct && (
                  <button
                    onClick={() => onSelectProduct(f.relatedId!)}
                    style={{ marginTop: 6, background: 'none', border: 'none', color: 'var(--color-uniform-green, #14532D)', cursor: 'pointer', fontSize: 12, padding: 0, fontWeight: 600, textDecoration: 'underline' }}
                  >
                    Open product: {f.relatedId}
                  </button>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontStyle: 'italic' }}>
              No {filter} findings.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

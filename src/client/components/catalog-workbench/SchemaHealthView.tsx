import React, { useState, useEffect } from 'react';
import { getCatalogSchemaHealth, getCatalogHealthReport } from '../../api';
import type { SchemaHealthFinding, CatalogSchemaHealthReport } from './types';

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
    blocker: { bg: '#fef2f2', border: '#fecaca', fg: '#dc2626', label: 'Blocker' },
    warning: { bg: '#fef3c7', border: '#fbbf24', fg: '#d97706', label: 'Warning' },
    info: { bg: '#eff6ff', border: '#bfdbfe', fg: '#2563eb', label: 'Info' },
  }[s] ?? { bg: '#f8fafc', border: '#e2e8f0', fg: '#6b7280', label: s });

  return (
    <div>
      <p style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
        Schema health checks across Catalog Fields, Attribute Mappings, Category Page assignments, and classification configuration.
        Findings are computed from live SQLite state and classification config.
      </p>

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
              padding: '8px 16px',
              borderRadius: 8,
              border: filter === s.key ? '2px solid #4f46e5' : '1px solid #e2e8f0',
              background: filter === s.key ? '#eef2ff' : '#fff',
              cursor: 'pointer',
              flex: 1,
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 20, fontWeight: 700, color: s.key === 'blocker' ? '#dc2626' : s.key === 'warning' ? '#d97706' : '#0f172a' }}>
              {s.count}
            </div>
            <div style={{ fontSize: 11, color: '#64748b' }}>{s.label}</div>
          </button>
        ))}
      </div>

      {findings.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
          <p style={{ fontSize: 24, margin: '0 0 8px' }}>✅</p>
          <p>No schema health issues found.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map(f => {
            const colors = severityColor(f.severity);
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
                  <span style={{ background: colors.fg, color: '#fff', padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700 }}>
                    {colors.label}
                  </span>
                  <code style={{ fontSize: 10, color: '#6b7280' }}>{f.code}</code>
                  {f.relatedId && <span style={{ fontSize: 10, color: '#6b7280' }}>· {f.relatedTab}:{f.relatedId}</span>}
                </div>
                <div style={{ color: '#1e293b', fontWeight: 500 }}>{f.message}</div>
                {f.relatedId && f.relatedTab === 'health' && onSelectProduct && (
                  <button
                    onClick={() => onSelectProduct(f.relatedId!)}
                    style={{ marginTop: 6, background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 12, padding: 0, textDecoration: 'underline' }}
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

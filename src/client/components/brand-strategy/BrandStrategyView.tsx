// story: e08s01 — minimal Brands audit grid (Preferred/Fallback tier pills, not sequential, distributor-only eligible)
import React, { useEffect, useState } from 'react';
import { KNOWN_RETAILER_OR_DISTRIBUTOR_DOMAINS } from '../../../onboarding/discovery/retailer-domain-list';
import type { BrandStrategy } from '../../../shared/schemas/brand-strategy';

type Props = {
  strategies?: BrandStrategy[];
  loading?: boolean;
};

function TierPills({ strategy }: { strategy: BrandStrategy }) {
  const preferred = strategy.preferredDistributorIds;
  if (preferred.length === 0) return <span style={{ color: '#6b7280', fontSize: 12 }}>All Enabled</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>Preferred tier:</span>
      {preferred.map((id) => (
        <span key={id} style={{ background: '#e0f2fe', color: '#0c4a6e', borderRadius: 999, padding: '2px 8px', fontSize: 11, fontWeight: 600 }}>{id}</span>
      ))}
      {strategy.fallbackTier.length > 0 && (
        <>
          <span style={{ fontSize: 11, color: '#6b7280' }}>Fallback tier:</span>
          {strategy.fallbackTier.map((id) => (
            <span key={id} style={{ background: '#fef3c7', color: '#92400e', borderRadius: 999, padding: '2px 8px', fontSize: 11 }}>{id}</span>
          ))}
        </>
      )}
    </div>
  );
}

function ReadinessBadge({ strategy }: { strategy: BrandStrategy }) {
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    active: { label: 'Active', bg: '#dcfce7', fg: '#166534' },
    degraded: { label: 'Degraded', bg: '#fee2e2', fg: '#991b1b' },
    draft: { label: 'Draft', bg: '#e0e7ff', fg: '#3730a3' },
    needs_testing: { label: 'Needs testing', bg: '#fef3c7', fg: '#92400e' },
    not_configured: { label: 'Not configured', bg: '#f3f4f6', fg: '#374151' },
    profile_bypass_eligible: { label: 'Profile bypass eligible when distributor evidence qualifies', bg: '#f0fdf4', fg: '#14532d' },
  };
  const v = map[strategy.extractorReadiness] ?? map.not_configured;
  return <span style={{ background: v.bg, color: v.fg, borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 600 }}>{v.label}</span>;
}

export function BrandStrategyView({ strategies: initial, loading }: Props) {
  const [strategies, setStrategies] = useState<BrandStrategy[]>(initial ?? []);
  const [fetching, setFetching] = useState(!initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial) return;
    setFetching(true);
    fetch('/api/onboarding/brands/strategy')
      .then(async (r) => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          if (j.error === 'multiple_workspaces') throw new Error(`Multiple workspaces: ${j.workspaces?.join(', ')}`);
          throw new Error(j.error ?? `HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((j) => setStrategies(j.strategies ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setFetching(false));
  }, [initial]);

  const isLoading = loading || fetching;

  if (isLoading) return <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>Loading brand strategies…</div>;
  if (error) return <div style={{ padding: 16, color: '#991b1b', fontSize: 13 }}>{error}</div>;

  return (
    <div>
      {/* Global retailer banner — once, read-only */}
      <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#92400e', marginBottom: 16 }}>
        Global retailer denylist active — discovery will not persist provisional domains on these hosts ({KNOWN_RETAILER_OR_DISTRIBUTOR_DOMAINS.size} hosts)
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Brand Identity</th>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Sourcing tier</th>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Official Domain & Sitemap</th>
              <th style={{ padding: '10px 12px', fontWeight: 600, color: '#374151' }}>Extraction Readiness</th>
            </tr>
          </thead>
          <tbody>
            {strategies.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No brands configured</td></tr>
            )}
            {strategies.map((s) => (
              <tr key={s.normalizedBrand} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={{ padding: '12px' }}>
                  <div style={{ fontWeight: 600, color: '#111827' }}>{s.brandKey}</div>
                  {s.aliases.length > 0 && <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>{s.aliases.map((a) => <span key={a} style={{ background: '#f3f4f6', borderRadius: 999, padding: '1px 7px', fontSize: 11, color: '#4b5563' }}>{a}</span>)}</div>}
                  {s.ambiguous.length > 0 && <div style={{ marginTop: 6, fontSize: 11, color: '#92400e' }}>⚠ Ambiguous: {s.ambiguous.map((a) => `${a.candidateBrand} (${a.reason})`).join(', ')}</div>}
                  {s.unmatched && s.officialDomains.length === 0 && s.aliases.length === 0 && <div style={{ marginTop: 4, fontSize: 11, color: '#6b7280' }}>Unmatched advisory</div>}
                </td>
                <td style={{ padding: '12px' }}><TierPills strategy={s} /></td>
                <td style={{ padding: '12px' }}>
                  {s.officialDomains.length === 0 ? (
                    <span style={{ color: '#6b7280', fontSize: 12 }}>No official site configured</span>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {s.officialDomains.map((d) => (
                        <div key={d.domain} style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontWeight: 500, color: '#111827' }}>{d.domain}</span>
                          <span style={{ fontSize: 11, color: '#6b7280' }}>{d.sitemap.totalUrls} URLs · {d.sitemap.freshness}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td style={{ padding: '12px' }}><ReadinessBadge strategy={s} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

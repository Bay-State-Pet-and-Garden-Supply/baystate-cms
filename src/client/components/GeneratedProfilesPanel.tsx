// fallow-ignore-file unused-exports

/**
 * GeneratedProfilesPanel.tsx — domain-level generated profile queue
 * + history.
 *
 * Lists every active extractor profile (which is also a "domain")
 * and shows:
 *  - the count of validated / proposed / rejected generations for
 *    that domain
 *  - a "Review" button that opens the per-generation review screen
 *  - a link to see the field-decision history for the domain
 *
 * The panel does not list individual generations at the top level;
 * a generation is only shown when the user opens a specific domain
 * review. This keeps the queue manageable when many domains exist.
 *
 * Phase 4 (UI) consumer.
 */

import React, { useEffect, useState } from 'react';
import {
  getExtractorProfiles,
  getProfileGenerations,
  getDomainProfileGovernance,
} from '../onboarding-api';
import type {
  ExtractorProfile,
  ProfileGenerationGeneration,
  ProfileGenerationStatus,
  DomainProfileGovernance,
} from '../../shared/schemas/onboarding';
import { ProfileGenerationReview } from './ProfileGenerationReview';

const STATUS_COLORS: Record<ProfileGenerationStatus, string> = {
  proposed: '#9ca3af',
  validated: '#2563eb',
  rejected: '#dc2626',
  promoted: '#16a34a',
  failed: '#d97706',
};

interface DomainRow {
  domain: string;
  activeProfile: ExtractorProfile | null;
  counts: Partial<Record<ProfileGenerationStatus, number>>;
  validationSampleCount: number;
}

export function GeneratedProfilesPanel(): React.ReactElement {
  const [domainRows, setDomainRows] = useState<DomainRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [openDomain, setOpenDomain] = useState<string | null>(null);
  const [openGeneration, setOpenGeneration] = useState<string | null>(null);
  const [openGovernance, setOpenGovernance] = useState<DomainProfileGovernance | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [profilesRes, allGenerationsRes] = await Promise.all([
        getExtractorProfiles(),
        getProfileGenerations(),
      ]);
      const activeProfilesByDomain = new Map(
        profilesRes.extractorProfiles.map((profile) => [profile.domain, profile]),
      );
      const domains = Array.from(new Set([
        ...profilesRes.extractorProfiles.map((profile) => profile.domain),
        ...allGenerationsRes.generations.map((generation) => generation.domain),
      ])).sort();

      // Fetch one governance summary per domain. This includes active profile
      // values when present and generation counts even for proposal-only
      // domains that have no active extractor profile yet.
      const rows: DomainRow[] = await Promise.all(
        domains.map(async (domain) => {
          try {
            const gov = await getDomainProfileGovernance(domain);
            const counts: Partial<Record<ProfileGenerationStatus, number>> = {};
            for (const g of gov.generations) {
              counts[g.status] = (counts[g.status] ?? 0) + 1;
            }
            return {
              domain,
              activeProfile: gov.activeProfile,
              counts,
              validationSampleCount: gov.validationSampleCount,
            };
          } catch {
            const counts: Partial<Record<ProfileGenerationStatus, number>> = {};
            for (const generation of allGenerationsRes.generations.filter((g) => g.domain === domain)) {
              counts[generation.status] = (counts[generation.status] ?? 0) + 1;
            }
            return {
              domain,
              activeProfile: activeProfilesByDomain.get(domain) ?? null,
              counts,
              validationSampleCount: 0,
            };
          }
        }),
      );
      setDomainRows(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openReview = async (domain: string, generationId: string) => {
    setOpenDomain(domain);
    setOpenGeneration(generationId);
    setOpenGovernance(null);
  };

  const openDomainHistory = async (domain: string) => {
    setOpenDomain(domain);
    setOpenGeneration(null);
    setOpenGovernance(null);
    try {
      const gov = await getDomainProfileGovernance(domain);
      setOpenGovernance(gov);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Generated Profile Governance
          {loading && <span style={{ marginLeft: 8, fontSize: 12, color: '#9ca3af' }}>loading…</span>}
        </h3>
        <button
          type="button"
          onClick={load}
          style={{
            background: 'none',
            border: '1px solid #d1d5db',
            borderRadius: 6,
            padding: '4px 12px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>
      {error && (
        <p style={{ color: '#dc2626', fontSize: 13, background: '#fef2f2', padding: 8, borderRadius: 4 }}>
          {error}
        </p>
      )}
      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
        Profiles are managed at the <strong>domain</strong> level. Each row shows a domain with
        counts of generated proposals by status. Click a domain to review its proposals or
        field-decision history.
      </p>
      {domainRows.length === 0 && !loading ? (
        <p style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>
          No domains or generated proposals yet. Generated selector proposals will appear here
          even before a domain has an active extractor profile.
        </p>
      ) : (
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            marginTop: 8,
            fontSize: 13,
          }}
        >
          <thead>
            <tr>
              <th style={thStyle}>Domain</th>
              <th style={thStyle}>Status counts</th>
              <th style={thStyle}>Confirmed samples</th>
              <th style={thStyle}>Action</th>
            </tr>
          </thead>
          <tbody>
            {domainRows.map((row) => (
              <React.Fragment key={row.domain}>
                <tr>
                  <td style={tdStyle}>
                    <strong>{row.domain}</strong>
                    {row.activeProfile && (
                      <div style={{ fontSize: 11, color: '#6b7280' }}>
                        active title: <code>{row.activeProfile.titleSelector ?? '—'}</code>
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {(Object.keys(STATUS_COLORS) as ProfileGenerationStatus[]).map((status) => {
                        const count = row.counts[status] ?? 0;
                        if (count === 0) return null;
                        return (
                          <span
                            key={status}
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              background: STATUS_COLORS[status],
                              color: '#fff',
                              padding: '2px 8px',
                              borderRadius: 999,
                            }}
                          >
                            {status} {count}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td style={tdStyle}>{row.validationSampleCount}</td>
                  <td style={tdStyle}>
                    <button
                      type="button"
                      onClick={() => openDomainHistory(row.domain)}
                      style={{
                        background: 'none',
                        border: '1px solid #2563eb',
                        color: '#2563eb',
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      View domain
                    </button>
                  </td>
                </tr>
                {openDomain === row.domain && (
                  <tr>
                    <td colSpan={4} style={{ padding: 12, background: '#f9fafb' }}>
                      <DomainDetail
                        domain={row.domain}
                        governance={openGovernance}
                        openGeneration={openGeneration}
                        onSelectGeneration={(id) => setOpenGeneration(id)}
                        onOpenReview={(id) => openReview(row.domain, id)}
                        onClose={() => {
                          setOpenDomain(null);
                          setOpenGeneration(null);
                          setOpenGovernance(null);
                        }}
                      />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  borderBottom: '2px solid #e5e7eb',
  textAlign: 'left',
  padding: '8px 12px',
  color: '#4b5563',
  fontWeight: 600,
};
const tdStyle: React.CSSProperties = {
  borderBottom: '1px solid #e5e7eb',
  padding: '8px 12px',
  verticalAlign: 'top',
};

interface DomainDetailProps {
  domain: string;
  governance: DomainProfileGovernance | null;
  openGeneration: string | null;
  onSelectGeneration: (id: string) => void;
  onOpenReview: (id: string) => void;
  onClose: () => void;
}

function DomainDetail(props: DomainDetailProps) {
  const { domain, governance, openGeneration, onSelectGeneration, onOpenReview, onClose } = props;
  const [generations, setGenerations] = useState<ProfileGenerationGeneration[]>([]);
  const [loadingGens, setLoadingGens] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingGens(true);
      try {
        const res = await getProfileGenerations(domain);
        if (!cancelled) setGenerations(res.generations);
      } catch {
        if (!cancelled) setGenerations([]);
      } finally {
        if (!cancelled) setLoadingGens(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [domain]);

  if (openGeneration) {
    return (
      <div>
        <button
          type="button"
          onClick={() => onSelectGeneration('')}
          style={{
            background: 'none',
            border: '1px solid #d1d5db',
            borderRadius: 4,
            padding: '2px 8px',
            fontSize: 11,
            cursor: 'pointer',
            marginBottom: 8,
          }}
        >
          ← Back to {domain}
        </button>
        <ProfileGenerationReview
          generationId={openGeneration}
          governance={governance}
          onClose={onClose}
        />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h4 style={{ margin: 0, fontSize: 14 }}>{domain}</h4>
        <span style={{ fontSize: 11, color: '#6b7280' }}>
          {governance?.validationSampleCount ?? 0} confirmed sample(s)
        </span>
      </div>
      <h5 style={{ margin: '8px 0', fontSize: 13 }}>Generations ({generations.length})</h5>
      {loadingGens ? (
        <p style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</p>
      ) : generations.length === 0 ? (
        <p style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>No generations yet for this domain.</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {generations.map((g) => (
            <li
              key={g.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 8px',
                borderRadius: 4,
                background: '#fff',
                border: '1px solid #e5e7eb',
                marginBottom: 4,
                fontSize: 12,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  background: STATUS_COLORS[g.status],
                  color: '#fff',
                  padding: '2px 6px',
                  borderRadius: 3,
                }}
              >
                {g.status}
              </span>
              <span style={{ color: '#4b5563', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.sourceUrl}>
                {g.sourceUrl}
              </span>
              {g.expectedName && <span style={{ color: '#6b7280' }}>expected: {g.expectedName}</span>}
              <span style={{ color: '#6b7280' }}>conf: {g.confidence.toFixed(2)}</span>
              <span style={{ color: '#6b7280' }}>{new Date(g.createdAt).toLocaleString()}</span>
              <button
                type="button"
                onClick={() => onOpenReview(g.id)}
                style={{
                  background: '#2563eb',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 4,
                  padding: '2px 10px',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Review
              </button>
            </li>
          ))}
        </ul>
      )}

      {governance && governance.fieldDecisions.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h5 style={{ margin: '8px 0', fontSize: 13 }}>
            Field decisions ({governance.fieldDecisions.length})
          </h5>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {governance.fieldDecisions
              .slice()
              .sort((a, b) => new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime())
              .slice(0, 10)
              .map((d) => (
                <li
                  key={d.id}
                  style={{
                    fontSize: 12,
                    color: '#4b5563',
                    padding: '4px 0',
                    borderBottom: '1px solid #f3f4f6',
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      background:
                        d.decision === 'approved'
                          ? '#dcfce7'
                          : d.decision === 'rejected'
                            ? '#fee2e2'
                            : '#e0e7ff',
                      color:
                        d.decision === 'approved'
                          ? '#16a34a'
                          : d.decision === 'rejected'
                            ? '#dc2626'
                            : '#4338ca',
                      padding: '1px 4px',
                      borderRadius: 3,
                      marginRight: 6,
                    }}
                  >
                    {d.decision}
                  </span>
                  {d.selectorField}
                  <span style={{ color: '#9ca3af' }}> · {new Date(d.decidedAt).toLocaleString()}</span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

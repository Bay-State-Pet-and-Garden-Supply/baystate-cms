// story: e06s01 — Profile Workspace Header (General Store)
import React from 'react';
import type { DomainProfileState } from '../../../db/repositories/domain-profile-state-repo';
import { colors, fonts, rounded } from '../../theme';

export function ProfileWorkspaceHeader({ state }: { state: DomainProfileState }): React.ReactElement {
  const domain = state?.domain || '';
  const brandAssociations = Array.isArray(state?.brandAssociations) ? state.brandAssociations : [];
  const activeVersion = state?.activeVersion ?? null;
  const freshness = state?.freshness ?? null;
  const blockedCount = state?.blockedCount ?? 0;
  const productCount = state?.productCount ?? 0;
  const hasActive = Boolean(activeVersion);

  return (
    <header
      style={{
        background: colors.whiteSurface,
        border: `1px solid ${colors.cardBorder}`,
        borderRadius: rounded.lg,
        padding: '20px 24px',
        marginBottom: 20,
        boxShadow: '0 1px 4px rgba(33, 20, 20, 0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span
            style={{
              fontFamily: fonts.body,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              background: colors.uniformGreen,
              color: colors.feedBagCream,
              padding: '3px 8px',
              borderRadius: rounded.sm,
            }}
          >
            Extractor Profile
          </span>

          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 12,
              color: colors.ledgerCharcoal,
              background: colors.feedBagCream,
              border: `1px solid ${colors.cardBorder}`,
              padding: '2px 8px',
              borderRadius: rounded.sm,
            }}
          >
            {brandAssociations.length ? brandAssociations.join(' · ') : 'No brands mapped'}
          </span>

          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              padding: '3px 9px',
              borderRadius: rounded.full,
              background: hasActive ? 'rgba(22, 132, 77, 0.12)' : blockedCount > 0 ? 'rgba(118, 12, 25, 0.1)' : 'rgba(233, 181, 32, 0.18)',
              color: hasActive ? colors.seedlingGreen : blockedCount > 0 ? colors.signetBurgundy : colors.mulchBrown,
              border: `1px solid ${hasActive ? 'rgba(22, 132, 77, 0.3)' : blockedCount > 0 ? 'rgba(118, 12, 25, 0.25)' : colors.mutedGold}`,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: hasActive ? colors.seedlingGreen : blockedCount > 0 ? colors.signetBurgundy : colors.mutedGold,
              }}
            />
            {hasActive ? `Active · ${activeVersion}` : blockedCount > 0 ? 'Profile Needed · Blocked Items' : 'Draft In Progress'}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginTop: 8, marginBottom: 16 }}>
        <h1
          style={{
            fontFamily: fonts.display,
            fontSize: '1.75rem',
            fontWeight: 700,
            color: colors.ledgerCharcoal,
            margin: 0,
            lineHeight: 1.2,
            letterSpacing: '-0.02em',
          }}
        >
          {domain || 'Domain Profile'}
        </h1>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 16,
          borderTop: `1px solid ${colors.cardBorder}`,
          paddingTop: 16,
        }}
      >
        <div>
          <div style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: colors.mulchBrown }}>
            Discovered Products
          </div>
          <div style={{ fontFamily: fonts.mono, fontSize: '1.125rem', fontWeight: 700, color: colors.ledgerCharcoal, marginTop: 2 }}>
            {productCount.toLocaleString()}
          </div>
        </div>

        <div>
          <div style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: colors.mulchBrown }}>
            Pipeline Blocked
          </div>
          <div
            style={{
              fontFamily: fonts.mono,
              fontSize: '1.125rem',
              fontWeight: 700,
              color: blockedCount > 0 ? colors.signetBurgundy : colors.ledgerCharcoal,
              marginTop: 2,
            }}
          >
            {blockedCount.toLocaleString()}
            {blockedCount > 0 && <span style={{ fontSize: 11, fontWeight: 600, fontFamily: fonts.body, color: colors.signetBurgundy, marginLeft: 6 }}>waiting for profile</span>}
          </div>
        </div>

        <div>
          <div style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: colors.mulchBrown }}>
            Catalog Freshness
          </div>
          <div style={{ fontFamily: fonts.body, fontSize: '0.9375rem', fontWeight: 600, color: colors.ledgerCharcoal, marginTop: 2 }}>
            {freshness ?? '—'}
          </div>
        </div>

        <div>
          <div style={{ fontFamily: fonts.body, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: colors.mulchBrown }}>
            Active Profile Version
          </div>
          <div style={{ fontFamily: fonts.mono, fontSize: '0.9375rem', fontWeight: 600, color: hasActive ? colors.seedlingGreen : colors.mulchBrown, marginTop: 2 }}>
            {activeVersion ?? 'Not configured'}
          </div>
        </div>
      </div>
    </header>
  );
}


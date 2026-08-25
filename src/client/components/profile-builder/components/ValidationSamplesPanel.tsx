/**
 * ValidationSamplesPanel — simple URL selection dropdown and validation trigger.
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';
import { colors, fonts, rounded } from '../../../theme';

interface ValidationSamplesPanelProps {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
  availableUrls?: string[];
}

function getDomainPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url;
  }
}

export function ValidationSamplesPanel({ state, controller, availableUrls = [] }: ValidationSamplesPanelProps) {
  const { samples, requests, draft } = state;

  // Options from available suite URLs and draft product URL
  const candidateOptions = Array.from(
    new Set([
      ...availableUrls,
      draft.productUrl,
      ...samples.map((s) => s.url),
    ].filter(Boolean) as string[])
  );

  const activeUrl = draft.productUrl || candidateOptions[0] || '';

  const handleSelectUrl = (url: string) => {
    if (!url) return;
    controller.setProductUrl(url);
    controller.addSample(url);
  };

  return (
    <div
      style={{
        background: colors.whiteSurface,
        borderRadius: rounded.lg,
        border: `1px solid ${colors.cardBorder}`,
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        boxShadow: '0 1px 3px rgba(33,20,20,0.04)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 280 }}>
        <span style={{ fontFamily: fonts.display, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mulchBrown, whiteSpace: 'nowrap' }}>
          Validation Sample:
        </span>
        <select
          value={activeUrl}
          onChange={(e) => handleSelectUrl(e.target.value)}
          style={{
            flex: 1,
            padding: '7px 12px',
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.sm,
            fontSize: 12,
            fontFamily: fonts.mono,
            background: colors.feedBagCream,
            color: colors.ledgerCharcoal,
            cursor: 'pointer',
          }}
        >
          {candidateOptions.length === 0 ? (
            <option value="">No product URLs available</option>
          ) : (
            candidateOptions.map((u) => (
              <option key={u} value={u}>
                {getDomainPath(u)}
              </option>
            ))
          )}
        </select>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          disabled={!activeUrl || requests.validate.loading}
          onClick={controller.runValidation}
          style={{
            background: activeUrl && !requests.validate.loading ? colors.uniformGreen : colors.feedBagCream,
            color: activeUrl && !requests.validate.loading ? colors.feedBagCream : colors.mulchBrown,
            border: `1px solid ${activeUrl && !requests.validate.loading ? colors.shadowPine : colors.cardBorder}`,
            borderRadius: rounded.sm,
            padding: '7px 18px',
            fontSize: 12,
            fontFamily: fonts.body,
            fontWeight: 700,
            cursor: activeUrl && !requests.validate.loading ? 'pointer' : 'not-allowed',
            boxShadow: activeUrl && !requests.validate.loading ? '0 1px 2px rgba(20,83,45,0.15)' : 'none',
          }}
        >
          {requests.validate.loading ? 'Validating…' : 'Run Validation'}
        </button>

        {requests.validate.error && (
          <div
            role="alert"
            style={{
              padding: '6px 12px',
              background: 'rgba(118, 12, 25, 0.08)',
              borderRadius: rounded.sm,
              border: `1px solid ${colors.signetBurgundy}`,
              color: colors.signetBurgundy,
              fontSize: 11,
            }}
          >
            {requests.validate.error}
          </div>
        )}
      </div>
    </div>
  );
}



/**
 * ProfileProposalDrawer.tsx — DEPRECATED slide-out drawer for profile
 * building, testing, and per-field approval/rejection.
 *
 * @deprecated This component has been replaced by ProfileGenerationReview
 * which supports dynamic/custom fields, price/brand selectors, variant
 * strategy, per-field approval, validation evidence display, and the full
 * field catalog. This file is kept as a thin wrapper for backward
 * compatibility with OnboardingSettings.tsx.
 *
 * OnboardingSettings.tsx still passes drawerState props through this
 * component. The wrapper extracts the generation ID and renders
 * ProfileGenerationReview directly. New code should import
 * ProfileGenerationReview instead.
 */

import React from 'react';
import { ProfileGenerationReview } from './ProfileGenerationReview';
import type { ExtractorProfile, ProfileGenerationGeneration } from '../../shared/schemas/onboarding';

interface ProfileProposalDrawerProps {
  domain: string;
  proposal: ProfileGenerationGeneration;
  revisionId: string | null;
  activeProfile: ExtractorProfile | null;
  /** Pre-populated test URL (persisted from the last preview run). */
  testUrl?: string;
  onClose: () => void;
  onChange?: () => void;
  /** Called when the test URL changes so the parent can persist it. */
  onTestUrlChange?: (url: string) => void;
}

const DRAWER_STYLES = {
  overlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.3)',
    zIndex: 999,
  },
  drawer: {
    position: 'fixed' as const,
    top: 0,
    right: 0,
    bottom: 0,
    width: 720,
    background: '#fff',
    boxShadow: '-4px 0 24px rgba(0,0,0,0.15)',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    borderBottom: '1px solid #e5e7eb',
  },
  headerTitle: { fontSize: 18, fontWeight: 600, margin: 0 },
  closeBtn: {
    background: 'none',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    padding: '4px 12px',
    fontSize: 14,
    cursor: 'pointer' as const,
  },
  body: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '16px 20px',
  },
};

export function ProfileProposalDrawer(
  props: ProfileProposalDrawerProps,
): React.ReactElement {
  const { proposal, onClose, onChange } = props;

  return (
    <>
      <div style={DRAWER_STYLES.overlay} onClick={onClose} />
      <div style={DRAWER_STYLES.drawer}>
        {/* Header */}
        <div style={DRAWER_STYLES.header}>
          <div>
            <h2 style={DRAWER_STYLES.headerTitle}>
              Profile Review: {proposal.domain}
            </h2>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              Source: {proposal.sourceUrl}
            </p>
          </div>
          <button type="button" style={DRAWER_STYLES.closeBtn} onClick={onClose}>
            ✕ Close
          </button>
        </div>

        {/* Body — delegates to the canonical review component */}
        <div style={DRAWER_STYLES.body}>
          <ProfileGenerationReview
            generationId={proposal.id}
            onChange={onChange}
            onClose={onClose}
          />
        </div>
      </div>
    </>
  );
}

export default ProfileProposalDrawer;

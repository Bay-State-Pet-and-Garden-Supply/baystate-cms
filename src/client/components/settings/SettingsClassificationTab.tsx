import React from 'react';
import { FrozenBanner } from './FrozenBanner';

/**
 * Composition component for the read-only classification surfaces inside
 * Store Settings (P1 UI revamp).
 *
 * Wraps a reused catalog-workbench view with the FrozenBanner pattern and a
 * "Back to onboarding settings" cross-link, so managers operate taxonomy
 * administration top-level without entering an Onboarding batch context.
 * Zero logic of its own — children own all data fetching.
 */

export type ClassificationSettingsView = 'catalog-fields' | 'types-attributes' | 'mappings-health';

interface SettingsClassificationTabProps {
  view: ClassificationSettingsView;
  /** Active taxonomy revision slug when known (rendered inside the banner). */
  revision?: string | null;
  /** Render the FrozenBanner chrome (default true). Views that own their
   * banner (reused standalone workbench views) pass false to avoid doubles. */
  showBanner?: boolean;
  children: React.ReactNode;
}

const CROSS_LINK_STYLE: React.CSSProperties = {
  fontSize: 12,
  marginTop: 16,
  paddingTop: 12,
  borderTop: '1px solid var(--color-card-border, #E8E6D9)',
};

export function SettingsClassificationTab({ view, revision, showBanner = true, children }: SettingsClassificationTabProps): React.ReactElement {
  const note =
    view === 'types-attributes'
      ? 'Editing Product Types, Attributes, and Mappings is available in Onboarding Settings → Curation.'
      : undefined;
  return (
    <div>
      {showBanner && <FrozenBanner revision={revision} note={note} />}
      {children}
      <p style={CROSS_LINK_STYLE}>
        <a href="/?view=onboarding&settingsTab=curation" style={{ color: '#14532D', fontWeight: 600 }}>
          ← Back to onboarding settings
        </a>
      </p>
    </div>
  );
}

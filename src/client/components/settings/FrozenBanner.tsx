import React from 'react';

/**
 * Frozen-taxonomy banner primitive (P1 UI revamp).
 *
 * Rendered by every release-derived (read-only) view. States what WOULD be
 * possible and why editing is unavailable — never pretends editability with
 * fake-disabled editors. When the workspace pin revision is unknown on the
 * client (revision metadata arrives with the P4 release-status endpoint),
 * the copy degrades to a generic immutable-release statement.
 */

interface FrozenBannerProps {
  /** Active taxonomy release slug (e.g. "bay-state-v4"), when known. */
  revision?: string | null;
  /** Optional extra sentence appended after the standard copy. */
  note?: string;
}

export function FrozenBanner({ revision, note }: FrozenBannerProps): React.ReactElement {
  const text =
    `Managed by immutable taxonomy release${revision ? ` \`${revision}\`` : ''}. ` +
    'Definitions, profiles, mappings and seeds are read-only. ' +
    'Changes require authoring and activating a new release.' +
    (note ? ` ${note}` : '');
  return (
    <div
      role="note"
      data-frozen-banner="true"
      title="Taxonomy frozen — read-only"
      style={{
        marginBottom: 16,
        padding: 12,
        background: '#fef9c3',
        border: '1px solid #fde047',
        borderRadius: 8,
        fontSize: 13,
        color: '#713f12',
        lineHeight: 1.4,
      }}
    >
      🔒 {text}
    </div>
  );
}

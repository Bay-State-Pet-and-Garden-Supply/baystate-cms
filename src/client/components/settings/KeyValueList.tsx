import React from 'react';

/**
 * Key/value definition-list primitive (P1 UI revamp).
 *
 * Replaces ad-hoc inline-styled dl/div pairs in SchemaHealthView summaries,
 * the Types & Attributes detail panes, and (from P4) release manifest cards.
 */

export interface KeyValueEntry {
  label: string;
  value: React.ReactNode;
}

interface KeyValueListProps {
  items: readonly KeyValueEntry[];
  /** Stack rows vertically (default) instead of wrapping horizontally. */
  stacked?: boolean;
}

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#525252',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  margin: 0,
};

const VALUE_STYLE: React.CSSProperties = {
  fontSize: 13,
  color: '#211414',
  margin: '2px 0 8px',
};

export function KeyValueList({ items, stacked = true }: KeyValueListProps): React.ReactElement {
  return (
    <dl
      style={{
        display: stacked ? 'block' : 'flex',
        flexWrap: stacked ? undefined : 'wrap',
        gap: stacked ? undefined : 24,
        margin: 0,
      }}
    >
      {items.map((item) => (
        <div key={item.label} style={stacked ? undefined : { minWidth: 90 }}>
          <dt style={LABEL_STYLE}>{item.label}</dt>
          <dd style={VALUE_STYLE}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

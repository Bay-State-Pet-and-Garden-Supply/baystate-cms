/**
 * ProfileRevisionDiff.tsx — visual diff between two revisions.
 *
 * Shows added, changed, and removed selector keys with before/after values.
 */

import React, { useState } from 'react';
import type { RevisionDiffEntry } from '../profile-review-utils';

// ─── Props ──────────────────────────────────────────────────────────────────

interface ProfileRevisionDiffProps {
  entries: RevisionDiffEntry[];
}

// ─── Style helpers ───────────────────────────────────────────────────────────

const tagStyle = (
  bg: string,
  fg: string,
): React.CSSProperties => ({
  display: 'inline-block',
  fontSize: 10,
  fontWeight: 700,
  padding: '1px 6px',
  borderRadius: 999,
  background: bg,
  color: fg,
  textTransform: 'uppercase',
  marginRight: 6,
  flexShrink: 0,
});

// ─── Component ──────────────────────────────────────────────────────────────

export function ProfileRevisionDiff(
  props: ProfileRevisionDiffProps,
): React.ReactElement {
  const { entries } = props;
  const [showUnchanged, setShowUnchanged] = useState(false);

  if (entries.length === 0) {
    return (
      <p style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
        No changes between revisions.
      </p>
    );
  }

  const visible = showUnchanged
    ? entries
    : entries.filter((e) => e.changeType !== 'unchanged' || (e.oldSelector !== null || e.newSelector !== null));

  const added = entries.filter((e) => e.changeType === 'added').length;
  const changed = entries.filter((e) => e.changeType === 'changed').length;
  const removed = entries.filter((e) => e.changeType === 'removed').length;
  const unchanged = entries.filter((e) => e.changeType === 'unchanged').length;

  return (
    <div>
      {/* Summary bar */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          marginBottom: 10,
          fontSize: 12,
          color: '#6b7280',
        }}
      >
        {added > 0 && <span style={{ color: '#16a34a', fontWeight: 600 }}>+{added} added</span>}
        {changed > 0 && <span style={{ color: '#d97706', fontWeight: 600 }}>~{changed} changed</span>}
        {removed > 0 && <span style={{ color: '#dc2626', fontWeight: 600 }}>-{removed} removed</span>}
        {unchanged > 0 && (
          <button
            type="button"
            onClick={() => setShowUnchanged(!showUnchanged)}
            style={{
              background: 'none',
              border: 'none',
              color: '#9ca3af',
              fontSize: 12,
              cursor: 'pointer',
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            {showUnchanged ? `Hide ${unchanged} unchanged` : `Show ${unchanged} unchanged`}
          </button>
        )}
      </div>

      {/* Diff entries */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {visible.map((entry) => {
          const colorMap: Record<string, string> = {
            added: '#16a34a',
            removed: '#dc2626',
            changed: '#d97706',
            unchanged: '#9ca3af',
          };
          const bgMap: Record<string, string> = {
            added: '#dcfce7',
            removed: '#fee2e2',
            changed: '#fef3c7',
            unchanged: '#f3f4f6',
          };
          const color = colorMap[entry.changeType] ?? '#9ca3af';
          const bg = bgMap[entry.changeType] ?? '#f3f4f6';

          return (
            <div
              key={entry.key}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '6px 8px',
                background: bg,
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              <span style={tagStyle(bg, color)}>{entry.changeType}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: '#374151', marginBottom: 2 }}>
                  {entry.label}
                  <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: 4 }}>
                    {entry.key}
                  </span>
                </div>
                {entry.changeType === 'changed' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                    <div style={{ color: '#dc2626', fontSize: 11 }}>
                      <span style={{ fontWeight: 600 }}>−</span>{' '}
                      <code style={{ background: '#fff', padding: '1px 3px', borderRadius: 2 }}>
                        {entry.oldSelector ?? 'null'}
                      </code>
                    </div>
                    <div style={{ color: '#16a34a', fontSize: 11 }}>
                      <span style={{ fontWeight: 600 }}>+</span>{' '}
                      <code style={{ background: '#fff', padding: '1px 3px', borderRadius: 2 }}>
                        {entry.newSelector ?? 'null'}
                      </code>
                    </div>
                  </div>
                )}
                {entry.changeType === 'added' && entry.newSelector && (
                  <code
                    style={{
                      fontSize: 11,
                      background: '#fff',
                      padding: '1px 3px',
                      borderRadius: 2,
                      marginTop: 2,
                      display: 'inline-block',
                    }}
                  >
                    {entry.newSelector}
                  </code>
                )}
                {entry.changeType === 'removed' && entry.oldSelector && (
                  <code
                    style={{
                      fontSize: 11,
                      background: '#fff',
                      padding: '1px 3px',
                      borderRadius: 2,
                      marginTop: 2,
                      display: 'inline-block',
                      textDecoration: 'line-through',
                      color: '#dc2626',
                    }}
                  >
                    {entry.oldSelector}
                  </code>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

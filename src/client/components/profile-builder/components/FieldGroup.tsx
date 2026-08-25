/**
 * FieldGroup — collapsible category group of field cards.
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController, FieldCategory, SelectorFieldState } from '../profileBuilderTypes';
import type { FieldDefinition } from '../fieldCatalog';
import { FieldCard } from './FieldCard';
import { colors, fonts, rounded } from '../../../theme';

interface FieldGroupProps {
  category: FieldCategory;
  fields: FieldDefinition[];
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

const CATEGORY_LABELS: Record<FieldCategory, string> = {
  identity: 'Identity & Naming',
  media: 'Media & Imagery',
  description: 'Description & Copy',
  nutrition: 'Nutrition & Ingredients',
  details: 'Product Attributes & Specs',
  variants: 'Variants & SKUs',
};

function badgeStyle(bg: string, fg: string): React.CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: rounded.full,
    background: bg,
    color: fg,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    border: `1px solid ${fg}33`,
  };
}

const s: Record<string, React.CSSProperties> = {
  group: {
    background: colors.whiteSurface,
    borderRadius: rounded.lg,
    border: `1px solid ${colors.cardBorder}`,
    overflow: 'hidden',
    boxShadow: '0 1px 4px rgba(33, 20, 20, 0.05)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    cursor: 'pointer',
    background: colors.feedBagCream,
    borderBottom: `1px solid ${colors.cardBorder}`,
    userSelect: 'none',
  },
  headerTitle: {
    fontFamily: fonts.display,
    fontSize: '0.9375rem',
    fontWeight: 700,
    color: colors.ledgerCharcoal,
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  badges: { display: 'flex', gap: 6, alignItems: 'center' },
  body: { padding: 12, background: colors.whiteSurface },
  empty: { padding: '16px 14px', fontSize: 12, color: colors.mulchBrown, fontStyle: 'italic', textAlign: 'center' },
};

function countByStatus(fields: FieldDefinition[], ss: Record<string, SelectorFieldState>) {
  const c = { assigned: 0, warning: 0, failed: 0, validated: 0 };
  for (const f of fields) {
    const st = ss[f.key];
    if (!st || st.status === 'unassigned') continue;
    if (st.status === 'validated') c.validated++;
    else if (st.status === 'failed') c.failed++;
    else if (st.status === 'warning') c.warning++;
    else c.assigned++;
  }
  return c;
}

function FieldGroupComponent({ category, fields, state, controller }: FieldGroupProps) {
  const collapsed = state.collapsedCategories[category] ?? false;
  const counts = countByStatus(fields, state.fields);
  const hasContent = fields.some(f => { const st = state.fields[f.key]; return st && st.status !== 'unassigned'; });

  return (
    <div style={s.group}>
      <div style={s.header} onClick={() => controller.toggleCategory(category)}>
        <h4 style={s.headerTitle}>
          {CATEGORY_LABELS[category] ?? category}
          <span style={{ fontFamily: fonts.mono, fontSize: 11, fontWeight: 400, color: colors.mulchBrown }}>
            ({fields.length})
          </span>
        </h4>
        <div style={s.badges}>
          {counts.failed > 0 && <span style={badgeStyle('rgba(118, 12, 25, 0.1)', colors.signetBurgundy)}>{counts.failed} failed</span>}
          {counts.warning > 0 && <span style={badgeStyle('rgba(246, 219, 18, 0.3)', colors.ledgerCharcoal)}>{counts.warning} warning</span>}
          {counts.validated > 0 && <span style={badgeStyle('rgba(22, 132, 77, 0.15)', colors.seedlingGreen)}>{counts.validated} validated</span>}
          {hasContent && counts.validated === 0 && counts.failed === 0 && counts.warning === 0 && (
            <span style={badgeStyle('rgba(20, 83, 45, 0.1)', colors.uniformGreen)}>assigned</span>
          )}
          <span style={{ fontSize: 12, color: colors.mulchBrown, marginLeft: 4 }}>{collapsed ? '▶' : '▼'}</span>
        </div>
      </div>
      {!collapsed && (
        <div style={s.body}>
          {fields.map(field => {
            const fs = state.fields[field.key];
            if (!fs) return null;
            return <FieldCard key={field.key} field={field} selectorState={fs} state={state} controller={controller} />;
          })}
          {!hasContent && <div style={s.empty}>No selectors configured in this group.</div>}
        </div>
      )}
    </div>
  );
}

export const FieldGroup = React.memo(FieldGroupComponent);


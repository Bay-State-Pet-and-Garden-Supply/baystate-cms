/**
 * FieldGroup — collapsible category group of field cards.
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController, FieldCategory, SelectorFieldState } from '../profileBuilderTypes';
import type { FieldDefinition } from '../fieldCatalog';
import { FieldCard } from './FieldCard';

interface FieldGroupProps {
  category: FieldCategory;
  fields: FieldDefinition[];
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

const CATEGORY_LABELS: Record<FieldCategory, string> = {
  identity: 'Identity',
  media: 'Media',
  description: 'Description',
  nutrition: 'Nutrition',
  details: 'Details',
  variants: 'Variants',
};

function badgeStyle(bg: string, fg: string): React.CSSProperties {
  return { fontSize: 11, fontWeight: 600, padding: '1px 8px', borderRadius: 999, background: bg, color: fg };
}

const s: Record<string, React.CSSProperties> = {
  group: { background: '#fff', borderRadius: 8, border: '1px solid #e5e7eb', overflow: 'hidden' },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 14px', cursor: 'pointer', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', userSelect: 'none',
  },
  headerTitle: { fontSize: 14, fontWeight: 600, color: '#111827', margin: 0 },
  badges: { display: 'flex', gap: 6, alignItems: 'center' },
  body: { padding: 8 },
  empty: { padding: '16px 14px', fontSize: 13, color: '#9ca3af', fontStyle: 'italic' },
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

export function FieldGroup({ category, fields, state, controller }: FieldGroupProps) {
  const collapsed = state.collapsedCategories[category] ?? false;
  const counts = countByStatus(fields, state.fields);
  const hasContent = fields.some(f => { const st = state.fields[f.key]; return st && st.status !== 'unassigned'; });

  return (
    <div style={s.group}>
      <div style={s.header} onClick={() => controller.toggleCategory(category)}>
        <h4 style={s.headerTitle}>
          {CATEGORY_LABELS[category] ?? category}{' '}
          <span style={{ fontSize: 12, fontWeight: 400, color: '#9ca3af' }}>({fields.length} fields)</span>
        </h4>
        <div style={s.badges}>
          {counts.failed > 0 && <span style={badgeStyle('#fee2e2', '#991b1b')}>{counts.failed} failed</span>}
          {counts.warning > 0 && <span style={badgeStyle('#fef3c7', '#92400e')}>{counts.warning} warning</span>}
          {counts.validated > 0 && <span style={badgeStyle('#dcfce7', '#166534')}>{counts.validated} validated</span>}
          {hasContent && counts.validated === 0 && counts.failed === 0 && counts.warning === 0 && (
            <span style={badgeStyle('#dbeafe', '#1e40af')}>assigned</span>
          )}
          <span style={{ fontSize: 12, color: '#9ca3af', marginLeft: 4 }}>{collapsed ? '▶' : '▼'}</span>
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

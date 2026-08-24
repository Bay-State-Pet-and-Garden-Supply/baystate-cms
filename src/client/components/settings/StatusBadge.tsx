import React from 'react';

/**
 * Status badge primitive (P1 UI revamp).
 *
 * Icon + text always (never color-only) for accessibility; WCAG-AA contrast
 * against theme backgrounds via CSS-variable fallbacks from the design system.
 *
 * Consumers: MappingsView stale flags, SchemaHealthView severities,
 * TypesAttributesView mapping status, CatalogFieldDrawer, and (from P4)
 * the Taxonomy Release status card.
 */

export type StatusBadgeVariant =
  | 'frozen'
  | 'stale'
  | 'active'
  | 'draft'
  | 'unmapped'
  | 'mapped'
  | 'blocker'
  | 'warning'
  | 'info';

interface VariantSpec {
  icon: string;
  label: string;
  bg: string;
  fg: string;
}

const VARIANTS: Record<StatusBadgeVariant, VariantSpec> = {
  frozen: { icon: '🔒', label: 'Frozen', bg: '#fef9c3', fg: '#713f12' },
  stale: { icon: '⚠️', label: 'Stale', bg: 'var(--color-warning-bg, #fef3c7)', fg: 'var(--color-warning-text, #78350f)' },
  active: { icon: '✓', label: 'Active', bg: 'rgba(20, 83, 45, 0.08)', fg: 'var(--color-uniform-green, #14532D)' },
  draft: { icon: '◔', label: 'Draft', bg: '#f5f5f5', fg: '#525252' },
  unmapped: { icon: '○', label: 'Unmapped', bg: 'var(--color-warning-bg, #fef3c7)', fg: 'var(--color-warning-text, #78350f)' },
  mapped: { icon: '●', label: 'Mapped', bg: 'var(--color-success-bg, #d1fae5)', fg: 'var(--color-uniform-green, #14532D)' },
  blocker: { icon: '⛔', label: 'Blocker', bg: 'var(--color-danger-bg, #fee2e2)', fg: 'var(--color-signet-burgundy, #760C19)' },
  warning: { icon: '⚠️', label: 'Warning', bg: 'var(--color-warning-bg, #fef3c7)', fg: 'var(--color-warning-text, #78350f)' },
  info: { icon: 'ℹ️', label: 'Info', bg: 'rgba(20, 83, 45, 0.08)', fg: 'var(--color-uniform-green, #14532D)' },
};

interface StatusBadgeProps {
  variant: StatusBadgeVariant;
  /** Overrides the variant's default label (icon stays). */
  label?: string;
  title?: string;
}

export function StatusBadge({ variant, label, title }: StatusBadgeProps): React.ReactElement {
  const spec = VARIANTS[variant] ?? VARIANTS.draft;
  return (
    <span
      data-status-badge={variant}
      title={title ?? `${spec.label}${variant === label || !label ? '' : `: ${label}`}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: spec.bg,
        color: spec.fg,
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true">{spec.icon}</span>
      <span>{label ?? spec.label}</span>
    </span>
  );
}

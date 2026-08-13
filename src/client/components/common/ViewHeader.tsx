import React from 'react';
import { typography, colors } from '../../theme';

export interface ViewHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  titleColor?: string;
}

export function ViewHeader({
  title,
  description,
  badge,
  actions,
  className = '',
  style,
  titleColor,
}: ViewHeaderProps) {
  return (
    <div
      className={`view-header ${className}`}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 14,
        gap: 16,
        flexWrap: 'wrap',
        ...style,
      }}
    >
      <div style={{ flex: 1, minWidth: 260 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h1
            className="view-title"
            style={{
              ...typography.viewTitle,
              ...(titleColor ? { color: titleColor } : {}),
            }}
          >
            {title}
          </h1>
          {badge && <div style={{ display: 'inline-flex', alignItems: 'center' }}>{badge}</div>}
        </div>
        {description && (
          <p className="view-subtitle" style={typography.viewSubtitle}>
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            marginTop: 2,
          }}
        >
          {actions}
        </div>
      )}
    </div>
  );
}

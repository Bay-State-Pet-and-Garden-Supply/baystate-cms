import React from 'react';
import { typography } from '../../theme';

export interface SectionHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  level?: 2 | 3 | 4;
  className?: string;
  style?: React.CSSProperties;
}

export function SectionHeader({
  title,
  subtitle,
  actions,
  level = 2,
  className = '',
  style,
}: SectionHeaderProps) {
  const getHeaderElement = () => {
    switch (level) {
      case 3:
        return (
          <h3 className="card-title" style={typography.cardTitle}>
            {title}
          </h3>
        );
      case 4:
        return (
          <h4 className="subsection-title" style={typography.subsectionTitle}>
            {title}
          </h4>
        );
      case 2:
      default:
        return (
          <h2 className="section-title" style={typography.sectionTitle}>
            {title}
          </h2>
        );
    }
  };

  return (
    <div
      className={`section-header ${className}`}
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: subtitle ? 4 : 12,
        gap: 12,
        ...style,
      }}
    >
      <div>
        {getHeaderElement()}
        {subtitle && (
          <p className="section-subtitle" style={typography.sectionSubtitle}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{actions}</div>}
    </div>
  );
}

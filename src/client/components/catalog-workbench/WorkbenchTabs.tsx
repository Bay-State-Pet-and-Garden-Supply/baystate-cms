import React from 'react';
import type { WorkbenchTab } from './types';

// Shared tab bar CSS — anchored to Bay State Pet & Garden Supply design system
export const WORKBENCH_TAB_CSS = `
  .workbench-tabs {
    display: flex;
    gap: 0;
    border-bottom: 2px solid var(--color-card-border, #E8E6D9);
    margin-bottom: 24px;
    overflow-x: auto;
    padding: 0;
    flex-shrink: 0;
  }
  .workbench-tab-btn {
    padding: 12px 20px;
    font-size: 13px;
    font-weight: 600;
    color: #525252;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    cursor: pointer;
    transition: all var(--transition-fast, 0.15s ease);
    white-space: nowrap;
    position: relative;
    font-family: var(--font-body, inherit);
  }
  .workbench-tab-btn:hover {
    color: var(--color-uniform-green, #14532D);
    background: rgba(20, 83, 45, 0.05);
  }
  .workbench-tab-btn.active {
    color: var(--color-uniform-green, #14532D);
    font-weight: 700;
    border-bottom-color: var(--color-uniform-green, #14532D);
  }
  .workbench-tab-btn.active::after {
    content: '';
    position: absolute;
    bottom: -2px;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--color-uniform-green, #14532D);
  }
  .workbench-tab-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 6px;
    border-radius: var(--rounded-full, 9999px);
    background: #e5e7eb;
    color: #4b5563;
    font-size: 11px;
    font-weight: 700;
    margin-left: 6px;
    vertical-align: middle;
  }
  .workbench-tab-badge.warning {
    background: var(--color-warning-bg, #fef3c7);
    color: var(--color-warning-text, #78350f);
  }
  .workbench-tab-badge.danger {
    background: var(--color-danger-bg, #fee2e2);
    color: var(--color-danger-text, #760c19);
  }
`;

interface WorkbenchTabsProps {
  tabs: WorkbenchTab[];
  active: string;
  onChange: (tabId: string) => void;
}

export function WorkbenchTabs({ tabs, active, onChange }: WorkbenchTabsProps) {
  return (
    <div className="workbench-tabs">
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={`workbench-tab-btn ${active === tab.id ? 'active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.badge !== undefined && (
            <span className={`workbench-tab-badge ${typeof tab.badge === 'number' && tab.badge > 0 ? 'warning' : ''}`}>
              {tab.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

import React from 'react';
import type { WorkbenchTab } from './types';

// Shared tab bar CSS — mirrors CatalogHealth's `.tab-btn` pattern
export const WORKBENCH_TAB_CSS = `
  .workbench-tabs {
    display: flex;
    gap: 0;
    border-bottom: 2px solid #e5e7eb;
    margin-bottom: 24px;
    overflow-x: auto;
    padding: 0;
    flex-shrink: 0;
  }
  .workbench-tab-btn {
    padding: 10px 20px;
    font-size: 13px;
    font-weight: 600;
    color: #64748b;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
    position: relative;
  }
  .workbench-tab-btn:hover {
    color: #334155;
    background: #f8fafc;
  }
  .workbench-tab-btn.active {
    color: #4f46e5;
    border-bottom-color: #4f46e5;
  }
  .workbench-tab-btn.active::after {
    content: '';
    position: absolute;
    bottom: -2px;
    left: 0;
    right: 0;
    height: 2px;
    background: #4f46e5;
  }
  .workbench-tab-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: #e5e7eb;
    color: #4b5563;
    font-size: 11px;
    font-weight: 700;
    margin-left: 6px;
    vertical-align: middle;
  }
  .workbench-tab-badge.warning {
    background: #fef3c7;
    color: #d97706;
  }
  .workbench-tab-badge.danger {
    background: #fee2e2;
    color: #dc2626;
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

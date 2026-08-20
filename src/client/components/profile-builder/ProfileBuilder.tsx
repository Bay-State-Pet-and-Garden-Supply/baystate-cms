/**
 * ProfileBuilder — public entrypoint for the profile builder workspace.
 *
 * Renders inline only; modal overlay removed (e07s04) — canonical surface is /settings/domains/:domain/profile.
 *
 * This file is intentionally thin — it composes child components and avoids
 * embedding API calls or reducer logic directly.
 */

import React from 'react';
import { useProfileBuilderController } from './hooks/useProfileBuilderController';
import {
  CORE_FIELDS,
  STANDARD_CUSTOM_FIELDS,
  FIELD_GROUP_ORDER,
  getFieldDefinition,
  createArbitraryCustomField,
} from './fieldCatalog';
import type { FieldDefinition } from './fieldCatalog';
import { DomainBar } from './components/DomainBar';
import { SnapshotPanel } from './components/SnapshotPanel';
import { FieldGroup } from './components/FieldGroup';
import { ArtifactBrowser } from './components/ArtifactBrowser';
import { ExtractionPreview } from './components/ExtractionPreview';
import { ValidationSamplesPanel } from './components/ValidationSamplesPanel';
import { ValidationMatrix } from './components/ValidationMatrix';
import { SaveBar } from './components/SaveBar';
import { GeneratedCustomFieldsPanel } from './components/GeneratedCustomFieldsPanel';
import type { ProfileBuilderProps, FieldCategory } from './profileBuilderTypes';
import type { ExtractorProfile } from './profileBuilderTypes';

export type { ProfileBuilderProps };
export type { ExtractorProfile };

const workspaceStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontSize: 14,
  color: '#111827',
};

const mainGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 360px',
  gap: 16,
  alignItems: 'start',
};

const leftColumnStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

const rightRailStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  position: 'sticky',
  top: 16,
};

// story: e07s04 — modal overlay removed; ProfileBuilder is inline only (canonical /settings/domains/:domain/profile)

/**
 * Group field definitions by category for rendering.
 */
function groupFieldsByCategory(
  coreFields: readonly FieldDefinition[],
  customFields: readonly FieldDefinition[],
  customFieldOrder: string[],
): Map<FieldCategory, FieldDefinition[]> {
  const grouped = new Map<FieldCategory, FieldDefinition[]>();

  // Initialize empty arrays for every group.
  for (const cat of FIELD_GROUP_ORDER) {
    grouped.set(cat, []);
  }

  // Add core fields.
  for (const f of coreFields) {
    const arr = grouped.get(f.category);
    if (arr) arr.push(f);
  }

  // Add standard custom fields.
  for (const f of customFields) {
    const arr = grouped.get(f.category);
    if (arr) arr.push(f);
  }

  return grouped;
}

export function ProfileBuilder(props: ProfileBuilderProps) {
  const controller = useProfileBuilderController(props);
  const { state } = controller;

  // Build categorized field groups.
  const grouped = groupFieldsByCategory(CORE_FIELDS, STANDARD_CUSTOM_FIELDS, state.customFieldOrder);

  // Build custom FieldDefinitions for arbitrary custom fields.
  const customFieldDefs: FieldDefinition[] = state.customFieldOrder
    .map((key) => getFieldDefinition(key) ?? createArbitraryCustomField(key))
    .filter((d): d is FieldDefinition => d !== null);

  // Collect into "Custom" group (details category).
  const mainContent = (
    <div style={workspaceStyle}>
      <DomainBar state={state} controller={controller} />
      <SnapshotPanel state={state} controller={controller} />

      {/* ── Generate Selectors ── */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          disabled={!state.snapshot || state.generation.status === 'generating'}
          onClick={() => controller.generateSelectors()}
          style={{
            background: state.snapshot && state.generation.status !== 'generating' ? '#2563eb' : '#9ca3af',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '8px 20px',
            fontSize: 13,
            fontWeight: 600,
            cursor: state.snapshot && state.generation.status !== 'generating' ? 'pointer' : 'not-allowed',
          }}
        >
          {state.generation.status === 'generating' ? 'Generating...' : state.generation.status === 'failed' ? 'Retry Generate Selectors' : 'Generate Selectors'}
        </button>
      </div>
      {state.generation.error && (
        <div style={{
          padding: '6px 10px', background: '#fee2e2', borderRadius: 6, color: '#991b1b', fontSize: 12,
        }}>
          {state.generation.error.message}
        </div>
      )}

      <div style={mainGridStyle}>
        <div style={leftColumnStyle}>
          {FIELD_GROUP_ORDER.map((category) => {
            const catFields = grouped.get(category) ?? [];
            if (catFields.length === 0) return null;

            return (
              <FieldGroup
                key={category}
                category={category}
                fields={catFields}
                state={state}
                controller={controller}
              />
            );
          })}

          {/* Custom field group (arbitrary custom fields) */}
          {customFieldDefs.length > 0 && (
            <FieldGroup
              category="details"
              fields={customFieldDefs}
              state={state}
              controller={controller}
            />
          )}

          {/* Add custom field */}
          <AddCustomFieldInput controller={controller} />

          {/* Generated custom field suggestions */}
          <GeneratedCustomFieldsPanel state={state} controller={controller} />
        </div>

        <div style={rightRailStyle}>
          <ArtifactBrowser
            snapshot={state.snapshot}
            artifactUrlResolver={props.artifactUrlResolver}
          />
          <ExtractionPreview state={state} controller={controller} />
        </div>
      </div>

      <ValidationSamplesPanel state={state} controller={controller} />
      <ValidationMatrix state={state} />
      <SaveBar state={state} controller={controller} />
    </div>
  );

  // story: e07s04 — deprecated modal branch removed; inline is the only surface
  if (props.mode === 'modal') {
    throw new Error('ProfileBuilder mode="modal" is removed — use getProfileWorkspacePath');
  }

  return mainContent;
}

// ─── Add Custom Field Input ──────────────────────────────────────────────────

interface AddCustomFieldInputProps {
  controller: any; // ProfileBuilderController
}

function AddCustomFieldInput({ controller }: AddCustomFieldInputProps) {
  const [name, setName] = React.useState('');

  const handleAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    controller.addCustomField(trimmed);
    setName('');
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        padding: '8px 10px',
        background: '#fff',
        borderRadius: 8,
        border: '1px dashed #d1d5db',
      }}
    >
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
        placeholder="Custom field name (e.g. Flavor)"
        style={{
          flex: 1,
          padding: '6px 10px',
          border: '1px solid #d1d5db',
          borderRadius: 6,
          fontSize: 13,
        }}
      />
      <button
        type="button"
        onClick={handleAdd}
        disabled={!name.trim()}
        style={{
          background: name.trim() ? '#2563eb' : '#9ca3af',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          padding: '6px 14px',
          fontSize: 12,
          fontWeight: 600,
          cursor: name.trim() ? 'pointer' : 'not-allowed',
          whiteSpace: 'nowrap',
        }}
      >
        + Add Custom Field
      </button>
    </div>
  );
}

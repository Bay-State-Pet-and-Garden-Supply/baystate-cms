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
import { BuildCanvas } from './components/BuildCanvas';
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

      {/* ── Generate draft from 3 confirmed samples (suite-based, primary task) ── */}
      <GenerateDraftTask state={state} controller={controller} />
      {state.generation.error && (
        <div style={{
          padding: '8px 10px', background: state.generation.error.code === 'LLM_NOT_CONFIGURED' ? 'var(--color-feed-bag-cream)' : '#fee2e2', borderRadius: 6, color: state.generation.error.code === 'LLM_NOT_CONFIGURED' ? 'var(--color-mulch-brown)' : '#991b1b', fontSize: 12, border: state.generation.error.code === 'LLM_NOT_CONFIGURED' ? '1px solid var(--color-card-border)' : 'none',
        }}>
          {state.generation.error.code === 'LLM_NOT_CONFIGURED' ? 'LLM unavailable for profile_generation — fail-closed. You can still edit selectors manually under Advanced.' : state.generation.error.message}
        </div>
      )}
      <BuildCanvasSection state={state} controller={controller} />
      <details style={{ background: 'var(--color-white-surface)', border: '1px solid var(--color-card-border)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-2)' }}>
        <summary style={{ cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: '0.8rem', fontWeight: 600 }}>Advanced — manual selector editing & snapshot-only fallback</summary>
        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" disabled={!state.snapshot || state.generation.status === 'generating'} onClick={() => controller.generateSelectors()} style={{ background: state.snapshot && state.generation.status !== 'generating' ? 'var(--color-uniform-green)' : '#9ca3af', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: state.snapshot && state.generation.status !== 'generating' ? 'pointer' : 'not-allowed' }}>Generate from snapshot (fallback)</button>
        </div>
      </details>

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

function GenerateDraftTask({ state, controller }: { state: any; controller: any }): React.ReactElement {
  const confirmed = (state.samples as Array<{ confirmed: boolean }>).filter((s) => s.confirmed).length;
  const hasWaiver = false;
  const ready = confirmed >= 3 || hasWaiver;
  const generating = state.generation.status === 'generating';
  const disabled = !ready || generating;
  const tip = !ready ? `Need 3 confirmed samples — have ${confirmed}. Confirm via SuitePanel or needs waiver.` : undefined;
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
      <button type="button" title={tip} disabled={disabled} onClick={() => (controller as { generateDraftFromSuite?: (u: string[]) => void }).generateDraftFromSuite?.(state.samples.filter((s: { confirmed: boolean }) => s.confirmed).slice(0, 3).map((s: { url: string }) => s.url))} style={{ background: !disabled ? 'var(--color-uniform-green)' : 'var(--color-feed-bag-cream)', color: !disabled ? 'var(--color-feed-bag-cream)' : 'var(--color-mulch-brown)', border: `1px solid ${!disabled ? 'var(--color-shadow-pine)' : 'var(--color-card-border)'}`, borderRadius: 'var(--radius-sm)', padding: '8px 16px', fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 700, cursor: !disabled ? 'pointer' : 'not-allowed' }}>
        {generating ? 'Generating draft…' : 'Generate draft from 3 confirmed samples'}
      </button>
    </div>
  );
}

function BuildCanvasSection({ state, controller }: { state: any; controller: any }): React.ReactElement | null {
  const groups = buildCanvasGroups(state);
  if (groups.length === 0) return null;
  const pending = hasPending(groups);
  return (
    <BuildCanvas fieldGroups={groups} onAccept={(k) => controller.acceptSelectorSuggestion(k)} onReject={(k) => controller.rejectSelectorSuggestion(k)} onSuggest={(k) => controller.generateSelectors()} onExplain={(k) => controller.generateSelectors()} onRevise={(k, fb) => controller.generateSelectors()} provenance={state.generation.fieldSuggestions ? { provider: 'llm', model: 'profile_generation', configId: 'profile_generation', promptHash: state.generation.requestId ?? '', htmlLeftMachine: true, disclosureBadge: 'draft from suite' } : null} canSave={!pending} />
  );
}

function buildCanvasGroups(state: any): Array<{ group: string; fields: Array<{ key: string; label: string; active?: string | null; draft?: string | null; alternatives: Array<{ selector: string; evidence: string }>; warnings: string[]; preview?: string | null; decision: string }> }> {
  const entries = Object.entries(state.generation.fieldSuggestions ?? {}) as Array<[string, any]>;
  if (entries.length === 0) return [];
  const fields = entries.map(([k, v]: [string, any]) => ({
    key: k,
    label: k,
    active: null,
    draft: v.selector ?? null,
    alternatives: (v.warnings ?? []).map((w: string) => ({ selector: w, evidence: '' })),
    warnings: v.warnings ?? [],
    preview: v.preview?.text ?? null,
    decision: v.decision ?? 'pending',
  }));
  return [{ group: 'Suggested fields', fields }];
}

function hasPending(groups: Array<{ fields: Array<{ decision: string }> }>): boolean {
  return groups.some((g) => g.fields.some((f) => f.decision === 'pending'));
}

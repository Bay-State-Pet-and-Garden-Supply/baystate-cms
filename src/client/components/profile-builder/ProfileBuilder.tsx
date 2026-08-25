/**
 * ProfileBuilder — public entrypoint for the profile builder workspace (General Store).
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
import { colors, fonts, rounded } from '../../theme';

export type { ProfileBuilderProps };
export type { ExtractorProfile };

const workspaceStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  fontFamily: fonts.body,
  fontSize: 14,
  color: colors.ledgerCharcoal,
};

const leftColumnStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

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

  const isInline = props.mode === 'inline';

  const assignedCount = Object.values(state.fields).filter((f) => f && f.status !== 'unassigned').length;
  const totalCore = CORE_FIELDS.length;

  const mainContent = (
    <div style={workspaceStyle}>
      {!isInline && <DomainBar state={state} controller={controller} />}
      {!isInline && <SnapshotPanel state={state} controller={controller} />}

      {/* Unified Action Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          background: colors.whiteSurface,
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: rounded.lg,
          padding: '12px 18px',
          boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <GenerateDraftTask state={state} controller={controller} />
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: 11,
              fontWeight: 700,
              color: assignedCount >= totalCore ? colors.seedlingGreen : colors.mulchBrown,
              background: colors.feedBagCream,
              padding: '4px 10px',
              borderRadius: rounded.sm,
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            {assignedCount}/{totalCore} Core Fields Configured
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <AddCustomFieldInput controller={controller} />
          <button
            type="button"
            onClick={controller.saveProfile}
            disabled={state.requests.save.loading}
            style={{
              padding: '6px 16px',
              background: state.requests.save.success ? colors.seedlingGreen : colors.uniformGreen,
              color: colors.feedBagCream,
              border: `1px solid ${state.requests.save.success ? colors.seedlingGreen : colors.shadowPine}`,
              borderRadius: rounded.sm,
              fontFamily: fonts.body,
              fontSize: 12,
              fontWeight: 700,
              cursor: state.requests.save.loading ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              boxShadow: '0 1px 3px rgba(20,83,45,0.2)',
              transition: 'background 150ms ease',
            }}
          >
            {state.requests.save.loading ? (
              <><span>⏳</span> Saving Draft…</>
            ) : state.requests.save.success ? (
              <><span>✓</span> Draft Saved</>
            ) : (
              <><span>💾</span> Save Profile Draft</>
            )}
          </button>
        </div>
      </div>

      {state.requests.save.error && (
        <div
          style={{
            padding: '10px 14px',
            background: 'rgba(118, 12, 25, 0.08)',
            borderRadius: rounded.sm,
            color: colors.signetBurgundy,
            fontSize: 12,
            border: `1px solid ${colors.signetBurgundy}`,
            fontFamily: fonts.body,
          }}
        >
          <strong>Save Error:</strong> {state.requests.save.error}
        </div>
      )}

      {state.generation.error && (
        <div
          style={{
            padding: '10px 14px',
            background: state.generation.error.code === 'LLM_NOT_CONFIGURED' ? colors.feedBagCream : 'rgba(118, 12, 25, 0.08)',
            borderRadius: rounded.sm,
            color: state.generation.error.code === 'LLM_NOT_CONFIGURED' ? colors.mulchBrown : colors.signetBurgundy,
            fontSize: 12,
            border: `1px solid ${state.generation.error.code === 'LLM_NOT_CONFIGURED' ? colors.cardBorder : colors.signetBurgundy}`,
            fontFamily: fonts.body,
          }}
        >
          {state.generation.error.code === 'LLM_NOT_CONFIGURED' ? 'LLM unavailable for profile_generation — fail-closed. You can still select elements visually or edit selectors manually under Advanced.' : state.generation.error.message}
        </div>
      )}

      <BuildCanvasSection state={state} controller={controller} />

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

        {/* Generated custom field suggestions */}
        <GeneratedCustomFieldsPanel state={state} controller={controller} />

        {/* Bottom Save & Proceed Action Banner */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            padding: '14px 20px',
            background: colors.whiteSurface,
            border: `1px solid ${colors.cardBorder}`,
            borderRadius: rounded.lg,
            boxShadow: '0 1px 3px rgba(33, 20, 20, 0.04)',
            marginTop: 4,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: colors.ledgerCharcoal }}>
              Ready to validate your selectors?
            </div>
            <div style={{ fontSize: 11, color: colors.mulchBrown, marginTop: 2 }}>
              Save this draft version to run live extraction tests on all 3 sample pages in Step 3.
            </div>
          </div>
          <button
            type="button"
            onClick={controller.saveProfile}
            disabled={state.requests.save.loading}
            style={{
              padding: '8px 22px',
              background: state.requests.save.success ? colors.seedlingGreen : colors.uniformGreen,
              color: colors.feedBagCream,
              border: 'none',
              borderRadius: rounded.sm,
              fontFamily: fonts.body,
              fontSize: 12,
              fontWeight: 700,
              cursor: state.requests.save.loading ? 'not-allowed' : 'pointer',
              boxShadow: '0 2px 4px rgba(20,83,45,0.2)',
            }}
          >
            {state.requests.save.loading ? 'Saving Draft…' : state.requests.save.success ? '✓ Draft Saved — Proceed to Step 3 Below ↓' : '💾 Save Draft & Proceed to Validation →'}
          </button>
        </div>
      </div>
    </div>
  );

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
        gap: 8,
        alignItems: 'center',
        padding: '10px 14px',
        background: colors.whiteSurface,
        borderRadius: rounded.lg,
        border: `1px dashed ${colors.cardBorder}`,
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
          padding: '7px 12px',
          border: `1px solid ${colors.cardBorder}`,
          borderRadius: rounded.sm,
          fontSize: 13,
          fontFamily: fonts.body,
        }}
      />
      <button
        type="button"
        onClick={handleAdd}
        disabled={!name.trim()}
        style={{
          background: name.trim() ? colors.uniformGreen : colors.feedBagCream,
          color: name.trim() ? colors.feedBagCream : colors.mulchBrown,
          border: `1px solid ${name.trim() ? colors.shadowPine : colors.cardBorder}`,
          borderRadius: rounded.sm,
          padding: '7px 16px',
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
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
      <button
        type="button"
        title={tip}
        disabled={disabled}
        onClick={() => (controller as { generateDraftFromSuite?: (u: string[]) => void }).generateDraftFromSuite?.(state.samples.filter((s: { confirmed: boolean }) => s.confirmed).slice(0, 3).map((s: { url: string }) => s.url))}
        style={{
          background: !disabled ? colors.uniformGreen : colors.feedBagCream,
          color: !disabled ? colors.feedBagCream : colors.mulchBrown,
          border: `1px solid ${!disabled ? colors.shadowPine : colors.cardBorder}`,
          borderRadius: rounded.sm,
          padding: '8px 18px',
          fontFamily: fonts.body,
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          cursor: !disabled ? 'pointer' : 'not-allowed',
          boxShadow: !disabled ? '0 1px 2px rgba(20,83,45,0.15)' : 'none',
        }}
      >
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


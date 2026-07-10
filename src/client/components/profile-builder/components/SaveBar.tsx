/**
 * SaveBar — save controls with blocking errors, non-blocking warnings.
 */

import React from 'react';
import type { ProfileBuilderState, ProfileBuilderController } from '../profileBuilderTypes';

interface SaveBarProps {
  state: ProfileBuilderState;
  controller: ProfileBuilderController;
}

function dirtyBadgeStyle(dirty: boolean): React.CSSProperties {
  return {
    fontSize: 12, fontWeight: 600, padding: '2px 10px', borderRadius: 999,
    background: dirty ? '#fef3c7' : '#dcfce7', color: dirty ? '#92400e' : '#166534',
  };
}

const s: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '12px 16px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb', flexWrap: 'wrap',
  },
  left: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  saveBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 24px', fontSize: 14, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  saveBtnDisabled: { background: '#9ca3af', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 24px', fontSize: 14, fontWeight: 600, cursor: 'not-allowed', whiteSpace: 'nowrap' },
  errorBox: { padding: '6px 10px', background: '#fee2e2', borderRadius: 6, color: '#991b1b', fontSize: 12, flexBasis: '100%' },
  warningBox: { padding: '6px 10px', background: '#fef3c7', borderRadius: 6, color: '#92400e', fontSize: 12, flexBasis: '100%' },
  warningList: { margin: '4px 0 0', paddingLeft: 16 },
  successMsg: { fontSize: 13, color: '#166534', fontWeight: 600 },
};

export function SaveBar({ state, controller }: SaveBarProps) {
  const { dirty, requests, draft, validation, activeProfile } = state;
  const isSaving = requests.save.loading;
  const saveError = requests.save.error;
  const saveSuccess = requests.save.success;

  const blockingErrors: string[] = [];
  if (!draft.domain.trim()) blockingErrors.push('Domain is required.');

  const warnings: string[] = [];
  const hasValidationRun = validation !== null;
  if (!hasValidationRun) warnings.push('Validation has not been run.');
  if (hasValidationRun && validation?.summary && validation.summary.failingSamples > 0) {
    warnings.push(`Validation has ${validation.summary.failingSamples} failing sample(s).`);
  }
  if (!draft.imagesSelector) warnings.push('No image selector configured.');
  if (!draft.descriptionSelector) warnings.push('No description selector configured.');
  if (draft.runtime === 'static' && !draft.productUrl.includes('http')) {
    warnings.push('Runtime is "static" — dynamic content may not be captured.');
  }

  // Count warnings from accepted generated selectors
  const acceptedFieldWarnings = Object.values(state.generation.fieldSuggestions)
    .filter((s) => s.decision === 'accepted' && s.warnings.length > 0)
    .reduce((sum, s) => sum + s.warnings.length, 0);
  const acceptedCustomFieldWarnings = state.generation.customFieldSuggestions
    .filter((s) => s.addedToDraft && s.warnings.length > 0)
    .reduce((sum, s) => sum + s.warnings.length, 0);
  const totalSuggestionWarnings = acceptedFieldWarnings + acceptedCustomFieldWarnings;
  if (totalSuggestionWarnings > 0) {
    warnings.push(`${totalSuggestionWarnings} warning${totalSuggestionWarnings !== 1 ? 's' : ''} from generated selectors should be reviewed before saving.`);
  }

  const canSave = blockingErrors.length === 0 && !isSaving && dirty;

  const handleSave = () => { if (canSave) controller.saveProfile(); };

  return (
    <div style={s.bar}>
      <div style={s.left}>
        <span style={dirtyBadgeStyle(dirty)}>
          {isSaving ? 'Saving…' : saveSuccess ? 'Saved' : dirty ? 'Unsaved changes' : 'No changes'}
        </span>
        {saveSuccess && activeProfile && (
          <span style={s.successMsg}>✓ Profile saved ({activeProfile.domain})</span>
        )}
      </div>

      <button type="button" style={canSave ? s.saveBtn : s.saveBtnDisabled}
        onClick={handleSave} disabled={!canSave}>
        {isSaving ? 'Saving…' : 'Save Profile'}
      </button>

      {blockingErrors.length > 0 && (
        <div style={s.errorBox}>{blockingErrors.map((err, i) => <div key={i}>✗ {err}</div>)}</div>
      )}
      {saveError && !isSaving && <div style={s.errorBox}>✗ {saveError}</div>}

      {warnings.length > 0 && (
        <div style={s.warningBox}>
          <strong>Warnings:</strong>
          <ul style={s.warningList}>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

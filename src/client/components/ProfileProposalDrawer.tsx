/**
 * ProfileProposalDrawer.tsx — slide-out drawer for profile building,
 * testing, and per-field approval/rejection.
 *
 * The drawer provides enough space for image thumbnails, side-by-side
 * extraction results, and the approve/reject workflow. It is triggered
 * from the Domain Configuration accordion.
 */

import React, { useState, useCallback } from 'react';
import {
  testExtractorProfile,
  approveRevisionFields,
  rejectRevisionFields,
  createRevisionFromFeedback,
} from '../onboarding-api';
import type {
  ExtractorProfile,
  ProfileGenerationGeneration,
  SelectorField,
  StructuredFeedback,
} from '../../shared/schemas/onboarding';
import { SELECTOR_FIELDS } from '../../shared/schemas/onboarding';
import { ProfileRevisionFeedbackForm } from './ProfileRevisionFeedbackForm';
import { ElementPickerButton } from './ElementPickerButton';
import type { ImagePreview } from './ImagePreviewGrid';
import type { PickElementResponse } from '../../shared/schemas/extraction-worker';

interface ValidationRun {
  url: string;
  active: Record<string, unknown> | null;
  proposal: Record<string, unknown> | null;
  error: string | null;
}

interface ProfileProposalDrawerProps {
  domain: string;
  proposal: ProfileGenerationGeneration;
  revisionId: string | null;
  activeProfile: ExtractorProfile | null;
  /** Pre-populated test URL (persisted from the last preview run). */
  testUrl?: string;
  onClose: () => void;
  onChange?: () => void;
  /** Called when the test URL changes so the parent can persist it. */
  onTestUrlChange?: (url: string) => void;
}

const FIELD_LABELS: Record<string, string> = {
  titleSelector: 'Title',
  descriptionSelector: 'Description',
  imagesSelector: 'Images',
};

export function ProfileProposalDrawer(
  props: ProfileProposalDrawerProps,
): React.ReactElement {
  const { domain, proposal, revisionId, activeProfile, testUrl, onClose, onChange, onTestUrlChange } = props;

  // Preview state — initialised from the persisted test URL, falling back to the proposal's source URL.
  const [previewUrl, setPreviewUrl] = useState<string>(
    testUrl || proposal.sourceUrl || '',
  );
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [validationRuns, setValidationRuns] = useState<ValidationRun[]>([]);
  const [activeResults, setActiveResults] = useState<Record<string, unknown> | null>(null);
  const [proposalResults, setProposalResults] = useState<Record<string, unknown> | null>(null);

  // Approval state
  const [approvingField, setApprovingField] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [imagePreviewsReviewed, setImagePreviewsReviewed] = useState(false);
  const [shopifyJSONPath, setShopifyJSONPath] = useState(false);

  // Feedback/Revision state
  const [feedbackField, setFeedbackField] = useState<string | null>(null);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const [feedbackSuccess, setFeedbackSuccess] = useState<string | null>(null);
  /** When the LLM revises selectors, store them here so the drawer
   *  shows the updated values immediately without needing a reload. */
  const [revisedSelectors, setRevisedSelectors] = useState<Record<string, string | null> | null>(null);

  // Derive proposed selectors from the proposal's selectors_json
  const proposedSelectors = revisedSelectors ?? (proposal.selectors ?? {}) as Record<string, string | null>;
  const activeSelectors: Record<string, string | null> = activeProfile
    ? {
        titleSelector: activeProfile.titleSelector ?? null,
        descriptionSelector: activeProfile.descriptionSelector ?? null,
        imagesSelector: activeProfile.imagesSelector ?? null,
      }
    : {};

  const isFieldChanged = (field: string): boolean => {
    const proposed = proposedSelectors[field] ?? null;
    const active = activeSelectors[field] ?? null;
    return Boolean(proposed) && proposed !== active;
  };

  /** Run both active and proposal selectors against a single URL. */
  const handlePreview = useCallback(async () => {
    if (!previewUrl.trim()) return;
    setPreviewBusy(true);
    setPreviewError('');
    setActiveResults(null);
    setProposalResults(null);

    // Run active profile first.
    let activeRes: Record<string, unknown> | null = null;
    if (activeProfile) {
      try {
        const res = await testExtractorProfile({
          url: previewUrl.trim(),
          titleSelector: activeProfile.titleSelector ?? null,
          descriptionSelector: activeProfile.descriptionSelector ?? null,
          imagesSelector: activeProfile.imagesSelector ?? null,
        });
        if (res.success) activeRes = res.extracted as unknown as Record<string, unknown>;
      } catch (err) {
        // Non-fatal — active profile run failure is shown in the run list.
      }
    }

    // Run proposed selectors.
    let proposalRes: Record<string, unknown> | null = null;
    try {
      const res = await testExtractorProfile({
        url: previewUrl.trim(),
        titleSelector: proposedSelectors.titleSelector ?? null,
        descriptionSelector: proposedSelectors.descriptionSelector ?? null,
        imagesSelector: proposedSelectors.imagesSelector ?? null,
      });
      if (res.success) proposalRes = res.extracted as unknown as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPreviewError(`Proposal preview failed: ${msg}`);
    }

    setActiveResults(activeRes);
    setProposalResults(proposalRes);

    const run: ValidationRun = {
      url: previewUrl.trim(),
      active: activeRes,
      proposal: proposalRes,
      error: previewError || null,
    };
    setValidationRuns((prev) => [run, ...prev]);

    if (proposalRes) {
      setPreviewError('');
    }
    setPreviewBusy(false);
  }, [previewUrl, activeProfile, proposedSelectors, previewError]);

  /** Approve a single field. */
  const handleApprove = async (field: string) => {
    if (!revisionId) return;
    setApprovingField(field);
    setActionError('');
    try {
      const approvedFields: Partial<Record<SelectorField, boolean>> = {
        [field as SelectorField]: true,
      };
      await approveRevisionFields(proposal.id, revisionId, {
        approvedFields: approvedFields as Record<SelectorField, boolean>,
        imagePreviewsReviewed: field === 'imagesSelector' ? imagePreviewsReviewed : false,
      });
      onChange?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setApprovingField(null);
    }
  };

  /** Reject a single field. */
  const handleReject = async (field: string) => {
    if (!revisionId) return;
    setApprovingField(field);
    setActionError('');
    try {
      await rejectRevisionFields(proposal.id, revisionId, {
        rejectedFields: [field as SelectorField],
        reason: 'Rejected from profile review drawer',
      });
      onChange?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setApprovingField(null);
    }
  };

  /** Persist a visually-picked selector into a new revision. */
  const handlePickedSelector = async (
    field: string,
    selector: string,
    extractedText: string | null,
  ) => {
    if (!revisionId) return;

    // Update local state immediately so the preview updates
    const fieldKey = field as keyof typeof proposedSelectors;
    setRevisedSelectors((prev) => ({
      ...prev,
      [fieldKey]: selector,
    }));

    // Create a revision via feedback to persist the selector
    const feedback: StructuredFeedback =
      field === 'imagesSelector'
        ? { kind: 'images' as const, perImage: {}, notes: 'Advanced selector hint: ' + selector }
        : {
            kind: 'text' as const,
            field: field as SelectorField,
            currentValueCorrect: true,
            notes: 'Advanced selector hint: ' + selector,
          };

    try {
      const result = await createRevisionFromFeedback(proposal.id, {
        parentRevisionId: revisionId,
        feedback,
      });
      if (result.success) {
        const preview = extractedText
          ? '"' + extractedText.slice(0, 60) + '"'
          : 'preview available';
        setActionError('✓ Visually selected: ' + selector + ' — ' + preview);
        setTimeout(() => setActionError(''), 5000);

        // If the API returned revised selectors, use them
        const newSelectors = result.revision.selectors as Record<string, unknown>;
        if (newSelectors && Object.keys(newSelectors).length > 0) {
          const mapped: Record<string, string | null> = {};
          for (const key of ['titleSelector', 'descriptionSelector', 'imagesSelector']) {
            const val = newSelectors[key];
            mapped[key] = typeof val === 'string' ? val : null;
          }
          setRevisedSelectors(mapped);
        }
      }
    } catch (err) {
      console.warn('Failed to create revision from visual picker:', err);
      setActionError('Selector preview available but could not persist to revision');
    }
  };

  /** Submit structured feedback to create a new revision. */
  const handleSubmitFeedback = async (feedback: StructuredFeedback) => {
    setFeedbackSubmitting(true);
    setActionError('');
    try {
      const result = await createRevisionFromFeedback(proposal.id, {
        parentRevisionId: revisionId,
        feedback,
      });
      if (result.success) {
        setFeedbackField(null);
        setActionError('');
        // Update the drawer with the revised selectors from the API response.
        const newSelectors = result.revision.selectors as Record<string, unknown>;
        if (newSelectors && Object.keys(newSelectors).length > 0) {
          const mapped: Record<string, string | null> = {};
          for (const key of ['titleSelector', 'descriptionSelector', 'imagesSelector']) {
            const val = newSelectors[key];
            mapped[key] = typeof val === 'string' ? val : null;
          }
          setRevisedSelectors(mapped);
        }
        setFeedbackSuccess(
          result.revision.status === 'validated'
            ? 'AI revision complete. The selectors have been updated based on your feedback — preview them above.'
            : 'Revision submitted but the AI pass did not complete. The revision is saved; preview the current selectors above.',
        );
        setTimeout(() => setFeedbackSuccess(null), 5000);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setFeedbackSubmitting(false);
    }
  };

  // Styles
  const styles = {
    overlay: {
      position: 'fixed' as const,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.3)',
      zIndex: 999,
    },
    drawer: {
      position: 'fixed' as const,
      top: 0,
      right: 0,
      bottom: 0,
      width: 640,
      background: '#fff',
      boxShadow: '-4px 0 24px rgba(0,0,0,0.15)',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column' as const,
      overflow: 'hidden',
    },
    header: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '16px 20px',
      borderBottom: '1px solid #e5e7eb',
    },
    headerTitle: { fontSize: 18, fontWeight: 600, margin: 0 },
    closeBtn: {
      background: 'none',
      border: '1px solid #d1d5db',
      borderRadius: 6,
      padding: '4px 12px',
      fontSize: 14,
      cursor: 'pointer' as const,
    },
    body: {
      flex: 1,
      overflowY: 'auto' as const,
      padding: '16px 20px',
    },
    section: { marginBottom: 24 },
    sectionTitle: { fontSize: 15, fontWeight: 600, margin: '0 0 8px 0', color: '#111827' },
    label: { fontSize: 13, fontWeight: 500, color: '#4b5563', display: 'block', marginBottom: 4 },
    input: {
      width: '100%',
      padding: '8px 12px',
      border: '1px solid #d1d5db',
      borderRadius: 6,
      fontSize: 14,
      boxSizing: 'border-box' as const,
    },
    primaryBtn: {
      background: '#2563eb',
      color: '#fff',
      border: 'none',
      borderRadius: 6,
      padding: '8px 16px',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer' as const,
    },
    secondaryBtn: {
      background: 'none',
      border: '1px solid #d1d5db',
      borderRadius: 6,
      padding: '8px 16px',
      fontSize: 13,
      cursor: 'pointer' as const,
    },
    table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
    th: {
      borderBottom: '2px solid #e5e7eb',
      textAlign: 'left' as const,
      padding: '6px 8px',
      color: '#4b5563',
      fontWeight: 600,
    },
    td: { borderBottom: '1px solid #e5e7eb', padding: '6px 8px', verticalAlign: 'top' as const },
    code: { fontSize: 12, background: '#f3f4f6', padding: '1px 4px', borderRadius: 3 },
    badge: {
      display: 'inline-block',
      fontSize: 10,
      fontWeight: 700,
      padding: '2px 8px',
      borderRadius: 999,
      textTransform: 'uppercase' as const,
    },
    resultBox: {
      fontSize: 12,
      padding: 8,
      borderRadius: 4,
      border: '1px solid',
      marginTop: 8,
    },
    errorText: { color: '#dc2626', fontSize: 13, padding: 8, background: '#fef2f2', borderRadius: 4, marginTop: 8 },
  };

  const proposalStatus = proposal.status;
  const statusColor =
    proposalStatus === 'validated' || proposalStatus === 'promoted'
      ? '#16a34a'
      : proposalStatus === 'rejected'
        ? '#dc2626'
        : '#d97706';

  return (
    <>
      <div style={styles.overlay} onClick={onClose} />
      <div style={styles.drawer}>
        {/* Header */}
        <div style={styles.header}>
          <div>
            <h2 style={styles.headerTitle}>
              Profile Review: {domain}
            </h2>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              Source: {proposal.sourceUrl}
            </p>
          </div>
          <button type="button" style={styles.closeBtn} onClick={onClose}>
            ✕ Close
          </button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {actionError && <div style={styles.errorText}>{actionError}</div>}
          {feedbackSuccess && (
            <div
              style={{
                color: '#16a34a',
                fontSize: 13,
                padding: 8,
                background: '#f0fdf4',
                borderRadius: 4,
                marginBottom: 12,
                border: '1px solid #16a34a',
              }}
            >
              {feedbackSuccess}
            </div>
          )}

          {/* ── Section: Proposal Summary ── */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Proposal Summary</h3>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 8 }}>
              <span style={{ ...styles.badge, background: statusColor, color: '#fff' }}>
                {proposalStatus}
              </span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                confidence: {proposal.confidence.toFixed(2)}
              </span>
            </div>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Field</th>
                  <th style={styles.th}>Current Selector</th>
                  <th style={styles.th}>Proposed Selector</th>
                </tr>
              </thead>
              <tbody>
                {SELECTOR_FIELDS.map((field) => {
                  const label = FIELD_LABELS[field];
                  const proposed = proposedSelectors[field] ?? null;
                  const active = activeSelectors[field] ?? null;
                  const changed = proposed && proposed !== active;
                  return (
                    <tr key={field}>
                      <td style={styles.td}>{label}</td>
                      <td style={styles.td}>
                        <code style={styles.code}>{active || '—'}</code>
                      </td>
                      <td style={styles.td}>
                        <code
                          style={{
                            ...styles.code,
                            color: changed ? '#9333ea' : '#9ca3af',
                            fontWeight: changed ? 600 : 400,
                          }}
                        >
                          {proposed || '—'}
                        </code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '16px 0' }} />

          {/* ── Section: Preview against URL ── */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Preview extraction</h3>
            <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
              Enter a product URL to see what the current profile and the AI proposal would extract.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                style={styles.input}
                value={previewUrl}
                onChange={(e) => {
                  setPreviewUrl(e.target.value);
                  onTestUrlChange?.(e.target.value);
                }}
                placeholder="https://example.com/product/123"
              />
              <button
                type="button"
                style={styles.primaryBtn}
                onClick={handlePreview}
                disabled={previewBusy || !previewUrl.trim()}
              >
                {previewBusy ? 'Fetching…' : 'Preview'}
              </button>
            </div>

            {previewError && <div style={styles.errorText}>{previewError}</div>}

            {/* Side-by-side results */}
            {(activeResults || proposalResults) && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                {activeResults ? (
                  <div style={{ ...styles.resultBox, borderColor: '#16a34a', background: '#f0fdf4' }}>
                    <div style={{ fontWeight: 600, fontSize: 11, color: '#166534', marginBottom: 6 }}>
                      Current Profile
                    </div>
                    {renderExtractionPreview(activeResults)}
                  </div>
                ) : (
                  <div style={{ ...styles.resultBox, borderColor: '#d1d5db', background: '#f9fafb' }}>
                    <div style={{ fontWeight: 600, fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
                      Current Profile
                    </div>
                    <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>No active profile</span>
                  </div>
                )}
                {proposalResults ? (
                  <div style={{ ...styles.resultBox, borderColor: '#9333ea', background: '#faf5ff' }}>
                    <div style={{ fontWeight: 600, fontSize: 11, color: '#6b21a8', marginBottom: 6 }}>
                      🤖 AI Proposal
                    </div>
                    {renderExtractionPreview(proposalResults)}
                  </div>
                ) : (
                  <div style={{ ...styles.resultBox, borderColor: '#d1d5db', background: '#f9fafb' }}>
                    <div style={{ fontWeight: 600, fontSize: 11, color: '#6b7280', marginBottom: 6 }}>
                      🤖 AI Proposal
                    </div>
                    <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>No result</span>
                  </div>
                )}
              </div>
            )}

            {/* Validation runs history */}
            {validationRuns.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <h4 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px' }}>Validation runs</h4>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                  {validationRuns.map((run, i) => (
                    <li
                      key={i}
                      style={{
                        fontSize: 12,
                        color: '#4b5563',
                        padding: '6px 8px',
                        borderLeft: '3px solid #9333ea',
                        marginBottom: 4,
                        background: '#f9fafb',
                        borderRadius: '0 4px 4px 0',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{run.url}</span>
                      {run.error && (
                        <span style={{ color: '#dc2626', marginLeft: 8 }}>Error: {run.error}</span>
                      )}
                      {run.proposal && (
                        <span style={{ color: '#16a34a', marginLeft: 8 }}>✓ Proposal ran</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '16px 0' }} />

          {/* ── Section: Per-field approval ── */}
          <div style={styles.section}>
            <h3 style={styles.sectionTitle}>Approve or reject fields</h3>
            <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
              Only fields where the proposed selector differs from the current value can be approved.
              Use "Preview" above to see what each selector produces before approving.
            </p>

            {!revisionId && (
              <div style={styles.errorText}>
                No revision ID available. Generate a proposal first.
              </div>
            )}

            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Field</th>
                  <th style={styles.th}>Preview value</th>
                  <th style={styles.th}>Action</th>
                </tr>
              </thead>
              <tbody>
                {SELECTOR_FIELDS.map((field) => {
                  const label = FIELD_LABELS[field];
                  const proposed = proposedSelectors[field] ?? null;
                  const changed = isFieldChanged(field);
                  const previewVal = field === 'imagesSelector'
                    ? proposalResults?.['images']
                    : proposalResults?.[field.replace(/Selector$/, '')];
                  return (
                    <React.Fragment key={field}>
                    <tr>
                      <td style={styles.td}>
                        <strong>{label}</strong>
                      </td>
                      <td style={{ ...styles.td, maxWidth: 240, wordBreak: 'break-word' }}>
                        {field === 'imagesSelector' && Array.isArray(previewVal) ? (
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {(previewVal as string[]).slice(0, 4).map((url, i) => (
                              <img
                                key={i}
                                src={url}
                                alt={`Product image ${i + 1}`}
                                style={{
                                  width: 72,
                                  height: 72,
                                  objectFit: 'cover',
                                  borderRadius: 4,
                                  border: '1px solid #e5e7eb',
                                }}
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display = 'none';
                                }}
                              />
                            ))}
                            {(previewVal as string[]).length > 4 && (
                              <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }}>
                                +{(previewVal as string[]).length - 4} more
                              </span>
                            )}
                          </div>
                        ) : previewVal !== undefined && previewVal !== null ? (
                          <span>{String(previewVal).slice(0, 120)}</span>
                        ) : (
                          <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>Run preview first</span>
                        )}
                      </td>
                      <td style={styles.td}>
                        {changed ? (
                          <div style={{ display: 'flex', gap: 4, flexDirection: 'column', alignItems: 'flex-start' }}>
                            <button
                              type="button"
                              onClick={() => handleApprove(field)}
                              disabled={approvingField !== null}
                              style={{
                                background: '#16a34a',
                                color: '#fff',
                                border: 'none',
                                borderRadius: 4,
                                padding: '4px 12px',
                                fontSize: 12,
                                fontWeight: 600,
                                cursor: approvingField !== null ? 'not-allowed' : 'pointer',
                                opacity: approvingField !== null ? 0.6 : 1,
                              }}
                            >
                              {approvingField === field ? '…' : 'Approve'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleReject(field)}
                              disabled={approvingField !== null}
                              style={{
                                background: 'none',
                                border: '1px solid #dc2626',
                                color: '#dc2626',
                                borderRadius: 4,
                                padding: '3px 11px',
                                fontSize: 12,
                                fontWeight: 600,
                                cursor: approvingField !== null ? 'not-allowed' : 'pointer',
                              }}
                            >
                              Reject
                            </button>
                          </div>
                        ) : proposed ? (
                          <span style={{ fontSize: 11, color: '#6b7280' }}>Same as active</span>
                        ) : (
                          <span style={{ fontSize: 11, color: '#9ca3af' }}>Not proposed</span>
                        )}
                        {/* Suggest Revision — available when a proposed selector exists */}
                        {proposed && (
                          <button
                            type="button"
                            onClick={() => setFeedbackField(feedbackField === field ? null : field)}
                            style={{
                              background: 'none',
                              border: '1px solid #9333ea',
                              color: '#9333ea',
                              borderRadius: 4,
                              padding: '2px 8px',
                              fontSize: 11,
                              fontWeight: 600,
                              cursor: 'pointer',
                              marginTop: 4,
                            }}
                          >
                            {feedbackField === field ? 'Close' : 'Suggest Revision'}
                          </button>
                        )}
                        {/* Visual picker — always available when a preview URL exists */}
                        {previewUrl && (
                          <ElementPickerButton
                            field={field === 'imagesSelector' ? 'images' : field === 'descriptionSelector' ? 'description' : 'title'}
                            url={previewUrl}
                            onPicked={(result) => {
                              void handlePickedSelector(
                                field,
                                result.selector,
                                result.extractedText ?? null,
                              );
                            }}
                            onCancel={() => {
                              /* no-op: drawer stays open */
                            }}
                          />
                        )}
                      </td>
                    </tr>
                    {/* Inline feedback form */}
                    {feedbackField === field && (
                      <tr key={`${field}-feedback`}>
                        <td colSpan={4} style={{ padding: '12px 8px', background: '#faf5ff', borderBottom: '1px solid #e5e7eb' }}>
                          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                            Tell the AI what to improve about the <strong>{label}</strong> selector.
                            This creates a new revision; the current one is preserved.
                          </div>
                          <ProfileRevisionFeedbackForm
                            field={field as SelectorField}
                            currentValue={
                              field === 'imagesSelector'
                                ? null
                                : typeof (proposalResults?.[field] ?? activeResults?.[field]) === 'string'
                                  ? String((proposalResults?.[field] ?? activeResults?.[field]))
                                  : null
                            }
                            currentImages={
                              field === 'imagesSelector' && Array.isArray(proposalResults?.['images'])
                                ? (proposalResults!['images'] as string[]).map((url: string) => ({
                                    url,
                                    sampleUrl: previewUrl,
                                    expectedName: null,
                                    brandHint: null,
                                    warnings: [],
                                  }))
                                : []
                            }
                            sourcePageUrl={previewUrl}
                            onSubmit={handleSubmitFeedback}
                            busy={feedbackSubmitting}
                          />
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>

            {/* Image previews review checkbox */}
            <div style={{ marginTop: 12 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  fontSize: 13,
                  color: '#4b5563',
                }}
              >
                <input
                  type="checkbox"
                  checked={imagePreviewsReviewed}
                  onChange={(e) => setImagePreviewsReviewed(e.target.checked)}
                />
                I reviewed the image previews and approve the image selector
              </label>
              <p style={{ fontSize: 11, color: '#6b7280', margin: '4px 0 0 24px' }}>
                Image approval requires this checkbox and at least 2 validated samples.
              </p>
            </div>

            {/* Shopify productJSON toggle */}
            <div style={{ marginTop: 12, padding: 12, background: '#f8f9fa', borderRadius: 8 }}>
              <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={shopifyJSONPath}
                  onChange={(e) => setShopifyJSONPath(e.target.checked)}
                />
                <strong>Shopify productJSON</strong>
                <span style={{ color: '#888' }}>— prefer embedded Shopify data for title and images</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** Render a single extraction result (text or images). */
function renderExtractionPreview(result: Record<string, unknown>): React.ReactNode {
  const entries = Object.entries(result).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) {
    return <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>No values extracted</span>;
  }
  return (
    <div>
      {entries.map(([key, value]) => (
        <div key={key} style={{ marginBottom: 6 }}>
          <strong style={{ textTransform: 'capitalize' }}>{key}:</strong>{' '}
          {key === 'images' && Array.isArray(value) ? (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
              {(value as string[]).slice(0, 8).map((url: string, i: number) => (
                <img
                  key={i}
                  src={url}
                  alt={`Preview ${i + 1}`}
                  style={{
                    width: 80,
                    height: 80,
                    objectFit: 'cover',
                    borderRadius: 4,
                    border: '1px solid #e5e7eb',
                  }}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              ))}
              {(value as string[]).length > 8 && (
                <span style={{ fontSize: 11, alignSelf: 'center', color: '#6b7280' }}>
                  +{(value as string[]).length - 8} more
                </span>
              )}
              {value.length === 0 && (
                <span style={{ color: '#9ca3af', fontStyle: 'italic' }}>No images found</span>
              )}
            </div>
          ) : Array.isArray(value) ? (
            <span>{value.join(', ').slice(0, 200)}</span>
          ) : (
            <span>{String(value).slice(0, 200)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export default ProfileProposalDrawer;

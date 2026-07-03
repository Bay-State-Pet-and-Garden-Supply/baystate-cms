/**
 * ProfileGenerationReview.tsx — single generation / revision review.
 *
 * Preview-driven review flow with state machine:
 *   previewing → validating → validated → promoting → promoted
 *   feedback branches from previewing or validated
 *
 * Phase 4 (UI) consumer.
 */

import React, { useEffect, useState } from 'react';
import {
  getProfileGenerationDetail,
  validateRevision,
  approveRevisionFields,
  createRevisionFromFeedback,
  rollbackProfileField,
  deleteProfileGeneration,
  testExtractorProfile,
} from '../onboarding-api';
import type {
  ProfileGenerationGeneration,
  ProfileGenerationRevision,
  ProfileGenerationFieldDecision,
  SelectorField,
  StructuredFeedback,
  DomainProfileGovernance,
} from '../../shared/schemas/onboarding';
import type { ValidationRunSummary } from '../onboarding-api';
import { SELECTOR_FIELDS } from '../../shared/schemas/onboarding';
import { ProfileExtractionPreview } from './ProfileExtractionPreview';
import { ProfileRevisionFeedbackForm } from './ProfileRevisionFeedbackForm';

// ─── Props ─────────────────────────────────────────────────────────────────

interface ProfileGenerationReviewProps {
  generationId: string;
  /** Optional governance summary for showing the active profile selectors. */
  governance?: DomainProfileGovernance | null;
  onChange?: () => void;
  onClose?: () => void;
}

// ─── State machine ─────────────────────────────────────────────────────────

type ReviewState =
  | 'previewing'
  | 'validating'
  | 'validated'
  | 'promoting'
  | 'promoted'
  | 'feedback';

// ─── Component ─────────────────────────────────────────────────────────────

export function ProfileGenerationReview(
  props: ProfileGenerationReviewProps,
): React.ReactElement {
  const { generationId, onChange, onClose } = props;
  const [generation, setGeneration] = useState<ProfileGenerationGeneration | null>(null);
  const [revisions, setRevisions] = useState<ProfileGenerationRevision[]>([]);
  const [decisions, setDecisions] = useState<ProfileGenerationFieldDecision[]>([]);
  const [latestRevision, setLatestRevision] = useState<ProfileGenerationRevision | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  // State machine
  const [reviewState, setReviewState] = useState<ReviewState>('previewing');
  const [validationResult, setValidationResult] = useState<ValidationRunSummary | null>(null);
  const [validationBusy, setValidationBusy] = useState(false);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [imagePreviewsReviewed, setImagePreviewsReviewed] = useState(false);
  const [onDemandPreview, setOnDemandPreview] = useState<any>(null);
  const [feedbackField, setFeedbackField] = useState<SelectorField | null>(null);

  // ── Data loading ──────────────────────────────────────────────────────

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const detail = await getProfileGenerationDetail(generationId);
      setGeneration(detail.generation);
      setRevisions(detail.revisions);
      setDecisions(detail.fieldDecisions);
      const latest =
        detail.revisions
          .slice()
          .sort((a, b) => b.revisionNumber - a.revisionNumber)[0] ?? null;
      setLatestRevision(latest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [generationId]);

  // ── On-demand preview fetch ───────────────────────────────────────────

  useEffect(() => {
    const seedPreview = (latestRevision as any)?.fieldSamples?.seedPreview;
    if (!seedPreview && generation?.sourceUrl && latestRevision) {
      const proposed = (latestRevision.selectors ?? {}) as Record<string, string | null>;
      testExtractorProfile({
        url: generation.sourceUrl,
        titleSelector: proposed.titleSelector ?? null,
        descriptionSelector: proposed.descriptionSelector ?? null,
        imagesSelector: proposed.imagesSelector ?? null,
        shopifyJSONPath: (generation as any)?.selectors?.shopifyJSONPath ?? false,
      })
        .then((res) => {
          if (res?.extracted) setOnDemandPreview(res.extracted);
        })
        .catch(() => {});
    }
  }, [latestRevision?.id, generation?.sourceUrl]);

  // ── State machine actions ─────────────────────────────────────────────

  const handleLooksCorrect = async () => {
    if (!latestRevision) return;
    setReviewState('validating');
    setValidationBusy(true);
    setError('');
    try {
      const res = await validateRevision(generationId, latestRevision.id, { sampleLimit: 5 });
      setValidationResult(res.result);
      setReviewState('validated');
      await load();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReviewState('previewing');
    } finally {
      setValidationBusy(false);
    }
  };

  const handlePromote = async () => {
    if (!latestRevision || !validationResult) return;
    setReviewState('promoting');
    setPromoteBusy(true);
    setError('');
    try {
      const approvedFields: Record<SelectorField, boolean> = {
        titleSelector: true,
        descriptionSelector: true,
        imagesSelector: true,
        priceSelector: false,
        brandSelector: false,
      };
      const res = await approveRevisionFields(generationId, latestRevision.id, {
        approvedFields,
        imagePreviewsReviewed,
      });
      if (!res.imageApprovalAccepted) {
        throw new Error(
          'Image approval requires at least 2 validated samples AND the "I reviewed the image previews" checkbox.',
        );
      }
      setReviewState('promoted');
      await load();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setReviewState('validated');
    } finally {
      setPromoteBusy(false);
    }
  };

  const handleSomethingWrong = () => {
    setFeedbackField('titleSelector');
    setReviewState('feedback');
  };

  const cancelFeedback = () => {
    setFeedbackField(null);
    setReviewState('previewing');
  };

  // ── Existing handlers ─────────────────────────────────────────────────

  const submitFeedback = async (feedback: StructuredFeedback) => {
    if (!latestRevision) return;
    if (feedback.kind !== 'images' && feedback.kind !== 'price') {
      if (!feedback.field) return;
    }
    setBusy(true);
    setError('');
    try {
      await createRevisionFromFeedback(generationId, {
        parentRevisionId: latestRevision.id,
        feedback,
      });
      setFeedbackField(null);
      setReviewState('previewing');
      await load();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRollback = async (decision: ProfileGenerationFieldDecision) => {
    if (!confirm(`Roll back ${decision.selectorField} on ${decision.domain}?`)) return;
    setBusy(true);
    setError('');
    try {
      await rollbackProfileField(decision.id, { notes: 'Rolled back from review UI' });
      await load();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (
      !confirm(
        'Permanently delete this generation proposal? All revisions, validation results, and field decisions will be removed.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await deleteProfileGeneration(generationId);
      onChange?.();
      onClose?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  // ── Early return / loading ────────────────────────────────────────────

  if (loading) {
    return <p style={{ color: '#6b7280' }}>Loading…</p>;
  }
  if (!generation) {
    return <p style={{ color: '#dc2626' }}>Generation not found.</p>;
  }

  // ── Derived values ────────────────────────────────────────────────────

  const seedPreview = (latestRevision as any)?.fieldSamples?.seedPreview ?? null;
  const hasLatestRevision = latestRevision != null;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>
            Generation Review
            <span style={{ marginLeft: 8, fontSize: 12, color: '#6b7280' }}>
              {generation.id}
            </span>
          </h3>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
            {generation.domain} · {generation.sourceUrl}
            {generation.expectedName && (
              <span> · expected: {generation.expectedName}</span>
            )}
          </p>
        </div>
        {onClose && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: '1px solid #d1d5db',
                borderRadius: 6,
                padding: '4px 12px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={busy}
              style={{
                background: 'none',
                border: '1px solid #dc2626',
                color: '#dc2626',
                borderRadius: 6,
                padding: '4px 12px',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {/* ── Error banner ──────────────────────────────────────────────── */}
      {error && (
        <p
          style={{
            color: '#dc2626',
            fontSize: 13,
            background: '#fef2f2',
            padding: 8,
            borderRadius: 4,
          }}
        >
          {error}
        </p>
      )}

      {/* ── Extraction Preview ────────────────────────────────────────── */}
      <ProfileExtractionPreview
        seedPreview={seedPreview}
        sourceUrl={generation.sourceUrl}
        onDemandResult={
          onDemandPreview
            ? {
                title: (onDemandPreview as any).title,
                description: (onDemandPreview as any).description,
                images: (onDemandPreview as any).images ?? [],
                variantOptions: [],
              }
            : null
        }
        busy={loading}
      />

      {/* ── Action Area (state machine) ─────────────────────────────────── */}

      {/* previewing state */}
      {reviewState === 'previewing' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {hasLatestRevision ? (
            <>
              <button
                type="button"
                onClick={handleLooksCorrect}
                disabled={validationBusy}
                style={{
                  background: '#16a34a',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  padding: '8px 16px',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: validationBusy ? 'not-allowed' : 'pointer',
                  opacity: validationBusy ? 0.6 : 1,
                }}
              >
                Looks correct
              </button>
              <button
                type="button"
                onClick={handleSomethingWrong}
                disabled={validationBusy}
                style={{
                  background: '#6b7280',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  padding: '8px 16px',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: validationBusy ? 'not-allowed' : 'pointer',
                  opacity: validationBusy ? 0.6 : 1,
                }}
              >
                Something's wrong
              </button>
            </>
          ) : (
            <p style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
              No revision available to review.
            </p>
          )}
        </div>
      )}

      {/* validating state */}
      {reviewState === 'validating' && (
        <div style={{ padding: 12, background: '#f3f4f6', borderRadius: 6 }}>
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
            Validating across confirmed samples…
          </p>
        </div>
      )}

      {/* validated state */}
      {reviewState === 'validated' && validationResult && (
        <div
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: 16,
            background: '#fafafa',
          }}
        >
          <h4 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
            Validation Summary
          </h4>

          {/* Per-field summary */}
          {SELECTOR_FIELDS.map((field) => {
            const tally = validationResult.byField[field];
            if (!tally) return null;
            const total = tally.passing + tally.warning + tally.failing;
            return (
              <div
                key={field}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 6,
                  fontSize: 13,
                }}
              >
                <span style={{ fontWeight: 500, minWidth: 140 }}>{field}:</span>
                <span style={{ color: '#16a34a' }}>{tally.passing} pass</span>
                {tally.warning > 0 && (
                  <span style={{ color: '#d97706' }}>{tally.warning} warn</span>
                )}
                {tally.failing > 0 && (
                  <span style={{ color: '#dc2626' }}>{tally.failing} fail</span>
                )}
                {total === 0 && (
                  <span style={{ color: '#9ca3af' }}>no samples</span>
                )}
              </div>
            );
          })}

          {/* Image approval gate */}
          {validationResult.byField.imagesSelector &&
            validationResult.byField.imagesSelector.passing >= 2 && (
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: '#4b5563',
                  marginTop: 8,
                  padding: 8,
                  background: '#fff',
                  border: '1px solid #e5e7eb',
                  borderRadius: 4,
                }}
              >
                <input
                  type="checkbox"
                  checked={imagePreviewsReviewed}
                  onChange={(e) => setImagePreviewsReviewed(e.target.checked)}
                />
                <span>
                  I reviewed the image previews — images are correct and show
                  the actual product
                </span>
              </label>
            )}

          {/* Buttons */}
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button
              type="button"
              onClick={handlePromote}
              disabled={
                promoteBusy ||
                (validationResult.byField.imagesSelector?.passing >= 2 &&
                  !imagePreviewsReviewed)
              }
              style={{
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '8px 16px',
                fontSize: 14,
                fontWeight: 600,
                cursor:
                  promoteBusy ||
                  (validationResult.byField.imagesSelector?.passing >= 2 &&
                    !imagePreviewsReviewed)
                    ? 'not-allowed'
                    : 'pointer',
                opacity:
                  promoteBusy ||
                  (validationResult.byField.imagesSelector?.passing >= 2 &&
                    !imagePreviewsReviewed)
                    ? 0.6
                    : 1,
              }}
            >
              {promoteBusy ? 'Promoting…' : 'Promote'}
            </button>
            <button
              type="button"
              onClick={handleSomethingWrong}
              disabled={promoteBusy}
              style={{
                background: '#6b7280',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '8px 16px',
                fontSize: 14,
                fontWeight: 600,
                cursor: promoteBusy ? 'not-allowed' : 'pointer',
                opacity: promoteBusy ? 0.6 : 1,
              }}
            >
              Something's wrong
            </button>
          </div>
        </div>
      )}

      {/* promoting state */}
      {reviewState === 'promoting' && (
        <div style={{ padding: 12, background: '#f3f4f6', borderRadius: 6 }}>
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
            Promoting selectors to extractor profile…
          </p>
        </div>
      )}

      {/* promoted state */}
      {reviewState === 'promoted' && (
        <div
          style={{
            background: '#f0fdf4',
            border: '1px solid #86efac',
            borderRadius: 8,
            padding: 16,
          }}
        >
          <p style={{ color: '#166534', fontWeight: 600, margin: 0 }}>
            ✓ Generation promoted successfully. Selectors have been written to{' '}
            <code>extractor_profiles</code>.
          </p>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              style={{
                marginTop: 8,
                background: '#16a34a',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '6px 14px',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          )}
        </div>
      )}

      {/* feedback state */}
      {reviewState === 'feedback' && (
        <div
          style={{
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: 16,
            background: '#fffbeb',
          }}
        >
          <h4 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>
            What's wrong? Provide feedback
          </h4>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
            Select the field that needs revision and describe what's incorrect.
          </p>
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              marginBottom: 12,
            }}
          >
            {SELECTOR_FIELDS.map((field) => (
              <button
                key={field}
                type="button"
                onClick={() => setFeedbackField(field)}
                style={{
                  background: feedbackField === field ? '#2563eb' : '#fff',
                  color: feedbackField === field ? '#fff' : '#2563eb',
                  border: '1px solid #2563eb',
                  borderRadius: 4,
                  padding: '4px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Revise {field}
              </button>
            ))}
          </div>
          {feedbackField && latestRevision && (
            <ProfileRevisionFeedbackForm
              field={feedbackField}
              currentValue={
                (latestRevision.selectors as Record<string, string | null>)[
                  feedbackField
                ] ?? null
              }
              currentImages={
                feedbackField === 'imagesSelector'
                  ? validationResult?.samples
                      .filter((s) => s.field === 'imagesSelector')
                      .flatMap((s) =>
                        s.extractedImages.map((url) => ({
                          url,
                          sampleUrl: s.sampleUrl,
                          expectedName: s.expectedName,
                          brandHint: s.brandHint,
                          warnings: s.warnings,
                        })),
                      )
                  : undefined
              }
              sourcePageUrl={generation?.sourceUrl ?? ''}
              onSubmit={submitFeedback}
              busy={busy}
            />
          )}
          <button
            type="button"
            onClick={cancelFeedback}
            disabled={busy}
            style={{
              marginTop: 8,
              background: 'none',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              padding: '6px 14px',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── Below the fold ────────────────────────────────────────────────── */}

      {/* Revision history */}
      <div>
        <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>Revision history</h4>
        {revisions.length === 0 ? (
          <p style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
            No revisions yet.
          </p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {revisions
              .slice()
              .sort((a, b) => a.revisionNumber - b.revisionNumber)
              .map((r) => (
                <li
                  key={r.id}
                  style={{
                    borderLeft: '3px solid #d1d5db',
                    paddingLeft: 12,
                    marginBottom: 8,
                    fontSize: 12,
                    color: '#4b5563',
                  }}
                >
                  <strong>#{r.revisionNumber}</strong> · {r.source} · {r.status}
                  {' · '}
                  {new Date(r.createdAt).toLocaleString()}
                  {r.confidence ? (
                    <span> · conf {r.confidence.toFixed(2)}</span>
                  ) : null}
                </li>
              ))}
          </ul>
        )}
      </div>

      {/* Field decisions & rollback */}
      <div>
        <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>
          Field decisions &amp; rollback
        </h4>
        {decisions.length === 0 ? (
          <p style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>
            No field decisions yet.
          </p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {decisions
              .slice()
              .sort(
                (a, b) =>
                  new Date(b.decidedAt).getTime() -
                  new Date(a.decidedAt).getTime(),
              )
              .map((d) => (
                <li
                  key={d.id}
                  style={{
                    borderLeft: '3px solid #e5e7eb',
                    paddingLeft: 12,
                    marginBottom: 6,
                    fontSize: 12,
                    color: '#4b5563',
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      background:
                        d.decision === 'approved'
                          ? '#dcfce7'
                          : d.decision === 'rejected'
                            ? '#fee2e2'
                            : '#e0e7ff',
                      color:
                        d.decision === 'approved'
                          ? '#16a34a'
                          : d.decision === 'rejected'
                            ? '#dc2626'
                            : '#4338ca',
                      padding: '2px 6px',
                      borderRadius: 3,
                    }}
                  >
                    {d.decision}
                  </span>
                  <span>{d.selectorField}</span>
                  {d.previousSelector && (
                    <span style={{ color: '#9ca3af' }}>
                      was: <code>{d.previousSelector}</code>
                    </span>
                  )}
                  {d.approvedSelector && (
                    <span>
                      now: <code>{d.approvedSelector}</code>
                    </span>
                  )}
                  <span style={{ color: '#9ca3af' }}>
                    · {new Date(d.decidedAt).toLocaleString()}
                  </span>
                  {d.decision === 'approved' && (
                    <button
                      type="button"
                      onClick={() => handleRollback(d)}
                      disabled={busy}
                      style={{
                        background: 'none',
                        border: '1px solid #d1d5db',
                        color: '#6b7280',
                        borderRadius: 4,
                        padding: '2px 8px',
                        fontSize: 11,
                        cursor: busy ? 'not-allowed' : 'pointer',
                        marginLeft: 'auto',
                      }}
                    >
                      Rollback
                    </button>
                  )}
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}

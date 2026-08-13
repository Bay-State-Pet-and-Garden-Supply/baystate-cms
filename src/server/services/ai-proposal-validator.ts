// ---------------------------------------------------------------------------
// AI proposal validation (epic #42, #39)
//
// Deterministic, pure validation of AI-generated ProductField proposals.
// Responsibilities:
//  1. Fence stripping + strict JSON parsing of the model response.
//  2. Strict envelope/candidate schema validation (structural failures are
//     ALL-OR-NOTHING: persist nothing, keep prior proposals).
//  3. Deterministic business-rule validation per candidate (safe-skip with
//     bounded diagnostics for independent business rejections).
//
// `normalizationKind` is DERIVED from the old/new values using the same
// deterministic transformations the audit service uses — never from model
// prose or confidence. `safeToStage` is deterministic: casing/whitespace are
// mechanical; separator/typo/semantic always require review. Confidence is
// informational only and never affects `safeToStage`.
//
// This module is intentionally DB-free so it stays pure and testable.
// ---------------------------------------------------------------------------

import {
  AiProposalsEnvelopeSchema,
  MAX_AI_PROPOSAL_COUNT,
  MAX_AI_PROPOSAL_RESPONSE_BYTES,
  NORMALIZATION_KINDS,
  type NormalizationKind,
  type ProposalSource,
} from '../../shared/schemas/catalog-health-proposal';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AiProposalErrorCode =
  | 'invalid_json'
  | 'invalid_envelope'
  | 'response_too_large'
  | 'too_many_proposals'
  | 'no_proposals';

export type AiProposalBusinessCode =
  | 'identical_values'
  | 'unsafe_payload'
  | 'old_value_not_observed'
  | 'old_value_case_mismatch'
  | 'duplicate_mapping'
  | 'conflicting_mapping'
  | 'chain_mapping'
  | 'unsupported_field'
  | 'non_editable_field';

export interface AiProposalDiagnostic {
  /** 0-based candidate index in the model response; -1 for envelope-level. */
  index: number;
  /** Per-candidate outcome: accepted (safe-skip passed) or rejected. */
  status: 'accepted' | 'rejected';
  code: string;
  /** Derived normalization kind for accepted candidates (informational). */
  normalizationKind?: NormalizationKind;
  /** Deterministic staging safety for accepted candidates. */
  safeToStage?: boolean;
  /** Bounded, redacted message. Never raw model prose. */
  message: string;
}

export interface ValidatedAiProposal {
  oldValue: string;
  newValue: string;
  reason: string;
  confidence: number;
  normalizationKind: NormalizationKind;
  /** Deterministic. Never derived from confidence. */
  safeToStage: boolean;
}

export interface AiProposalValidationSuccess {
  ok: true;
  candidates: ValidatedAiProposal[];
  /** Per-candidate business rejections (safe-skip), bounded. */
  diagnostics: AiProposalDiagnostic[];
  rejectedCount: number;
}

export interface AiProposalValidationFailure {
  ok: false;
  code: AiProposalErrorCode;
  /** Redacted structural diagnostics. */
  diagnostics: AiProposalDiagnostic[];
}

export type AiProposalValidationResult =
  | AiProposalValidationSuccess
  | AiProposalValidationFailure;

export interface AiProposalValidationContext {
  workspaceId: string;
  field: string;
  /** Exact observed values from the audit snapshot (casing/whitespace preserved). */
  observedValues: ReadonlySet<string>;
  /** Whether the field is registered in the workspace field registry. */
  fieldRegistered: boolean;
  /** Whether the field is editable in the workspace field registry. */
  fieldEditable: boolean;
  /** Source recorded on persisted proposals ('ai' for this path). */
  source: ProposalSource;
}

// ---------------------------------------------------------------------------
// Deterministic helpers (mirror the audit-service transformations)
// ---------------------------------------------------------------------------

const SEPARATOR_NORMALIZE = (s: string): string =>
  s.toLowerCase().replace(/[\s\->/|;:]+/g, ' ').trim();

const CASING_NORMALIZE = (s: string): string => s.trim().toLowerCase();

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const HTML_MARKUP = /[<>]/;
const HTML_ENTITY = /&[a-z0-9#]+;/i;
const URL_LIKE = /^(https?:|file:)\/\//i;
const PATH_TRAVERSAL = /(^|[/\\])\.\.([/\\]|$)/;
const ABSOLUTE_PATH = /^([a-zA-Z]:)?[/\\]/;

/** Bounded, deterministic Levenshtein distance (used for typo detection). */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * Derive the normalization kind from the old/new value pair using the same
 * transformations the audit service uses. Priority: whitespace -> casing ->
 * separator -> typo -> semantic.
 */
export function classifyNormalizationKind(oldValue: string, newValue: string): NormalizationKind {
  if (oldValue === newValue) return 'semantic'; // identical is rejected earlier
  if (newValue === oldValue.trim() && newValue !== oldValue) return 'whitespace';
  if (CASING_NORMALIZE(oldValue) === CASING_NORMALIZE(newValue)) return 'casing';
  if (SEPARATOR_NORMALIZE(oldValue) === SEPARATOR_NORMALIZE(newValue)) return 'separator';
  const a = oldValue.toLowerCase();
  const b = newValue.toLowerCase();
  if (a.length >= 4 && b.length >= 4 && levenshteinDistance(a, b) <= 2) return 'typo';
  return 'semantic';
}

/** Deterministic staging safety. Semantic/typo/separator are never mechanical. */
export function safeToStageForKind(kind: NormalizationKind): boolean {
  return kind === 'casing' || kind === 'whitespace';
}

/** True when a value carries control chars, markup, URLs, or path payloads. */
export function hasUnsafePayload(value: string): boolean {
  return (
    CONTROL_CHARS.test(value) ||
    HTML_MARKUP.test(value) ||
    HTML_ENTITY.test(value) ||
    URL_LIKE.test(value) ||
    PATH_TRAVERSAL.test(value) ||
    ABSOLUTE_PATH.test(value)
  );
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Strip markdown code fences (```json ... ``` / ``` ... ```). */
export function stripCodeFence(raw: string): string {
  return raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
}

/**
 * Parse the raw model response into a structurally valid envelope.
 * Structural failures (bad JSON, schema violations, oversized) are
 * all-or-nothing: callers persist nothing on failure.
 */
export function parseAiProposalsEnvelope(
  raw: string,
): { ok: true; envelope: { proposals: Array<{ oldValue: string; newValue: string; reason?: string; confidence?: number }> } } | { ok: false; code: AiProposalErrorCode; diagnostics: AiProposalDiagnostic[] } {
  if (raw.length > MAX_AI_PROPOSAL_RESPONSE_BYTES) {
    return {
      ok: false,
      code: 'response_too_large',
      diagnostics: [{ index: -1, status: 'rejected', code: 'response_too_large', message: `AI response exceeds the ${MAX_AI_PROPOSAL_RESPONSE_BYTES}-byte limit.` }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return {
      ok: false,
      code: 'invalid_json',
      diagnostics: [{ index: -1, status: 'rejected', code: 'invalid_json', message: 'AI response is not valid JSON.' }],
    };
  }

  const result = AiProposalsEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    const diagnostics = result.error.issues.slice(0, 10).map((issue) => ({
      index: -1,
      status: 'rejected' as const,
      code: 'invalid_envelope',
      message: `Invalid proposal envelope at ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    }));
    return { ok: false, code: 'invalid_envelope', diagnostics };
  }

  const envelope = result.data;
  if (envelope.proposals.length > MAX_AI_PROPOSAL_COUNT) {
    return {
      ok: false,
      code: 'too_many_proposals',
      diagnostics: [{ index: -1, status: 'rejected', code: 'too_many_proposals', message: `AI response contains more than ${MAX_AI_PROPOSAL_COUNT} proposals.` }],
    };
  }
  return { ok: true, envelope };
}

// ---------------------------------------------------------------------------
// Business-rule validation
// ---------------------------------------------------------------------------

/**
 * Validate every candidate against deterministic business rules. Independent
 * per-candidate rejections are safe-skipped with bounded diagnostics; the
 * returned candidates are safe to persist (subject to the transaction in the
 * caller).
 */
export function validateAiProposalCandidates(
  envelope: { proposals: Array<{ oldValue: string; newValue: string; reason?: string; confidence?: number }> },
  ctx: AiProposalValidationContext,
): { candidates: ValidatedAiProposal[]; diagnostics: AiProposalDiagnostic[] } {
  const diagnostics: AiProposalDiagnostic[] = [];
  const accepted: ValidatedAiProposal[] = [];

  // Cross-candidate maps for duplicate/conflict/chain detection.
  const byOld = new Map<string, string[]>(); // oldValue -> newValues seen
  const newValueSet = new Set<string>();
  const oldValueSet = new Set<string>();

  for (const c of envelope.proposals) {
    oldValueSet.add(c.oldValue);
    newValueSet.add(c.newValue);
  }

  const reject = (index: number, code: string, message: string) => {
    diagnostics.push({ index, status: 'rejected', code, message });
  };


  envelope.proposals.forEach((c, index) => {
    // Exact values as the model quoted them (casing/whitespace preserved).
    const oldValue = c.oldValue;
    const newValue = c.newValue;

    // 1. Identical values are never a proposal.
    if (oldValue === newValue) {
      reject(index, 'identical_values', 'oldValue and newValue are identical.');
      return;
    }

    // 2. No control/markup/path/URL payloads in either value.
    if (hasUnsafePayload(oldValue) || hasUnsafePayload(newValue)) {
      reject(index, 'unsafe_payload', 'Proposal contains control characters, markup, URLs, or path payloads.');
      return;
    }

    // 3. oldValue must be an exact observed catalog value.
    if (!ctx.observedValues.has(oldValue)) {
      const caseVariantExists = Array.from(ctx.observedValues).some(
        (v) => v.toLowerCase().trim() === oldValue.toLowerCase().trim(),
      );
      reject(
        index,
        caseVariantExists ? 'old_value_case_mismatch' : 'old_value_not_observed',
        caseVariantExists
          ? `oldValue "${oldValue}" does not exactly match an observed value (a casing variant exists).`
          : `oldValue "${oldValue}" is not an observed catalog value for ${ctx.field}.`,
      );
      return;
    }

    // 4. Cross-candidate duplicates / conflicts / chains.
    const priorNewValues = byOld.get(oldValue);
    if (priorNewValues?.includes(newValue)) {
      reject(index, 'duplicate_mapping', `Duplicate mapping for "${oldValue}" -> "${newValue}".`);
      return;
    }
    if (priorNewValues && priorNewValues.length > 0) {
      reject(index, 'conflicting_mapping', `Conflicting mappings proposed for "${oldValue}".`);
      return;
    }
    // Chain/cycle: this candidate's oldValue is another candidate's target, or
    // its newValue becomes another candidate's source.
    const isChain =
      newValueSet.has(oldValue) || oldValueSet.has(newValue);
    if (isChain) {
      reject(index, 'chain_mapping', 'Proposal participates in a mapping chain or cycle.');
      return;
    }

    byOld.set(oldValue, [...(byOld.get(oldValue) ?? []), newValue]);

    const kind = classifyNormalizationKind(oldValue, newValue);
    accepted.push({
      oldValue,
      newValue,
      reason: c.reason && c.reason.trim().length > 0 ? c.reason : 'AI recommendation',
      confidence: c.confidence ?? 0.8,
      normalizationKind: kind,
      safeToStage: safeToStageForKind(kind),
    });
    diagnostics.push({
      index,
      status: 'accepted',
      code: 'accepted',
      normalizationKind: kind,
      safeToStage: safeToStageForKind(kind),
      message: `validated as ${NORMALIZATION_KIND_LABELS[kind]}; staging safety is deterministic (${safeToStageForKind(kind) ? 'mechanical' : 'review required'}).`,
    });
  });

  return { candidates: accepted, diagnostics };
}

/**
 * Full pipeline: parse envelope (all-or-nothing) then validate candidates
 * (safe-skip). Returns a success with candidates+diagnostics, or a failure
 * with structural diagnostics.
 */
export function validateAiProposalResponse(
  raw: string,
  ctx: AiProposalValidationContext,
): AiProposalValidationResult {
  const envelope = parseAiProposalsEnvelope(raw);
  if (!envelope.ok) {
    return envelope;
  }
  const { candidates, diagnostics } = validateAiProposalCandidates(envelope.envelope, ctx);
  return {
    ok: true,
    candidates,
    diagnostics,
    rejectedCount: diagnostics.filter((d) => d.status === 'rejected').length,
  };
}

// ---------------------------------------------------------------------------
// Kind metadata (exported for diagnostics / UI copy)
// ---------------------------------------------------------------------------

export const NORMALIZATION_KIND_LABELS: Record<NormalizationKind, string> = {
  casing: 'casing normalization (mechanical)',
  whitespace: 'whitespace normalization (mechanical)',
  separator: 'separator cleanup (review required)',
  typo: 'typo correction (review required)',
  semantic: 'semantic/taxonomy consolidation (review required)',
};

export { NORMALIZATION_KINDS };
export type { ProposalSource };

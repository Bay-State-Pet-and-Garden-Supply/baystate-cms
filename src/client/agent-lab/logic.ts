/**
 * Agent Lab pure logic (PI-7).
 *
 * All client-side computation that doesn't need React/DOM/fetch lives here so
 * it can be unit-tested under vitest's default node environment without jsdom.
 * Components import these helpers; tests exercise them directly.
 *
 * HARD RULE: never surface raw model/message content in timeline items.
 * Only structured event payload fields (toolName, isError, field, severity,
 * reasons, sourceUrl, rightsStatus, schemaVersion, code) are rendered.
 */

import type {
  PiLiveEvent,
  PiRunRow,
  PiRunProjection,
  PiEvidenceRow,
  PiConflictRow,
  PiResultRow,
  PiToolCallRow,
  PiComparisonRow,
} from '../product-intelligence-api';

// ---------------------------------------------------------------------------
// Run launch validation
// ---------------------------------------------------------------------------

export type RunLaunchFields =
  | { sku: string; name: string; price?: string }
  | { gtin: string; registerName: string; price?: string; quantity?: number };

export interface ValidationResult {
  valid: boolean;
  issues: string[];
}

export function validateRunLaunch(fields: RunLaunchFields): ValidationResult {
  const issues: string[] = [];

  if ('sku' in fields) {
    if (!fields.sku.trim()) issues.push('SKU is required');
    if (!fields.name.trim()) issues.push('Product name is required');
  } else {
    const digits = fields.gtin.replace(/[\s-]/g, '');
    if (!digits) issues.push('GTIN is required');
    else if (!/^\d+$/.test(digits)) issues.push('GTIN must contain only digits');
    else if (digits.length < 8 || digits.length > 14) issues.push('GTIN must be 8-14 digits');
    if (!fields.registerName.trim()) issues.push('Register name is required');
    if (fields.quantity !== undefined && (!Number.isInteger(fields.quantity) || fields.quantity < 1)) {
      issues.push('Quantity must be a positive integer');
    }
  }

  if (fields.price !== undefined && fields.price !== '') {
    const price = Number(fields.price);
    if (!Number.isFinite(price) || price < 0) {
      issues.push('Price must be a non-negative number');
    }
  }

  return { valid: issues.length === 0, issues };
}

export function buildRunLaunchPayload(fields: { sku: string; name: string; price?: string }): { sku: string; name: string; price?: string };
export function buildRunLaunchPayload(fields: { gtin: string; registerName: string; brandHint?: string; departmentHint?: string; price?: string; quantity?: number }): Record<string, unknown>;
export function buildRunLaunchPayload(fields: { sku?: string; name?: string; gtin?: string; registerName?: string; brandHint?: string; departmentHint?: string; price?: string; quantity?: number }): Record<string, unknown> {
  if (fields.sku !== undefined || fields.name !== undefined) {
    const payload: { sku: string; name: string; price?: string } = { sku: fields.sku?.trim() ?? '', name: fields.name?.trim() ?? '' };
    if (fields.price !== undefined && fields.price !== '') payload.price = fields.price;
    return payload;
  }
  const payload: Record<string, unknown> = {
    gtin: fields.gtin?.replace(/[\s-]/g, '') ?? '',
    registerName: fields.registerName?.trim() ?? '',
  };
  if (fields.brandHint?.trim()) payload.brandHint = fields.brandHint.trim();
  if (fields.departmentHint?.trim()) payload.departmentHint = fields.departmentHint.trim();
  if (fields.price !== undefined && fields.price !== '') payload.price = fields.price;
  if (fields.quantity !== undefined) payload.quantity = fields.quantity;
  return payload;
}

// ---------------------------------------------------------------------------
// Event presentation / timeline
// ---------------------------------------------------------------------------

export type EventTone = 'info' | 'ok' | 'warn' | 'error';

export interface EventPresentation {
  label: string;
  icon: string;
  tone: EventTone;
}

export const EVENT_PRESENTATION: Record<string, EventPresentation> = {
  'run.started': { label: 'Run started', icon: '🚀', tone: 'info' },
  'step.started': { label: 'Step started', icon: '▶', tone: 'info' },
  'step.completed': { label: 'Step completed', icon: '✓', tone: 'ok' },
  'tool.started': { label: 'Tool started', icon: '🔧', tone: 'info' },
  'tool.completed': { label: 'Tool completed', icon: '🔧', tone: 'ok' },
  'result.updated': { label: 'Result updated', icon: '📄', tone: 'info' },
  'run.completed': { label: 'Run completed', icon: '✓', tone: 'ok' },
  'run.failed': { label: 'Run failed', icon: '✕', tone: 'error' },
  'run.cancelled': { label: 'Run cancelled', icon: '⊘', tone: 'warn' },
  'source.added': { label: 'Source added', icon: '🌐', tone: 'info' },
  'evidence.added': { label: 'Evidence added', icon: '🔬', tone: 'info' },
  'conflict.detected': { label: 'Conflict detected', icon: '⚠', tone: 'warn' },
  'asset.added': { label: 'Asset added', icon: '🖼', tone: 'info' },
  'run.needs_review': { label: 'Needs review', icon: '⏸', tone: 'warn' },
};

const FALLBACK_PRESENTATION: EventPresentation = {
  label: 'Event',
  icon: '•',
  tone: 'info',
};

/** Allowed payload fields for timeline detail — everything else is ignored. */
const ALLOWED_PAYLOAD_KEYS = new Set([
  'toolName',
  'isError',
  'field',
  'severity',
  'reasons',
  'sourceUrl',
  'rightsStatus',
  'schemaVersion',
  'code',
  'domain',
  'url',
  'evidenceId',
  'conflictId',
  'sourceId',
  'disposition',
  'outcome',
  'executor',
  'commerceApproved',
]);

export interface TimelineItem {
  key: string;
  sequence: number;
  timestamp: string;
  type: string;
  label: string;
  icon: string;
  tone: EventTone;
  detail: string;
}

export function toTimelineItems(events: PiLiveEvent[]): TimelineItem[] {
  return events.map((event) => {
    const presentation = EVENT_PRESENTATION[event.type] ?? FALLBACK_PRESENTATION;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(payload)) {
      if (!ALLOWED_PAYLOAD_KEYS.has(key)) continue;
      const val = payload[key];
      if (val === null || val === undefined) continue;
      if (typeof val === 'boolean') {
        parts.push(`${key}: ${val ? 'yes' : 'no'}`);
      } else if (Array.isArray(val)) {
        parts.push(`${key}: ${val.join(', ')}`);
      } else {
        parts.push(`${key}: ${String(val)}`);
      }
    }
    return {
      key: `${event.runId}:${event.sequence}`,
      sequence: event.sequence,
      timestamp: event.createdAt,
      type: event.type,
      label: presentation.label,
      icon: presentation.icon,
      tone: presentation.tone,
      detail: parts.join(' · '),
    };
  });
}

// ---------------------------------------------------------------------------
// Event stream merge
// ---------------------------------------------------------------------------

export function mergeEventStream(prev: PiLiveEvent[], incoming: PiLiveEvent[]): PiLiveEvent[] {
  const map = new Map<string, PiLiveEvent>();
  for (const e of prev) map.set(`${e.runId}:${e.sequence}`, e);
  for (const e of incoming) map.set(`${e.runId}:${e.sequence}`, e);
  return Array.from(map.values()).sort((a, b) => a.sequence - b.sequence);
}

// ---------------------------------------------------------------------------
// Terminal detection
// ---------------------------------------------------------------------------

const TERMINAL_EVENT_TYPES = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

export function isTerminalEvent(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// Field status derivation
// ---------------------------------------------------------------------------

export type FieldStatus = 'verified' | 'conflicting' | 'inferred' | 'missing' | 'resolved';

export function deriveFieldStatus(
  field: string,
  evidence: PiEvidenceRow[],
  conflicts: PiConflictRow[],
  result: PiResultRow | null,
  manuallyResolved: Set<string>,
): FieldStatus {
  if (manuallyResolved.has(field)) return 'resolved';

  const hasConflict = conflicts.some((c) => conflictMatchesField(c, field) && c.status === 'open');
  if (hasConflict) return 'conflicting';

  const hasEvidence = evidence.some(
    (e) => e.targetField === field && e.directSupport > 0,
  );
  if (hasEvidence) return 'verified';

  if (result) {
    const parsed = safeParseJson(result.resultJson);
    if (parsed && fieldPresentInResult(parsed, field)) return 'inferred';
  }

  return 'missing';
}

/**
 * The server persists the full ProductResearchResult envelope, with the
 * submission nested under `submission` (pi-executor buildResult). Read from
 * that level, falling back to top-level for robustness.
 */
function submissionOf(result: Record<string, unknown>): Record<string, unknown> {
  const sub = result.submission;
  if (sub && typeof sub === 'object' && !Array.isArray(sub)) return sub as Record<string, unknown>;
  return result;
}

/**
 * PI-1 conflicts are persisted under their machine category (e.g.
 * `title_conflict`) while the proposal field is `title`; PI-4 bundles use the
 * field name directly. Match both.
 */
export function conflictMatchesField(conflict: PiConflictRow, field: string): boolean {
  return (
    conflict.field === field ||
    conflict.field === `${field}_conflict` ||
    conflict.field.startsWith(`${field}_`)
  );
}

function fieldPresentInResult(result: Record<string, unknown>, field: string): boolean {
  const parsed = submissionOf(result);
  // PI-1 envelope: productProposal.fields[].field === field
  const proposal = parsed.productProposal as Record<string, unknown> | undefined;
  if (proposal && Array.isArray(proposal.fields)) {
    for (const f of proposal.fields as Array<Record<string, unknown>>) {
      if (f.field === field) return true;
    }
  }
  // PI-4 bundle: identity.canonicalName→title, identity.brand→brand, commerceFacts[].field === field
  const identity = result.identity as Record<string, unknown> | undefined;
  if (identity) {
    const fieldMap: Record<string, string> = {
      title: 'canonicalName',
      brand: 'brand',
      manufacturer: 'manufacturer',
      variant: 'variant',
    };
    const resultKey = fieldMap[field];
    if (resultKey && identity[resultKey] != null) return true;
  }
  const commerceFacts = result.commerceFacts;
  if (Array.isArray(commerceFacts)) {
    for (const f of commerceFacts as Array<Record<string, unknown>>) {
      if (f.field === field) return true;
    }
  }
  return false;
}

function safeParseJson(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Proposal fields extraction (from result)
// ---------------------------------------------------------------------------

export interface ProposalField {
  key: string;
  label: string;
  value: string | null;
}

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  brand: 'Brand',
  description: 'Description',
  bullets: 'Bullets',
  size: 'Size',
  count: 'Count',
  productType: 'Product Type',
  attributes: 'Attributes',
  categoryPages: 'Category Pages',
  primaryImage: 'Primary Image',
  manufacturer: 'Manufacturer',
  variant: 'Variant',
};

export function getProposalFields(result: PiResultRow | null): ProposalField[] {
  if (!result) return [];
  const parsed = safeParseJson(result.resultJson);
  if (!parsed) return [];

  const fields: ProposalField[] = [];

  // The server persists the full result envelope; the submission (PI-1
  // envelope or PI-4 bundle) is nested under `submission`.
  const submission = submissionOf(parsed);

  // PI-1 envelope
  const proposal = submission.productProposal as Record<string, unknown> | undefined;
  if (proposal && Array.isArray(proposal.fields)) {
    for (const f of proposal.fields as Array<Record<string, unknown>>) {
      const key = String(f.field ?? '');
      fields.push({
        key,
        label: FIELD_LABELS[key] ?? key,
        value: f.value != null ? String(f.value) : null,
      });
    }
  }

  // PI-4 bundle
  const identity = submission.identity as Record<string, unknown> | undefined;
  if (identity) {
    const identityFields: Array<[string, string]> = [
      ['canonicalName', 'title'],
      ['brand', 'brand'],
      ['manufacturer', 'manufacturer'],
      ['variant', 'variant'],
    ];
    for (const [srcKey, destKey] of identityFields) {
      const val = identity[srcKey];
      if (val != null) {
        if (!fields.some((f) => f.key === destKey)) {
          fields.push({
            key: destKey,
            label: FIELD_LABELS[destKey] ?? destKey,
            value: String(val),
          });
        }
      }
    }
    const netContent = identity.netContent as Record<string, unknown> | undefined;
    if (netContent && netContent.value != null) {
      if (!fields.some((f) => f.key === 'size')) {
        fields.push({
          key: 'size',
          label: 'Size',
          value: `${netContent.value} ${netContent.unit ?? ''}`.trim(),
        });
      }
    }
    const packCount = identity.packCount;
    if (packCount != null) {
      if (!fields.some((f) => f.key === 'count')) {
        fields.push({
          key: 'count',
          label: 'Count',
          value: String(packCount),
        });
      }
    }
  }

  const commerceFacts = submission.commerceFacts;
  if (Array.isArray(commerceFacts)) {
    for (const f of commerceFacts as Array<Record<string, unknown>>) {
      const key = String(f.field ?? '');
      if (!fields.some((existing) => existing.key === key)) {
        fields.push({
          key,
          label: FIELD_LABELS[key] ?? key,
          value: f.value != null ? String(f.value) : null,
        });
      }
    }
  }

  // images
  const images = submission.images;
  if (Array.isArray(images) && images.length > 0) {
    if (!fields.some((f) => f.key === 'primaryImage')) {
      const first = images[0] as Record<string, unknown>;
      fields.push({
        key: 'primaryImage',
        label: 'Primary Image',
        value: first.url != null ? String(first.url) : null,
      });
    }
  }
  const imageCandidates = submission.imageCandidates;
  if (Array.isArray(imageCandidates) && imageCandidates.length > 0) {
    if (!fields.some((f) => f.key === 'primaryImage')) {
      const first = imageCandidates[0] as Record<string, unknown>;
      fields.push({
        key: 'primaryImage',
        label: 'Primary Image',
        value: first.url != null ? String(first.url) : null,
      });
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Metrics computation
// ---------------------------------------------------------------------------

export interface MetricsResult {
  runCount: number;
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  completionRate: number;
  failureRate: number;
  abstentionRate: number;
  avgDurationMs: number;
  totalCostUsd: number;
  avgCostUsd: number;
  withCost: number;
  deterministicCount: number;
  deterministicRate: number;
  escalatedCount: number;
  escalationRate: number;
  profileHitCount: number;
  profileHitRate: number;
}

export function computeMetrics(
  runs: PiRunRow[],
  projections: Map<string, PiRunProjection>,
): MetricsResult {
  const runCount = runs.length;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;
  let running = 0;
  let abstained = 0;
  let completedWithResult = 0;
  let totalDuration = 0;
  let durationCount = 0;
  let totalCost = 0;
  let withCost = 0;
  let deterministicCount = 0;
  let escalatedCount = 0;
  let profileHitCount = 0;

  for (const run of runs) {
    const proj = projections.get(run.id);
    const hasProfileEvidence = proj?.evidence?.some((e) => e.extractionMethod === 'profile_selector') ?? false;
    if (hasProfileEvidence) profileHitCount++;

    const isDeterministic = (run.actualCost === 0 || run.actualCost === null) && (proj?.toolCalls?.length === 0 || run.piVersion?.startsWith('preflight'));
    if (run.status === 'completed' && isDeterministic) {
      deterministicCount++;
    } else if (run.status === 'completed' || (proj?.toolCalls && proj.toolCalls.length > 0)) {
      escalatedCount++;
    }

    switch (run.status) {
      case 'completed':
        completed++;
        {
          if (proj?.result) {
            completedWithResult++;
            if (proj.result.disposition === 'abstained') abstained++;
          }
        }
        if (run.completedAt) {
          const dur = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
          if (Number.isFinite(dur) && dur >= 0) {
            totalDuration += dur;
            durationCount++;
          }
        }
        if (run.actualCost != null) {
          totalCost += run.actualCost;
          withCost++;
        }
        break;
      case 'failed':
        failed++;
        if (run.completedAt) {
          const dur = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
          if (Number.isFinite(dur) && dur >= 0) {
            totalDuration += dur;
            durationCount++;
          }
        }
        break;
      case 'cancelled':
        cancelled++;
        break;
      case 'running':
        running++;
        break;
    }
  }

  return {
    runCount,
    completed,
    failed,
    cancelled,
    running,
    completionRate: runCount > 0 ? completed / runCount : 0,
    failureRate: runCount > 0 ? failed / runCount : 0,
    abstentionRate: completedWithResult > 0 ? abstained / completedWithResult : 0,
    avgDurationMs: durationCount > 0 ? totalDuration / durationCount : 0,
    totalCostUsd: totalCost,
    avgCostUsd: withCost > 0 ? totalCost / withCost : 0,
    withCost,
    deterministicCount,
    deterministicRate: runCount > 0 ? deterministicCount / runCount : 0,
    escalatedCount,
    escalationRate: runCount > 0 ? escalatedCount / runCount : 0,
    profileHitCount,
    profileHitRate: runCount > 0 ? profileHitCount / runCount : 0,
  };
}

// ---------------------------------------------------------------------------
// Comparison row formatting
// ---------------------------------------------------------------------------

export interface ComparisonMetric {
  label: string;
  value: string;
}

export function formatComparisonRow(row: PiComparisonRow): ComparisonMetric[] {
  const metrics = safeParseJson(row.metricsJson);
  if (!metrics) return [];
  const result: ComparisonMetric[] = [];
  const labelMap: Record<string, string> = {
    executor: 'Executor',
    outcome: 'Outcome',
    durationMs: 'Duration (ms)',
    fieldCount: 'Fields',
    conflictCount: 'Conflicts',
    sourceCount: 'Sources',
    imageCount: 'Images',
    abstained: 'Abstained',
    errorCode: 'Error code',
  };
  for (const key of Object.keys(metrics)) {
    const val = metrics[key];
    if (val === null || val === undefined) continue;
    result.push({
      label: labelMap[key] ?? key,
      value: typeof val === 'boolean' ? (val ? 'yes' : 'no') : String(val),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Image URL extraction
// ---------------------------------------------------------------------------

export function primaryImageUrl(projection: PiRunProjection | null): string | null {
  if (!projection) return null;
  // first primary-role asset
  for (const asset of projection.assets) {
    if (asset.rightsStatus === 'approved' && asset.commerceApproved) {
      return asset.sourceUrl;
    }
  }
  // first commerceApproved
  const approved = projection.assets.find((a) => a.commerceApproved);
  if (approved) return approved.sourceUrl;
  // proposal image from result
  const fields = getProposalFields(projection.result);
  const img = fields.find((f) => f.key === 'primaryImage');
  return img?.value ?? null;
}

// ---------------------------------------------------------------------------
// Tool failure rates
// ---------------------------------------------------------------------------

export interface ToolFailureRates {
  total: number;
  denied: number;
  budgetExceeded: number;
  deniedRate: number;
}

export function computeToolFailureRates(toolCalls: PiToolCallRow[]): ToolFailureRates {
  const total = toolCalls.length;
  const denied = toolCalls.filter((t) => t.policyOutcome === 'denied').length;
  const budgetExceeded = toolCalls.filter((t) => t.policyOutcome === 'budget_exceeded').length;
  return {
    total,
    denied,
    budgetExceeded,
    deniedRate: total > 0 ? (denied + budgetExceeded) / total : 0,
  };
}
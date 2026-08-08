// fallow-ignore-file unused-export

/**
 * Pure classification-readiness UI derivation (issue #17 work item L).
 *
 * Derives per-capability display states and the overall run gate from the
 * validated readiness report. Kept free of React/HTTP so it can be unit-tested
 * without a DOM harness and reused by Settings, Pipeline Board, and the
 * catalog classification panel.
 */
import type { ClassificationReadinessReportDto } from '../shared/schemas/classification';

export type ReadinessCapabilityKind = 'product_type' | 'product_field' | 'page';

export type ReadinessDisplayState = 'ready' | 'disabled' | 'warning' | 'error' | 'unknown';

export interface ReadinessCapabilityView {
  kind: ReadinessCapabilityKind;
  enabled: boolean;
  runnable: boolean;
  state: ReadinessDisplayState;
  reason: string;
}

export interface ReadinessView {
  isReady: boolean;
  hasWarnings: boolean;
  overallState: ReadinessDisplayState;
  capabilities: Record<ReadinessCapabilityKind, ReadinessCapabilityView>;
  findingCodes: string[];
  summary: string[];
}

/** Conservative: a failed/unparseable fetch must never read as ready. */
export function readinessViewFromReport(report: ClassificationReadinessReportDto | null | undefined): ReadinessView {
  if (!report) {
    return {
      isReady: false,
      hasWarnings: false,
      overallState: 'unknown',
      capabilities: {
        product_type: { kind: 'product_type', enabled: false, runnable: false, state: 'unknown', reason: 'Readiness report unavailable' },
        product_field: { kind: 'product_field', enabled: false, runnable: false, state: 'unknown', reason: 'Readiness report unavailable' },
        page: { kind: 'page', enabled: false, runnable: false, state: 'unknown', reason: 'Readiness report unavailable' },
      },
      findingCodes: [],
      summary: [],
    };
  }

  const capabilityState = (cap: { enabled: boolean; runnable: boolean; reason?: string | null }): ReadinessDisplayState => {
    if (!cap.enabled) return 'disabled';
    if (cap.runnable) return 'ready';
    return 'error';
  };

  const typeView = capabilityState(report.capabilities.productType);
  const fieldView = capabilityState(report.capabilities.productFields);
  const pageView = capabilityState(report.capabilities.categoryPages);

  const overallState: ReadinessDisplayState = report.isReady
    ? (report.hasWarnings ? 'warning' : 'ready')
    : (typeView === 'error' || fieldView === 'error' || pageView === 'error' ? 'error' : 'disabled');

  return {
    isReady: report.isReady,
    hasWarnings: report.hasWarnings,
    overallState,
    capabilities: {
      product_type: {
        kind: 'product_type',
        enabled: report.capabilities.productType.enabled,
        runnable: report.capabilities.productType.runnable,
        state: typeView,
        reason: report.capabilities.productType.reason ?? '',
      },
      product_field: {
        kind: 'product_field',
        enabled: report.capabilities.productFields.enabled,
        runnable: report.capabilities.productFields.runnable,
        state: fieldView,
        reason: report.capabilities.productFields.reason ?? '',
      },
      page: {
        kind: 'page',
        enabled: report.capabilities.categoryPages.enabled,
        runnable: report.capabilities.categoryPages.runnable,
        state: pageView,
        reason: report.capabilities.categoryPages.reason ?? '',
      },
    },
    findingCodes: report.findings.map(f => f.code),
    summary: report.summary,
  };
}

/** Whether a run action should be blocked by readiness. */
export function shouldBlockRun(view: ReadinessView): boolean {
  return !view.isReady;
}

/** The first blocking finding code, or null when ready. */
export function blockingFindingCode(view: ReadinessView): string | null {
  if (view.isReady) return null;
  return view.findingCodes[0] ?? 'classification_not_ready';
}

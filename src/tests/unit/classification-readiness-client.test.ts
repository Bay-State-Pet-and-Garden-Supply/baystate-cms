import { describe, expect, it } from 'vitest';
import {
  readinessViewFromReport,
  shouldBlockRun,
  blockingFindingCode,
  type ReadinessView,
} from '../../client/classification-readiness-view';
import type { ClassificationReadinessReportDto } from '../../shared/schemas/classification';

function report(overrides: Partial<ClassificationReadinessReportDto> = {}): ClassificationReadinessReportDto {
  return {
    isReady: true,
    hasWarnings: false,
    capabilities: {
      productType: { kind: 'product_type', enabled: true, targetCount: 1, runnable: true, reason: null },
      productFields: { kind: 'product_field', enabled: true, targetCount: 1, runnable: true, reason: null },
      categoryPages: { kind: 'page', enabled: true, targetCount: 1, runnable: true, reason: null },
    },
    findings: [],
    summary: ['Product Type classification is runnable.'],
    ...overrides,
  };
}

describe('classification-readiness-view (issue #17 L)', () => {
  it('derives a ready view from a fully ready report', () => {
    const view = readinessViewFromReport(report());
    expect(view.isReady).toBe(true);
    expect(view.overallState).toBe('ready');
    expect(view.capabilities.product_type.state).toBe('ready');
    expect(view.capabilities.page.state).toBe('ready');
    expect(shouldBlockRun(view)).toBe(false);
    expect(blockingFindingCode(view)).toBeNull();
  });

  it('marks disabled capabilities without blocking already-runnable ones', () => {
    const view = readinessViewFromReport(report({
      capabilities: {
        productType: { kind: 'product_type', enabled: false, targetCount: 0, runnable: false, reason: 'No enabled Product Type targets' },
        productFields: { kind: 'product_field', enabled: true, targetCount: 1, runnable: true, reason: null },
        categoryPages: { kind: 'page', enabled: false, targetCount: 0, runnable: false, reason: 'No enabled Category Page targets' },
      },
    }));
    expect(view.capabilities.product_type.state).toBe('disabled');
    expect(view.capabilities.page.state).toBe('disabled');
    expect(view.capabilities.product_field.state).toBe('ready');
  });

  it('marks an enabled-but-not-runnable capability as an error and blocks the run', () => {
    const view = readinessViewFromReport(report({
      isReady: false,
      capabilities: {
        productType: { kind: 'product_type', enabled: true, targetCount: 1, runnable: true, reason: null },
        productFields: { kind: 'product_field', enabled: true, targetCount: 1, runnable: true, reason: null },
        categoryPages: { kind: 'page', enabled: true, targetCount: 1, runnable: false, reason: 'No verified store pages available' },
      },
      findings: [
        { severity: 'error', code: 'verified_page_catalog_required', path: '$.curationTargets[0].enabled', message: 'Enabled Page assignment requires an active verified Page import.' },
      ],
    }));
    expect(view.overallState).toBe('error');
    expect(view.capabilities.page.state).toBe('error');
    expect(view.capabilities.page.reason).toBe('No verified store pages available');
    expect(shouldBlockRun(view)).toBe(true);
    expect(blockingFindingCode(view)).toBe('verified_page_catalog_required');
  });

  it('shows a warning state when ready but warning findings exist', () => {
    const view = readinessViewFromReport(report({
      hasWarnings: true,
      findings: [
        { severity: 'warning', code: 'page_only_workspace', path: '$.curationTargets', message: 'Page-only workspace.' },
      ],
    }));
    expect(view.isReady).toBe(true);
    expect(view.overallState).toBe('warning');
    expect(shouldBlockRun(view)).toBe(false);
  });

  it('fails conservatively (unknown) when no report is available', () => {
    const view = readinessViewFromReport(null);
    expect(view.isReady).toBe(false);
    expect(view.overallState).toBe('unknown');
    expect(view.capabilities.product_type.state).toBe('unknown');
    expect(view.capabilities.product_type.reason).toBe('Readiness report unavailable');
    expect(shouldBlockRun(view)).toBe(true);
    expect(blockingFindingCode(view)).toBe('classification_not_ready');
  });

  it('keeps view derivation pure — no report mutation and stable output', () => {
    const input = report();
    const first = readinessViewFromReport(input);
    const second = readinessViewFromReport(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect((first as ReadinessView).isReady).toBe(true);
  });
});

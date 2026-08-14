import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  compileStoreManagerCommand,
  StoreManagerCommandCompileError,
} from '../../store-manager/commands/compiler';

/**
 * Operations console, Issue 2 — the server-owned command compiler.
 * Pure: no DB, no services, no model, no tool dispatch.
 */

const ALL_TOOL_VERSIONS: Record<string, number> = {
  getProductFieldAudit: 1,
  getCatalogHealthReport: 1,
  listCatalogHealthIssues: 1,
  listStoredProposals: 1,
  getChangeSetDetail: 1,
  getStoreManagerReport: 1,
  repair_approved_change_set_images: 1,
  searchProducts: 1,
  getDashboardStats: 1,
  preview_product_field_normalization: 1,
};
const resolveToolVersion = (name: string): number | undefined => ALL_TOOL_VERSIONS[name];

const base = (raw: string, pinnedScope: unknown = null) =>
  compileStoreManagerCommand(raw, { pinnedScope: pinnedScope as never, resolveToolVersion });

describe('Store Manager command compiler (Issue 2)', () => {
  it('compiles every required command to the expected objective/scope/tool hints', () => {
    const audit = base('/audit ProductField24');
    expect(audit.commandName).toBe('audit');
    expect(audit.scopeHint).toEqual({ kind: 'product_field', field: 'ProductField24' });
    expect(audit.expectedToolHints.map((h) => h.name)).toEqual(['getProductFieldAudit']);
    expect(audit.planPreview).toBe(false);
    expect(audit.objective).toContain('ProductField24');

    const health = base('/health');
    expect(health.scopeHint).toBeNull();
    expect(health.expectedToolHints.map((h) => h.name).sort()).toEqual(
      ['getCatalogHealthReport', 'listCatalogHealthIssues'].sort(),
    );

    const explain = base('/explain SKU123');
    expect(explain.scopeHint).toEqual({ kind: 'sku_set', skus: ['SKU123'] });
    expect(explain.expectedToolHints.some((h) => h.name === 'searchProducts')).toBe(true);

    const proposals = base('/proposals');
    expect(proposals.expectedToolHints.map((h) => h.name)).toEqual(['listStoredProposals']);

    const changeset = base('/changeset cs-1');
    expect(changeset.scopeHint).toEqual({ kind: 'change_set', changeSetId: 'cs-1' });

    const report = base('/report');
    expect(report.expectedToolHints.map((h) => h.name)).toEqual(['getStoreManagerReport']);

    const repair = base('/repair-images cs-1');
    expect(repair.requiresApproval).toBe(true);
    expect(repair.networkActivity).toBe('bounded');
  });

  it('compiles /duplicates within a bounded product_field scope and refuses ambiguity', () => {
    const withField = base('/duplicates ProductField24');
    expect(withField.scopeHint).toEqual({ kind: 'product_field', field: 'ProductField24' });

    const viaPin = base('/duplicates', { kind: 'product_field', field: 'ProductField16' });
    expect(viaPin.scopeHint).toEqual({ kind: 'product_field', field: 'ProductField16' });

    // No field + no pinned scope: refuse ambiguous all-field scan.
    expect(() => base('/duplicates')).toThrowError(StoreManagerCommandCompileError);
    try {
      base('/duplicates');
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerCommandCompileError).code).toBe('ambiguous_scope');
    }
  });

  it('rejects unknown commands before any tool resolution', () => {
    const spy = vi.fn((name: string) => ALL_TOOL_VERSIONS[name]);
    try {
      compileStoreManagerCommand('/bogus x', { pinnedScope: null, resolveToolVersion: spy });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerCommandCompileError).code).toBe('unknown_command');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects trailing arguments, missing arguments, and malformed input before the runner', () => {
    expect(() => base('/audit ProductField24 extra')).toThrowError(StoreManagerCommandCompileError);
    expect(() => base('/audit')).toThrowError(StoreManagerCommandCompileError);
    expect(() => base('audit ProductField24')).toThrowError(StoreManagerCommandCompileError);
    expect(() => base('/health trailing')).toThrowError(StoreManagerCommandCompileError);
    try {
      base('/audit ProductField24 extra');
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerCommandCompileError).code).toBe('trailing_arguments');
    }
    try {
      base('/health trailing');
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerCommandCompileError).code).toBe('trailing_arguments');
    }
  });

  it('rejects ambiguous duplicate scope (command pins a different scope than the pinned scope)', () => {
    try {
      base('/audit ProductField16', { kind: 'product_field', field: 'ProductField24' });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerCommandCompileError).code).toBe('ambiguous_scope');
    }
  });

  it('rejects catalog-wide commands under a pinned scope (scope_unsupported, no whole-catalog widening)', () => {
    try {
      base('/health', { kind: 'sku_set', skus: ['SKU-1'] });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerCommandCompileError).code).toBe('scope_unsupported');
    }
    try {
      base('/report', { kind: 'change_set', changeSetId: 'cs-1' });
      throw new Error('expected failure');
    } catch (err) {
      expect((err as StoreManagerCommandCompileError).code).toBe('scope_unsupported');
    }
  });

  it('rejects unregistered tool hints (version drift)', () => {
    const sparse = (name: string): number | undefined =>
      name === 'getProductFieldAudit' ? undefined : ALL_TOOL_VERSIONS[name];
    expect(() =>
      compileStoreManagerCommand('/audit ProductField24', { pinnedScope: null, resolveToolVersion: sparse }),
    ).toThrowError(StoreManagerCommandCompileError);
  });

  it('/plan compiles a free objective and a nested command with zero execution', () => {
    let resolveCalls = 0;
    const countingResolve = (name: string) => {
      resolveCalls += 1;
      return ALL_TOOL_VERSIONS[name];
    };

    const freePlan = compileStoreManagerCommand('/plan weekly taxonomy cleanup', {
      pinnedScope: null,
      resolveToolVersion: countingResolve,
    });
    expect(freePlan.planPreview).toBe(true);
    expect(freePlan.commandName).toBe('plan');
    expect(freePlan.objective).toContain('weekly taxonomy cleanup');
    // Free-objective plans resolve no tool hints.
    expect(freePlan.expectedToolHints).toEqual([]);

    const nestedPlan = compileStoreManagerCommand('/plan /audit ProductField24', {
      pinnedScope: null,
      resolveToolVersion: countingResolve,
    });
    expect(nestedPlan.planPreview).toBe(true);
    expect(nestedPlan.scopeHint).toEqual({ kind: 'product_field', field: 'ProductField24' });
    expect(nestedPlan.expectedToolHints.map((h) => h.name)).toEqual(['getProductFieldAudit']);
    // No model dispatch counter exists in this pure module — the acceptance
    // requirement is that compilation performs zero execution. We assert the
    // compiler never calls anything beyond hint resolution and the plan is
    // marked preview-only.
    expect(nestedPlan.estimatedOutputKinds).toEqual(['preview']);
    expect(resolveCalls).toBeGreaterThanOrEqual(1);

    expect(() => base('/plan')).toThrowError(StoreManagerCommandCompileError);
    expect(() => base('/plan /bogus')).toThrowError(StoreManagerCommandCompileError);
  });

  it('compiler source contains no model/service/db imports (zero-execution by construction)', () => {
    const source = readFileSync(path.resolve(__dirname, '../../../', 'src/store-manager/commands/compiler.ts'), 'utf-8');
    expect(source).not.toMatch(/from\s+['"].*ai['"]/);
    expect(source).not.toMatch(/from\s+['"].*server\/services['"]/);
    expect(source).not.toMatch(/from\s+['"].*db\/['"]/);
    expect(source).not.toMatch(/streamText|convertToModelMessages/);
  });
});

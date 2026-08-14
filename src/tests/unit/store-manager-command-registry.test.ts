import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  STORE_MANAGER_COMMAND_DEFINITIONS,
  findStoreManagerCommandDefinition,
  describeStoreManagerCommands,
} from '../../store-manager/commands/registry';
import { compileStoreManagerCommand } from '../../store-manager/commands/compiler';
import { STORE_MANAGER_COMMAND_NAMES } from '../../shared/schemas/store-manager-command';

/**
 * Operations console, Issue 2 — the server-owned command registry.
 * Pure: no DB, no services, no model.
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

describe('Store Manager command registry (Issue 2)', () => {
  it('registers exactly the required commands with stable versions and no duplicates', () => {
    const names = STORE_MANAGER_COMMAND_DEFINITIONS.map((d) => d.name);
    expect(names).toEqual([...STORE_MANAGER_COMMAND_NAMES]);
    expect(new Set(names).size).toBe(names.length);
    for (const d of STORE_MANAGER_COMMAND_DEFINITIONS) {
      expect(d.version).toBeGreaterThanOrEqual(1);
      expect(d.description.length).toBeGreaterThan(0);
      expect(['none', 'single_token', 'free_text']).toContain(d.argShape);
    }
  });

  it('resolves commands by name and alias', () => {
    expect(findStoreManagerCommandDefinition('audit')?.name).toBe('audit');
    expect(findStoreManagerCommandDefinition('/audit')?.name).toBe('audit');
    expect(findStoreManagerCommandDefinition('a')?.name).toBe('audit');
    expect(findStoreManagerCommandDefinition('h')?.name).toBe('health');
    expect(findStoreManagerCommandDefinition('cs')?.name).toBe('changeset');
    expect(findStoreManagerCommandDefinition('ri')?.name).toBe('repair-images');
    expect(findStoreManagerCommandDefinition('bogus')).toBeUndefined();
  });

  it('produces bounded palette descriptors (no client-side catalog needed)', () => {
    const descriptors = describeStoreManagerCommands();
    expect(descriptors).toHaveLength(STORE_MANAGER_COMMAND_NAMES.length);
    for (const desc of descriptors) {
      expect(desc.name.length).toBeLessThanOrEqual(64);
      expect(desc.description.length).toBeLessThanOrEqual(300);
      expect(desc.argSpecs.length).toBeLessThanOrEqual(4);
      for (const arg of desc.argSpecs) {
        expect(['string', 'enum', 'number']).toContain(arg.valueType);
        expect(arg.name.length).toBeLessThanOrEqual(32);
      }
    }
  });

  it('every command compiles to tool hints that resolve in the registry (no drift)', () => {
    for (const d of STORE_MANAGER_COMMAND_DEFINITIONS) {
      const args = d.argShape === 'single_token' ? { value: d.name === 'duplicates' ? 'ProductField24' : 'x' } : { value: 'weekly taxonomy cleanup' };
      const compiled = compileStoreManagerCommand(`/${d.name}${d.argShape === 'none' ? '' : ' ' + (args.value ?? '')}`, {
        pinnedScope: null,
        resolveToolVersion,
      });
      expect(compiled.commandName).toBe(d.name);
      for (const hint of compiled.expectedToolHints) {
        expect(ALL_TOOL_VERSIONS[hint.name]).toBe(hint.version);
      }
    }
  });

  it('defines approval/network preview metadata per command (never preapproval)', () => {
    const repair = STORE_MANAGER_COMMAND_DEFINITIONS.find((d) => d.name === 'repair-images')!;
    expect(repair.scopeCompatibility).toEqual(['change_set']);
    const compiled = compileStoreManagerCommand('/repair-images cs-1', { pinnedScope: null, resolveToolVersion });
    expect(compiled.requiresApproval).toBe(true);
    expect(compiled.networkActivity).toBe('bounded');
    expect(compiled.expectedToolHints.map((h) => h.name)).toContain('repair_approved_change_set_images');
    // The repair tool is a hint only — it must not imply preapproval.
    expect(compiled.objective.toLowerCase()).toContain('approval');
  });

  it('registry and compiler contain no direct service/repository imports (server-neutral)', () => {
    for (const file of ['src/store-manager/commands/registry.ts', 'src/store-manager/commands/compiler.ts']) {
      const source = readFileSync(path.resolve(__dirname, '../../../', file), 'utf-8');
      expect(source).not.toMatch(/from\s+['"].*server\/services['"]/);
      expect(source).not.toMatch(/from\s+['"].*db\/['"]/);
      expect(source).not.toMatch(/fetch\s*\(/);
      expect(source).not.toMatch(/getDb\(/);
    }
  });
});

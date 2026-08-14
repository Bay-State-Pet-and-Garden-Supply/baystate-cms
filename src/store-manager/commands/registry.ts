/**
 * Store Manager command registry (operations console, Issue 2).
 *
 * The server-owned catalog of slash commands. Every command has a stable
 * name/version, aliases, a strict argument shape, a description, scope
 * requirements, a declarative objective, expected registered tool
 * name+version pairs, and approval/network preview metadata. The compiler
 * (`src/store-manager/commands/compiler.ts`) — and only the compiler — turns
 * a raw command line into a strict `StoreManagerCompiledCommand`; routes then
 * enter `runStoreManagerExecution` with that objective and lineage. This
 * module is intentionally import-free of services/repositories so it stays
 * pure and testable.
 */

import type {
  StoreManagerCommandName,
  StoreManagerCommandArgDescriptor,
  StoreManagerCompiledCommand,
} from '../../shared/schemas/store-manager-command';
import type { StoreManagerPinnedScope, StoreManagerScopeKind } from '../../shared/schemas/store-manager-operations';
import type { StoreManagerArtifactKind } from '../../shared/schemas/store-manager-operations';
import { StoreManagerCommandCompileError } from './compiler';

export interface StoreManagerCommandDefinition {
  /** Stable id (no leading slash). */
  name: StoreManagerCommandName;
  version: number;
  aliases: readonly string[];
  description: string;
  /** Argument shape (parsed by the compiler). */
  argShape: 'none' | 'single_token' | 'free_text';
  /** Palette descriptors for each argument. */
  argSpecs: readonly StoreManagerCommandArgDescriptor[];
  /** Scope kinds this command can operate under (empty = catalog-wide only). */
  scopeCompatibility: readonly StoreManagerScopeKind[];
  /** Scope the command pins from its arguments (null = none declared). */
  scopeHintFromArgs(args: { value?: string }): StoreManagerPinnedScope | null;
  /** Compile to a declarative objective + tool hints (pure; no services). */
  compile(
    args: { value?: string },
    ctx: { pinnedScope?: StoreManagerPinnedScope | null; resolveToolVersion: (name: string) => number | undefined },
  ): StoreManagerCompiledCommand;
}

function hintsFor(
  names: readonly string[],
  resolveToolVersion: (name: string) => number | undefined,
): { name: string; version: number }[] {
  const resolved: { name: string; version: number }[] = [];
  for (const name of names) {
    const version = resolveToolVersion(name);
    if (typeof version !== 'number' || version < 1) {
      // Fail closed: a command that references an unregistered/version-drifted
      // tool must never compile into a runnable objective.
      throw new StoreManagerCommandCompileError(
        'unregistered_tool',
        `Command references unregistered tool "${name}".`,
      );
    }
    resolved.push({ name, version });
  }
  return resolved;
}

/** Bounded objective text (never includes raw catalog content). */
function objective(s: string): string {
  return s.length <= 800 ? s : s.slice(0, 800);
}

const productFieldArg: StoreManagerCommandArgDescriptor = {
  name: 'value',
  label: 'ProductField',
  description: 'Registered ProductField (e.g. ProductField24)',
  required: true,
  valueType: 'string',
  placeholder: 'ProductField24',
};

const changeSetIdArg: StoreManagerCommandArgDescriptor = {
  name: 'value',
  label: 'Change Set ID',
  description: 'Workspace Change Set id',
  required: true,
  valueType: 'string',
  placeholder: '<change-set-id>',
};

const skuArg: StoreManagerCommandArgDescriptor = {
  name: 'value',
  label: 'SKU',
  description: 'Product SKU',
  required: true,
  valueType: 'string',
  placeholder: 'SKU123',
};

export const STORE_MANAGER_COMMAND_DEFINITIONS: readonly StoreManagerCommandDefinition[] = [
  {
    name: 'audit',
    version: 1,
    aliases: ['a'],
    description: 'Audit a registered ProductField for value quality and duplicate groups.',
    argShape: 'single_token',
    argSpecs: [productFieldArg],
    scopeCompatibility: ['product_field'],
    scopeHintFromArgs: (args) =>
      typeof args.value === 'string' && args.value ? { kind: 'product_field', field: args.value } : null,
    compile: (args, ctx) => {
      const scope = { kind: 'product_field' as const, field: args.value ?? '' };
      const hints = hintsFor(['getProductFieldAudit'], ctx.resolveToolVersion);
      return {
        commandName: 'audit',
        commandVersion: 1,
        objective: objective(
          `Audit ${scope.field} and report value quality: unique/missing counts and casing, whitespace, or separator duplicate groups. Scope: ${scope.field}.`,
        ),
        scopeHint: scope,
        expectedToolHints: hints,
        requiresApproval: false,
        networkActivity: 'none',
        planPreview: false,
        estimatedOutputKinds: ['audit'],
      };
    },
  },
  {
    name: 'health',
    version: 1,
    aliases: ['h'],
    description: 'Catalog health scan: blockers, warnings, and totals.',
    argShape: 'none',
    argSpecs: [],
    scopeCompatibility: [],
    scopeHintFromArgs: () => null,
    compile: (_args, ctx) => {
      const hints = hintsFor(['getCatalogHealthReport', 'listCatalogHealthIssues'], ctx.resolveToolVersion);
      return {
        commandName: 'health',
        commandVersion: 1,
        objective: objective(
          'Run a catalog health scan and summarize healthy/unhealthy totals, blockers, and warnings. Keep the summary evidence-backed and compact.',
        ),
        scopeHint: null,
        expectedToolHints: hints,
        requiresApproval: false,
        networkActivity: 'none',
        planPreview: false,
        estimatedOutputKinds: ['report'],
      };
    },
  },
  {
    name: 'duplicates',
    version: 1,
    aliases: ['dup'],
    description: 'Duplicate-focused audit within a bounded ProductField scope. Refuses ambiguous all-field scans without an explicit scope.',
    argShape: 'single_token',
    argSpecs: [{ ...productFieldArg, required: false, description: 'Registered ProductField; defaults to the pinned field scope' }],
    scopeCompatibility: ['product_field'],
    scopeHintFromArgs: (args) =>
      typeof args.value === 'string' && args.value ? { kind: 'product_field', field: args.value } : null,
    compile: (args, ctx) => {
      const field =
        typeof args.value === 'string' && args.value
          ? args.value
          : ctx.pinnedScope?.kind === 'product_field'
            ? ctx.pinnedScope.field
            : null;
      if (!field) {
        throw new StoreManagerCommandCompileError(
          'ambiguous_scope',
          '"/duplicates" needs a ProductField argument or a pinned product_field scope; refusing an all-field scan.',
        );
      }
      const hints = hintsFor(['getProductFieldAudit', 'preview_product_field_normalization'], ctx.resolveToolVersion);
      return {
        commandName: 'duplicates',
        commandVersion: 1,
        objective: objective(
          `Find casing, whitespace, and separator duplicate groups in ${field} within the pinned scope only. Do not scan other fields.`,
        ),
        scopeHint: { kind: 'product_field', field },
        expectedToolHints: hints,
        requiresApproval: false,
        networkActivity: 'none',
        planPreview: false,
        estimatedOutputKinds: ['audit'],
      };
    },
  },
  {
    name: 'explain',
    version: 1,
    aliases: ['x'],
    description: 'Explain one product SKU with evidence-backed read results.',
    argShape: 'single_token',
    argSpecs: [skuArg],
    scopeCompatibility: ['sku_set'],
    scopeHintFromArgs: (args) =>
      typeof args.value === 'string' && args.value ? { kind: 'sku_set', skus: [args.value] } : null,
    compile: (args, ctx) => {
      const sku = args.value ?? '';
      const hints = hintsFor(['searchProducts', 'getDashboardStats'], ctx.resolveToolVersion);
      return {
        commandName: 'explain',
        commandVersion: 1,
        objective: objective(
          `Explain product SKU ${sku} with authoritative evidence: status, price, inventory, and any health/drift flags. Scope: exactly SKU ${sku}.`,
        ),
        scopeHint: { kind: 'sku_set', skus: [sku] },
        expectedToolHints: hints,
        requiresApproval: false,
        networkActivity: 'none',
        planPreview: false,
        estimatedOutputKinds: ['audit'],
      };
    },
  },
  {
    name: 'proposals',
    version: 1,
    aliases: ['p'],
    description: 'List stored normalization proposals and their review state.',
    argShape: 'none',
    argSpecs: [],
    scopeCompatibility: ['product_field'],
    scopeHintFromArgs: () => null,
    compile: (_args, ctx) => {
      const hints = hintsFor(['listStoredProposals'], ctx.resolveToolVersion);
      const fieldScope =
        ctx.pinnedScope?.kind === 'product_field'
          ? ` within pinned field ${ctx.pinnedScope.field}`
          : '';
      return {
        commandName: 'proposals',
        commandVersion: 1,
        objective: objective(
          `List stored normalization proposals${fieldScope} and summarize their review state (proposed/applied/dismissed counts).`,
        ),
        scopeHint: ctx.pinnedScope?.kind === 'product_field' ? ctx.pinnedScope : null,
        expectedToolHints: hints,
        requiresApproval: false,
        networkActivity: 'none',
        planPreview: false,
        estimatedOutputKinds: ['report'],
      };
    },
  },
  {
    name: 'changeset',
    version: 1,
    aliases: ['cs'],
    description: 'Inspect a workspace Change Set: state, items, and operation summary.',
    argShape: 'single_token',
    argSpecs: [changeSetIdArg],
    scopeCompatibility: ['change_set'],
    scopeHintFromArgs: (args) =>
      typeof args.value === 'string' && args.value ? { kind: 'change_set', changeSetId: args.value } : null,
    compile: (args, ctx) => {
      const id = args.value ?? '';
      const hints = hintsFor(['getChangeSetDetail'], ctx.resolveToolVersion);
      return {
        commandName: 'changeset',
        commandVersion: 1,
        objective: objective(
          `Inspect Change Set ${id} and summarize its state, affected SKU count, operation mix, and validation status. Scope: exactly Change Set ${id}.`,
        ),
        scopeHint: { kind: 'change_set', changeSetId: id },
        expectedToolHints: hints,
        requiresApproval: false,
        networkActivity: 'none',
        planPreview: false,
        estimatedOutputKinds: ['report'],
      };
    },
  },
  {
    name: 'report',
    version: 1,
    aliases: ['r'],
    description: 'Assemble the deterministic operational report (health, fields, sync, drift).',
    argShape: 'none',
    argSpecs: [],
    scopeCompatibility: [],
    scopeHintFromArgs: () => null,
    compile: (_args, ctx) => {
      const hints = hintsFor(['getStoreManagerReport'], ctx.resolveToolVersion);
      return {
        commandName: 'report',
        commandVersion: 1,
        objective: objective(
          'Assemble the deterministic operational report (catalog health, product-field issues, sync state, drift) from authoritative read evidence and present a compact summary.',
        ),
        scopeHint: null,
        expectedToolHints: hints,
        requiresApproval: false,
        networkActivity: 'none',
        planPreview: false,
        estimatedOutputKinds: ['report'],
      };
    },
  },
  {
    name: 'repair-images',
    version: 1,
    aliases: ['ri'],
    description: 'Inspect a Change Set and prepare the approved image-repair flow. Repair itself still requires operator approval.',
    argShape: 'single_token',
    argSpecs: [changeSetIdArg],
    scopeCompatibility: ['change_set'],
    scopeHintFromArgs: (args) =>
      typeof args.value === 'string' && args.value ? { kind: 'change_set', changeSetId: args.value } : null,
    compile: (args, ctx) => {
      const id = args.value ?? '';
      const hints = hintsFor(['getChangeSetDetail', 'repair_approved_change_set_images'], ctx.resolveToolVersion);
      return {
        commandName: 'repair-images',
        commandVersion: 1,
        objective: objective(
          `Inspect Change Set ${id} (state, items, image status). Do NOT invoke image repair without an approved Change Set and explicit operator approval; report exactly what repair would do and what approval is required.`,
        ),
        scopeHint: { kind: 'change_set', changeSetId: id },
        expectedToolHints: hints,
        requiresApproval: true,
        networkActivity: 'bounded',
        planPreview: false,
        estimatedOutputKinds: ['diff', 'verification_diff'],
      };
    },
  },
  {
    name: 'plan',
    version: 1,
    aliases: [],
    description: 'Preview what a command or objective would do. Compiles and validates only — nothing executes.',
    argShape: 'free_text',
    argSpecs: [
      {
        name: 'value',
        label: 'Objective or command',
        description: 'A free-text objective or a slash command such as /audit ProductField24',
        required: true,
        valueType: 'string',
        placeholder: 'weekly taxonomy cleanup',
      },
    ],
    scopeCompatibility: ['product_field', 'change_set', 'sku_set', 'onboarding_batch', 'vendor'],
    scopeHintFromArgs: () => null,
    compile: (args, ctx) => {
      // The compiler resolves the free-objective form; command-form plans are
      // compiled by the compiler (which resolves the inner command first) and
      // passed through `args.value` as the plain objective text.
      const value = (args.value ?? '').trim();
      if (!value) {
        throw new StoreManagerCommandCompileError('plan_requires_objective', '"/plan" needs an objective or a slash command to preview.');
      }
      if (value.startsWith('/')) {
        throw new StoreManagerCommandCompileError(
          'plan_requires_objective',
          'Nested command plans are resolved by the compiler; use "/plan /command ..." syntax.',
        );
      }
      return {
        commandName: 'plan',
        commandVersion: 1,
        objective: objective(`Plan preview for objective: ${value}`),
        scopeHint: ctx.pinnedScope ?? null,
        expectedToolHints: [],
        requiresApproval: false,
        networkActivity: 'none',
        planPreview: true,
        estimatedOutputKinds: ['preview'],
      };
    },
  },
];

/** Look up a command definition by name or alias. */
export function findStoreManagerCommandDefinition(name: string): StoreManagerCommandDefinition | undefined {
  const normalized = name.replace(/^\/+/, '').trim();
  if (!normalized) return undefined;
  return STORE_MANAGER_COMMAND_DEFINITIONS.find(
    (cmd) => cmd.name === normalized || cmd.aliases.includes(normalized),
  );
}

/** Stable palette descriptors for all commands (the client renders only these). */
export function describeStoreManagerCommands(): {
  name: StoreManagerCommandName;
  version: number;
  aliases: readonly string[];
  description: string;
  argSpecs: readonly StoreManagerCommandArgDescriptor[];
}[] {
  return STORE_MANAGER_COMMAND_DEFINITIONS.map((cmd) => ({
    name: cmd.name,
    version: cmd.version,
    aliases: cmd.aliases,
    description: cmd.description,
    argSpecs: cmd.argSpecs,
  }));
}

/** Re-exported so consumers import the error from the compiler only. */
export type { StoreManagerArtifactKind };

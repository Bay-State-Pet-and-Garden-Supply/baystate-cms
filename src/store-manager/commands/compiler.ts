/**
 * Store Manager command compiler (operations console, Issue 2).
 *
 * The authoritative parser/compiler for slash commands. The client may lex
 * input only to show completion UI; THIS module is the server-owned
 * parser/compiler shared by routes and runtime tests. Compilation is pure —
 * no services, DB, model, or adapter dispatch — and fails closed on unknown
 * commands, trailing arguments, ambiguous duplicate scope, malformed IDs,
 * and unregistered tool/version pairs BEFORE any model or tool execution.
 */

import type {
  StoreManagerCompiledCommand,
} from '../../shared/schemas/store-manager-command';
import type { StoreManagerPinnedScope } from '../../shared/schemas/store-manager-operations';
import {
  findStoreManagerCommandDefinition,
} from './registry';

export class StoreManagerCommandCompileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StoreManagerCommandCompileError';
    this.code = code;
  }
}

export interface StoreManagerCommandCompileContext {
  pinnedScope?: StoreManagerPinnedScope | null;
  /** Injected by the route (backed by the adapter registry); undefined names
   * are refused as tool/version drift. */
  resolveToolVersion: (name: string) => number | undefined;
}

/**
 * Compile a raw command line into a strict compiled command. Zero execution:
 * no model invocation, no tool dispatch, no repository collector, no network.
 */
export function compileStoreManagerCommand(
  raw: string,
  ctx: StoreManagerCommandCompileContext,
): StoreManagerCompiledCommand {
  if (typeof raw !== 'string') {
    throw new StoreManagerCommandCompileError('malformed_command', 'Command input must be text.');
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) {
    throw new StoreManagerCommandCompileError('malformed_command', 'Command input must start with "/".');
  }
  const body = trimmed.slice(1).trim();
  if (!body) {
    throw new StoreManagerCommandCompileError('malformed_command', 'Missing command name after "/".');
  }
  const tokens = body.split(/\s+/).filter(Boolean);
  const nameToken = tokens[0] ?? '';
  const definition = findStoreManagerCommandDefinition(nameToken);
  if (!definition) {
    throw new StoreManagerCommandCompileError(
      'unknown_command',
      `Unknown command "/${nameToken}". Use the command palette for available commands.`,
    );
  }
  const rest = body.slice(nameToken.length).trim();

  // Argument parsing per declared shape.
  let value: string | undefined;
  if (definition.argShape === 'none') {
    if (rest) {
      throw new StoreManagerCommandCompileError(
        'trailing_arguments',
        `"/${definition.name}" takes no arguments; unexpected trailing text: "${rest.slice(0, 80)}".`,
      );
    }
  } else if (definition.argShape === 'single_token') {
    const argRequired = definition.argSpecs[0]?.required ?? true;
    if (!rest && argRequired) {
      throw new StoreManagerCommandCompileError(
        'missing_argument',
        `"/${definition.name}" requires a single argument (${definition.argSpecs[0]?.label ?? 'value'}).`,
      );
    }
    if (rest) {
      const restTokens = rest.split(/\s+/).filter(Boolean);
      if (restTokens.length > 1) {
        throw new StoreManagerCommandCompileError(
          'trailing_arguments',
          `"/${definition.name}" takes a single argument; unexpected extra tokens.`,
        );
      }
      value = restTokens[0];
    }
    // Optional single-token arg omitted: value stays undefined so the
    // command definition decides (e.g. /duplicates requires a pinned scope).
  } else {
    // free_text: entire remainder (may contain spaces); required.
    if (!rest) {
      throw new StoreManagerCommandCompileError(
        'missing_argument',
        `"/${definition.name}" requires text after the command.`,
      );
    }
    value = rest;
  }

  // Pinned-scope compatibility + ambiguity checks (pure).
  const pinnedScope = ctx.pinnedScope ?? null;
  const commandScopeHint = definition.scopeHintFromArgs({ value });
  if (commandScopeHint && pinnedScope) {
    const sameKind = commandScopeHint.kind === pinnedScope.kind;
    let sameId = false;
    if (commandScopeHint.kind === 'product_field' && pinnedScope.kind === 'product_field') {
      sameId = commandScopeHint.field === pinnedScope.field;
    } else if (commandScopeHint.kind === 'change_set' && pinnedScope.kind === 'change_set') {
      sameId = commandScopeHint.changeSetId === pinnedScope.changeSetId;
    } else if (commandScopeHint.kind === 'sku_set' && pinnedScope.kind === 'sku_set') {
      sameId =
        commandScopeHint.skus.length === pinnedScope.skus.length &&
        commandScopeHint.skus.every((s, i) => s === pinnedScope.skus[i]);
    }
    if (!sameKind || !sameId) {
      throw new StoreManagerCommandCompileError(
        'ambiguous_scope',
        `"/${definition.name}" pins a different scope than the currently pinned scope; clear the pinned scope or match it first.`,
      );
    }
  }
  if (pinnedScope && !definition.scopeCompatibility.includes(pinnedScope.kind)) {
    throw new StoreManagerCommandCompileError(
      'scope_unsupported',
      `"/${definition.name}" cannot run under the pinned ${pinnedScope.kind} scope.`,
    );
  }

  // /plan command-form: resolve the inner command first, then build the
  // plan compilation from it (the plan definition itself only handles the
  // free-objective form).
  if (definition.name === 'plan' && value && value.startsWith('/')) {
    const inner = compileStoreManagerCommand(value, ctx);
    const objective =
      `Plan preview for command "/${inner.commandName}": ${inner.objective}`.length <= 800
        ? `Plan preview for command "/${inner.commandName}": ${inner.objective}`
        : `Plan preview for command "/${inner.commandName}".`;
    return {
      commandName: 'plan',
      commandVersion: 1,
      objective,
      scopeHint: inner.scopeHint,
      expectedToolHints: inner.expectedToolHints,
      requiresApproval: inner.requiresApproval,
      networkActivity: inner.networkActivity,
      planPreview: true,
      estimatedOutputKinds: ['preview'],
    };
  }

  const compiled = definition.compile({ value }, {
    pinnedScope,
    resolveToolVersion: ctx.resolveToolVersion,
  });

  // Tool/version drift guard: every hint must resolve in the registry.
  for (const hint of compiled.expectedToolHints) {
    if (typeof hint.version !== 'number' || hint.version < 1) {
      throw new StoreManagerCommandCompileError(
        'unregistered_tool',
        `Command "/${definition.name}" references unregistered tool "${hint.name}".`,
      );
    }
  }
  return compiled;
}

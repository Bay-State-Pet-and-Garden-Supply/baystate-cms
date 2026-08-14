// ---------------------------------------------------------------------------
// Store Manager slash-command schemas (operations console, Issue 2).
//
// Cross-boundary contract shared by the server-owned command registry,
// compiler, routes, and the client command palette. Everything is bounded
// and redacted by construction; unknown keys are rejected (`.strict()`).
// The client NEVER maintains a second command catalog — palette descriptors
// come from `GET /api/store-manager/commands` generated from this schema.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { StoreManagerPinnedScopeSchema, STORE_MANAGER_OPERATIONS_BOUNDS } from './store-manager-operations';

export const STORE_MANAGER_COMMAND_BOUNDS = {
  maxCommandNameLength: 64,
  maxDescriptionLength: 300,
  maxObjectiveLength: 800,
  maxArgNameLength: 32,
  maxArgLabelLength: 80,
  maxArgDescriptionLength: 200,
  maxArgOptions: 100,
  maxArgSuggestions: 50,
  maxAliases: 6,
  maxRawLength: 500,
  maxToolHints: 10,
} as const;

/** Commands registered in the server-owned registry (stable names). */
export const STORE_MANAGER_COMMAND_NAMES = [
  'audit',
  'health',
  'duplicates',
  'explain',
  'proposals',
  'changeset',
  'report',
  'repair-images',
  'plan',
] as const;
export const StoreManagerCommandNameSchema = z.enum(STORE_MANAGER_COMMAND_NAMES);
export type StoreManagerCommandName = z.infer<typeof StoreManagerCommandNameSchema>;

/** Argument value type shown to the palette (server-owned descriptors). */
export const STORE_MANAGER_ARG_VALUE_TYPES = ['string', 'enum', 'number'] as const;
export const StoreManagerArgValueTypeSchema = z.enum(STORE_MANAGER_ARG_VALUE_TYPES);
export type StoreManagerArgValueType = z.infer<typeof StoreManagerArgValueTypeSchema>;

/** One argument descriptor rendered by the palette (never a client catalog). */
export const StoreManagerCommandArgDescriptorSchema = z.object({
  name: z.string().min(1).max(STORE_MANAGER_COMMAND_BOUNDS.maxArgNameLength),
  label: z.string().min(1).max(STORE_MANAGER_COMMAND_BOUNDS.maxArgLabelLength),
  description: z.string().max(STORE_MANAGER_COMMAND_BOUNDS.maxArgDescriptionLength),
  required: z.boolean(),
  valueType: StoreManagerArgValueTypeSchema,
  options: z.array(z.string().max(200)).max(STORE_MANAGER_COMMAND_BOUNDS.maxArgOptions).optional(),
  /** Server-derived suggestions (e.g. registered ProductFields), bounded. */
  suggestions: z.array(z.string().max(200)).max(STORE_MANAGER_COMMAND_BOUNDS.maxArgSuggestions).optional(),
  placeholder: z.string().max(200).optional(),
}).strict();
export type StoreManagerCommandArgDescriptor = z.infer<typeof StoreManagerCommandArgDescriptorSchema>;

/** Stable palette descriptor served from the registry. */
export const StoreManagerCommandDescriptorSchema = z.object({
  name: StoreManagerCommandNameSchema,
  version: z.number().int().positive().max(10_000),
  aliases: z.array(z.string().min(1).max(32)).max(STORE_MANAGER_COMMAND_BOUNDS.maxAliases),
  description: z.string().min(1).max(STORE_MANAGER_COMMAND_BOUNDS.maxDescriptionLength),
  argSpecs: z.array(StoreManagerCommandArgDescriptorSchema).max(4),
}).strict();
export type StoreManagerCommandDescriptor = z.infer<typeof StoreManagerCommandDescriptorSchema>;

/** Tool hint resolved to a registered name+version pair. */
export const StoreManagerToolHintSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.number().int().positive().max(10_000),
}).strict();
export type StoreManagerToolHint = z.infer<typeof StoreManagerToolHintSchema>;

/** Compiled command produced by the server-owned compiler (zero execution). */
export const StoreManagerCompiledCommandSchema = z.object({
  commandName: StoreManagerCommandNameSchema,
  commandVersion: z.number().int().positive().max(10_000),
  objective: z.string().trim().min(1).max(STORE_MANAGER_COMMAND_BOUNDS.maxObjectiveLength),
  /** Scope the command pins (bounded identifiers); null when catalog-wide. */
  scopeHint: StoreManagerPinnedScopeSchema.nullable(),
  expectedToolHints: z.array(StoreManagerToolHintSchema).max(STORE_MANAGER_COMMAND_BOUNDS.maxToolHints),
  /** True when any hinted tool requires operator approval (never preapproval). */
  requiresApproval: z.boolean(),
  /** Contract-derived estimate: 'bounded' only for repair/network adapters. */
  networkActivity: z.enum(['none', 'bounded']),
  /** True when this compilation is a /plan preview (zero execution). */
  planPreview: z.boolean(),
  /** Likely artifact kinds the run would produce (contract-derived). */
  estimatedOutputKinds: z.array(z.string().min(1).max(64)).max(8),
}).strict();
export type StoreManagerCompiledCommand = z.infer<typeof StoreManagerCompiledCommandSchema>;

/** Compile request wire type. */
export const StoreManagerCommandCompileRequestSchema = z.object({
  raw: z.string().trim().min(1).max(STORE_MANAGER_COMMAND_BOUNDS.maxRawLength),
  pinnedScope: StoreManagerPinnedScopeSchema.nullable().optional(),
}).strict();
export type StoreManagerCommandCompileRequest = z.infer<typeof StoreManagerCommandCompileRequestSchema>;

/** Execute request wire type (mode 'execute' streams nothing; 'plan' previews). */
export const StoreManagerCommandExecuteRequestSchema = z.object({
  raw: z.string().trim().min(1).max(STORE_MANAGER_COMMAND_BOUNDS.maxRawLength),
  pinnedScope: StoreManagerPinnedScopeSchema.nullable().optional(),
  selectedModel: z.string().min(1).max(200).optional(),
  mode: z.enum(['execute', 'plan']).default('execute'),
}).strict();
export type StoreManagerCommandExecuteRequest = z.infer<typeof StoreManagerCommandExecuteRequestSchema>;

/** Bounded tool outcome summary returned to the command palette. */
export const StoreManagerCommandToolOutcomeSchema = z.object({
  toolCallId: z.string().min(1).max(200),
  toolName: z.string().min(1).max(200),
  status: z.enum(['ok', 'error', 'denied']),
  output: z.unknown().optional(),
  errorText: z.string().max(500).optional(),
}).strict();
export type StoreManagerCommandToolOutcome = z.infer<typeof StoreManagerCommandToolOutcomeSchema>;

/** Structured command execution result (drained server-side; no raw stream). */
export const StoreManagerCommandResultSchema = z.object({
  ok: z.literal(true),
  runId: z.string().min(1).max(64),
  turnId: z.string().min(1).max(64),
  terminalStatus: z.enum(['success', 'failed', 'cancelled', 'policy_denied', 'deadline_exceeded']),
  outcomeReason: z.string().max(200).nullable(),
  modelCallId: z.string().min(1).max(64).nullable(),
  /** Bounded assistant text assembled from the drained stream. */
  text: z.string().max(64 * 1024),
  toolResults: z.array(StoreManagerCommandToolOutcomeSchema).max(200),
}).strict();
export type StoreManagerCommandResult = z.infer<typeof StoreManagerCommandResultSchema>;

/** Server-owned compilation failure vocabulary (never raw parser text). */
export const STORE_MANAGER_COMMAND_ERROR_CODES = [
  'unknown_command',
  'malformed_command',
  'missing_argument',
  'trailing_arguments',
  'ambiguous_scope',
  'unregistered_field',
  'invalid_argument',
  'unregistered_tool',
  'scope_unsupported',
  'plan_requires_objective',
] as const;
export type StoreManagerCommandErrorCode = (typeof STORE_MANAGER_COMMAND_ERROR_CODES)[number];

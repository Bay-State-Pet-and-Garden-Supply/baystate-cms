import { z } from 'zod';

/**
 * Provider-neutral contracts for the Multi-Distributor Sourcing engine.
 *
 * This module is the single seam between the deterministic CMS (worker,
 * repositories, reconciler, routes) and provider connectors (REST APIs,
 * SFTP catalogs, CSV snapshots). It encodes the ADR 0014 decisions:
 *
 * - Distributor evidence is supporting IDENTITY evidence for Discovery; it is
 *   never canonical merchandising authority.
 * - Lookups are UPC/GTIN-first with exact normalized identifier matching.
 *   Brand is advisory only: a missing or stale brand profile falls open to
 *   every enabled connection and never implies `not_stocked`.
 * - A connector returns exactly one of `found` | `not_stocked` | `source_error`.
 *   An HTTP 200 with the wrong size/pack/variant is NEVER `found` — it is a
 *   hard conflict at reconciliation time or `not_stocked` here.
 * - No throw crosses the connector boundary; no raw response or credential is
 *   ever persisted. Errors carry stable non-secret codes.
 * - Evidence attempts are immutable and generation-scoped (`sourcing_generation_id`);
 *   a retry starts a new generation and stale generations can never influence
 *   reconciliation, acceptance, conflict completion, or routing.
 */

// ─── Connector type ───────────────────────────────────────────────────────────

/**
 * Closed set of connector implementations. `legacy_adapter` exists only for
 * migration compatibility with historical connection rows; an unknown
 * connector fails as `source_error`, never silently falls back.
 */
export const SOURCING_CONNECTOR_TYPES = ['api', 'ftp_catalog', 'csv', 'legacy_adapter'] as const;
export type SourcingConnectorType = (typeof SOURCING_CONNECTOR_TYPES)[number];

export function isSourcingConnectorType(value: unknown): value is SourcingConnectorType {
  return typeof value === 'string' && (SOURCING_CONNECTOR_TYPES as readonly string[]).includes(value);
}

// ─── Identifier normalization ─────────────────────────────────────────────────

/**
 * Normalize a UPC/GTIN to digits only, accepting 8–14 digit barcodes
 * (UPC-A/EAN-13, including EAN-8). Returns null for anything else.
 *
 * This is the shared project normalizer (the same 8–14 digit rule used by
 * packaging OCR transcription). Connectors must search by the normalized
 * identifier and report matches only on EXACT normalized equality.
 */
export function normalizeGtin(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim()) {
    const digits = raw.replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 14 ? digits : null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const digits = String(raw).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 14 ? digits : null;
  }
  return null;
}

// ─── Lookup request ───────────────────────────────────────────────────────────

/**
 * One connector lookup for one onboarding item in one sourcing generation.
 *
 * `upc` is REQUIRED (non-null): a brand-only lookup (no identifier) is
 * not expressible by this type. `gtin` is an optional secondary identifier;
 * both are normalized by `normalizeGtin` before use. The engine calls
 * `normalizeLookupIdentifier` and fails closed when neither field yields an
 * 8–14 digit identifier.
 */
export interface SourcingLookupRequest {
  itemId: string;
  /** The immutable sourcing generation this attempt belongs to. */
  generationId: string;
  /** Raw UPC as entered/imported; normalized by `normalizeGtin`. */
  upc: string;
  /** Raw GTIN as entered/imported; normalized by `normalizeGtin`. */
  gtin?: string | null;
  /** Advisory brand hint from the spreadsheet / brand registry. */
  brandHint?: string | null;
  /** Spreadsheet register/row name as an identity hint (never a lookup key). */
  registerName?: string | null;
  /** Workspace-scoped identity of the enabled connection being invoked. */
  connection: SourcingConnectionRef;
  /**
   * Resolved credential material (server-side, immediately before execution;
   * ADR 0014). Connectors MUST use this and NEVER resolve secrets themselves;
   * it is never logged, persisted, or returned to API callers.
   */
  secret: string | null;
  /** Cancellation signal composed by the engine (deadline + caller abort). */
  signal: AbortSignal;
  /** Absolute ISO deadline for this lookup. */
  deadlineAt: string;
}

/**
 * Resolve the normalized lookup identifier from a request's UPC/GTIN.
 * Returns null when neither normalizes to an 8–14 digit barcode — the
 * engine MUST fail closed (no lookups) rather than issue a brand-only query.
 */
export function normalizeLookupIdentifier(upc: string | null | undefined, gtin?: string | null): string | null {
  return normalizeGtin(upc) ?? normalizeGtin(gtin);
}

/** Read-only connection identity handed to connectors (never secrets). */
export interface SourcingConnectionRef {
  id: string;
  distributorId: string;
  connectorType: SourcingConnectorType;
  /** Non-secret configuration only (base URL, paths, field maps). */
  configuration: Record<string, unknown>;
}

// ─── Catalog record ───────────────────────────────────────────────────────────

/**
 * Normalized identity record returned by a `found` lookup.
 *
 * Image URLs are display-only evidence for v1 (PI-6 rights verification is
 * required before any catalog use) and MUST NOT be copied into
 * extraction/classification/draft/promotion payloads.
 */
export interface DistributorCatalogRecord {
  /** Exact normalized identifier that matched (UPC/GTIN digits only). */
  matchedIdentifier: string;
  distributorUpc: string | null;
  gtin: string | null;
  name: string | null;
  description: string | null;
  brand: string | null;
  manufacturerPartNumber: string | null;
  weight: string | null;
  /** Variant dimensions: size/count/pack count/flavor/formula etc. */
  attributes: Record<string, string>;
  imageUrls: string[];
  /** Real source URL when one exists; null otherwise (never invented). */
  sourceUrl: string | null;
  /** Catalog identity metadata when the record came from a catalog snapshot. */
  catalogVersion: string | null;
  observedAt: string;
  /** Optional expiry for snapshot-backed records; null = no expiry known. */
  expiresAt: string | null;
}

// ─── Lookup outcome ───────────────────────────────────────────────────────────

/** Discriminated union — a connector always returns exactly one of these. */
export type SourcingLookupResult =
  | {
      outcome: 'found';
      record: DistributorCatalogRecord;
      /** Matched fields from the record (identity keys, name, brand, ...). */
      matchedFields: string[];
      /** Bounded warnings; never contain credentials or raw payloads. */
      warnings: string[];
    }
  | {
      outcome: 'not_stocked';
      /** Bounded, non-secret explanation. */
      reason?: string;
    }
  | {
      outcome: 'source_error';
      /** Stable, non-secret error code (e.g. 'timeout', 'auth_missing', 'bad_json'). */
      code: string;
      /** Bounded, redacted message. Credentials are never included. */
      message: string;
    };

// ─── Runtime validation of connector output (fail-closed) ─────────────────────
//
// Connector results are plain TS unions at the boundary, but the engine
// validates every connector output against these zod schemas before
// persisting anything: a malformed `found` (un-normalized identifier,
// missing record, unknown outcome) fails closed as `source_error` — it can
// never become evidence.

const NormalizedIdentifierSchema = z
  .string()
  .refine((v) => normalizeGtin(v) !== null && normalizeGtin(v) === v, {
    message: 'matchedIdentifier must be an exact normalized 8-14 digit identifier',
  });

export const DistributorCatalogRecordSchema: z.ZodType<DistributorCatalogRecord> = z.object({
  matchedIdentifier: NormalizedIdentifierSchema,
  distributorUpc: z.string().nullable(),
  gtin: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  brand: z.string().nullable(),
  manufacturerPartNumber: z.string().nullable(),
  weight: z.string().nullable(),
  attributes: z.record(z.string(), z.string()),
  imageUrls: z.array(z.string()),
  sourceUrl: z.string().nullable(),
  catalogVersion: z.string().nullable(),
  observedAt: z.string(),
  expiresAt: z.string().nullable(),
});

export const SourcingLookupResultSchema: z.ZodType<SourcingLookupResult> = z.discriminatedUnion(
  'outcome',
  [
    z.object({
      outcome: z.literal('found'),
      record: DistributorCatalogRecordSchema,
      matchedFields: z.array(z.string().max(64)).max(50),
      warnings: z.array(z.string().max(500)).max(20),
    }),
    z.object({
      outcome: z.literal('not_stocked'),
      reason: z.string().max(500).optional(),
    }),
    z.object({
      outcome: z.literal('source_error'),
      code: z.string().min(1).max(64),
      message: z.string().min(1).max(500),
    }),
  ],
);

/**
 * Validate a connector result at the engine boundary. Returns null when the
 * result is malformed (the engine then persists a bounded `source_error`
 * attempt; the malformed payload is never stored).
 */
export function parseSourcingLookupResult(raw: unknown): SourcingLookupResult | null {
  const parsed = SourcingLookupResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ─── Connector interface ──────────────────────────────────────────────────────

/**
 * One provider connector. Implementations are transport-specific (REST,
 * SFTP snapshot, CSV) but MUST NOT throw across the engine boundary: every
 * failure path returns `source_error`.
 */
export interface DistributorConnector {
  readonly connectorType: SourcingConnectorType;
  /** Human/provider identifier for evidence provenance. */
  readonly providerId: string;
  /**
   * Perform an exact normalized identifier lookup.
   *
   * Rules:
   * - `found` requires an EXACT normalized identifier match on a
   *   variant-consistent record (same size/pack/count/flavor/formula family
   *   as the request's advisory identity when determinable).
   * - An HTTP 200 with the wrong variant is NOT `found`.
   * - Timeout, cancellation, transport/auth/parse failure → `source_error`.
   */
  lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult>;
}

// ─── Identity conflict authority ──────────────────────────────────────────────

/**
 * Fields whose disagreement between two `found` records is a HARD identity
 * conflict (blocks advancement until operator resolution).
 *
 * `brand` is listed because contradictory returned brand evidence is a
 * reviewable identity conflict — but it remains ADVISORY as a lookup key:
 * it is never used to filter connections or imply `not_stocked`.
 *
 * Amendment A (default-on): `flavor` and `formula` are variant axes — a
 * disagreement between providers on either makes the record insufficient
 * for the Discovery-skipping `distributor_record_to_extraction` route.
 * Connector-declared variant axes (see `normalizeVariantAxis` /
 * `isUnknownVariantAxis`) join this set for the generation; an unknown /
 * undeclared variant-bearing attribute is NEVER silently soft.
 */
export const IDENTITY_CRITICAL_FIELDS = [
  'upc',
  'gtin',
  'manufacturerPartNumber',
  'weight',
  'size',
  'count',
  'packCount',
  'brand',
  'flavor',
  'formula',
] as const;
export type IdentityCriticalField = (typeof IDENTITY_CRITICAL_FIELDS)[number];

export function isIdentityCriticalField(field: string): field is IdentityCriticalField {
  return (IDENTITY_CRITICAL_FIELDS as readonly string[]).includes(field);
}

// ─── Variant axis registry (Amendment A) ──────────────────────────────────────

/**
 * The canonical variant-axis authority lives in
 * `src/shared/schemas/variant-axes.ts` (single source of truth, shared with
 * the persisted-evidence schema so the registry and the schema cannot
 * drift apart). These symbols are re-exported here to keep every existing
 * importer (`distributor-record-projection.ts`, `sourcing-reconciler.ts`,
 * tests) working unchanged.
 */
export {
  VARIANT_AXIS_ALLOWLIST,
  normalizeVariantAxis,
  normalizeDeclaredVariantAxis,
  isCanonicalDeclaredAxis,
} from '../../shared/schemas/variant-axes';
export type { VariantAxisName } from '../../shared/schemas/variant-axes';
import {
  normalizeVariantAxis,
  normalizeDeclaredVariantAxis,
} from '../../shared/schemas/variant-axes';

/** Maximum connector-declared variant axes per evidence observation. */
export const MAX_CONNECTOR_VARIANT_AXES = 16;

/** Durable raw-field → normalized-axis declaration for one connector. */
export interface ConnectorVariantAxisDeclaration {
  /** The raw attribute key as emitted by the provider. */
  rawField: string;
  /** The deterministic normalized axis name (see `normalizeDeclaredVariantAxis`). */
  normalizedAxis: string;
}

/**
 * Build the connector-declared raw-field → normalized-axis registry for a
 * generation. Declarations are normalized, deduplicated by normalized axis
 * (first declaration wins), bounded to `MAX_CONNECTOR_VARIANT_AXES`, and
 * invalid declarations are dropped (fail closed). Deterministic: output
 * order follows normalized-axis sort, independent of input order.
 */
export function declareConnectorVariantAxes(
  rawFields: readonly string[],
): ConnectorVariantAxisDeclaration[] {
  const byAxis = new Map<string, ConnectorVariantAxisDeclaration>();
  for (const raw of rawFields) {
    if (byAxis.size >= MAX_CONNECTOR_VARIANT_AXES) break;
    const normalized = normalizeDeclaredVariantAxis(raw);
    if (!normalized) continue;
    if (byAxis.has(normalized)) continue;
    byAxis.set(normalized, { rawField: raw.trim(), normalizedAxis: normalized });
  }
  return Array.from(byAxis.values()).sort((a, b) =>
    a.normalizedAxis < b.normalizedAxis ? -1 : a.normalizedAxis > b.normalizedAxis ? 1 : 0,
  );
}

/** The normalized axes of a declaration list (pure helper). */
export function declaredVariantAxisNames(
  declarations: readonly ConnectorVariantAxisDeclaration[],
): string[] {
  return declarations.map((d) => d.normalizedAxis);
}

/**
 * True when a raw attribute key is variant-bearing but unrecognized: it is
 * neither a built-in axis nor a connector-declared axis for this generation.
 * Such a field makes the record INSUFFICIENT for Discovery-skipping
 * qualification (never silently treated as copy).
 */
export function isUnknownVariantAxis(raw: string, declaredAxes: readonly string[] = []): boolean {
  if (normalizeVariantAxis(raw) !== null) return false;
  const normalizedDeclared = new Set(
    declaredAxes.map((d) => normalizeDeclaredVariantAxis(d)).filter((d): d is string => d !== null),
  );
  return !normalizedDeclared.has(raw.trim().toLowerCase().replace(/[\s_-]+/g, ' '));
}

// ─── Generation identity (ADR 0014) ───────────────────────────────────────────

/**
 * Durable sourcing generation identity. One generation is created per
 * (item, attempt cycle): the worker starts a generation when Sourcing runs,
 * retry/reset SUPERSEDES the current generation and starts a fresh one.
 * Evidence attempts, conflicts, and acceptances are all generation-scoped;
 * stale generations remain audit-visible but can never influence decisions.
 */
export interface SourcingGeneration {
  id: string;
  itemId: string;
  status: 'running' | 'completed' | 'superseded' | 'failed';
  /** The generation this one supersedes, if any. */
  supersedesId: string | null;
  /** Why the generation was created/superseded ('automatic' | 'operator_retry' | ...). */
  reason: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ─── Engine entry point ───────────────────────────────────────────────────────

/**
 * Engine-level contract (implemented in `engine.ts`, Milestone 3).
 *
 * `runSourcingGeneration` resolves the workspace's enabled connections,
 * applies advisory brand ordering WITHOUT filtering, composes cancellation
 * and deadline signals, invokes each connector with per-provider bounds,
 * validates every result, and persists exactly one durable evidence attempt
 * per invoked connection through the evidence writer.
 */
export interface SourcingEngine {
  runGeneration(request: {
    itemId: string;
    generationId: string;
    workspaceId: string;
    upc: string;
    gtin?: string | null;
    brandHint?: string | null;
    signal: AbortSignal;
    deadlineAt: string;
  }): Promise<SourcingGenerationRunResult>;
}

/**
 * Deterministic summary of one generation run — the input to the
 * reconciler (`sourcing-reconciler.ts`), which decides the routing outcome.
 */
export interface SourcingGenerationRunResult {
  generationId: string;
  /** One entry per invoked connection, in deterministic order. */
  attempts: SourcingGenerationAttemptSummary[];
  /** Connections that were enabled but could not be invoked (missing secret, unknown type). */
  skipped: Array<{ connectionId: string; reason: string }>;
}

export interface SourcingGenerationAttemptSummary {
  attemptId: string;
  connectionId: string;
  providerId: string;
  outcome: 'found' | 'not_stocked' | 'source_error';
  matchedIdentifier: string | null;
  errorCode: string | null;
}

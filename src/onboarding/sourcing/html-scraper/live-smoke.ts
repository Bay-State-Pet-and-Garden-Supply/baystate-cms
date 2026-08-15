#!/usr/bin/env bun
/**
 * Environment-gated live smoke for Distributor Scraper (`html_scraper`)
 * connectors (M6, ADR 0014 Amendment B).
 *
 * The script verifies ONE provider against its real storefront using the
 * production connector code paths (origin/deadline/rate/auth policy) and
 * exits with a machine-readable JSON report. It NEVER runs unless the
 * operator sets `BAYSTATE_CMS_SOURCING_LIVE_SMOKE=1` EXACTLY, refuses to run
 * when `CI` is set, and never accepts credentials as CLI arguments.
 *
 * Design invariants:
 * - Calls the connector DIRECTLY (never `DefaultSourcingEngine`) — it writes
 *   NO generation/evidence/decision/extraction rows and performs no CMS DB
 *   mutation. Any DB opened for `api_keys` resolution is opened READ-ONLY
 *   (`bun:sqlite` `{ readonly: true }`) and only when `--db` is explicitly
 *   given; no migrations ever run.
 * - Auth uses an opaque `--secret-ref` resolved with the same semantics as
 *   the production resolver: an environment variable whose name equals the
 *   ref first, then the read-only DB, with the project's usable-secret rule
 *   (non-empty and not a UI mask starting with `•`).
 * - Public providers (bradley, central_pet) require no secret.
 * - Bradley refuses `001135` (6-digit BCI item number — not a UPC/GTIN).
 * - Exit codes: 0 passing expected result; 1 completed failing smoke; 2 gate
 *   or configuration refusal (before any network).
 *
 * The actual live command is a manual rollout action (M8); it is never run
 * by tests or CI, and this module performs no network when the gate is
 * absent.
 */
import { openSync, writeSync, closeSync } from 'node:fs';
import { DefaultConnectorRegistry } from '../connector-registry';
import {
  normalizeGtin,
  type DistributorConnector,
  type SourcingLookupRequest,
  type SourcingLookupResult,
} from '../contracts';
import { redactHtmlScraperEvent } from './contracts';
import { closeAllHtmlScraperSessions } from './session-runner';
import { LIVE_SMOKE_PROVIDERS, BRADLEY_REFUSED_IDENTIFIER } from './live-smoke-catalog';

export const SMOKE_SCHEMA_VERSION = 1;
/** Matches the engine's 60-second per-item budget. */
export const SMOKE_DEFAULT_TIMEOUT_MS = 60_000;
/** Bounded field caps so reports never carry full merchandising copy. */
const MAX_MESSAGE_LENGTH = 200;
const MAX_WARNING_COUNT = 10;

// ─── Argument parsing (fail-closed; no credential flags exist) ───────────────

export interface SmokeArgs {
  provider: string | null;
  upc: string | null;
  secretRef: string | null;
  report: string | null;
  db: string | null;
}

const KNOWN_FLAGS: Readonly<Set<string>> = new Set(['provider', 'upc', 'secret-ref', 'report', 'db']);
/** Credential-shaped flags that must NEVER exist on this CLI. */
const FORBIDDEN_FLAGS: Readonly<Set<string>> = new Set([
  'username', 'user', 'password', 'passwd', 'pwd', 'cookie', 'cookies', 'token', 'access-token', 'apikey', 'api-key', 'secret',
]);

export type ParseSmokeArgsResult = { ok: true; args: SmokeArgs } | { ok: false; reason: string };

export function parseSmokeArgs(argv: readonly string[]): ParseSmokeArgsResult {
  const args: SmokeArgs = { provider: null, upc: null, secretRef: null, report: null, db: null };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!;
    if (!raw.startsWith('--')) {
      return { ok: false, reason: `unexpected positional argument "${raw}"` };
    }
    const eq = raw.indexOf('=');
    const key = raw.slice(2, eq >= 0 ? eq : undefined);
    const inlineValue = eq >= 0 ? raw.slice(eq + 1) : null;
    let value = inlineValue;
    if (value === null) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      }
    }
    if (FORBIDDEN_FLAGS.has(key)) {
      return { ok: false, reason: `flag "--${key}" is forbidden: credentials must NEVER be passed as CLI arguments (use an opaque --secret-ref)` };
    }
    if (!KNOWN_FLAGS.has(key)) {
      return { ok: false, reason: `unknown flag "--${key}"` };
    }
    if (value === null || value === '') {
      return { ok: false, reason: `flag "--${key}" requires a value` };
    }
    switch (key) {
      case 'provider':
        if (args.provider !== null) return { ok: false, reason: '--provider may be given only once (no "all" mode)' };
        if (value === 'all') return { ok: false, reason: 'refusing "--provider all": exactly one provider is required per invocation' };
        args.provider = value;
        break;
      case 'upc':
        args.upc = value;
        break;
      case 'secret-ref':
        // Opaque refs only: inline credential material ('=', ':', whitespace)
        // is rejected fail-closed so the flag cannot smuggle a secret.
        if (/[=:\s]/.test(value)) {
          return { ok: false, reason: '--secret-ref must be an opaque reference name, not inline credential material' };
        }
        args.secretRef = value;
        break;
      case 'report':
        args.report = value;
        break;
      case 'db':
        args.db = value;
        break;
      default:
        return { ok: false, reason: `unsupported flag "--${key}"` };
    }
  }
  return { ok: true, args };
}

// ─── Gates (exit 2 before any network) ───────────────────────────────────────

export type GateResult = { ok: true; providerId: string; identifier: string } | { ok: false; reason: string };

export function evaluateSmokeGates(env: Record<string, string | undefined>, provider: string | null, upc: string | null): GateResult {
  if (env.BAYSTATE_CMS_SOURCING_LIVE_SMOKE !== '1') {
    return { ok: false, reason: 'gate not enabled: BAYSTATE_CMS_SOURCING_LIVE_SMOKE must be exactly "1"' };
  }
  if (env.CI !== undefined && env.CI.trim() !== '') {
    return { ok: false, reason: 'refusing to run when CI is set' };
  }
  if (provider === null) {
    return { ok: false, reason: 'provider is required (--provider <id>); there is no default "all"' };
  }
  const meta = LIVE_SMOKE_PROVIDERS[provider];
  if (!meta) {
    return { ok: false, reason: `unknown provider "${provider}" (expected one of: ${Object.keys(LIVE_SMOKE_PROVIDERS).join(', ')})` };
  }
  const identifier = upc ?? meta.defaultIdentifier;
  if (meta.providerId === 'bradley' && identifier === BRADLEY_REFUSED_IDENTIFIER) {
    return {
      ok: false,
      reason: `bradley "${BRADLEY_REFUSED_IDENTIFIER}" is a 6-digit BCI item number, not a UPC/GTIN — refused as an engine identifier; use the verified 8-14 digit UPC or an explicit verified --upc`,
    };
  }
  if (normalizeGtin(identifier) === null) {
    return { ok: false, reason: `identifier "${identifier}" is not an 8-14 digit UPC/GTIN` };
  }
  return { ok: true, providerId: meta.providerId, identifier };
}

// ─── Secret resolution (env first; then an explicitly opened READ-ONLY DB) ───

function isUsableSecret(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('•');
}

export async function resolveSmokeSecret(
  secretRef: string | null,
  dbPath: string | null,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  if (!secretRef) return null;
  const fromEnv = env[secretRef];
  if (isUsableSecret(fromEnv)) return fromEnv;
  if (dbPath) {
    try {
      // READ-ONLY open: the smoke never writes the api_keys DB and never
      // runs migrations. Any open/query failure = unprovisioned (null). The
      // bun:sqlite import is lazy so the module stays importable under
      // vitest (project convention: bun:sqlite never enters the vitest graph).
      const { Database } = await import('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.query('SELECT api_key FROM api_keys WHERE service = ?').get(secretRef) as { api_key?: unknown } | undefined;
        const value = row && typeof row.api_key === 'string' ? row.api_key : undefined;
        if (isUsableSecret(value)) return value;
      } finally {
        db.close();
      }
    } catch {
      // read-only lookup failure → treated as unprovisioned (fail-closed)
    }
  }
  return null;
}

// ─── Report ──────────────────────────────────────────────────────────────────

export interface MerchandisingFieldSummary {
  present: boolean;
  length: number;
}

export interface SmokeReport {
  schemaVersion: number;
  provider: string;
  connectorType: 'html_scraper';
  testIdentifier: string;
  expectedName: string | null;
  expectedBrand: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** 'found' | 'not_stocked' | 'source_error' (terminal contract outcome). */
  outcome: string;
  errorCode: string | null;
  /** Redacted + bounded error message (never credentials/raw HTML). */
  errorMessage: string | null;
  exactIdentifierMatch: boolean;
  matchedFields: string[];
  merchandising: {
    description: MerchandisingFieldSummary | null;
    featuresCount: number;
    category: MerchandisingFieldSummary | null;
    dimensions: MerchandisingFieldSummary | null;
    casePack: MerchandisingFieldSummary | null;
    unitOfMeasure: MerchandisingFieldSummary | null;
    ingredients: MerchandisingFieldSummary | null;
    imageCount: number;
  };
  /** Origin ONLY of the real evidence URL (never path/query/credentials). */
  evidenceUrlOrigin: string | null;
  /**
   * Login/session telemetry: the connector boundary does not surface the
   * runner's HtmlScraperTelemetry, so these are always null with
   * `telemetryUnavailable: true` (never fabricated booleans/counts).
   */
  login: {
    attempted: boolean | null;
    sessionReused: boolean | null;
    reLoginCount: number | null;
    telemetryUnavailable: boolean;
  };
  warnings: string[];
  passed: boolean;
  failedAssertions: string[];
}

function boundedRedacted(value: string): string {
  return redactHtmlScraperEvent({ message: value.slice(0, MAX_MESSAGE_LENGTH) });
}

function originOnly(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function namesMatch(expected: string | null, actual: string | null | undefined): boolean {
  if (!expected) return true;
  if (!actual) return false;
  const e = expected.trim().toLowerCase();
  const a = actual.trim().toLowerCase();
  return e.length > 0 && (e === a || a.includes(e) || e.includes(a));
}

function fieldSummary(value: string | null | undefined): MerchandisingFieldSummary | null {
  if (value == null) return null;
  const v = String(value).trim();
  return { present: v.length > 0, length: v.length };
}

export interface LiveSmokeDeps {
  /** Default: DefaultConnectorRegistry ('html_scraper' + providerId). */
  createConnector?: (providerId: string) => DistributorConnector | null;
  /** Default: resolveSmokeSecret (env → read-only --db). */
  resolveSecret?: (secretRef: string | null, dbPath: string | null, env: Record<string, string | undefined>) => Promise<string | null> | string | null;
  /** Default: closeAllHtmlScraperSessions(). */
  closeAllSessions?: () => Promise<void>;
  now?: () => string;
  /** Override the 60s item budget (tests). */
  timeoutMs?: number;
}

export interface LiveSmokeOptions {
  provider: string | null;
  upc?: string | null;
  secretRef?: string | null;
  reportPath?: string | null;
  dbPath?: string | null;
  env?: Record<string, string | undefined>;
  deps?: LiveSmokeDeps;
}

export type LiveSmokeOutcome =
  | { exitCode: 2; report: null; refusalReason: string }
  | { exitCode: 0 | 1; report: SmokeReport; refusalReason: null };

export async function runLiveSmoke(options: LiveSmokeOptions): Promise<LiveSmokeOutcome> {
  const env = options.env ?? process.env;
  const gate = evaluateSmokeGates(env, options.provider, options.upc ?? null);
  if (!gate.ok) return { exitCode: 2, report: null, refusalReason: gate.reason };

  const meta = LIVE_SMOKE_PROVIDERS[gate.providerId];
  const startedAt = (options.deps?.now ?? (() => new Date().toISOString()))();
  const startedMs = Date.now();
  const timeoutMs = options.deps?.timeoutMs ?? SMOKE_DEFAULT_TIMEOUT_MS;
  const createConnector =
    options.deps?.createConnector ?? ((providerId: string) => new DefaultConnectorRegistry().createConnector('html_scraper', providerId, {}));
  const resolveSecret = options.deps?.resolveSecret ?? resolveSmokeSecret;
  const closeAllSessions = options.deps?.closeAllSessions ?? closeAllHtmlScraperSessions;

  const connector = createConnector(meta.providerId);
  if (!connector) {
    return { exitCode: 2, report: null, refusalReason: `provider "${meta.providerId}" has no registered html_scraper connector` };
  }

  // Secret is resolved ONLY for providers that require one; public
  // storefronts run with secret=null exactly like the engine does.
  const secret = meta.requiresSecret ? await resolveSecret(options.secretRef ?? null, options.dbPath ?? null, env) : null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadlineAt = new Date(startedMs + timeoutMs).toISOString();
  const request: SourcingLookupRequest = {
    itemId: `smoke-${meta.providerId}`,
    generationId: `smoke-${meta.providerId}-${startedMs}`,
    upc: gate.identifier,
    gtin: null,
    brandHint: meta.expectedBrand ?? null,
    registerName: 'live-smoke',
    connection: {
      id: `smoke-${meta.providerId}`,
      distributorId: meta.providerId,
      connectorType: 'html_scraper',
      configuration: {},
    },
    secret,
    signal: controller.signal,
    deadlineAt,
  };

  let result: SourcingLookupResult;
  try {
    result = await connector.lookupByGtin(request);
  } catch (err) {
    result = {
      outcome: 'source_error',
      code: 'unexpected',
      message: err instanceof Error ? err.message : 'unexpected connector error',
    };
  } finally {
    clearTimeout(timer);
    try {
      await closeAllSessions();
    } catch {
      // best-effort cleanup; session close failure is not a report failure
    }
  }

  const endedAt = (options.deps?.now ?? (() => new Date().toISOString()))();
  const durationMs = Date.now() - startedMs;

  const normalized = normalizeGtin(gate.identifier);
  const found = result.outcome === 'found' ? result : null;
  const record = found?.record ?? null;
  const exactIdentifierMatch = found !== null && record !== null && record.matchedIdentifier === normalized;
  const warnings = (found?.warnings ?? []).slice(0, MAX_WARNING_COUNT).map(boundedRedacted);
  const failedAssertions: string[] = [];

  if (result.outcome !== 'found') {
    failedAssertions.push(`expected a 'found' result, got '${result.outcome}'`);
  }
  if (!exactIdentifierMatch) {
    failedAssertions.push('exact identifier match failed (record UPC/GTIN does not equal the requested identifier)');
  }
  if (record !== null && !namesMatch(meta.expectedName, record.name)) {
    failedAssertions.push(`expected name "${meta.expectedName}" not matched by record name`);
  }
  if (record !== null && !namesMatch(meta.expectedBrand, record.brand)) {
    failedAssertions.push(`expected brand "${meta.expectedBrand}" not matched by record brand`);
  }

  const report: SmokeReport = {
    schemaVersion: SMOKE_SCHEMA_VERSION,
    provider: meta.providerId,
    connectorType: 'html_scraper',
    testIdentifier: gate.identifier,
    expectedName: meta.expectedName,
    expectedBrand: meta.expectedBrand,
    startedAt,
    endedAt,
    durationMs,
    outcome: result.outcome,
    errorCode: result.outcome === 'source_error' ? result.code : null,
    errorMessage: result.outcome === 'source_error' ? boundedRedacted(result.message) : null,
    exactIdentifierMatch,
    matchedFields: found?.matchedFields ?? [],
    merchandising: record
      ? {
          description: fieldSummary(record.description),
          featuresCount: Array.isArray(record.features) ? record.features.length : 0,
          category: fieldSummary(record.category),
          dimensions: fieldSummary(record.dimensions),
          casePack: fieldSummary(record.casePack),
          unitOfMeasure: fieldSummary(record.unitOfMeasure),
          ingredients: fieldSummary(record.ingredients),
          imageCount: Array.isArray(record.imageUrls) ? record.imageUrls.length : 0,
        }
      : {
          description: null,
          featuresCount: 0,
          category: null,
          dimensions: null,
          casePack: null,
          unitOfMeasure: null,
          ingredients: null,
          imageCount: 0,
        },
    evidenceUrlOrigin: record ? originOnly(record.sourceUrl) : null,
    login: { attempted: null, sessionReused: null, reLoginCount: null, telemetryUnavailable: true },
    warnings,
    passed: failedAssertions.length === 0,
    failedAssertions,
  };

  if (options.reportPath) {
    writeReportFile(options.reportPath, report);
  }
  return { exitCode: report.passed ? 0 : 1, report, refusalReason: null };
}

/** Write the report JSON with mode 0600 (never wider). */
export function writeReportFile(path: string, report: SmokeReport): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}

// ─── CLI entry (invoked by the scripts/ wrapper) ─────────────────────────────

export function main(argv: readonly string[], env: Record<string, string | undefined>): void {
  const parsed = parseSmokeArgs(argv);
  if (!parsed.ok) {
    console.error(`sourcing-live-smoke: ${parsed.reason}`);
    process.exit(2);
  }
  runLiveSmoke({
    provider: parsed.args.provider,
    upc: parsed.args.upc,
    secretRef: parsed.args.secretRef,
    reportPath: parsed.args.report,
    dbPath: parsed.args.db,
    env,
  })
    .then((outcome) => {
      if (outcome.exitCode === 2) {
        console.error(`sourcing-live-smoke: ${outcome.refusalReason}`);
      } else {
        console.log(JSON.stringify(outcome.report, null, 2));
      }
      process.exit(outcome.exitCode);
    })
    .catch((err: unknown) => {
      console.error(`sourcing-live-smoke: unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}

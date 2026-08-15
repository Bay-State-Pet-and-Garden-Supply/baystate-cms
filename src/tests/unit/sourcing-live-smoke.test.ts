import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSmokeArgs,
  evaluateSmokeGates,
  resolveSmokeSecret,
  runLiveSmoke,
  writeReportFile,
  SMOKE_SCHEMA_VERSION,
  type SmokeReport,
} from '../../onboarding/sourcing/html-scraper/live-smoke.ts';
import { LIVE_SMOKE_PROVIDERS, BRADLEY_REFUSED_IDENTIFIER } from '../../onboarding/sourcing/html-scraper/live-smoke-catalog';
import type { DistributorConnector, DistributorCatalogRecord, SourcingLookupRequest, SourcingLookupResult } from '../../onboarding/sourcing/contracts';

const GATED_ENV: Record<string, string | undefined> = { BAYSTATE_CMS_SOURCING_LIVE_SMOKE: '1' };

let tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function foundRecord(overrides: Partial<DistributorCatalogRecord> = {}): DistributorCatalogRecord {
  return {
    matchedIdentifier: '018653299524',
    distributorUpc: '018653299524',
    gtin: null,
    distributorSku: '001135',
    name: 'E-Z HANG SCALE',
    description: 'For quick weight control, for economic forage control',
    brand: 'KERBL',
    manufacturerPartNumber: '099917',
    weight: '3.1 lb',
    features: ['Nickel-plated hook', '55 lb capacity'],
    category: 'Scales',
    dimensions: null,
    casePack: '6',
    unitOfMeasure: 'EA',
    ingredients: null,
    attributes: {},
    imageUrls: ['https://cdn11.bigcommerce.com/s-x/product/1.jpg'],
    sourceUrl: 'https://www.bradleycaldwell.com/e-z-hang-scale-silver-up-to-55-lb-001135',
    catalogVersion: null,
    observedAt: '2026-08-15T00:00:00.000Z',
    expiresAt: null,
    ...overrides,
  };
}

class FakeConnector implements DistributorConnector {
  readonly connectorType = 'html_scraper' as const;
  readonly providerId: string;
  readonly requiresSecret: boolean;
  readonly requests: SourcingLookupRequest[] = [];
  throwError: Error | null = null;
  constructor(
    providerId: string,
    private readonly result: SourcingLookupResult,
    requiresSecret: boolean,
  ) {
    this.providerId = providerId;
    this.requiresSecret = requiresSecret;
  }
  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    this.requests.push(request);
    if (this.throwError) throw this.throwError;
    return this.result;
  }
}

interface Harness {
  connector: FakeConnector;
  created: string[];
  resolved: Array<{ secretRef: string | null; dbPath: string | null }>;
  /** Function so the primitive counter stays live (not captured by value). */
  closed: () => number;
  run: typeof runLiveSmoke;
}

function makeHarness(providerId: string, result: SourcingLookupResult, requiresSecret: boolean): Harness {
  const connector = new FakeConnector(providerId, result, requiresSecret);
  const created: string[] = [];
  const resolved: Array<{ secretRef: string | null; dbPath: string | null }> = [];
  let closed = 0;
  const run = (opts: Parameters<typeof runLiveSmoke>[0]) =>
    runLiveSmoke({
      env: GATED_ENV,
      deps: {
        createConnector: (id) => {
          created.push(id);
          return id === providerId ? connector : null;
        },
        resolveSecret: (secretRef, dbPath) => {
          resolved.push({ secretRef, dbPath });
          return null;
        },
        closeAllSessions: async () => {
          closed += 1;
        },
        now: () => '2026-08-15T12:00:00.000Z',
        timeoutMs: 1_000,
      },
      ...opts,
    });
  return { connector, created, resolved, closed: () => closed, run };
}

describe('parseSmokeArgs — fail-closed CLI', () => {
  test('accepts exactly the supported flags', () => {
    const r = parseSmokeArgs(['--provider', 'orgill', '--upc', '755625321923', '--secret-ref', 'orgill', '--report', '/tmp/r.json', '--db', '/tmp/app.db']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args).toEqual({ provider: 'orgill', upc: '755625321923', secretRef: 'orgill', report: '/tmp/r.json', db: '/tmp/app.db' });
    }
  });

  test('NO credential CLI flags exist', () => {
    for (const flag of ['username', 'user', 'password', 'passwd', 'pwd', 'cookie', 'cookies', 'token', 'access-token', 'apikey', 'api-key', 'secret']) {
      const r = parseSmokeArgs(['--provider', 'orgill', `--${flag}`, 'value']);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('forbidden');
    }
  });

  test('unknown flag, positional argument, missing value are refused', () => {
    expect(parseSmokeArgs(['--provider', 'orgill', '--wat', 'x']).ok).toBe(false);
    expect(parseSmokeArgs(['orgill']).ok).toBe(false);
    expect(parseSmokeArgs(['--provider']).ok).toBe(false);
  });

  test('no accidental default "all"; one provider only', () => {
    const all = parseSmokeArgs(['--provider', 'all']);
    expect(all.ok).toBe(false);
    if (!all.ok) expect(all.reason).toContain('exactly one provider');
    const dup = parseSmokeArgs(['--provider', 'orgill', '--provider', 'bradley']);
    expect(dup.ok).toBe(false);
  });

  test('--secret-ref refuses inline credential material', () => {
    expect(parseSmokeArgs(['--provider', 'orgill', '--secret-ref', 'user:pass']).ok).toBe(false);
    expect(parseSmokeArgs(['--provider', 'orgill', '--secret-ref', 'x=secret']).ok).toBe(false);
    expect(parseSmokeArgs(['--provider', 'orgill', '--secret-ref', 'orgill']).ok).toBe(true);
  });
});

describe('evaluateSmokeGates — inert without the gate, safe in CI', () => {
  test('refuses unless BAYSTATE_CMS_SOURCING_LIVE_SMOKE is exactly "1"', () => {
    expect(evaluateSmokeGates({}, 'bradley', null).ok).toBe(false);
    expect(evaluateSmokeGates({ BAYSTATE_CMS_SOURCING_LIVE_SMOKE: '0' }, 'bradley', null).ok).toBe(false);
    expect(evaluateSmokeGates({ BAYSTATE_CMS_SOURCING_LIVE_SMOKE: 'yes' }, 'bradley', null).ok).toBe(false);
    expect(evaluateSmokeGates({ BAYSTATE_CMS_SOURCING_LIVE_SMOKE: '1' }, 'bradley', null).ok).toBe(true);
  });

  test('refuses when CI is set', () => {
    expect(evaluateSmokeGates({ ...GATED_ENV, CI: '1' }, 'bradley', null).ok).toBe(false);
    expect(evaluateSmokeGates({ ...GATED_ENV, CI: 'true' }, 'bradley', null).ok).toBe(false);
  });

  test('refuses missing/unknown provider and invalid identifiers', () => {
    expect(evaluateSmokeGates(GATED_ENV, null, null).ok).toBe(false);
    expect(evaluateSmokeGates(GATED_ENV, 'amazon', null).ok).toBe(false);
    expect(evaluateSmokeGates(GATED_ENV, 'bradley', '123').ok).toBe(false);
  });

  test('Bradley refuses 001135 as an engine identifier', () => {
    const r = evaluateSmokeGates(GATED_ENV, 'bradley', BRADLEY_REFUSED_IDENTIFIER);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('6-digit BCI item number');
  });

  test('every catalog provider passes the gate with its verified identifier', () => {
    for (const [id, meta] of Object.entries(LIVE_SMOKE_PROVIDERS)) {
      const r = evaluateSmokeGates(GATED_ENV, id, null);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.identifier).toBe(meta.defaultIdentifier);
    }
  });
});

describe('runLiveSmoke — gate refusals never touch the connector', () => {
  test('missing gate → exit 2 and connector never created', async () => {
    const created: string[] = [];
    const outcome = await runLiveSmoke({
      provider: 'bradley',
      env: {}, // gate absent
      deps: {
        createConnector: (id) => {
          created.push(id);
          return null;
        },
        closeAllSessions: async () => {},
      },
    });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report).toBeNull();
    expect(created).toEqual([]);
  });

  test('unknown provider → exit 2 without connector call', async () => {
    const h = makeHarness('bradley', { outcome: 'not_stocked' }, false);
    const outcome = await h.run({ provider: 'amazon' });
    expect(outcome.exitCode).toBe(2);
    expect(h.created).toEqual([]);
  });

  test('Bradley 001135 → exit 2 without connector call', async () => {
    const h = makeHarness('bradley', { outcome: 'not_stocked' }, false);
    const outcome = await h.run({ provider: 'bradley', upc: BRADLEY_REFUSED_IDENTIFIER });
    expect(outcome.exitCode).toBe(2);
    expect(h.created).toEqual([]);
    expect(h.connector.requests).toEqual([]);
  });

  test('unregistered provider (connector factory returns null) → exit 2', async () => {
    const h = makeHarness('bradley', { outcome: 'not_stocked' }, false);
    const outcome = await runLiveSmoke({
      provider: 'bradley',
      env: GATED_ENV,
      deps: {
        createConnector: () => null,
        closeAllSessions: async () => {},
        now: () => '2026-08-15T12:00:00.000Z',
        timeoutMs: 1_000,
      },
    });
    expect(outcome.exitCode).toBe(2);
  });
});

describe('runLiveSmoke — found path', () => {
  test('found + matching name/brand → exit 0 with the full report', async () => {
    const h = makeHarness('bradley', { outcome: 'found', record: foundRecord(), matchedFields: ['matchedIdentifier', 'name', 'brand', 'distributorSku', 'description', 'imageUrls'], warnings: [] }, false);
    const outcome = await h.run({ provider: 'bradley' });

    expect(outcome.exitCode).toBe(0);
    if (outcome.exitCode !== 2 && outcome.report) {
      const r = outcome.report;
      expect(r.schemaVersion).toBe(SMOKE_SCHEMA_VERSION);
      expect(r.provider).toBe('bradley');
      expect(r.connectorType).toBe('html_scraper');
      expect(r.testIdentifier).toBe('018653299524');
      expect(r.outcome).toBe('found');
      expect(r.exactIdentifierMatch).toBe(true);
      expect(r.matchedFields).toContain('name');
      expect(r.merchandising.description?.present).toBe(true);
      expect(r.merchandising.featuresCount).toBe(2);
      expect(r.merchandising.casePack?.present).toBe(true);
      expect(r.merchandising.imageCount).toBe(1);
      expect(r.evidenceUrlOrigin).toBe('https://www.bradleycaldwell.com');
      expect(r.login.telemetryUnavailable).toBe(true);
      expect(r.passed).toBe(true);
      expect(r.failedAssertions).toEqual([]);
    }

    // Direct connector call (never the engine): one lookup, secret null for public.
    expect(h.connector.requests).toHaveLength(1);
    expect(h.connector.requests[0]!.secret).toBeNull();
    expect(h.connector.requests[0]!.connection.distributorId).toBe('bradley');
    expect(h.connector.requests[0]!.upc).toBe('018653299524');
    // Sessions closed exactly once.
    expect(h.closed()).toBe(1);
  });

  test('identifier mismatch → exit 1 with a failed assertion even with a name match', async () => {
    const h = makeHarness('bradley', { outcome: 'found', record: foundRecord({ matchedIdentifier: '999999999999' }), matchedFields: ['name'], warnings: [] }, false);
    const outcome = await h.run({ provider: 'bradley' });
    expect(outcome.exitCode).toBe(1);
    if (outcome.report) {
      expect(outcome.report.exactIdentifierMatch).toBe(false);
      expect(outcome.report.failedAssertions.some((a) => a.includes('exact identifier'))).toBe(true);
    }
  });

  test('name mismatch → exit 1', async () => {
    const h = makeHarness('bradley', { outcome: 'found', record: foundRecord({ name: 'SOME OTHER SCALE' }), matchedFields: ['matchedIdentifier', 'name'], warnings: [] }, false);
    const outcome = await h.run({ provider: 'bradley' });
    expect(outcome.exitCode).toBe(1);
    if (outcome.report) {
      expect(outcome.report.failedAssertions.some((a) => a.includes('name'))).toBe(true);
      expect(outcome.report.passed).toBe(false);
    }
  });

  test('warnings are redacted and bounded', async () => {
    const h = makeHarness('bradley', {
      outcome: 'found',
      record: foundRecord(),
      matchedFields: ['matchedIdentifier'],
      warnings: ['note password=supersecret123 sentinel', 'another password: hunter2'],
    }, false);
    const outcome = await h.run({ provider: 'bradley' });
    if (outcome.report) {
      for (const w of outcome.report.warnings) {
        expect(w).not.toContain('supersecret123');
        expect(w).not.toContain('hunter2');
      }
    }
  });
});

describe('runLiveSmoke — failing outcomes and auth', () => {
  test('not_stocked → exit 1 with stable outcome', async () => {
    const h = makeHarness('orgill', { outcome: 'not_stocked', reason: 'no exact match' }, true);
    const outcome = await h.run({ provider: 'orgill' });
    expect(outcome.exitCode).toBe(1);
    if (outcome.report) {
      expect(outcome.report.outcome).toBe('not_stocked');
      expect(outcome.report.passed).toBe(false);
      expect(outcome.report.errorCode).toBeNull();
    }
  });

  test('source_error auth_failed → exit 1 with stable redacted code/message', async () => {
    const h = makeHarness('orgill', { outcome: 'source_error', code: 'auth_failed', message: 'login rejected (password=g00dby3!)' }, true);
    const outcome = await h.run({ provider: 'orgill' });
    expect(outcome.exitCode).toBe(1);
    if (outcome.report) {
      expect(outcome.report.errorCode).toBe('auth_failed');
      expect(outcome.report.errorMessage).not.toContain('g00dby3!');
      expect(outcome.report.login.telemetryUnavailable).toBe(true);
    }
  });

  test('connector throw → exit 1 code unexpected', async () => {
    const h = makeHarness('central_pet', { outcome: 'not_stocked' }, false);
    h.connector.throwError = new Error('boom password=abc123');
    const outcome = await h.run({ provider: 'central_pet' });
    expect(outcome.exitCode).toBe(1);
    if (outcome.report) {
      expect(outcome.report.errorCode).toBe('unexpected');
      expect(outcome.report.errorMessage).not.toContain('abc123');
    }
  });

  test('secret resolution: requiresSecret providers get a resolved secret; resolver called with ref + db', async () => {
    const h = makeHarness('orgill', { outcome: 'not_stocked' }, true);
    await h.run({ provider: 'orgill', secretRef: 'orgill', dbPath: '/tmp/readonly.db' });
    expect(h.resolved).toEqual([{ secretRef: 'orgill', dbPath: '/tmp/readonly.db' }]);
    expect(h.connector.requests[0]!.secret).toBeNull(); // fake resolver returns null
  });

  test('secret resolution: a resolved value reaches the connector', async () => {
    const connector = new FakeConnector('orgill', { outcome: 'not_stocked' }, true);
    const outcome = await runLiveSmoke({
      provider: 'orgill',
      env: GATED_ENV,
      deps: {
        createConnector: () => connector,
        resolveSecret: () => '{"username":"u","password":"p"}',
        closeAllSessions: async () => {},
        now: () => '2026-08-15T12:00:00.000Z',
        timeoutMs: 1_000,
      },
    });
    expect(outcome.exitCode).toBe(1);
    expect(connector.requests[0]!.secret).toBe('{"username":"u","password":"p"}');
  });

  test('public providers never resolve a secret', async () => {
    const h = makeHarness('bradley', { outcome: 'not_stocked' }, false);
    await h.run({ provider: 'bradley', secretRef: 'bradley' });
    expect(h.resolved).toEqual([]);
    expect(h.connector.requests[0]!.secret).toBeNull();
  });
});

describe('resolveSmokeSecret — env first, fail-closed (DB path proven in the bun-only DB suite)', () => {
  test('env variable named exactly the secret ref wins', async () => {
    expect(await resolveSmokeSecret('ORGILL_SMOKE', null, { ORGILL_SMOKE: '{"username":"a","password":"b"}' })).toBe('{"username":"a","password":"b"}');
  });

  test('masked values are treated as unprovisioned', async () => {
    expect(await resolveSmokeSecret('S', null, { S: '••••1234' })).toBeNull();
    expect(await resolveSmokeSecret('S', null, { S: '' })).toBeNull();
  });

  test('null/empty ref → null', async () => {
    expect(await resolveSmokeSecret(null, null, {})).toBeNull();
  });
});

describe('writeReportFile — mode 0600 and JSON shape', () => {
  test('writes JSON with mode 0600', () => {
    const dir = makeTempDir();
    const path = join(dir, 'report.json');
    const report: SmokeReport = {
      schemaVersion: SMOKE_SCHEMA_VERSION,
      provider: 'bradley',
      connectorType: 'html_scraper',
      testIdentifier: '018653299524',
      expectedName: 'E-Z HANG SCALE',
      expectedBrand: 'KERBL',
      startedAt: '2026-08-15T12:00:00.000Z',
      endedAt: '2026-08-15T12:00:00.100Z',
      durationMs: 100,
      outcome: 'found',
      errorCode: null,
      errorMessage: null,
      exactIdentifierMatch: true,
      matchedFields: ['name'],
      merchandising: { description: null, featuresCount: 0, category: null, dimensions: null, casePack: null, unitOfMeasure: null, ingredients: null, imageCount: 0 },
      evidenceUrlOrigin: null,
      login: { attempted: null, sessionReused: null, reLoginCount: null, telemetryUnavailable: true },
      warnings: [],
      passed: true,
      failedAssertions: [],
    };
    writeReportFile(path, report);
    const st = statSync(path);
    expect(st.mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.schemaVersion).toBe(SMOKE_SCHEMA_VERSION);
    expect(parsed.passed).toBe(true);
  });

  test('runLiveSmoke writes the report file when --report is given', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'report.json');
    const h = makeHarness('bradley', { outcome: 'found', record: foundRecord(), matchedFields: ['matchedIdentifier'], warnings: [] }, false);
    const outcome = await h.run({ provider: 'bradley', reportPath: path });
    expect(outcome.exitCode).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.provider).toBe('bradley');
    expect(parsed.outcome).toBe('found');
  });
});

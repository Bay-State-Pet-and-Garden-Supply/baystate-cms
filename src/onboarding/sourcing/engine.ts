import type {
  SourcingEngine,
  SourcingGenerationRunResult,
  SourcingGenerationAttemptSummary,
  SourcingLookupRequest,
} from './contracts';
import { normalizeLookupIdentifier, parseSourcingLookupResult, recordSizeViolation } from './contracts';
import type { ConnectorRegistry } from './connector-registry';
import { DefaultConnectorRegistry } from './connector-registry';
import { resolveSecret } from './secret-resolver';
import { listConnectionsByWorkspace, getPreferredDistributorOrder } from '../../db/repositories/distributor-repo';
import { insertEvidenceAttempt } from '../../db/repositories/onboarding-evidence-repo';
import { findItemById } from '../../db/repositories/onboarding-item-repo';
import type { DistributorConnection } from '../../shared/schemas/distributor';
import type { EvidenceLookupOutcome } from '../../shared/schemas/distributor-evidence';

/**
 * Provider-neutral sourcing engine (ADR 0014).
 *
 * `runGeneration` for one item + generation:
 * 1. resolves the workspace's ENABLED connections;
 * 2. applies ADVISORY brand ordering only (never filtering — a missing brand
 *    profile falls open to every enabled connection and never implies
 *    `not_stocked`);
 * 3. composes cancellation + deadline signals and invokes each connector
 *    with bounded concurrency and per-provider timeout;
 * 4. validates every connector result (`parseSourcingLookupResult` — a
 *    malformed `found` fails closed);
 * 5. persists exactly ONE durable evidence attempt per invoked connection
 *    through the single writer (`insertEvidenceAttempt`);
 * 6. returns a deterministic summary for the reconciler.
 *
 * Connections that cannot be invoked (missing secret, unregistered
 * connector type, no identifier) are reported in `skipped` — never silently
 * dropped, never a fake `not_stocked`.
 */
export class DefaultSourcingEngine implements SourcingEngine {
  constructor(
    private readonly registry: ConnectorRegistry = new DefaultConnectorRegistry(),
    private readonly concurrency = 3,
  ) {}

  async runGeneration(request: {
    itemId: string;
    generationId: string;
    workspaceId: string;
    upc: string;
    gtin?: string | null;
    brandHint?: string | null;
    signal: AbortSignal;
    deadlineAt: string;
  }): Promise<SourcingGenerationRunResult> {
    const attempts: SourcingGenerationAttemptSummary[] = [];
    const skipped: SourcingGenerationRunResult['skipped'] = [];

    const identifier = normalizeLookupIdentifier(request.upc, request.gtin ?? null);
    if (!identifier) {
      skipped.push({ connectionId: '', reason: 'no_identifier' });
      return { generationId: request.generationId, attempts, skipped };
    }

    const connections = listConnectionsByWorkspace(request.workspaceId, true);
    if (connections.length === 0) {
      return { generationId: request.generationId, attempts, skipped };
    }

    // registerName is an advisory identity hint (the spreadsheet register
    // row); it is never a lookup key.
    const item = findItemById(request.itemId);
    const registerName = item?.name ?? null;

    // Advisory brand ordering ONLY (ADR 0014: fall-open, never filters).
    const ordered = orderByBrandPreference(connections, request.workspaceId, request.brandHint ?? null);

    // Bounded concurrency over the ordered connections.
    const work = ordered.map((connection) => () => this.runOneConnection({ ...request, registerName }, connection, identifier));
    const results = await runBounded(work, this.concurrency);

    for (const result of results) {
      if (result.kind === 'attempt') {
        attempts.push(result.summary);
      } else {
        skipped.push({ connectionId: result.connectionId, reason: result.reason });
      }
    }

    return { generationId: request.generationId, attempts, skipped };
  }

  private async runOneConnection(
    request: {
      itemId: string;
      generationId: string;
      upc: string;
      gtin?: string | null;
      brandHint?: string | null;
      registerName?: string | null;
      signal: AbortSignal;
      deadlineAt: string;
    },
    connection: DistributorConnection,
    identifier: string,
  ): Promise<{ kind: 'attempt'; summary: SourcingGenerationAttemptSummary } | { kind: 'skipped'; connectionId: string; reason: string }> {
    // Registry check FIRST (a stable connector_not_registered reason for
    // unregistered types, without touching secret material), then secret.
    const connector = this.registry.createConnector(
      connection.connectorType,
      connection.distributorId,
      connection.configuration,
    );
    if (!connector) {
      // Durable outcome (ADR 0014): an unregistered connector type persists
      // as a bounded source_error attempt, never a silent fallback.
      this.persistErrorAttempt(request, connection, identifier, 'connector_not_registered', `connector not registered for ${connection.connectorType}`);
      return { kind: 'skipped', connectionId: connection.id, reason: `connector_not_registered:${connection.connectorType}` };
    }

    // Amendment B (M2): a secret is resolved ONLY for connectors that require
    // one. Public storefront scrapers (Bradley, Central Pet) run with
    // `secret=null`; the unconditional secret_missing path no longer blocks
    // them. Required connectors still fail closed on a missing/masked secret.
    let secret: string | null = null;
    if (connector.requiresSecret) {
      const resolved = resolveSecret(connection.secretRef);
      if (resolved === null) {
        // Durable outcome: a missing/redacted secret persists as a bounded
        // source_error attempt (stable code, never the secret itself).
        this.persistErrorAttempt(request, connection, identifier, 'secret_missing', 'connection secret is not configured');
        return { kind: 'skipped', connectionId: connection.id, reason: 'secret_missing' };
      }
      secret = resolved;
    }

    const lookupRequest: SourcingLookupRequest = {
      itemId: request.itemId,
      generationId: request.generationId,
      upc: request.upc,
      gtin: request.gtin ?? null,
      brandHint: request.brandHint ?? null,
      registerName: request.registerName ?? null,
      connection: {        id: connection.id,
        distributorId: connection.distributorId,
        connectorType: connection.connectorType,
        configuration: connection.configuration,
      },
      secret,
      signal: request.signal,
      deadlineAt: request.deadlineAt,
    };

    // Per-attempt observation timing (Amendment A, MC): measured connector
    // wall time feeds the measured p95 / source-error rollout gates. The
    // single evidence writer persists it as durationMs (immutable row).
    const attemptStartedAt = Date.now();

    // Connector MUST NOT throw across the engine boundary (contract); a throw
    // is still contained as a durable source_error.
    let result;
    try {
      result = await connector.lookupByGtin(lookupRequest);
    } catch {
      result = { outcome: 'source_error', code: 'connector_threw', message: 'connector threw unexpectedly' };
    }
    const attemptDurationMs = Date.now() - attemptStartedAt;

    const validated = parseSourcingLookupResult(result);
    // A malformed connector result fails closed as a bounded source_error.
    let invalidReason: string | null = null;
    if (validated) {
      // Provider-neutral boundary re-verification: a `found` result whose
      // matchedIdentifier differs from the requested identifier is never
      // evidence (defective connectors cannot invent found results).
      if (validated.outcome === 'found' && validated.record.matchedIdentifier !== identifier) {
        invalidReason = 'identifier_mismatch';
      }
    } else {
      // Amendment B (M2): an OVERSIZED record is distinguished from a
      // structurally malformed one — both fail closed, but oversized data
      // gets the stable `record_too_large` code (never silently truncated).
      const rawRecord = (result as { record?: unknown } | null)?.record;
      invalidReason = rawRecord ? recordSizeViolation(rawRecord) ?? 'invalid_connector_result' : 'invalid_connector_result';
    }

    const outcome: EvidenceLookupOutcome = validated && !invalidReason ? validated.outcome : 'source_error';
    const summary: SourcingGenerationAttemptSummary = {
      attemptId: '',
      connectionId: connection.id,
      providerId: connector.providerId,
      outcome,
      matchedIdentifier: null,
      errorCode: null,
    };

    const identity = validated?.outcome === 'found' ? validated.record : undefined;
    const attempt = insertEvidenceAttempt({
      itemId: request.itemId,
      providerId: connector.providerId,
      distributorConnectionId: connection.id,
      lookupUpc: identifier,
      outcome,
      confidence: validated?.outcome === 'found' ? 0.9 : 0,
      evidenceUrl: identity?.sourceUrl ?? null,
      matchedFields: validated?.outcome === 'found' ? validated.matchedFields : [],
      identityJson: identity
        ? JSON.stringify({
            upc: identity.matchedIdentifier,
            gtin: identity.gtin ?? undefined,
            distributorUpc: identity.distributorUpc ?? undefined,
            distributorSku: identity.distributorSku ?? identity.distributorUpc ?? undefined,
            manufacturerPartNumber: identity.manufacturerPartNumber ?? undefined,
            name: identity.name ?? undefined,
            brand: identity.brand ?? undefined,
            description: identity.description ?? undefined,
            weight: identity.weight ?? undefined,
            features: identity.features,
            category: identity.category ?? undefined,
            dimensions: identity.dimensions ?? undefined,
            casePack: identity.casePack ?? undefined,
            unitOfMeasure: identity.unitOfMeasure ?? undefined,
            ingredients: identity.ingredients ?? undefined,
            attributes: identity.attributes,
            images: identity.imageUrls,
          })
        : null,
      warningsJson: validated && validated.outcome === 'found' && validated.warnings.length > 0
        ? JSON.stringify(validated.warnings)
        : null,
      errorCode: validated?.outcome === 'source_error' ? validated.code : invalidReason,
      errorMessage: validated?.outcome === 'source_error' ? validated.message : invalidReason ? 'connector returned a malformed result' : null,
      // Observation provenance floor (Milestone B): the ENGINE is the observer,
      // so a connector that omits these still yields qualifiable attempts —
      // observedAt stamps the observation instant and catalogVersion falls
      // back to the observation date when the provider does not version its
      // catalog. Without this, engine-produced attempts could never qualify
      // (E2E-caught: automatic routing could never reach Extraction).
      catalogVersion: identity?.catalogVersion ?? new Date().toISOString().slice(0, 10),
      sourcingGenerationId: request.generationId,
      observedAt: identity?.observedAt ?? new Date().toISOString(),
      expiresAt: identity?.expiresAt ?? null,
      durationMs: attemptDurationMs,
    });

    summary.attemptId = attempt.id;
    summary.matchedIdentifier = identity?.matchedIdentifier ?? null;
    summary.errorCode = validated?.outcome === 'source_error' ? validated.code : invalidReason;

    return { kind: 'attempt', summary };
  }

  /** Persist a bounded durable source_error attempt (skipped connections are still durable). */
  private persistErrorAttempt(
    request: { itemId: string; generationId: string; upc: string; gtin?: string | null },
    connection: DistributorConnection,
    identifier: string,
    code: string,
    message: string,
    durationMs?: number,
  ): void {
    insertEvidenceAttempt({
      itemId: request.itemId,
      providerId: `connector:${connection.connectorType}`,
      distributorConnectionId: connection.id,
      lookupUpc: identifier,
      outcome: 'source_error',
      confidence: 0,
      evidenceUrl: null,
      matchedFields: [],
      identityJson: null,
      warningsJson: null,
      errorCode: code,
      errorMessage: message,
      sourcingGenerationId: request.generationId,
      observedAt: null,
      expiresAt: null,
      durationMs: durationMs,
    });
  }
}

/**
 * Advisory brand preference ordering (ADR 0014): connections whose
 * DISTRIBUTOR id appears in the workspace brand profile come FIRST, in the
 * profile's configured order; everything else keeps creation order. Fall-open:
 * a null/unknown brand returns the original order unchanged and NEVER filters
 * connections.
 */
function orderByBrandPreference(
  connections: DistributorConnection[],
  workspaceId: string,
  brand: string | null,
): DistributorConnection[] {
  const preferred = getPreferredDistributorOrder(workspaceId, brand);
  if (!preferred || preferred.length === 0) return connections;

  const byDistributorId = new Map(connections.map((c) => [c.distributorId, c]));
  const preferredOrder: DistributorConnection[] = [];
  const seen = new Set<string>();
  for (const distributorId of preferred) {
    const connection = byDistributorId.get(distributorId);
    if (connection && !seen.has(connection.id)) {
      preferredOrder.push(connection);
      seen.add(connection.id);
    }
  }
  const rest = connections.filter((c) => !seen.has(c.id));
  return [...preferredOrder, ...rest];
}



async function runBounded<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

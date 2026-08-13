import { Hono } from 'hono';
import { z } from 'zod';
import { getCurrentWorkspace } from '../services/workspace-service';
import { loadClassificationConfig, saveClassificationConfig, loadRuntimeConfig, createRuntimeActivationContext, loadRuntimeConfigAuthority } from '../../classification/config-loader';
import { migrateLegacyToClassificationConfig } from '../../classification/legacy-migration';
import { syncSeedToWorkspace } from '../../classification/seed-sync';
import { applyFieldMappingEdits, FieldMappingEditError, FieldMappingEditSchema } from '../../classification/field-mapping-editor';
import { applyAttributeProfileEdits, AttributeProfileEditError, AttributeProfileEditsPayloadSchema } from '../../classification/attribute-profile-editor';
import { applyCurationTargetEdits, CurationTargetEditError } from '../../classification/curation-target-editor';
import { applyAttributeEdits, AttributeEditError } from '../../classification/attribute-editor';
import { processRefreshQueue } from '../../classification/refresh-queue-processor';
import { syncConfigToCache } from '../../db/repositories/classification-config-repo';
import { deriveCurationApplicability } from '../../classification/curation-applicability';
import {
  applyCurationTargetsToConfig,
  listCurationTargetCandidates,
} from '../../classification/curation-targets';
import { getRun, getStageResults, getEvidenceByRun, getLiveDecisionsByRun, getProposalsByRun } from '../../db/repositories/classification-run-repo';
import { getModelCallsByRun } from '../../db/repositories/classification-model-call-repo';
import { getRuntimeSnapshotByHash, authorityConfigHashMatches, runtimeSnapshotHashMatchesConfig } from '../../classification/runtime-snapshot';
import { readProductFile } from '../../git/workspace-files';
import { computeProductHash } from '../../classification/catalog-product-source';

import { evaluateClassificationReadiness } from '../../classification/config-validation';
import { normalizeClassificationReadinessReport } from '../../classification/readiness';
import { QUALITY_REPORT_MAX_RANGE_DAYS } from '../../shared/schemas/classification-metrics';
import { buildQualityReport } from '../../db/repositories/classification-metrics-repo';

const router = new Hono();

/**
 * Deep-walk sanitization for run-detail responses: any string that carries
 * credential-shaped content (API keys, authorization headers, bearer/sk-
 * tokens) is replaced with a redaction marker, and object keys that look
 * secret are redacted outright. Evidence values, snippets, proposals,
 * decisions, and stage results are returned through this projection so the
 * endpoint has an enforceable no-sensitive-content guarantee.
 */
const CREDENTIAL_CONTENT_PATTERN =
  /(api[_-]?key|authorization|bearer\s|sk-[a-z0-9]{4,}|refresh_token|access_token|\{\s*"api_key|\{\s*"token)/i;
const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|bearer|token|secret|password|sk-|sk_)/i;

function sanitizeForRunDetail(value: unknown): unknown {
  if (typeof value === 'string') {
    return CREDENTIAL_CONTENT_PATTERN.test(value) ? '[REDACTED]' : value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForRunDetail);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // Secret-looking KEYS are dropped entirely (never emitted, even with a
      // redacted value) so the endpoint has an enforceable guarantee that
      // no api_key/Authorization/token field name appears in the body.
      if (SECRET_KEY_PATTERN.test(key)) continue;
      out[key] = sanitizeForRunDetail(val);
    }
    return out;
  }
  return value;
}

/**
 * GET /api/classification/readiness
 * Returns classification configuration readiness report for the active workspace.
 */
router.get('/classification/readiness', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const config = loadRuntimeConfig(ws.workspacePath, ws.id);
    const activationContext = createRuntimeActivationContext(ws.workspacePath, ws.id);
    const readiness = evaluateClassificationReadiness(config, {
      mode: config.manifest?.schemaVersion === 2 ? 'active' : 'preview',
      catalogFields: activationContext.catalogFields,
      verifyCatalogEvidence: activationContext.verifyCatalogEvidence,
      verifiedPageIds: activationContext.verifiedPageIds,
    });
    return c.json({ readiness: normalizeClassificationReadinessReport(readiness) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/classification/config
 * Returns the current loaded classification configuration.
 */
router.get('/classification/config', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const config = loadRuntimeConfig(ws.workspacePath, ws.id);
    return c.json({ config });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * PUT /api/classification/config
 * Updates the current classification configuration (attributes, mappings, etc.)
 */
router.put('/classification/config', async (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const body = await c.req.json();
    const config = body.config;
    if (!config) {
      return c.json({ error: 'Missing configuration payload' }, 400);
    }

    // Issue #31 D5: v2 workspaces have exactly one canonical mutation seam
    // (the mapping editor + the preview/activate workflow). A full-config
    // overwrite cannot bypass it — today this endpoint 500s on v2 workspaces
    // (loadClassificationConfig throws unsupported_version); the gate turns
    // that into an intentional 400. Unconfigured/legacy workspaces (no active
    // authority) keep the transitional v1 save path.
    try {
      const authority = loadRuntimeConfigAuthority(
        ws.workspacePath,
        createRuntimeActivationContext(ws.workspacePath, ws.id),
      );
      if (authority.kind === 'v2') {
        return c.json({
          error: 'unsupported_in_v2',
          message: 'Full config replacement is not supported in v2 workspaces. Use the mapping editor or the preview/activate workflow.',
        }, 400);
      }
    } catch {
      // No active classification config yet: fall through to the v1 path.
    }

    saveClassificationConfig(ws.workspacePath, config);
    syncConfigToCache(ws.id, config);

    return c.json({ success: true, config });
  } catch (err) {
    console.error('[ClassificationRoutes] Save configuration failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * PUT /api/classification/mappings
 * Applies ShopSite field mapping edits to the ACTIVE v2 bundle (the CMS
 * mirror of ShopSite's Extra Fields configuration). Mapping/serialization
 * only — field labels are owned exclusively by the field-metadata service
 * (issue #31 I3), so an edit payload carrying `label` is rejected. Fails
 * closed on invalid edits or when the edited bundle fails active validation.
 */
router.put('/classification/mappings', async (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const body = await c.req.json();
    const parsed = z.array(FieldMappingEditSchema).safeParse(body?.edits);
    if (!parsed.success) {
      return c.json({
        error: `Invalid edits payload: ${parsed.error.issues
          .map(issue => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        code: 'invalid_edit',
      }, 400);
    }

    const result = applyFieldMappingEdits(ws.workspacePath, ws.id, parsed.data);

    // Rebuild the mappings view the same way /catalog/mappings does.
    const config = loadRuntimeConfig(ws.workspacePath, ws.id);
    const attrNames = new Map(config.attributes.map(a => [a.id, a.name]));
    const attrToTypes = new Map<string, string[]>();
    for (const pt of config.productTypes) {
      const profile = config.attributeProfiles.find(ap => ap.id === pt.attributeProfileId);
      if (profile) {
        for (const pa of profile.attributes) {
          if (!attrToTypes.has(pa.attributeId)) attrToTypes.set(pa.attributeId, []);
          attrToTypes.get(pa.attributeId)!.push(pt.name);
        }
      }
    }
    const mappings = config.attributeMappings.map(m => ({
      id: m.id,
      attributeId: m.attributeId,
      attributeName: attrNames.get(m.attributeId) ?? m.attributeId,
      catalogField: m.catalogField,
      serialization: m.serialization,
      isStale: m.isStale,
      usedByProductTypes: attrToTypes.get(m.attributeId) ?? [],
    }));

    return c.json({ success: true, bundleHash: result.bundleHash, mappings });
  } catch (err) {
    if (err instanceof FieldMappingEditError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    console.error('[ClassificationRoutes] Save field mappings failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * PUT /api/classification/attribute-profiles/:productTypeId
 * Surgical edits to a Product Type's attribute profile in the active v2 bundle.
 */
router.put('/classification/attribute-profiles/:productTypeId', async (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }
  const productTypeId = c.req.param('productTypeId');

  try {
    const body = await c.req.json();
    const parsed = AttributeProfileEditsPayloadSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: `Invalid payload: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          code: 'invalid_edit',
        },
        400,
      );
    }

    const result = applyAttributeProfileEdits(ws.workspacePath, ws.id, productTypeId, parsed.data.edits);
    return c.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof AttributeProfileEditError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    console.error('[ClassificationRoutes] Edit attribute profile failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/classification/curation-targets
 * Returns manager-selected curation targets plus live-store candidates.
 */
router.get('/classification/curation-targets', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const config = loadRuntimeConfig(ws.workspacePath, ws.id);
    const candidates = listCurationTargetCandidates(ws.id, config);
    const { applicability, findings } = deriveCurationApplicability(config);
    return c.json({ targets: config.curationTargets ?? [], candidates, applicability, findings });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * PUT /api/classification/curation-targets
 * Saves which classification targets the curation stage should fill.
 */
router.put('/classification/curation-targets', async (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const body = await c.req.json();
    const targets = Array.isArray(body?.targets) ? body.targets : [];

    try {
      const authority = loadRuntimeConfigAuthority(
        ws.workspacePath,
        createRuntimeActivationContext(ws.workspacePath, ws.id),
      );
      if (authority.kind === 'v2') {
        applyCurationTargetEdits(ws.workspacePath, ws.id, targets);
        const updatedConfig = loadRuntimeConfig(ws.workspacePath, ws.id);
        const { applicability, findings } = deriveCurationApplicability(updatedConfig);
        return c.json({
          success: true,
          targets: updatedConfig.curationTargets,
          candidates: listCurationTargetCandidates(ws.id, updatedConfig),
          applicability,
          findings,
        });
      }
    } catch (err) {
      if (err instanceof CurationTargetEditError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      // No active v2 configuration yet: fall through to v1 path
    }

    const currentConfig = loadClassificationConfig(ws.workspacePath);
    const nextConfig = applyCurationTargetsToConfig(currentConfig, targets, ws.id);
    saveClassificationConfig(ws.workspacePath, nextConfig);
    syncConfigToCache(ws.id, nextConfig);
    const { applicability, findings } = deriveCurationApplicability(nextConfig);
    return c.json({
      success: true,
      targets: nextConfig.curationTargets,
      candidates: listCurationTargetCandidates(ws.id, nextConfig),
      applicability,
      findings,
    });
  } catch (err) {
    if (err instanceof CurationTargetEditError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    console.error('[ClassificationRoutes] Save curation targets failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * Updates attribute configuration (e.g. isUniversal) in active v2 bundle.
 */
router.put('/classification/attributes/:attributeId', async (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  const attributeId = c.req.param('attributeId');
  try {
    const body = await c.req.json();
    const result = applyAttributeEdits(ws.workspacePath, ws.id, attributeId, body);
    const updatedConfig = loadRuntimeConfig(ws.workspacePath, ws.id);
    const { applicability, findings } = deriveCurationApplicability(updatedConfig);
    return c.json({
      success: true,
      attribute: result.attribute,
      applicability,
      findings,
    });
  } catch (err) {
    if (err instanceof AttributeEditError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    console.error('[ClassificationRoutes] Update attribute failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/classification/migrate-legacy
 * Migrates existing product_types, product_type_fields, and field_registry
 * into a ClassificationConfig under store/classification/.
 */
router.post('/classification/migrate-legacy', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const config = migrateLegacyToClassificationConfig(ws.workspacePath, ws.id);
    if (!config) {
      return c.json({ message: 'Classification config already exists. Use overwrite=true to force migration.' }, 200);
    }

    return c.json({
      success: true,
      summary: {
        productTypes: config.productTypes.length,
        attributes: config.attributes.length,
        attributeProfiles: config.attributeProfiles.length,
        attributeMappings: config.attributeMappings.length,
      },
    });
  } catch (err) {
    console.error('[ClassificationRoutes] Migration failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/classification/sync-seed
 * Synchronizes the approved seed taxonomy (BayStatePetGardenSeed) into the active
 * workspace's store/classification/ bundle directory and updates the SQLite runtime cache.
 */
router.post('/classification/sync-seed', async (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const config = await syncSeedToWorkspace(ws.workspacePath, ws.id);
    const { applicability, findings } = deriveCurationApplicability(config);
    const candidates = listCurationTargetCandidates(ws.id, config);

    return c.json({
      success: true,
      summary: {
        productTypes: config.productTypes.length,
        attributes: config.attributes.length,
        attributeProfiles: config.attributeProfiles.length,
        attributeMappings: config.attributeMappings.length,
      },
      candidates,
      applicability,
      findings,
    });
  } catch (err) {
    console.error('[ClassificationRoutes] Seed sync failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * GET /api/classification/runs/:id
 *
 * Workspace-scoped run detail (issue #17 work item E). Returns the run, stage
 * results, evidence, proposals, live decisions, model calls, a runtime
 * snapshot summary (version/digests — never prompt bodies or credentials),
 * and config/source drift flags. A run that belongs to another workspace
 * returns 404 (no existence leak).
 */
router.get('/classification/runs/:id', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }
  const runId = c.req.param('id');
  const run = getRun(runId);
  if (!run || run.workspaceId !== ws.id) {
    return c.json({ error: 'Run not found' }, 404);
  }

  const evidence = getEvidenceByRun(runId);
  const proposals = getProposalsByRun(runId);
  const stageResults = getStageResults(runId);
  const decisions = getLiveDecisionsByRun(runId);
  const modelCalls = getModelCallsByRun(runId);

  // Real config/source drift from the actual authority + snapshot comparison
  // (never hard-coded false). An unresolvable config authority or unknown
  // snapshot hash is treated as drift (fail closed).
  let configDrift = false;
  let sourceDrift = false;
  if (run.configSnapshotHash) {
    try {
      const authority = loadRuntimeConfigAuthority(ws.workspacePath, createRuntimeActivationContext(ws.workspacePath, ws.id));
      const matches =
        authorityConfigHashMatches(authority, run.configSnapshotHash) ||
        runtimeSnapshotHashMatchesConfig(
          ws.id,
          run.configSnapshotHash,
          authority.kind === 'v2' ? authority.bundle : authority.config,
        );
      if (!matches) configDrift = true;
    } catch {
      configDrift = true;
    }
  }
  if (
    run.sourceProductHash &&
    (run.status === 'completed' || run.status === 'completed_with_abstentions')
  ) {
    try {
      const product = readProductFile(ws.workspacePath, run.productSku);
      // A completed run whose recorded source file has disappeared IS drift
      // (null product = drift for completed runs, issue #17 pass 4c).
      if (!product) {
        sourceDrift = true;
      } else if (computeProductHash(product) !== run.sourceProductHash) {
        sourceDrift = true;
      }
    } catch {
      sourceDrift = true;
    }
  }

  // Runtime snapshot summary: version + digests only. Never the full config
  // (which embeds allowed values etc.) and never prompt/response bodies.
  let snapshotSummary = null;
  if (run.configSnapshotHash) {
    const snap = getRuntimeSnapshotByHash(ws.id, run.configSnapshotHash);
    if (snap) {
      snapshotSummary = {
        schemaVersion: snap.schemaVersion,
        snapshotHash: snap.snapshotHash,
        createdAt: snap.createdAt,
        configAuthorityKind: snap.configAuthorityKind,
        sourceCatalogCommit: snap.sourceCatalogCommit,
        catalogEvidenceHash: snap.catalogEvidenceHash,
        modelExecutionPlanDigest: snap.modelExecutionPlan?.digest ?? null,
        runtimeRuleVersionsDigest: snap.runtimeRuleVersions?.digest ?? null,
        pageImportId: snap.pageImportId,
        pageImportHash: snap.pageImportHash,
      };
    } else {
      snapshotSummary = { unavailable: 'snapshot_unavailable', configSnapshotHash: run.configSnapshotHash };
    }
  }

  // Model-call projection: hashes/versions only — prompt hashes, never bodies.
  const modelCallsView = modelCalls.map(call => ({
    id: call.id,
    status: call.status,
    operation: call.operation,
    stageName: call.stage_name,
    attempt: call.attempt,
    provider: call.provider,
    model: call.model,
    locality: call.locality,
    snapshotHash: call.snapshot_hash,
    modelPolicyDigest: call.model_policy_digest,
    promptTemplateVersion: call.prompt_template_version,
    ruleVersion: call.rule_version,
    systemPromptHash: call.system_prompt_hash,
    userPromptHash: call.user_prompt_hash,
    startedAt: call.started_at,
    endedAt: call.ended_at,
    durationMs: call.duration_ms,
    promptTokens: call.prompt_tokens,
    completionTokens: call.completion_tokens,
    errorMessage: call.error_message,
    estimatedCostUsd: call.estimated_cost_usd,
    costBasis: call.cost_basis,
  }));

  return c.json({
    run: {
      id: run.id,
      workspaceId: run.workspaceId,
      sourceKind: run.sourceKind,
      productSku: run.productSku,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      errorMessage: run.errorMessage,
      sourceProductHash: run.sourceProductHash,
      configSnapshotHash: run.configSnapshotHash,
    },
    // Child records pass through the credential-sanitizing projection so the
    // endpoint never returns api_key/Authorization/sk- content.
    evidence: sanitizeForRunDetail(evidence),
    proposals: sanitizeForRunDetail(proposals),
    decisions: sanitizeForRunDetail(decisions),
    stageResults: sanitizeForRunDetail(stageResults),
    modelCalls: modelCallsView,
    snapshotSummary,
    drift: {
      configDrift,
      sourceDrift,
    },
  });
});

/**
 * GET /api/classification/quality-report?start=&end=
 *
 * Workspace-scoped, bounded production quality telemetry (issue #17 F).
 * Rejects invalid/reversed ranges and caps the window (90 days). The report
 * is read-only and deterministic for a fixed window/watermark.
 */
router.get('/classification/quality-report', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  const startRaw = c.req.query('start');
  const endRaw = c.req.query('end');
  const nowIso = new Date().toISOString();

  // Validate the RAW inputs FIRST (blocker 3): an unparseable `end` with an
  // omitted `start` must yield 400 — the default-start computation below can
  // never throw a RangeError into a 500.
  const parsedEnd = endRaw === undefined ? new Date(nowIso) : new Date(endRaw);
  if (!Number.isFinite(parsedEnd.getTime())) {
    return c.json({ error: 'Invalid date range: end must be a valid ISO timestamp' }, 400);
  }
  const parsedStart = startRaw === undefined
    ? new Date(parsedEnd.getTime() - 7 * 24 * 60 * 60 * 1000)
    : new Date(startRaw);
  if (!Number.isFinite(parsedStart.getTime())) {
    return c.json({ error: 'Invalid date range: start must be a valid ISO timestamp' }, 400);
  }
  if (parsedStart.getTime() > parsedEnd.getTime()) {
    return c.json({ error: 'Invalid date range: start must not be after end' }, 400);
  }
  const rangeMs = parsedEnd.getTime() - parsedStart.getTime();
  const maxMs = QUALITY_REPORT_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
  if (rangeMs > maxMs) {
    return c.json(
      { error: `Invalid date range: window exceeds the ${QUALITY_REPORT_MAX_RANGE_DAYS}-day maximum` },
      400,
    );
  }
  // Normalize to strict ISO datetime strings (blocker 4): date-only inputs like
  // 2026-08-01 parse permissively but would fail the report's strict ISO
  // datetime schema and 500. toISOString() canonicalizes them.
  const start = parsedStart.toISOString();
  const end = parsedEnd.toISOString();

  try {
    const report = buildQualityReport(ws.id, start, end, nowIso);
    return c.json({ report });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

/**
 * POST /api/classification/process-refresh-queue
 * Processes pending classification refresh queue items for the current workspace.
 */
router.post('/classification/process-refresh-queue', async (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) {
    return c.json({ error: 'No active workspace' }, 400);
  }

  try {
    const count = await processRefreshQueue(ws.id, ws.workspacePath);
    return c.json({ success: true, processed: count });
  } catch (err) {
    console.error('[ClassificationRoutes] Refresh queue failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default router;

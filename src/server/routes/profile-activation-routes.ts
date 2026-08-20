// story: e07s04 — POST /api/domains/:domain/profile/activate (cluster-aware fail-closed, deterministic release)
import { Hono } from 'hono';
import { getVersionById, setActiveVersion } from '../../db/repositories/profile-version-repo';
import { getMatrixResult } from '../../onboarding/profile-test-matrix';
import { evaluateGate } from '../../onboarding/profile-activation-gate';
import { getSuiteSuggestion } from '../../onboarding/suite-suggestion-service';

export const profileActivationRoutes = new Hono();

profileActivationRoutes.post('/domains/:domain/profile/activate', async (c) => {
  const domain = c.req.param('domain') ?? '';
  const body = (await c.req.json().catch(() => ({}))) as {
    versionId?: string;
    expectedArtifactHashes?: string[];
    sampleIds?: string[];
    clusterIds?: string[];
  };
  const versionId = body.versionId;
  if (!versionId) return c.json({ error: 'versionId required' }, 400);
  const version = getVersionById(versionId);
  if (!version) return c.json({ error: 'version not found' }, 404);
  const matrix = getMatrixResult(domain, versionId);
  let clusterIds = body.clusterIds;
  if (!clusterIds || clusterIds.length === 0) {
    try {
      const suggestion = await getSuiteSuggestion(domain);
      clusterIds = suggestion.clusters.map(cl => cl.prefix);
    } catch {
      clusterIds = [];
    }
  }
  const requiredResults = matrix
    ? matrix.rows.flatMap(r => r.cells.map(cell => ({ field: cell.field, success: cell.success, provenance: cell.provenance, artifactHash: cell.artifactHash, expected: cell.expected, extracted: cell.extracted })))
    : [];
  const gate = evaluateGate({
    requiredResults: requiredResults as any,
    wrongProduct: false,
    wrongVariant: false,
    waiver: false,
    confirmedCount: 3,
    matrixResult: matrix,
    expectedArtifactHashes: body.expectedArtifactHashes ?? version.artifactHashes,
    sampleIds: body.sampleIds,
    clusterIds,
  } as any);
  if (!gate.allowed) {
    return c.json({ allowed: false, blockReason: gate.blockReason, reviseAction: gate.reviseAction, reason: gate.reason }, 409);
  }
  setActiveVersion(domain, versionId);
  // best-effort deterministic release of parked official_page items is handled by existing onboarding-work-api on next poll;
  // distributor_record bypass is preserved (profile-parking never parks distributor_record)
  return c.json({ allowed: true, activeVersionId: versionId });
});

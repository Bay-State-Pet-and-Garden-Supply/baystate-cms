import { Hono } from 'hono';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getCurrentWorkspace } from '../services/workspace-service';
import { listRegistry, isProjectionStale } from '../../db/repositories/field-registry-repo';
import { repairFieldRegistryAttestation, updateFieldMetadata } from '../services/field-metadata-service';

const route = new Hono();

/** Include the stale-projection marker state when it is set (F2). */
function projectionStalePayload(workspaceId: string): { projectionStale: true; condition: 'field_registry_projection_stale' } | { projectionStale: false } {
  return isProjectionStale(workspaceId)
    ? { projectionStale: true as const, condition: 'field_registry_projection_stale' as const }
    : { projectionStale: false as const };
}

/**
 * GET /api/field-registry - List field registry entries.
 *
 * Lazy repair fallback (issue #31 commit 3, D1): when the R2 attestation file
 * (`store/field-registry.json`) is missing, rebuild it from R1 (the
 * authoritative DB) so evidence scans and activation verification never see an
 * absent projection. Cheap existence check; repair failures are non-fatal here.
 */
route.get('/field-registry', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const attestationPath = path.join(workspace.workspacePath, 'store', 'field-registry.json');
  if (!fs.existsSync(attestationPath)) {
    try {
      repairFieldRegistryAttestation({ id: workspace.id, workspacePath: workspace.workspacePath });
    } catch (err) {
      console.error('[FieldRegistryRoute] GET lazy attestation repair failed (non-fatal):', err);
    }
  }

  const entries = listRegistry(workspace.id);
  // F2: surface the stale-projection marker when a prior R2 rewrite failed, so
  // clients can see that the attestation is (or is not) trustworthy.
  return c.json({ entries, ...projectionStalePayload(workspace.id) });
});

/**
 * POST /api/field-registry/repair - Explicit repair path (issue #31 commit 3,
 * D1). Rebuilds `store/field-registry.json` from the authoritative R1
 * (`field_registry` DB) as the canonical attestation projection. Follows the
 * existing route patterns; auth is handled globally by the API-token
 * middleware for non-GET requests (src/server/app.ts). F2: a repair failure
 * marks the projection stale and surfaces that state in the error response.
 */
route.post('/field-registry/repair', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }
  try {
    const entries = repairFieldRegistryAttestation({ id: workspace.id, workspacePath: workspace.workspacePath });
    return c.json({ success: true, entryCount: entries.length, ...projectionStalePayload(workspace.id) });
  } catch (err) {
    console.error('[FieldRegistryRoute] Repair failed:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err), ...projectionStalePayload(workspace.id) }, 500);
  }
});

/**
 * PUT /api/field-registry/:id - Update a field registry entry through the
 * canonical field-metadata service.
 *
 * The service resolves the row by its `xmlField` (fixes C4: a partial payload
 * such as `{ label }` from the Catalog Field drawer must never insert an empty
 * `xml_field`), snapshots the old R1 state, mutates R1, and atomically rewrites
 * the R2 attestation projection (`store/field-registry.json`) from R1.
 */
route.put('/field-registry/:id', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));

  // Resolve the row by id first so a partial payload with a valid id succeeds
  // (C4). An explicit body.xmlField is honored when the row does not exist yet.
  const existing = listRegistry(workspace.id).find(entry => entry.id === id);
  const xmlField = existing?.xmlField
    ?? (typeof body.xmlField === 'string' && body.xmlField.trim() !== '' ? body.xmlField : null);
  if (!xmlField) {
    return c.json({ error: 'Field registry entry not found.' }, 404);
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.label === 'string') patch.label = body.label;
  if (typeof body.kind === 'string') patch.kind = body.kind;
  if (typeof body.dataType === 'string') patch.dataType = body.dataType;
  if (typeof body.editable === 'boolean') patch.editable = body.editable;
  if (typeof body.required === 'boolean') patch.required = body.required;
  if ('uiGroup' in body) patch.uiGroup = body.uiGroup === null ? null : String(body.uiGroup);

  try {
    const entry = updateFieldMetadata(
      { id: workspace.id, workspacePath: workspace.workspacePath },
      xmlField,
      patch as never,
    );
    return c.json({ success: true, entry });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: `Invalid field metadata patch: ${err.issues.map(i => i.message).join('; ')}` }, 400);
    }
    console.error('[FieldRegistryRoute] Failed to update field metadata:', err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default route;

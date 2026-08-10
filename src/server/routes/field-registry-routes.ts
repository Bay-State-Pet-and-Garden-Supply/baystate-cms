import { Hono } from 'hono';
import { z } from 'zod';
import { getCurrentWorkspace } from '../services/workspace-service';
import { listRegistry } from '../../db/repositories/field-registry-repo';
import { updateFieldMetadata } from '../services/field-metadata-service';

const route = new Hono();

/**
 * GET /api/field-registry - List field registry entries.
 */
route.get('/field-registry', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const entries = listRegistry(workspace.id);
  return c.json({ entries });
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

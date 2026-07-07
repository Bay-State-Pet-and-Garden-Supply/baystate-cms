import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { listRegistry, upsertRegistryEntry } from '../../db/repositories/field-registry-repo';

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
 * PUT /api/field-registry/:id - Update a field registry entry.
 */
route.put('/field-registry/:id', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const { label, kind, dataType, editable, required, uiGroup } = body as {
    label?: string; kind?: string; dataType?: string;
    editable?: boolean; required?: boolean; uiGroup?: string;
  };

  // Upsert with the given id
  const now = new Date().toISOString();
  upsertRegistryEntry({
    id,
    workspaceId: workspace.id,
    xmlField: body.xmlField ?? '',
    label: label ?? '',
    kind: kind ?? 'custom',
    dataType: (dataType as any) ?? 'string',
    editable: editable ?? true,
    required: required ?? false,
    uiGroup: uiGroup ?? null,
    sampleValuesJson: body.sampleValuesJson ?? null,
    createdAt: now,
    updatedAt: now,
  });

  // Write updated registry back to disk (field-registry.json)
  try {
    const entries = listRegistry(workspace.id);
    const { writeStoreConfig } = await import('../../git/workspace-files');
    writeStoreConfig(workspace.workspacePath, 'field-registry.json', {
      schemaVersion: 1,
      entries,
    });
  } catch (err) {
    console.error('[FieldRegistryRoute] Failed to write field-registry.json:', err);
  }

  return c.json({ success: true });
});

export default route;

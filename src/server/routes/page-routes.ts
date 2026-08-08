import { Hono } from 'hono';
import {
  listPages,
  listVerifiedPageOptions,
  listProvisionalCandidates,
  getProductPages,
  clearProductPages,
  assignProductToVerifiedPage,
} from '../../db/repositories/page-repo';
import { previewPageImport, activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { findWorkspace } from '../../db/repositories/workspace-repo';

const router = new Hono();

// List all pages (read-only)
router.get('/pages', async (c) => {
  const pages = listPages();
  return c.json({ pages });
});

// Authoritative Page options — only verified identities from the active import.
router.get('/pages/verified-options', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) return c.json({ error: 'No workspace configured' }, 409);
  const pages = listVerifiedPageOptions(workspace.id);
  return c.json({ pages });
});

// Provisional candidates — scanned ProductOnPages fragments (review context only).
router.get('/pages/provisional-candidates', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) return c.json({ error: 'No workspace configured' }, 409);
  const scan = await listProvisionalCandidates(workspace.workspacePath);
  return c.json(scan);
});

// Import preview — validates and counts with NO database effect.
router.post('/pages/import/preview', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) return c.json({ error: 'No workspace configured' }, 409);
  const body = await c.req.json();
  try {
    const preview = previewPageImport({
      workspaceId: workspace.id,
      sourceHash: body.sourceHash,
      parserFormatVersion: body.parserFormatVersion ?? 'pages-xml-1',
      records: body.records,
    });
    return c.json(preview);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Invalid import preview payload' }, 400);
  }
});

// Import activation — atomic; refuses name-only identities.
router.post('/pages/import/activate', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) return c.json({ error: 'No workspace configured' }, 409);
  const body = await c.req.json();
  try {
    const activated = activatePageImportFromRecords({
      workspaceId: workspace.id,
      sourceHash: body.sourceHash,
      parserFormatVersion: body.parserFormatVersion ?? 'pages-xml-1',
      records: body.records,
      activatedBy: body.activatedBy ?? null,
    });
    return c.json({ success: true, import: activated });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Import activation failed' }, 400);
  }
});

// ── Legacy unrestricted mutation endpoints are DISABLED ──────────────────────
// Authoritative Page upsert/delete would let unverified names or synthetic
// UUIDs masquerade as identities. Superseding happens only through import
// activation.
router.post('/pages', async (c) =>
  c.json(
    { error: 'Authoritative Page upsert is disabled. Use POST /pages/import/preview and POST /pages/import/activate.' },
    410,
  ),
);
router.delete('/pages/:id', async (c) =>
  c.json(
    { error: 'Authoritative Page delete is disabled. Import activation supersedes pages atomically.' },
    410,
  ),
);

// Get assigned pages for a product SKU (read-only)
router.get('/products/:sku/pages', async (c) => {
  const sku = c.req.param('sku');
  const pageNames = getProductPages(sku);
  return c.json({ pages: pageNames });
});

// Set page assignments for a product SKU — only verified identities from the
// active import may be assigned. Name-only pages are refused (409).
router.post('/products/:sku/pages', async (c) => {
  const sku = c.req.param('sku');
  const workspace = findWorkspace();
  if (!workspace) return c.json({ error: 'No workspace configured' }, 409);
  const body = await c.req.json();

  if (!body.pages || !Array.isArray(body.pages)) {
    return c.json({ error: 'pages field must be an array of page names' }, 400);
  }

  const verified = listVerifiedPageOptions(workspace.id);
  const verifiedByName = new Map(verified.map(p => [p.name, p]));
  const unverified = (body.pages as string[]).filter(name => !verifiedByName.has(name));
  if (unverified.length > 0) {
    return c.json(
      {
        error: `Refusing to assign unverified page identity: ${unverified.join(', ')}. Name-only pages are review context and cannot be serialized.`,
        unverified,
      },
      409,
    );
  }

  clearProductPages(sku);
  const pagesAssigned: string[] = [];
  for (const pageName of body.pages as string[]) {
    const page = verifiedByName.get(pageName);
    if (page) {
      assignProductToVerifiedPage(sku, page.id, page.name);
      pagesAssigned.push(pageName);
    }
  }

  return c.json({ success: true, pages: pagesAssigned });
});

export default router;

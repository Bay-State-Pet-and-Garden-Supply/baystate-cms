import { Hono } from 'hono';
import {
  listPages,
  listVerifiedPageOptions,
  getActivePageImportHash,
  listProvisionalCandidates,
  getProductPages,
  clearProductPages,
  assignProductToVerifiedPage,
} from '../../db/repositories/page-repo';
import { previewPageImport, activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { downloadPagesFromShopSite } from '../../shopsite/page-download-service';
import { ShopSiteHttpClient } from '../../shopsite/shopsite-http-client';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { findConnection } from '../../db/repositories/connection-repo';

const router = new Hono();

// List all pages (read-only)
router.get('/pages', async (c) => {
  const pages = listPages();
  return c.json({ pages });
});

// Authoritative Page options — only verified identities from the active import.
// activeImportHash (e09 round-3 FIX 1) lets the Review UI stamp a reviewer
// Category Page correction with the import it was captured against.
router.get('/pages/verified-options', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) return c.json({ error: 'No workspace configured' }, 409);
  const pages = listVerifiedPageOptions(workspace.id);
  const activeImportHash = getActivePageImportHash(workspace.id);
  return c.json({ pages, activeImportHash });
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

// Live download — pulls the Pages database from ShopSite (db_xml.cgi
// dbname=pages) and returns an activation-ready preview. No DB writes:
// activation still goes through /pages/import/activate.
router.post('/pages/import/download', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) return c.json({ error: 'No workspace configured' }, 409);

  const connection = findConnection(workspace.id);
  if (!connection?.cgiBaseUrl || !connection.merchantId || !connection.passwordSecretRef) {
    return c.json({ error: 'ShopSite connection is not configured. Please save and test your credentials first.' }, 400);
  }

  const client = new ShopSiteHttpClient({
    cgiBaseUrl: connection.cgiBaseUrl,
    merchantId: connection.merchantId,
    password: connection.passwordSecretRef,
  });

  const result = await downloadPagesFromShopSite(client);
  if (!result.ok) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    success: true,
    preview: {
      sourceHash: result.sourceHash,
      parserFormatVersion: result.parserFormatVersion,
      counts: result.counts,
      records: result.records,
      warnings: result.warnings,
    },
  });
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

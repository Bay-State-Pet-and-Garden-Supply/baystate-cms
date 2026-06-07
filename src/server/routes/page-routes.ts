import { Hono } from 'hono';
import {
  listPages,
  getPage,
  getPageByName,
  upsertPage,
  deletePage,
  getProductPages,
  clearProductPages,
  assignProductToPage,
} from '../../db/repositories/page-repo';

const router = new Hono();

// List all pages
router.get('/pages', async (c) => {
  const pages = listPages();
  return c.json({ pages });
});

// Upsert page
router.post('/pages', async (c) => {
  const body = await c.req.json();
  if (!body.name) {
    return c.json({ error: 'Page name is required' }, 400);
  }

  const page = upsertPage({
    name: body.name,
    fileName: body.fileName || null,
    parentId: body.parentId || null,
    pageHash: body.pageHash || 'draft-hash',
    lastSyncedAt: body.lastSyncedAt || null,
  });

  return c.json({ success: true, page });
});

// Delete page
router.delete('/pages/:id', async (c) => {
  const id = c.req.param('id');
  const page = getPage(id);
  if (!page) {
    return c.json({ error: 'Page not found' }, 404);
  }
  deletePage(id);
  return c.json({ success: true });
});

// Get assigned pages for a product SKU
router.get('/products/:sku/pages', async (c) => {
  const sku = c.req.param('sku');
  const pageNames = getProductPages(sku);
  return c.json({ pages: pageNames });
});

// Set page assignments for a product SKU
router.post('/products/:sku/pages', async (c) => {
  const sku = c.req.param('sku');
  const body = await c.req.json();
  
  if (!body.pages || !Array.isArray(body.pages)) {
    return c.json({ error: 'pages field must be an array of page names' }, 400);
  }

  clearProductPages(sku);
  
  const pagesAssigned: string[] = [];
  for (const pageName of body.pages) {
    assignProductToPage(sku, pageName);
    pagesAssigned.push(pageName);
  }

  return c.json({ success: true, pages: pagesAssigned });
});

export default router;

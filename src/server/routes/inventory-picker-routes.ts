// story: e07s02 + oracle picker S1
import { Hono } from 'hono';
import { findUrlsByDomain, normalizeDomain } from '../../db/repositories/brand-url-index-repo';
import { templateAwarePrefix } from '../../onboarding/template-clustering';

function isValidDomain(d: string): boolean {
  return d.length >= 3 && d.includes('.');
}

function clusterOf(url: string): string {
  try {
    const u = new URL(url);
    return templateAwarePrefix(u.pathname);
  } catch {
    return '';
  }
}

export const inventoryPickerRoutes = new Hono();

inventoryPickerRoutes.get('/domains/:domain/inventory-picker', (c) => {
  const rawDomain = c.req.param('domain') ?? '';
  const domain = normalizeDomain(rawDomain);
  if (!isValidDomain(domain)) return c.json({ error: 'invalid domain' }, 400);
  const query = c.req.query('query')?.trim() ?? '';
  const cluster = c.req.query('cluster')?.trim() ?? '';
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
  const limitRaw = Number(c.req.query('limit') ?? '20');
  const limit = Math.min(50, Math.max(1, limitRaw || 20));
  const offset = (page - 1) * limit;

  const { urls, total } = findUrlsByDomain(domain, {
    pageType: 'product',
    activeOnly: true,
    search: query || undefined,
    limit: limit + 100,
    offset: 0,
  });

  let filtered = urls;
  if (cluster) {
    const normCluster = cluster.startsWith('/') ? cluster : `/${cluster}`;
    filtered = filtered.filter((r) => clusterOf(r.url) === normCluster);
  }

  const totalFiltered = filtered.length;
  const pageItems = filtered.slice(offset, offset + limit);

  const items = pageItems.map((r) => ({
    url: r.url,
    title: r.title ?? r.h1 ?? r.slug ?? r.path,
    cluster: clusterOf(r.url),
    lastSeen: r.last_seen_at,
  }));

  return c.json({ items, total: totalFiltered, page, rawTotal: total });
});

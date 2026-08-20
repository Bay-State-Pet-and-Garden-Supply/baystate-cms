// story: e06s02 — representative suite + waiver API
import { Hono } from 'hono';
import { z } from 'zod';
import { getRepresentativeSuite, setRepresentativeSuite } from '../../db/repositories/representative-suite-repo';
import { getWaiver, createWaiver } from '../../db/repositories/waiver-repo';
import { getSitemapInventory } from '../../onboarding/sitemap-inventory-service';
import { clusterInventoryUrls } from '../../onboarding/template-clustering';
import { getClusterOverrides, setClusterOverride, applyOverrides, applyOverridesToSuggested } from '../../db/repositories/cluster-override-repo';

export const representativeSuiteRoutes = new Hono();

function safeClusters(domain: string): { clusters: unknown[]; suggested: string[]; filtered: { count: number; reason: string }; overrides: unknown[] } {
  try {
    const raw = clusterInventoryUrls(domain);
    const overrides = getClusterOverrides(domain);
    const clusters = applyOverrides(raw.clusters as never[], overrides as never[]) as unknown[];
    const suggestedRaw = raw.suggested.map(url => ({ clusterKey: url, url }));
    const suggestedFiltered = applyOverridesToSuggested(suggestedRaw as any, overrides as never[]).map((s: any) => s.url);
    return { clusters, suggested: suggestedFiltered, filtered: raw.filtered, overrides };
  } catch {
    return { clusters: [], suggested: [], filtered: { count: 0, reason: '' }, overrides: [] };
  }
}

representativeSuiteRoutes.get('/domains/:domain/representative-suite', (c) => {
  const domain = c.req.param('domain') ?? '';
  const suite = getRepresentativeSuite(domain);
  const inv = getSitemapInventory(domain);
  const extra = safeClusters(domain);
  return c.json({ suite, inventory: inv, ...extra });
});

const overrideSchema = z.object({
  clusterKey: z.string().min(1),
  action: z.string().min(1),
  actor: z.string().min(1),
});

representativeSuiteRoutes.post('/domains/:domain/cluster-overrides', async (c) => {
  const domain = c.req.param('domain') ?? '';
  const body = await c.req.json();
  const parsed = overrideSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  try {
    const ov = setClusterOverride(domain, parsed.data.clusterKey, parsed.data.action, parsed.data.actor);
    return c.json({ override: ov });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

representativeSuiteRoutes.get('/domains/:domain/cluster-overrides', (c) => {
  const domain = c.req.param('domain') ?? '';
  const list = getClusterOverrides(domain);
  return c.json({ overrides: list });
});

const putSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(10),
  actor: z.string().min(1),
});

representativeSuiteRoutes.put('/domains/:domain/representative-suite', async (c) => {
  const domain = c.req.param('domain') ?? '';
  const body = await c.req.json();
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  try {
    setRepresentativeSuite(domain, parsed.data.urls, parsed.data.actor);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const suite = getRepresentativeSuite(domain);
  return c.json({ suite });
});

const waiverSchema = z.object({
  reason: z.string().min(5),
  actor: z.string().min(1),
});

representativeSuiteRoutes.get('/domains/:domain/waiver', (c) => {
  const domain = c.req.param('domain') ?? '';
  const w = getWaiver(domain);
  return c.json({ waiver: w });
});

representativeSuiteRoutes.post('/domains/:domain/waiver', async (c) => {
  const domain = c.req.param('domain') ?? '';
  const body = await c.req.json();
  const parsed = waiverSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  try {
    const w = createWaiver(domain, parsed.data.reason, parsed.data.actor);
    return c.json({ waiver: w });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

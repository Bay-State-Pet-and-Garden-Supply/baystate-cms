// story: e06s02 — representative suite + waiver API
import { Hono } from 'hono';
import { z } from 'zod';
import { getRepresentativeSuite, setRepresentativeSuite } from '../../db/repositories/representative-suite-repo';
import { getWaiver, createWaiver } from '../../db/repositories/waiver-repo';
import { getSitemapInventory } from '../../onboarding/sitemap-inventory-service';

export const representativeSuiteRoutes = new Hono();

representativeSuiteRoutes.get('/domains/:domain/representative-suite', (c) => {
  const domain = c.req.param('domain') ?? '';
  const suite = getRepresentativeSuite(domain);
  const inv = getSitemapInventory(domain);
  return c.json({ suite, inventory: inv });
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

// story: e06s01 — Hono GET /api/domains/:domain/profile-state (server-derived header/readiness source)
import { Hono } from 'hono';
import { getDomainProfileState } from '../../db/repositories/domain-profile-state-repo';

export const domainProfileStateRoutes = new Hono();

domainProfileStateRoutes.get('/domains/:domain/profile-state', (c) => {
  const raw = c.req.param('domain') ?? '';
  const state = getDomainProfileState(raw);
  return c.json(state);
});

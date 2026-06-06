import { Hono } from 'hono';

const route = new Hono();

route.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

export default route;

import { serve } from 'bun';
import app from './app';

const PORT = parseInt(process.env.PORT ?? '3030', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

const server = serve({
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
});

console.log(`ShopSite CMS API server running on http://${HOST}:${PORT}`);
if (process.env.SHOPSITE_CMS_API_TOKEN) {
  console.log(`API token authentication is enabled for mutating requests.`);
} else {
  console.log(`No API token configured. Mutating requests are unauthenticated - set SHOPSITE_CMS_API_TOKEN for production use.`);
}

export { server };

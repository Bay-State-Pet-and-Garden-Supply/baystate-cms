import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { errorHandler } from './middleware/error-handler';
import healthRoute from './routes/health';
import workspaceRoutes from './routes/workspace-routes';
import bootstrapRoutes from './routes/bootstrap-routes';
import productRoutes from './routes/product-routes';
import changeSetRoutes from './routes/change-set-routes';
import fieldRegistryRoutes from './routes/field-registry-routes';
import connectionRoutes from './routes/connection-routes';
import exportRoutes from './routes/export-routes';
import syncRoutes from './routes/sync-routes';
import driftRoutes from './routes/drift-routes';

const app = new Hono();

// API token middleware
// When SHOPSITE_CMS_API_TOKEN is set, all mutating (non-GET) requests must include
// an Authorization: Bearer <token> header matching the configured token.
const apiToken = process.env.SHOPSITE_CMS_API_TOKEN;
if (apiToken) {
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      await next();
      return;
    }
    const auth = c.req.header('Authorization') ?? '';
    if (auth !== `Bearer ${apiToken}`) {
      return c.json({ error: 'Unauthorized. Provide a valid API token via Authorization: Bearer header.' }, 401);
    }
    await next();
  });
}

// Restricted CORS - only allow local UI origins
app.use('*', cors({
  origin: [
    'http://localhost:3031',
    'http://127.0.0.1:3031',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ],
  credentials: true,
}));

app.onError(errorHandler);

// Routes
app.route('/api', healthRoute);
app.route('/api', workspaceRoutes);
app.route('/api', bootstrapRoutes);
app.route('/api', productRoutes);
app.route('/api', changeSetRoutes);
app.route('/api', fieldRegistryRoutes);
app.route('/api', connectionRoutes);
app.route('/api', exportRoutes);
app.route('/api', syncRoutes);
app.route('/api', driftRoutes);

// 404 handler
app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;

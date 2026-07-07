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
import productTypeRoutes from './routes/product-type-routes';
import pageRoutes from './routes/page-routes';
import dashboardRoutes from './routes/dashboard-routes';
import onboardingRoutes from './routes/onboarding-routes';
import classificationRoutes from './routes/classification-routes';
import storeManagerRoutes from './routes/store-manager-routes';
import catalogRoutes from './routes/catalog-routes';
import { getCurrentWorkspace } from './services/workspace-service';

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

// Autoload middleware to ensure database is initialized on demand
app.use('/api/*', async (c, next) => {
  getCurrentWorkspace();
  await next();
});

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
app.route('/api', productTypeRoutes);
app.route('/api', pageRoutes);
app.route('/api', dashboardRoutes);
app.route('/api', onboardingRoutes);
app.route('/api', classificationRoutes);
app.route('/api', storeManagerRoutes);
app.route('/api', catalogRoutes);

// 404 handler
app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;

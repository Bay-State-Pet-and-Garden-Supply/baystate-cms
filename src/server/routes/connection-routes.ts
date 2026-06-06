import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { upsertConnection, findConnection, updateConnectionTestStatus } from '../../db/repositories/connection-repo';
import { ShopSiteHttpClient } from '../../shopsite/shopsite-http-client';
import { normalizeCgiBaseUrl, validateCgiUrl } from '../../shopsite/url-utils';

const route = new Hono();

route.get('/connection', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const connection = findConnection(workspace.id);
  return c.json({
    connection: connection ? {
      id: connection.id,
      workspaceId: connection.workspaceId,
      cgiBaseUrl: connection.cgiBaseUrl,
      authStrategy: connection.authStrategy,
      merchantId: connection.merchantId,
      passwordConfigured: !!connection.passwordSecretRef,
      lastTestedAt: connection.lastTestedAt,
      lastTestStatus: connection.lastTestStatus,
      lastTestError: connection.lastTestError,
    } : null,
  });
});

route.post('/connection/save', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = await c.req.json().catch(() => ({})) as {
    cgiBaseUrl?: string;
    merchantId?: string;
    password?: string;
  };

  const cgiBaseUrl = normalizeCgiBaseUrl(body.cgiBaseUrl ?? '');
  const merchantId = body.merchantId?.trim() ?? '';
  const password = body.password ?? '';

  if (!cgiBaseUrl || !merchantId) {
    return c.json({ error: 'CGI base URL and merchant/user ID are required.' }, 400);
  }

  const urlError = validateCgiUrl(body.cgiBaseUrl ?? '');
  if (urlError) {
    return c.json({ error: urlError }, 400);
  }

  const existing = findConnection(workspace.id);
  if (!password && !existing?.passwordSecretRef) {
    return c.json({ error: 'Password is required the first time connection settings are saved.' }, 400);
  }

  const connection = upsertConnection({
    workspaceId: workspace.id,
    cgiBaseUrl,
    merchantId,
    passwordSecretRef: password || existing?.passwordSecretRef || null,
    authStrategy: 'basic',
  });

  return c.json({
    success: true,
    connection: {
      id: connection.id,
      cgiBaseUrl: connection.cgiBaseUrl,
      merchantId: connection.merchantId,
      passwordConfigured: !!connection.passwordSecretRef,
      lastTestedAt: connection.lastTestedAt,
      lastTestStatus: connection.lastTestStatus,
      lastTestError: connection.lastTestError,
    },
  });
});

route.post('/connection/test', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const connection = findConnection(workspace.id);
  if (!connection?.cgiBaseUrl || !connection.merchantId || !connection.passwordSecretRef) {
    return c.json({ error: 'ShopSite connection is not configured.' }, 400);
  }

  const client = new ShopSiteHttpClient({
    cgiBaseUrl: connection.cgiBaseUrl,
    merchantId: connection.merchantId,
    password: connection.passwordSecretRef,
  });
  const result = await client.testConnection();
  updateConnectionTestStatus(workspace.id, result.success ? 'success' : 'failed', result.success ? null : result.message);

  return c.json({
    success: result.success,
    message: result.message,
  }, result.success ? 200 : 400);
});

export default route;

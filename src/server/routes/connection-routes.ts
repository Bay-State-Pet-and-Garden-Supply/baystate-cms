import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { upsertConnection, findConnection, updateConnectionTestStatus } from '../../db/repositories/connection-repo';
import { ShopSiteHttpClient } from '../../shopsite/shopsite-http-client';
import { normalizeCgiBaseUrl, validateCgiUrl } from '../../shopsite/url-utils';

const route = new Hono();

route.get('/connection', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No store workspace loaded.' }, 400);

  const connection = findConnection(workspace.id);

  // Environment variables fallback for standalone store deployment
  const envCgiUrl = process.env.SHOPSITE_CGI_URL;
  const envMerchantId = process.env.SHOPSITE_MERCHANT_ID;
  const envPassword = process.env.SHOPSITE_PASSWORD;

  const cgiBaseUrl = connection?.cgiBaseUrl || (envCgiUrl ? normalizeCgiBaseUrl(envCgiUrl) : '');
  const merchantId = connection?.merchantId || envMerchantId || null;
  const passwordConfigured = !!connection?.passwordSecretRef || !!envPassword;

  if (!connection && !cgiBaseUrl && !merchantId) {
    return c.json({ connection: null });
  }

  return c.json({
    connection: {
      id: connection?.id ?? 'env-default',
      workspaceId: workspace.id,
      cgiBaseUrl,
      authStrategy: connection?.authStrategy ?? 'basic',
      merchantId,
      passwordConfigured,
      lastTestedAt: connection?.lastTestedAt ?? null,
      lastTestStatus: connection?.lastTestStatus ?? null,
      lastTestError: connection?.lastTestError ?? null,
    },
  });
});

route.post('/connection/save', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No store workspace loaded.' }, 400);

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
  const envPassword = process.env.SHOPSITE_PASSWORD;
  if (!password && !existing?.passwordSecretRef && !envPassword) {
    return c.json({ error: 'Password is required the first time connection settings are saved.' }, 400);
  }

  const connection = upsertConnection({
    workspaceId: workspace.id,
    cgiBaseUrl,
    merchantId,
    passwordSecretRef: password || existing?.passwordSecretRef || envPassword || null,
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
  if (!workspace) return c.json({ error: 'No store workspace loaded.' }, 400);

  const connection = findConnection(workspace.id);
  const cgiBaseUrl = connection?.cgiBaseUrl || (process.env.SHOPSITE_CGI_URL ? normalizeCgiBaseUrl(process.env.SHOPSITE_CGI_URL) : '');
  const merchantId = connection?.merchantId || process.env.SHOPSITE_MERCHANT_ID || '';
  const password = connection?.passwordSecretRef || process.env.SHOPSITE_PASSWORD || '';

  if (!cgiBaseUrl || !merchantId || !password) {
    return c.json({ error: 'ShopSite connection credentials are not configured.' }, 400);
  }

  const client = new ShopSiteHttpClient({
    cgiBaseUrl,
    merchantId,
    password,
  });
  const result = await client.testConnection();
  if (connection) {
    updateConnectionTestStatus(workspace.id, result.success ? 'success' : 'failed', result.success ? null : result.message);
  }

  return c.json({
    success: result.success,
    message: result.message,
  }, result.success ? 200 : 400);
});

export default route;

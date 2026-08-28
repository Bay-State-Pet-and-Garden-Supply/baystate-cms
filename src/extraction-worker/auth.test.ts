import { afterEach, describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { checkAuth } from './auth';

describe('extraction worker checkAuth', () => {
  const originalEnv = process.env.BAYSTATE_CMS_WORKER_TOKEN;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.BAYSTATE_CMS_WORKER_TOKEN = originalEnv;
    } else {
      delete process.env.BAYSTATE_CMS_WORKER_TOKEN;
    }
  });

  it('fails closed when BAYSTATE_CMS_WORKER_TOKEN is not set', () => {
    delete process.env.BAYSTATE_CMS_WORKER_TOKEN;
    const req = { headers: { authorization: 'Bearer secret' } } as IncomingMessage;
    const result = checkAuth(req);
    expect(result.authorized).toBe(false);
    expect(result.message).toContain('Server authentication is not configured');
  });

  it('rejects missing authorization header', () => {
    process.env.BAYSTATE_CMS_WORKER_TOKEN = 'test-token';
    const req = { headers: {} } as IncomingMessage;
    const result = checkAuth(req);
    expect(result.authorized).toBe(false);
    expect(result.message).toBe('Missing Authorization header');
  });

  it('rejects non-Bearer authorization scheme', () => {
    process.env.BAYSTATE_CMS_WORKER_TOKEN = 'test-token';
    const req = { headers: { authorization: 'Basic test-token' } } as IncomingMessage;
    const result = checkAuth(req);
    expect(result.authorized).toBe(false);
    expect(result.message).toBe('Authorization header must use Bearer scheme');
  });

  it('rejects invalid token', () => {
    process.env.BAYSTATE_CMS_WORKER_TOKEN = 'test-token';
    const req = { headers: { authorization: 'Bearer wrong-token' } } as IncomingMessage;
    const result = checkAuth(req);
    expect(result.authorized).toBe(false);
    expect(result.message).toBe('Invalid bearer token');
  });

  it('accepts valid bearer token', () => {
    process.env.BAYSTATE_CMS_WORKER_TOKEN = 'test-token';
    const req = { headers: { authorization: 'Bearer test-token' } } as IncomingMessage;
    const result = checkAuth(req);
    expect(result.authorized).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import app from '../../server/app';

describe('fetch-html SSRF & Local File Disclosure protection', () => {
  it('rejects file:// scheme URLs', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('Only http and https protocols are allowed');
  });

  it('rejects gopher:// scheme URLs', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'gopher://127.0.0.1:70/' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('Only http and https protocols are allowed');
  });

  it('rejects private IP addresses (localhost)', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:8080/admin' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('URL points to a private network address');
  });

  it('rejects private IP addresses (127.0.0.1)', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/secret' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('URL points to a private network address');
  });
});

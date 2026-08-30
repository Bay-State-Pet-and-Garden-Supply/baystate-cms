import { describe, it, expect } from 'vitest';
import app from '../../server/app';

describe('POST /api/onboarding/settings/profile-tooling/fetch-html SSRF validation', () => {
  it('rejects invalid URL format', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-valid-url' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('Invalid URL');
  });

  it('rejects non-HTTP/HTTPS protocols like file://', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('Only http and https protocols are allowed');
  });

  it('rejects loopback address 127.0.0.1', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/admin' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('URL points to a private network address');
  });

  it('rejects localhost', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:8080' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('URL points to a private network address');
  });

  it('rejects octal representation of 127.0.0.1 (0177.0.0.1)', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://0177.0.0.1/' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('URL points to a private network address');
  });

  it('rejects hex representation of 127.0.0.1 (0x7f000001)', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://0x7f000001/' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('URL points to a private network address');
  });

  it('rejects integer representation of 127.0.0.1 (2130706433)', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://2130706433/' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('URL points to a private network address');
  });

  it('rejects RFC1918 private IP ranges (10.0.0.1, 192.168.1.1, 172.16.0.1)', async () => {
    for (const ip of ['10.0.0.1', '192.168.1.1', '172.16.0.1']) {
      const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: `http://${ip}/` }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('URL points to a private network address');
    }
  });

  it('rejects link-local IP 169.254.169.254 (AWS metadata endpoint)', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('URL points to a private network address');
  });
});

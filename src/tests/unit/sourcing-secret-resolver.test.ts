import { describe, test, expect } from 'vitest';
import { parseHtmlScraperCredentials } from '../../onboarding/sourcing/html-scraper/credentials';

describe('html_scraper credential JSON parsing (Amendment B, M2)', () => {
  test('valid username/password JSON parses exactly', () => {
    const result = parseHtmlScraperCredentials(JSON.stringify({ username: 'user1', password: 'pw-123' }));
    expect(result).toEqual({ ok: true, credentials: { username: 'user1', password: 'pw-123' } });
  });

  test('missing / null / masked material is secret_missing (never credential_invalid)', () => {
    expect(parseHtmlScraperCredentials(null)).toEqual({ ok: false, code: 'secret_missing' });
    expect(parseHtmlScraperCredentials(undefined)).toEqual({ ok: false, code: 'secret_missing' });
    expect(parseHtmlScraperCredentials('')).toEqual({ ok: false, code: 'secret_missing' });
    expect(parseHtmlScraperCredentials('••••••••')).toEqual({ ok: false, code: 'secret_missing' });
  });

  test('malformed JSON is credential_invalid without echoing input', () => {
    const result = parseHtmlScraperCredentials('{not json');
    expect(result).toEqual({ ok: false, code: 'credential_invalid' });
  });

  test('non-object payloads (arrays, primitives) are credential_invalid', () => {
    expect(parseHtmlScraperCredentials('["user","pass"]')).toEqual({ ok: false, code: 'credential_invalid' });
    expect(parseHtmlScraperCredentials('42')).toEqual({ ok: false, code: 'credential_invalid' });
    expect(parseHtmlScraperCredentials('"just-a-string"')).toEqual({ ok: false, code: 'credential_invalid' });
    expect(parseHtmlScraperCredentials('null')).toEqual({ ok: false, code: 'credential_invalid' });
  });

  test('extra credential fields are rejected (exactly username + password)', () => {
    const result = parseHtmlScraperCredentials(JSON.stringify({ username: 'u', password: 'p', apiKey: 'x' }));
    expect(result).toEqual({ ok: false, code: 'credential_invalid' });
  });

  test('missing / blank / non-string fields are credential_invalid', () => {
    expect(parseHtmlScraperCredentials(JSON.stringify({ username: 'u' }))).toEqual({ ok: false, code: 'credential_invalid' });
    expect(parseHtmlScraperCredentials(JSON.stringify({ password: 'p' }))).toEqual({ ok: false, code: 'credential_invalid' });
    expect(parseHtmlScraperCredentials(JSON.stringify({ username: '', password: 'p' }))).toEqual({ ok: false, code: 'credential_invalid' });
    expect(parseHtmlScraperCredentials(JSON.stringify({ username: 'u', password: '' }))).toEqual({ ok: false, code: 'credential_invalid' });
    expect(parseHtmlScraperCredentials(JSON.stringify({ username: 42, password: 'p' }))).toEqual({ ok: false, code: 'credential_invalid' });
    expect(parseHtmlScraperCredentials(JSON.stringify({ username: 'u', password: ['p'] }))).toEqual({ ok: false, code: 'credential_invalid' });
  });

  test('password with a UI mask prefix is treated as unprovisioned', () => {
    const result = parseHtmlScraperCredentials(JSON.stringify({ username: 'u', password: '••••' }));
    expect(result).toEqual({ ok: false, code: 'secret_missing' });
  });

  test('passwords are not trimmed or altered — leading/trailing spaces are preserved', () => {
    const result = parseHtmlScraperCredentials(JSON.stringify({ username: 'user ', password: ' pass with spaces ' }));
    expect(result).toEqual({ ok: true, credentials: { username: 'user ', password: ' pass with spaces ' } });
  });

  test('no parse error message or input value ever appears in the result (redaction seam)', () => {
    const sneaky = `{"username":"u","password":"p"} trailing-garbage`;
    const result = parseHtmlScraperCredentials(sneaky);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result)).not.toContain('u');
      expect(JSON.stringify(result)).not.toContain('trailing-garbage');
    }
  });
});

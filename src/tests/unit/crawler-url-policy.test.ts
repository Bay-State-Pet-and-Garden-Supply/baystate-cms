import { describe, it, expect } from 'vitest';
import {
  validateUrl,
  evaluateRedirect,
  registrableDomain,
} from '../../crawler/url-policy';

describe('crawler URL policy', () => {
  describe('validateUrl', () => {
    it('accepts canonical retail product URLs', () => {
      const result = validateUrl('https://www.chewy.com/dp/102534');
      expect(result.ok).toBe(true);
      expect(result.canonicalUrl).toBe('https://www.chewy.com/dp/102534');
      expect(result.registrableDomain).toBe('chewy.com');
    });

    it('canonicalizes scheme/host case and strips default ports and hashes', () => {
      const result = validateUrl('https://WWW.Chewy.com:443/dp/102534#reviews');
      expect(result.ok).toBe(true);
      expect(result.canonicalUrl).toBe('https://www.chewy.com/dp/102534');
    });

    it('rejects non-http(s) schemes', () => {
      const result = validateUrl('ftp://chewy.com/dp/102534');
      expect(result.ok).toBe(false);
      expect(result.issues).toContain('unsupported_scheme');
    });

    it('rejects URLs with credentials', () => {
      const result = validateUrl('https://user:pass@chewy.com/dp/102534');
      expect(result.ok).toBe(false);
      expect(result.issues).toContain('credentials');
    });

    it('rejects IP literals including private ranges', () => {
      expect(validateUrl('https://127.0.0.1/path').ok).toBe(false);
      expect(validateUrl('https://10.0.0.1/path').ok).toBe(false);
      expect(validateUrl('https://192.168.1.1/path').ok).toBe(false);
      expect(validateUrl('https://172.16.0.1/path').ok).toBe(false);
      expect(validateUrl('https://[::1]/path').ok).toBe(false);
      expect(validateUrl('https://8.8.8.8/path').ok).toBe(false); // public IP still rejected as ip_target
    });

    it('rejects localhost and reserved targets', () => {
      const localhost = validateUrl('https://localhost/path');
      expect(localhost.ok).toBe(false);
      expect(localhost.issues).toContain('reserved_target');
      expect(validateUrl('https://test.local/path').ok).toBe(false);
      expect(validateUrl('https://store.internal/path').ok).toBe(false);
    });

    it('rejects malformed hosts', () => {
      expect(validateUrl('https://chewy..com/path').ok).toBe(false);
      expect(validateUrl('https://-chewy.com/path').ok).toBe(false);
      expect(validateUrl('https://chewy-.com/path').ok).toBe(false);
      expect(validateUrl('https://chewy.com./path').ok).toBe(true); // trailing dot is normalized away
    });

    it('rejects unsupported ports', () => {
      const ssh = validateUrl('https://chewy.com:22/dp/102534');
      expect(ssh.ok).toBe(false);
      expect(ssh.issues).toContain('unsupported_port');
      expect(validateUrl('https://chewy.com:21/path').ok).toBe(false);
      expect(validateUrl('https://chewy.com:3306/path').ok).toBe(false);
    });

    it('accepts common http(s) ports', () => {
      expect(validateUrl('https://chewy.com:8080/path').ok).toBe(true);
      expect(validateUrl('http://chewy.com:80/path').ok).toBe(true);
    });

    it('rejects deceptive suffixes against an allowlist', () => {
      const allowed = new Set(['chewy.com', 'tractorsupply.com']);
      const fake = validateUrl('https://www.chewy.com.evil.com/dp/102534', allowed);
      expect(fake.ok).toBe(false);
      expect(fake.issues).toContain('deceptive_suffix');
      const real = validateUrl('https://www.tractorsupply.com/tsc/product/x', allowed);
      expect(real.ok).toBe(true);
    });

    it('rejects overlong URLs', () => {
      const long = `https://chewy.com/dp/${'a'.repeat(2100)}`;
      const result = validateUrl(long);
      expect(result.ok).toBe(false);
      expect(result.issues).toContain('excessive_length');
    });
  });

  describe('registrableDomain', () => {
    it('derives the registrable domain', () => {
      expect(registrableDomain('www.chewy.com')).toBe('chewy.com');
      expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
      expect(registrableDomain('store.openpetfoodfacts.org')).toBe('openpetfoodfacts.org');
    });
  });

  describe('evaluateRedirect', () => {
    it('allows same-domain redirects', () => {
      const decision = evaluateRedirect(
        'https://chewy.com/dp/1',
        'https://chewy.com/dp/2',
      );
      expect(decision.allowed).toBe(true);
      if (decision.allowed) expect(decision.canonicalUrl).toBe('https://chewy.com/dp/2');
    });

    it('rejects https → http downgrades', () => {
      const decision = evaluateRedirect('https://chewy.com/dp/1', 'http://chewy.com/dp/1');
      expect(decision.allowed).toBe(false);
    });

    it('rejects cross-domain redirects without an allowlist', () => {
      const decision = evaluateRedirect('https://chewy.com/dp/1', 'https://evil.com/dp/1');
      expect(decision.allowed).toBe(false);
    });

    it('allows cross-domain redirects to an explicitly allowed domain', () => {
      const decision = evaluateRedirect(
        'https://chewy.com/dp/1',
        'https://tractorsupply.com/tsc/product/x',
        new Set(['chewy.com', 'tractorsupply.com']),
      );
      expect(decision.allowed).toBe(true);
    });

    it('rejects invalid endpoints', () => {
      expect(evaluateRedirect('not a url', 'https://chewy.com/dp/1').allowed).toBe(false);
      expect(evaluateRedirect('https://chewy.com/dp/1', 'ftp://chewy.com/x').allowed).toBe(false);
    });
  });
});

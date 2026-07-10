import { describe, it, expect } from 'vitest';
import { inspectSnapshot } from '../../server/services/profile-builder/snapshotPreflight';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeHtml(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

function makeJsonLdHtml(html: string): string {
  return html.replace(
    '</head>',
    '<script type="application/ld+json">{"@type":"Product","name":"Test Product","brand":"Acme"}</script></head>',
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('inspectSnapshot', () => {
  // ── Rejection Cases ────────────────────────────────────────────────────

  describe('LOGIN_PAGE_DETECTED', () => {
    it('rejects when login title + password input present + no product signals', () => {
      const html = makeHtml('Login', '<input type="password" name="pwd"><button>Sign In</button>');
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('LOGIN_PAGE_DETECTED');
    });

    it('rejects with sign in title (hyphenated)', () => {
      const html = makeHtml('Sign-In - My Store', '<input type="password"><button>Sign In</button>');
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('LOGIN_PAGE_DETECTED');
    });

    it('continues when login credentials form has product signals', () => {
      const html = makeHtml(
        'Login',
        '<input type="password"><h1 class="product-title">Premium Dog Food</h1><span class="price">$29.99</span>',
      );
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(true);
    });
  });

  describe('ACCESS_DENIED_DETECTED', () => {
    it('rejects when title contains Access Denied', () => {
      const html = makeHtml('Access Denied', '<h1>403 Forbidden</h1><p>You do not have permission</p>');
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('ACCESS_DENIED_DETECTED');
    });

    it('rejects when title contains Forbidden', () => {
      const html = makeHtml('Forbidden', '<h1>Access Denied</h1>');
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('ACCESS_DENIED_DETECTED');
    });
  });

  describe('CAPTCHA_DETECTED', () => {
    it('rejects when recaptcha iframe present and no product heading', () => {
      const html = makeHtml('Just a moment...', '<iframe src="https://www.recaptcha.net/recaptcha/api2/anchor"></iframe>');
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('CAPTCHA_DETECTED');
    });

    it('rejects when hcaptcha class present and no product signals', () => {
      const html = makeHtml('Verify', '<div class="hcaptcha-container"><div class="h-captcha"></div></div>');
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('CAPTCHA_DETECTED');
    });

    it('continues when captcha script referenced but product content visible', () => {
      const html = makeHtml(
        'Product Name',
        '<h1 class="product-title">Premium Dog Food</h1><script src="https://www.recaptcha.net/recaptcha/api.js"></script>',
      );
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('SNAPSHOT_WARNING');
    });
  });

  describe('ERROR_PAGE_DETECTED', () => {
    it('rejects small body with Internal Server Error', () => {
      const html = makeHtml('500 Error', '<h1>500 Internal Server Error</h1><p>Something went wrong.</p>');
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('ERROR_PAGE_DETECTED');
    });

    it('rejects small body with Service Unavailable', () => {
      const html = makeHtml('Service Unavailable', '<h1>503 Service Temporarily Unavailable</h1>');
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('ERROR_PAGE_DETECTED');
    });

    it('rejects small body with maintenance mode text', () => {
      const html = makeHtml('Maintenance', '<h1>Down for Maintenance</h1><p>We will be back soon.</p>');
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('ERROR_PAGE_DETECTED');
    });
  });

  describe('INSUFFICIENT_CONTENT', () => {
    it('rejects nearly empty HTML with no product signals', () => {
      const html = makeHtml('', '<div>Hi</div>');
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('INSUFFICIENT_CONTENT');
    });

    it('continues when small body has JSON-LD product data', () => {
      const html = makeJsonLdHtml(makeHtml('Loading...', '<div id="app"></div>'));
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('SNAPSHOT_WARNING');
    });

    it('rejects empty HTML', () => {
      const result = inspectSnapshot('');
      expect(result.usable).toBe(false);
      expect(result.reason).toBe('INSUFFICIENT_CONTENT');
    });
  });

  // ── Usable Cases ───────────────────────────────────────────────────────

  describe('normal product pages', () => {
    it('returns usable for a normal product page', () => {
      const html = makeHtml(
        'Premium Dog Food - Acme Pet',
        '<h1 class="product-title">Premium Dog Food</h1><div class="description">A nutritious blend for adult dogs.</div><span class="price">$29.99</span>',
      );
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('returns usable with account login link in nav', () => {
      const html = makeHtml(
        'Premium Dog Food - Acme Pet',
        '<nav><a href="/login">Sign In</a></nav><h1 class="product-title">Premium Dog Food</h1>',
      );
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('SNAPSHOT_WARNING');
    });

    it('returns usable with product JSON-LD but no visible heading', () => {
      const html = makeJsonLdHtml(makeHtml('Product Page', '<div class="gallery"><img src="/img.jpg"/></div>'));
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(true);
    });
  });

  describe('authenticated content', () => {
    it('warns when password input and product content coexist', () => {
      const html = makeHtml(
        'Admin - Product Editor',
        '<input type="password" name="pwd"><h1 class="product-title">Premium Dog Food</h1>',
      );
      const result = inspectSnapshot(html);
      expect(result.usable).toBe(true);
      const hasAuthWarning = result.warnings.some((w) => w.includes('authenticated'));
      expect(hasAuthWarning).toBe(true);
    });
  });
});

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  firstText,
  textList,
  anyMatches,
  isAuthFailurePage,
  isAuthSuccessPage,
  isNoResultPage,
  isLoginPage,
  sameGtin,
  sameOrigin,
  isAllowedHttpsUrl,
  resolveUrl,
  dedupeStrings,
  utf8ByteLength,
} from '../../onboarding/sourcing/html-scraper/html-utils';
import { ORGILL_LOGIN, PET_FOOD_EXPERTS_LOGIN, PHILLIPS_STOREFRONT_LOGIN } from '../../onboarding/sourcing/html-scraper/login-config';

const FIXTURE_HTML = `
<html>
  <body>
    <h1 class="title">E-Z HANG SCALE</h1>
    <div id="cphMainContent_ctl00_lblDescription">KERBL E-Z HANG SCALE</div>
    <ul class="features"><li>Feature One</li><li>Feature Two</li></ul>
    <img class="product" src="https://cdn.example.com/a.jpg" />
    <img class="product" src="https://cdn.example.com/b.jpg" />
    <span data-test="login-error">Bad credentials</span>
    <div class="no-results">No products found</div>
    <dl><dt>UPC</dt><dd>012345678905</dd></dl>
  </body>
</html>
`;

describe('html-scraper pure helpers (offline fixture strings only)', () => {
  test('firstText uses ordered selector fallback (primary wins, fallbacks follow)', () => {
    expect(firstText(FIXTURE_HTML, ['#cphMainContent_ctl00_lblDescription', 'h1'])).toBe('KERBL E-Z HANG SCALE');
    expect(firstText(FIXTURE_HTML, ['h1', '#cphMainContent_ctl00_lblDescription'])).toBe('E-Z HANG SCALE');
    expect(firstText(FIXTURE_HTML, ['.missing', '.also-missing', 'h1'])).toBe('E-Z HANG SCALE');
  });

  test('firstText returns null when nothing matches or values are blank', () => {
    expect(firstText(FIXTURE_HTML, ['.missing', '.also-missing'])).toBeNull();
    expect(firstText('<html><body></body></html>', ['h1'])).toBeNull();
  });

  test('firstText can read attributes (src/href)', () => {
    expect(firstText(FIXTURE_HTML, ['img.product'], 'src')).toBe('https://cdn.example.com/a.jpg');
  });

  test('textList collects all matches in document order', () => {
    expect(textList(FIXTURE_HTML, '.features li')).toEqual(['Feature One', 'Feature Two']);
    expect(textList(FIXTURE_HTML, 'img.product', 'src')).toEqual([
      'https://cdn.example.com/a.jpg',
      'https://cdn.example.com/b.jpg',
    ]);
  });

  test('anyMatches / marker helpers', () => {
    expect(anyMatches(FIXTURE_HTML, ['.no-results'])).toBe(true);
    expect(isNoResultPage(FIXTURE_HTML, ['span.no-results-found', '.no-results'])).toBe(true);
    expect(isNoResultPage(FIXTURE_HTML, ['span.no-results-found'])).toBe(false);
    expect(isAuthFailurePage(FIXTURE_HTML, ["[data-test-selector='signIn_error']", '[data-test="login-error"]'])).toBe(true);
    expect(isAuthSuccessPage(FIXTURE_HTML, ["[data-test-selector='header_userName']", '#btnMyProfile'])).toBe(false);
  });

  test('sameGtin normalizes and requires exact 8-14 digit equality', () => {
    expect(sameGtin('0 12345 67890 5', '012345678905')).toBe(true);
    expect(sameGtin('012345678905', '012345678906')).toBe(false);
    expect(sameGtin('001135', '001135')).toBe(false); // 6 digits is never a GTIN
    expect(sameGtin(null, '012345678905')).toBe(false);
  });

  test('sameOrigin compares parsed origins', () => {
    expect(sameOrigin('https://www.orgill.com/SearchResultN.aspx', 'https://www.orgill.com')).toBe(true);
    expect(sameOrigin('https://www.orgill.com/x', 'https://evil.orgill.com')).toBe(false);
    expect(sameOrigin('not-a-url', 'https://www.orgill.com')).toBe(false);
  });

  test('isAllowedHttpsUrl enforces HTTPS, no userinfo, and host allowlists', () => {
    expect(isAllowedHttpsUrl('https://cdn.example.com/a.jpg', ['cdn.example.com'])).toBe(true);
    expect(isAllowedHttpsUrl('http://cdn.example.com/a.jpg', ['cdn.example.com'])).toBe(false);
    expect(isAllowedHttpsUrl('https://user:pass@cdn.example.com/a.jpg', ['cdn.example.com'])).toBe(false);
    expect(isAllowedHttpsUrl('https://evil.example.com/a.jpg', ['cdn.example.com'])).toBe(false);
    expect(isAllowedHttpsUrl('not-a-url', ['cdn.example.com'])).toBe(false);
  });

  test('resolveUrl resolves relative hrefs against a base and rejects malformed', () => {
    expect(resolveUrl('/products/1', 'https://www.bradleycaldwell.com')).toBe('https://www.bradleycaldwell.com/products/1');
    expect(resolveUrl('https://cdn.example.com/a.jpg', 'https://www.bradleycaldwell.com')).toBe('https://cdn.example.com/a.jpg');
    expect(resolveUrl('http://', 'https://www.bradleycaldwell.com')).toBeNull();
    expect(resolveUrl('https://', 'https://www.bradleycaldwell.com')).toBeNull();
  });

  test('dedupeStrings preserves first-seen order and drops blanks/dupes', () => {
    expect(dedupeStrings(['b', 'a', '', 'b', 'c', ' a '])).toEqual(['b', 'a', 'c']);
  });

  test('utf8ByteLength measures UTF-8 bytes (cap checks)', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('💥')).toBe(4);
  });

  test('isLoginPage detects the recovered login form on real captured login pages', () => {
    const ORGILL_LOGIN_PAGE = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'html-scrapers', 'orgill', 'auth-required.html'), 'utf8');
    const PFX_LOGIN_PAGE = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'html-scrapers', 'pet_food_experts', 'auth-required.html'), 'utf8');
    const PHILLIPS_LOGIN_PAGE = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'html-scrapers', 'phillips_storefront', 'auth-required.html'), 'utf8');

    // orgill: parsed DOM selectors.
    expect(isLoginPage(ORGILL_LOGIN_PAGE, ORGILL_LOGIN)).toBe(true);
    // pfx: parsed DOM selectors in the rendered React app.
    expect(isLoginPage(PFX_LOGIN_PAGE, PET_FOOD_EXPERTS_LOGIN)).toBe(true);
    // phillips: script-wrapped SFCC template — caught via the raw serialized
    // markup fallback (`id="emailField"` / `id="send2Dsk"`), not DOM selectors.
    expect(isLoginPage(PHILLIPS_LOGIN_PAGE, PHILLIPS_STOREFRONT_LOGIN)).toBe(true);
  });

  test('isLoginPage is false on ordinary product/search pages', () => {
    expect(isLoginPage('<html><body><h1>E-Z HANG SCALE</h1><div>UPC 018653299524</div></body></html>', ORGILL_LOGIN)).toBe(false);
    expect(isLoginPage('<html><body><h1>Wellness CORE</h1></body></html>', PET_FOOD_EXPERTS_LOGIN)).toBe(false);
    expect(isLoginPage('<html><body><div class="product-list">Fromm Gold</div></body></html>', PHILLIPS_STOREFRONT_LOGIN)).toBe(false);
  });

  test('isLoginPage is false on a non-login page that merely mentions a failure class in text', () => {
    expect(isLoginPage('<html><body><p>Please contact support at login-error@example.com</p></body></html>', ORGILL_LOGIN)).toBe(false);
  });
});

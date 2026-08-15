import { describe, test, expect } from 'vitest';
import {
  ORGILL_LOGIN,
  PHILLIPS_STOREFRONT_LOGIN,
  PET_FOOD_EXPERTS_LOGIN,
  LOGIN_CONFIG_BY_PROVIDER,
} from '../../onboarding/sourcing/html-scraper/login-config';
import {
  HTML_SCRAPER_CEILINGS,
  parseHtmlScraperConnectionConfig,
  redactHtmlScraperEvent,
} from '../../onboarding/sourcing/html-scraper/contracts';

describe('html_scraper login automation configs (port of BayState auth.py)', () => {
  test('orgill login config matches the recovered constants', () => {
    expect(ORGILL_LOGIN.loginUrl).toBe('https://www.orgill.com/index.aspx?tab=8');
    expect(ORGILL_LOGIN.usernameSelectors).toEqual(['#cphMainContent_ctl00_loginOrgillxs_UserName']);
    expect(ORGILL_LOGIN.passwordSelectors).toEqual(['#cphMainContent_ctl00_loginOrgillxs_Password']);
    expect(ORGILL_LOGIN.submitSelectors).toEqual(['#cphMainContent_ctl00_loginOrgillxs_LoginButton']);
    expect(ORGILL_LOGIN.successSelectors).toEqual(['#btnMyProfile']);
    // Python-derived failure indicators first, legacy-YAML fallback last.
    expect(ORGILL_LOGIN.failureSelectors).toEqual([
      '#cphMainContent_ctl00_loginOrgillxs_FailureText',
      '.validation-summary-errors',
      '.login-error',
    ]);
    expect(ORGILL_LOGIN.timeoutMs).toBe(60_000);
  });

  test('phillips_storefront login config matches the recovered constants', () => {
    expect(PHILLIPS_STOREFRONT_LOGIN.loginUrl).toBe('https://shop.phillipspet.com/ccrz__CCSiteLogin');
    expect(PHILLIPS_STOREFRONT_LOGIN.usernameSelectors).toEqual(['#emailField']);
    expect(PHILLIPS_STOREFRONT_LOGIN.passwordSelectors).toEqual(['#passwordField']);
    expect(PHILLIPS_STOREFRONT_LOGIN.submitSelectors).toEqual(['#send2Dsk']);
    expect(PHILLIPS_STOREFRONT_LOGIN.successSelectors).toEqual(['a.doLogout.cc_do_logout']);
    expect(PHILLIPS_STOREFRONT_LOGIN.failureSelectors).toEqual([
      '.cc-error-message',
      '.login-error',
      '.sfdc_notificationToastMessage',
    ]);
    expect(PHILLIPS_STOREFRONT_LOGIN.timeoutMs).toBe(60_000);
  });

  test('pet_food_experts login config matches the recovered constants', () => {
    expect(PET_FOOD_EXPERTS_LOGIN.loginUrl).toBe('https://orders.petfoodexperts.com/SignIn');
    expect(PET_FOOD_EXPERTS_LOGIN.usernameSelectors).toEqual(['#userName']);
    expect(PET_FOOD_EXPERTS_LOGIN.passwordSelectors).toEqual(['#password']);
    expect(PET_FOOD_EXPERTS_LOGIN.submitSelectors).toEqual(["button[data-test-selector='signIn_submit']"]);
    expect(PET_FOOD_EXPERTS_LOGIN.successSelectors).toEqual(["[data-test-selector='header_userName']"]);
    expect(PET_FOOD_EXPERTS_LOGIN.failureSelectors).toEqual([
      "[data-test-selector='signIn_error']",
      '.validation-summary-errors',
      '.login-error',
    ]);
    expect(PET_FOOD_EXPERTS_LOGIN.timeoutMs).toBe(30_000);
  });

  test('registry covers exactly the three authenticated providers', () => {
    expect(Object.keys(LOGIN_CONFIG_BY_PROVIDER).sort()).toEqual([
      'orgill',
      'pet_food_experts',
      'phillips_storefront',
    ]);
    // Public providers have no login config.
    expect(LOGIN_CONFIG_BY_PROVIDER.bradley).toBeUndefined();
    expect(LOGIN_CONFIG_BY_PROVIDER.central_pet).toBeUndefined();
  });
});

describe('html_scraper strict connection config (no runtime overrides)', () => {
  test('empty config is valid (everything code-fixed)', () => {
    expect(parseHtmlScraperConnectionConfig({})).toEqual({});
  });

  test('bounded operational reductions below ceilings are accepted', () => {
    const parsed = parseHtmlScraperConnectionConfig({ requestsPerMinute: 3, requestTimeoutMs: 10_000, responseCapBytes: 1024 * 1024 });
    expect(parsed).toEqual({ requestsPerMinute: 3, requestTimeoutMs: 10_000, responseCapBytes: 1024 * 1024 });
  });

  test('values above code-owned ceilings are rejected', () => {
    expect(parseHtmlScraperConnectionConfig({ requestsPerMinute: 99 })).toBeNull();
    expect(parseHtmlScraperConnectionConfig({ requestTimeoutMs: 300_000 })).toBeNull();
    expect(parseHtmlScraperConnectionConfig({ responseCapBytes: 50 * 1024 * 1024 })).toBeNull();
  });

  test('selectors, login URLs, origins, proxies, headers, and cookies are rejected', () => {
    expect(parseHtmlScraperConnectionConfig({ selectors: { name: 'h1' } })).toBeNull();
    expect(parseHtmlScraperConnectionConfig({ loginUrl: 'https://evil.example.com' })).toBeNull();
    expect(parseHtmlScraperConnectionConfig({ navigationOrigin: 'https://evil.example.com' })).toBeNull();
    expect(parseHtmlScraperConnectionConfig({ proxy: { url: 'http://proxy:8080' } })).toBeNull();
    expect(parseHtmlScraperConnectionConfig({ headers: { Cookie: 'a=b' } })).toBeNull();
    expect(parseHtmlScraperConnectionConfig({ cookies: { a: 'b' } })).toBeNull();
  });

  test('non-object / unknown keys fail closed', () => {
    expect(parseHtmlScraperConnectionConfig(null)).toBeNull();
    expect(parseHtmlScraperConnectionConfig('nope')).toBeNull();
    expect(parseHtmlScraperConnectionConfig({ anything: true })).toBeNull();
  });

  test('ceilings match the v1 contract', () => {
    expect(HTML_SCRAPER_CEILINGS.responseCapBytes).toBe(6 * 1024 * 1024);
    expect(HTML_SCRAPER_CEILINGS.sessionTtlMs).toBe(15 * 60 * 1000);
    expect(HTML_SCRAPER_CEILINGS.retryCount).toBe(1);
    expect(HTML_SCRAPER_CEILINGS.publicRequestsPerMinute).toBe(12);
    expect(HTML_SCRAPER_CEILINGS.authRequestsPerMinute).toBe(6);
  });
});

describe('html_scraper event redaction', () => {
  test('credential-shaped and cookie-shaped text is redacted', () => {
    expect(redactHtmlScraperEvent({ message: 'password=sup3rSecret hit the wall' })).not.toContain('sup3rSecret');
    expect(redactHtmlScraperEvent({ message: 'Cookie: PHPSESSID=abc123' })).not.toContain('PHPSESSID=abc123');
    expect(redactHtmlScraperEvent({ message: 'x-api-key=deadbeef' })).not.toContain('deadbeef');
    expect(redactHtmlScraperEvent({ message: 'no secrets here' })).toContain('no secrets here');
  });
});

import type { LoginAutomationConfig } from './contracts';

/**
 * Recovered login automation configs (ADR 0014 Amendment B, M2).
 *
 * Primary authority: BayState `apps/scraper/scrapers/approved_sources/auth.py`
 * (`ORGILL_LOGIN`, `PHILLIPS_LOGIN`, `PFE_LOGIN`). Legacy YAML failure
 * indicators come from the deleted `legacy-scraper-archive` configs
 * (git `5619f6a4^`) as ORDERED FALLBACKS appended after the Python-derived
 * indicators.
 *
 * Selectors, login URLs, and flows are code-fixed — there is no runtime
 * override surface (see `HtmlScraperConnectionConfigSchema`).
 */

export const ORGILL_LOGIN: LoginAutomationConfig = {
  loginUrl: 'https://www.orgill.com/index.aspx?tab=8',
  usernameSelectors: ['#cphMainContent_ctl00_loginOrgillxs_UserName'],
  passwordSelectors: ['#cphMainContent_ctl00_loginOrgillxs_Password'],
  submitSelectors: ['#cphMainContent_ctl00_loginOrgillxs_LoginButton'],
  successSelectors: ['#btnMyProfile'],
  failureSelectors: [
    '#cphMainContent_ctl00_loginOrgillxs_FailureText',
    '.validation-summary-errors',
    '.login-error', // legacy YAML fallback
  ],
  loginUrlFailureIndicators: ['.login-error'],
  timeoutMs: 60_000,
};

export const PHILLIPS_STOREFRONT_LOGIN: LoginAutomationConfig = {
  loginUrl: 'https://shop.phillipspet.com/ccrz__CCSiteLogin',
  usernameSelectors: ['#emailField'],
  passwordSelectors: ['#passwordField'],
  submitSelectors: ['#send2Dsk'],
  successSelectors: ['a.doLogout.cc_do_logout'],
  failureSelectors: [
    '.cc-error-message',
    '.login-error',
    '.sfdc_notificationToastMessage', // legacy YAML fallback
  ],
  loginUrlFailureIndicators: ['.sfdc_notificationToastMessage'],
  timeoutMs: 60_000,
};

export const PET_FOOD_EXPERTS_LOGIN: LoginAutomationConfig = {
  loginUrl: 'https://orders.petfoodexperts.com/SignIn',
  usernameSelectors: ['#userName'],
  passwordSelectors: ['#password'],
  submitSelectors: ["button[data-test-selector='signIn_submit']"],
  successSelectors: ["[data-test-selector='header_userName']"],
  failureSelectors: [
    "[data-test-selector='signIn_error']",
    '.validation-summary-errors', // legacy YAML fallback
    '.login-error', // legacy YAML fallback
  ],
  loginUrlFailureIndicators: ["[data-test-selector='signIn_error']"],
  timeoutMs: 30_000,
};

/** Fixed per-provider login automation; providers without a login are absent. */
export const LOGIN_CONFIG_BY_PROVIDER: Readonly<Record<string, LoginAutomationConfig>> = {
  orgill: ORGILL_LOGIN,
  phillips_storefront: PHILLIPS_STOREFRONT_LOGIN,
  pet_food_experts: PET_FOOD_EXPERTS_LOGIN,
};

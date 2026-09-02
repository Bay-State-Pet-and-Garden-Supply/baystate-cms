# Sentinel Security Journal

## 2025-05-18 - IPv4 Encoding SSRF Bypass in IP Classification
**Vulnerability:** The IP classification function `classifyIp()` in `src/shared/ssrf.ts` relied on basic `ip.split('.')` and `Number()` parsing assuming standard 4-part decimal IPv4 notation. Alternate valid IPv4 representations—such as octal notation (`0177.0.0.1`), hexadecimal notation (`0x7f000001`), integer notation (`2130706433`), or shortened multi-part notation (`127.1`)—were either incorrectly converted to decimal or returned `unknown`, bypassing `isPrivateOrLinkLocal()` SSRF checks.
**Learning:** Standard OS/networking resolution libraries and HTTP request engines (like curl/fetch/browsers) automatically parse octal, hex, multi-part, and integer IPv4 representations to internal 32-bit IP values. Naive string-based IP checks that do not parse all valid IPv4 format representations will misclassify private IP targets.
**Prevention:** Always parse IPv4 addresses across all valid part counts and radix formats (octal, hex, decimal integer) into a canonical 32-bit integer before comparing against CIDR ranges or RFC1918/link-local boundaries.

## 2025-05-19 - Timing Attack Vulnerability in Token Comparison
**Vulnerability:** Direct string equality comparisons (`===` / `!==`) were used to validate secret bearer tokens in API middleware and endpoints. String comparison short-circuits on first mismatched character, creating timing side-channels.
**Learning:** Standard string comparisons leak secret prefixes via microsecond response time differences.
**Prevention:** Always use SHA-256 fixed-length hashing and `crypto.timingSafeEqual` (via `timingSafeCompare`) for secret/token verification.

## 2025-05-20 - URL-Normalized IPv6-Mapped IPv4 SSRF Bypass
**Vulnerability:** The WHATWG `URL` parser automatically standardizes IPv6-mapped IPv4 hostnames like `[::ffff:127.0.0.1]` into hex word representation `[::ffff:7f00:1]`. Slicing off `::ffff:` resulted in `7f00:1`, which failed standard IPv4 decimal checks and returned `unknown` in `classifyIp()`, bypassing SSRF validation.
**Learning:** Standard WHATWG URL parsers reformat IPv6-mapped IPv4 addresses to hexadecimal word pairs (`::ffff:7f00:1`). SSRF checks that expect dotted-decimal IPv4 suffixes after `::ffff:` fail on normalized URL hostnames.
**Prevention:** Convert hexadecimal 16-bit word pairs following `::ffff:` into canonical dotted-decimal IPv4 octets before evaluating against private CIDR blocks.

## 2025-05-21 - Non-Shorthand & Unique-Local IPv6 SSRF Bypass in IP Classification
**Vulnerability:** The IP classification helper `classifyIp()` in `src/shared/ssrf.ts` relied on naive string prefix checks (e.g., `lower === '::1'`, `lower.startsWith('fe8')`) to identify IPv6 loopback, link-local, and IPv4-mapped addresses. Alternate IPv6 representations such as non-shorthand zero-padded addresses (`0000:0000:0000:0000:0000:0000:0000:0001` or `0:0:0:0:0:ffff:127.0.0.1`) or unique-local IPv6 ranges (`fc00::/7` like `fc00::1`, `fd00::1`) bypassed these prefix checks and evaluated as `public`, opening SSRF risks.
**Learning:** IPv6 addresses have multiple valid textual representations (zero-padded 4-hex-digit words, `::` zero compression at different positions, zone identifiers, and IPv4-embedded forms). Naive string matching fails to classify valid IPv6 representations.
**Prevention:** Always parse IPv6 strings into canonical 8-element 16-bit numerical arrays before matching against CIDR ranges (`fc00::/7`, `fe80::/10`, `::1/128`, `::/128`, etc.) or extracting embedded IPv4 octets.

## 2025-05-22 - Bracketed IPv6 Hostname SSRF Bypass in Snapshot Worker Route
**Vulnerability:** `isPrivateOrLinkLocalUrl()` in `src/extraction-worker/routes/snapshot.ts` used local string checks against `parsed.hostname`. For IPv6 URLs (e.g., `http://[::1]/`, `http://[fe80::1]/`), `URL.hostname` returns bracketed strings (`[::1]`, `[fe80::1]`). Naive `startsWith('fe80')` or `=== '::1'` checks failed due to the leading `[` character, bypassing private/link-local SSRF filters.
**Learning:** WHATWG `URL.hostname` retains enclosing square brackets for IPv6 hostnames. Custom string comparison logic on hostnames without stripping brackets breaks string-prefix security filters.
**Prevention:** Always delegate URL IP classification to canonical SSRF utilities (`isPrivateOrLinkLocal()`) after stripping bracket wrappers (`hostname.replace(/^\[|\]$/g, '')`).

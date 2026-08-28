# Sentinel Security Journal

## 2025-05-18 - IPv4 Encoding SSRF Bypass in IP Classification
**Vulnerability:** The IP classification function `classifyIp()` in `src/shared/ssrf.ts` relied on basic `ip.split('.')` and `Number()` parsing assuming standard 4-part decimal IPv4 notation. Alternate valid IPv4 representations—such as octal notation (`0177.0.0.1`), hexadecimal notation (`0x7f000001`), integer notation (`2130706433`), or shortened multi-part notation (`127.1`)—were either incorrectly converted to decimal or returned `unknown`, bypassing `isPrivateOrLinkLocal()` SSRF checks.
**Learning:** Standard OS/networking resolution libraries and HTTP request engines (like curl/fetch/browsers) automatically parse octal, hex, multi-part, and integer IPv4 representations to internal 32-bit IP values. Naive string-based IP checks that do not parse all valid IPv4 format representations will misclassify private IP targets.
**Prevention:** Always parse IPv4 addresses across all valid part counts and radix formats (octal, hex, decimal integer) into a canonical 32-bit integer before comparing against CIDR ranges or RFC1918/link-local boundaries.

## 2025-05-19 - Timing Attack Vulnerability in Token Comparison
**Vulnerability:** Direct string equality comparisons (`===` / `!==`) were used to validate secret bearer tokens in API middleware and endpoints. String comparison short-circuits on first mismatched character, creating timing side-channels.
**Learning:** Standard string comparisons leak secret prefixes via microsecond response time differences.
**Prevention:** Always use SHA-256 fixed-length hashing and `crypto.timingSafeEqual` (via `timingSafeCompare`) for secret/token verification.



# Backend Implementation: Unified Domain Config API

## Summary

Created a unified `PUT /api/onboarding/settings/domains/:domain` endpoint that atomically saves extractor profile selectors AND brand associations for a domain in a single transaction. This is the write counterpart to the existing read-only `GET /api/onboarding/settings/domain-diagnostics` endpoint.

## Changed Files

### Created: `src/onboarding/domain-config-service.ts`

New service module containing:
- **`DomainConfigUpsertSchema`** — Zod schema validating the request body:
  - `titleSelector`, `priceSelector`, `descriptionSelector`, `brandSelector`, `imagesSelector`, `sitemapProductUrlPattern` — all `string | null | undefined` (undefined preserves existing value)
  - `brands` — optional array of `{ id?, brandName, urlPattern?, successCount? }` with full-replacement semantics
- **`upsertDomainConfig(domain, data)`** — atomic transaction function that:
  1. Calls `upsertProfile()` from the existing extractor-profile-repo (which already handles undefined=preserve/null=clear semantics)
  2. When `data.brands` is provided, replaces all brand associations: upserts incoming brands, deletes any existing brand_sites for this domain NOT in the array
  3. Returns the updated `DomainDiagnosticsEntry` for the domain

### Modified: `src/server/routes/onboarding-routes.ts`

Added import at line 103 and a new route after the domain-diagnostics GET handler:

```typescript
route.put('/onboarding/settings/domains/:domain', async (c) => { ... })
```

The route:
1. Validates the domain param is present
2. Parses and validates the JSON body against `DomainConfigUpsertSchema`
3. Calls `upsertDomainConfig()` with proper error handling
4. Returns `{ domain: DomainDiagnosticsEntry }` on success
5. Returns `400` for missing domain/body/validation errors, `500` for internal errors

## Validation

- `bun run typecheck` passes with no errors (both old and new files)
- Follows existing patterns: same domain normalization (`toLowerCase().replace(/^www\./, '').trim()`), same Zod validation pattern, same error handling style

## Residual Risks

- **No tests yet** — the function would benefit from a unit test that exercises the transaction rollback and brand replacement logic
- **Fallback entry construction** — the `buildDomainDiagnostics()` fallback path should never be hit in normal operation; if it is, the returned diagnostic entry will have incomplete data

## Endpoint Contract

```
PUT /api/onboarding/settings/domains/:domain
Content-Type: application/json

{
  "titleSelector": "h1.product-title",
  "priceSelector": ".price-current",
  "descriptionSelector": null,
  "brandSelector": null,
  "imagesSelector": null,
  "sitemapProductUrlPattern": null,
  "brands": [
    { "brandName": "AcmeCo", "urlPattern": null },
    { "id": "existing-id", "brandName": "BrandCo", "urlPattern": "/products/", "successCount": 5 }
  ]
}
```

Response `200`:
```json
{
  "domain": {
    "domain": "example.com",
    "hasActiveProfile": true,
    "activeProfileId": "uuid",
    "profileUpdatedAt": "2026-07-02T...",
    "sitemapUrlsCount": 340,
    "sitemapFetchedAt": "2026-07-01T...",
    "sitemapExpiresAt": "2026-07-08T...",
    "sitemapSourceUrl": "https://example.com/sitemap.xml",
    "sitemapStale": false,
    "healthStatus": "ok",
    "healthCheckedAt": "2026-07-02T...",
    "healthReason": null,
    "healthStale": false,
    "brandAssociations": [
      { "id": "uuid", "brandName": "acmeco", "successCount": 1, "lastUsedAt": null }
    ],
    "generationCount": 0,
    "latestGenerationStatus": null,
    "latestGenerationAt": null
  }
}
```

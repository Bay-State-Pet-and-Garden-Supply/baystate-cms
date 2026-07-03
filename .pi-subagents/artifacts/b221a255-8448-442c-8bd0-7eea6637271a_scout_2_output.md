# Code Context: Onboarding Extractor Profile Routes

## Files Retrieved

1. **`src/server/routes/onboarding-routes.ts`** — Full file read. Contains all extractor profile route handlers (GET at line 1016, POST at line 1021, DELETE at line 1040, POST test at line 1046).
2. **`src/client/onboarding-api.ts`** (lines 307–347) — Client-side API functions `getExtractorProfiles`, `saveExtractorProfile`, `deleteExtractorProfile`, `testExtractorProfile`.
3. **`src/db/repositories/extractor-profile-repo.ts`** — Full file. Repository with `ExtractorProfile` interface (already has `sitemapProductUrlPattern`), `upsertProfile` (already supports the field), `listAllProfiles`, `findProfileByDomain`, `deleteProfile`.
4. **`src/shared/schemas/onboarding.ts`** (lines 155–185) — `ExtractorProfileSchema` Zod definition — **missing `sitemapProductUrlPattern`**.
5. **`src/client/components/Onboarding.tsx`** (lines 498–577) — UI calling `saveExtractorProfile`, never passes `sitemapProductUrlPattern`.
6. **`src/client/components/OnboardingSettings.tsx`** (lines 560–610) — Settings listing profiles, table doesn't show `sitemapProductUrlPattern`.
7. **`src/onboarding/source-discovery.ts`** (lines 505–545) — Consumer of `profile.sitemapProductUrlPattern` during sitemap-based discovery.
8. **`src/tests/unit/extractor-profiles.test.ts`** — Full file. Tests confirm `sitemapProductUrlPattern` round-trips correctly at the repo layer.
9. **`src/db/migrations.ts`** (lines 68, 80–85) — DB migration ensures `sitemap_product_url_pattern` column exists.

---

## Key Code

### 1. POST handler — missing `sitemapProductUrlPattern` (onboarding-routes.ts lines 1021–1038)
```typescript
route.post('/onboarding/settings/extractor-profiles', async (c) => {
  try {
    const { domain, titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector } = await c.req.json();
    // ^^^ sitemapProductUrlPattern is NOT destructured
    if (!domain) {
      return c.json({ error: 'domain is required' }, 400);
    }
    const profile = upsertProfile(domain, {
      titleSelector,
      priceSelector,
      descriptionSelector,
      brandSelector,
      imagesSelector,
      // sitemapProductUrlPattern is NEVER passed
    });
    return c.json({ success: true, profile });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
```

### 2. GET handler (onboarding-routes.ts lines 1016–1019)
```typescript
route.get('/onboarding/settings/extractor-profiles', (c) => {
  const profiles = listAllProfiles();
  return c.json({ extractorProfiles: profiles });
});
```
The repo returns `sitemapProductUrlPattern` in each profile, but the client-side Zod type doesn't know about it.

### 3. DELETE handler (onboarding-routes.ts lines 1040–1044)
```typescript
route.delete('/onboarding/settings/extractor-profiles/:id', (c) => {
  const id = c.req.param('id');
  deleteProfile(id);
  return c.json({ success: true });
});
```
Clean. No changes needed.

### 4. POST test handler (onboarding-routes.ts lines 1046–1105)
```typescript
route.post('/onboarding/extractor-profiles/test', async (c) => {
  const { url, titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector } = await c.req.json();
  // ... runs playwright, evaluates CSS selectors, returns extracted values
});
```
Does not need `sitemapProductUrlPattern` — it tests CSS selectors against a specific URL, not sitemap pattern matching.

### 5. Repository `upsertProfile` — already supports the field (extractor-profile-repo.ts lines 67–136)
```typescript
export function upsertProfile(
  domain: string,
  selectors: {
    titleSelector?: string | null;
    priceSelector?: string | null;
    descriptionSelector?: string | null;
    brandSelector?: string | null;
    imagesSelector?: string | null;
    sitemapProductUrlPattern?: string | null;   // ← already present
  },
): ExtractorProfile {
  // ...
  const sSel = resolve(existing?.sitemap_product_url_pattern ?? null, selectors.sitemapProductUrlPattern);
  // ...
}
```
Full merge semantics: `undefined` = preserve existing, `null` = clear, string = replace.

### 6. Shared Zod schema — missing field (onboarding.ts lines 161–174)
```typescript
export const ExtractorProfileSchema = z.object({
  id: z.string(),
  domain: z.string(),
  titleSelector: z.string().nullable().default(null),
  priceSelector: z.string().nullable().default(null),
  descriptionSelector: z.string().nullable().default(null),
  brandSelector: z.string().nullable().default(null),
  imagesSelector: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  // sitemapProductUrlPattern is MISSING
});
```

### 7. Client API type — missing field (onboarding-api.ts lines 311–323)
```typescript
export async function saveExtractorProfile(data: {
  domain: string;
  titleSelector?: string | null;
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
  // sitemapProductUrlPattern is MISSING
}): Promise<{ success: boolean; profile: ExtractorProfile }>
```

---

## Architecture

```
UI (Onboarding.tsx, OnboardingSettings.tsx)
  │  saveExtractorProfile({domain, titleSelector, ...})
  ▼
client/onboarding-api.ts ──HTTP──► server/routes/onboarding-routes.ts
  POST /api/onboarding/settings/extractor-profiles      │
  GET  /api/onboarding/settings/extractor-profiles      │
  DELETE /api/onboarding/settings/extractor-profiles/:id │
  POST /api/onboarding/extractor-profiles/test          │
                                        ▼
                        db/repositories/extractor-profile-repo.ts
                          upsertProfile(), listAllProfiles(), etc.
                                        ▼
                                  SQLite (extractor_profiles table)
                                        ▲
                          source-discovery.ts reads
                          sitemapProductUrlPattern via
                          findProfileByDomain()
```

**Data flow for writes**: HTTP body → route handler destructure → `upsertProfile(domain, selectors)` → SQLite INSERT/UPDATE
**Data flow for reads**: SQLite SELECT → `listAllProfiles()` maps DbProfile→ExtractorProfile → HTTP JSON response

**The gap**: The DB column `sitemap_product_url_pattern` exists, the migration handles it, the repo supports it, and `source-discovery.ts` consumes it — but the POST route handler never passes it through, the shared Zod schema doesn't define it, and the client API type doesn't include it. So the field is effectively invisible to the API while being fully functional at the data layer.

---

## Changes Needed (in order)

### A. Post route handler — add `sitemapProductUrlPattern` (onboarding-routes.ts ~line 1024)
1. Destructure `sitemapProductUrlPattern` alongside the other selectors
2. Pass it to `upsertProfile` in the selectors object

### B. Add PUT route for explicit updates (onboarding-routes.ts, after line 1044)
New route:
```
PUT /api/onboarding/settings/extractor-profiles/:id
```
Body: same fields as POST. Look up the profile by ID, extract its domain, call `upsertProfile(domain, selectors)`. Return the updated profile.

### C. Add field to Zod schema (shared/schemas/onboarding.ts ~line 173)
Add: `sitemapProductUrlPattern: z.string().nullable().default(null),`

### D. Add field to client API type (onboarding-api.ts ~line 311)
Add: `sitemapProductUrlPattern?: string | null`

### E. Optionally update UI components
- `Onboarding.tsx` line ~565: pass `sitemapProductUrlPattern` in the `saveExtractorProfile` call
- `OnboardingSettings.tsx` line ~587: add a column for it in the profiles table
- `GeneratedProfilesPanel.tsx` line ~61: if showing active profile info, consider displaying it

---

## Constraints & Risks

- **undefined vs null semantics**: The repo's `upsertProfile` treats `undefined` as "preserve existing" and `null` as "clear the field". The POST handler must pass through the raw value from the body (which could be `undefined` if omitted, or `null` if explicitly set to null) rather than coercing with `??`.
- **No PUT route currently**: Without a PUT route, the only way to update any field is POST (domain-keyed upsert). Adding a PUT-by-id route provides a clean explicit update path.
- **Backward compatibility for POST**: Adding a new destructured field from the body is backward-compatible; JSON bodies that omit it will yield `undefined`, which triggers the "preserve" semantics at the repo layer. No breaking changes.
- **Test route**: Does not need `sitemapProductUrlPattern` — it's for interactive CSS selector testing, not sitemap configuration.

---

## Start Here

Open **`src/server/routes/onboarding-routes.ts`** and go to line 1021 (the POST handler). This is the primary change point:

1. Add `sitemapProductUrlPattern` to the destructure on line 1024
2. Pass it into `upsertProfile` on line 1029
3. Add the new PUT route after line 1044

Then update **`src/shared/schemas/onboarding.ts`** (line ~173) and **`src/client/onboarding-api.ts`** (line ~311) for type completeness.

---

## Answers to Original Questions

**Q1: What does POST /onboarding/settings/extractor-profiles accept and return?**
- **Accepts**: JSON with `domain` (required), `titleSelector`, `priceSelector`, `descriptionSelector`, `brandSelector`, `imagesSelector` (all optional string|null). Does **not** accept `sitemapProductUrlPattern`.
- **Returns**: `{ success: true, profile: ExtractorProfile }` on success, or `{ error: string }` on failure.

**Q2: What does GET /onboarding/settings/extractor-profiles return?**
- Returns `{ extractorProfiles: ExtractorProfile[] }`. The repo returns `sitemapProductUrlPattern` in each profile object, but the client-side TypeScript type doesn't know about it (Zod schema is incomplete).

**Q3: What does the DELETE route do?**
- `DELETE /onboarding/settings/extractor-profiles/:id` — deletes by ID, returns `{ success: true }` or 404.

**Q4: What does POST /onboarding/extractor-profiles/test do?**
- Accepts `url` (required) + CSS selectors (optional), launches Playwright to evaluate the selectors against the page, returns `{ success: true, extracted: { title?, price?, description?, brand?, images? } }`.

**Q5: Is sitemapProductUrlPattern accepted anywhere?**
- **No.** Not in the POST route handler, not in the client API type, not in the Zod schema. It exists only in the DB, the repo layer, and tests.

**Q6: What changes are needed to add sitemapProductUrlPattern to POST and add a PUT route?**
- See "Changes Needed" section A–D above.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Scouting task completed — all 6 target questions answered. No code changes were made (this is a scouting-only task per the task description)."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "9 files examined, exact line ranges cited, gap analysis documented with specific before/after code, and a recommended implementation order provided."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "grep, find, read across 9 source files and 1 test file",
      "result": "passed",
      "summary": "Full codebase map of extractor-profiles data flow constructed"
    }
  ],
  "validationOutput": [
    "No validation needed — this was a scouting/mapping task, not an implementation task"
  ],
  "residualRisks": [
    "The repo's upsertProfile treats undefined as 'preserve existing' and null as 'clear'. When adding sitemapProductUrlPattern to the POST handler, the raw body value must be passed through without coercion to preserve this semantic.",
    "No PUT route currently exists; adding one requires a new handler with ID→domain resolution and upsertProfile call.",
    "The shared Zod schema and client API type must be updated in sync for TypeScript correctness."
  ],
  "noStagedFiles": true,
  "diffSummary": "No code changes made (scouting-only task). Full analysis delivered.",
  "reviewFindings": [
    "GAP: POST handler at onboarding-routes.ts:1024 does not destructure sitemapProductUrlPattern from request body",
    "GAP: Shared Zod schema ExtractorProfileSchema at onboarding.ts:173 is missing sitemapProductUrlPattern field",
    "GAP: Client API saveExtractorProfile type at onboarding-api.ts:311 is missing the field",
    "MISSING: No PUT route exists for explicit profile updates (only POST upsert-by-domain)"
  ],
  "manualNotes": "The DB column, migration, repository function (upsertProfile), and consumer (source-discovery.ts) already support sitemapProductUrlPattern. Only the API layer (route handler, schema, client type) needs changes to wire it through. The first file to edit is src/server/routes/onboarding-routes.ts."
}
```

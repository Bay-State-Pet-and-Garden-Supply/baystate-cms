# Scout Findings: `src/client/onboarding-api.ts` — Extractor Profile API Map

## 1. `saveExtractorProfile` — Current Signature

**File:** `src/client/onboarding-api.ts` (lines 311–322)

```typescript
export async function saveExtractorProfile(data: {
  domain: string;
  titleSelector?: string | null;
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
}): Promise<{ success: boolean; profile: ExtractorProfile }>
```

**What it sends:** A POST to `/api/onboarding/settings/extractor-profiles` with the above JSON body.

**Missing:** `sitemapProductUrlPattern` is not in the parameter type or the request body.

---

## 2. `getExtractorProfiles`

**File:** `src/client/onboarding-api.ts` (lines 307–309)

```typescript
export async function getExtractorProfiles(): Promise<{ extractorProfiles: ExtractorProfile[] }>
```

**What it sends:** GET `/api/onboarding/settings/extractor-profiles`.

**Note:** The return type `ExtractorProfile` is resolved from `src/shared/schemas/onboarding.ts` (line 173). That schema is **missing** `sitemapProductUrlPattern`. So even though the DB and repo return it, the TypeScript type doesn't know about it.

---

## 3. `deleteExtractorProfile`

**File:** `src/client/onboarding-api.ts` (lines 325–328)

```typescript
export async function deleteExtractorProfile(id: string): Promise<{ success: boolean }>
```

No changes needed. Sends DELETE to `/api/onboarding/settings/extractor-profiles/:id`.

---

## 4. `testExtractorProfile` and `ExtractorTestResult`

**File:** `src/client/onboarding-api.ts` (lines 339–349)

```typescript
export interface ExtractorTestResult {
  title?: string;
  price?: string;
  description?: string;
  brand?: string;
  images?: string[];
}

export async function testExtractorProfile(data: {
  url: string;
  titleSelector?: string | null;
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
}): Promise<{ success: boolean; extracted: ExtractorTestResult }>
```

**Not affected by `sitemapProductUrlPattern`:** This function tests CSS selectors against a live page. The sitemap URL pattern is not a CSS selector and does not fit here.

---

## 5. `sitemapProductUrlPattern` — Current State

| Layer | Has `sitemapProductUrlPattern`? | Details |
|-------|-------------------------------|---------|
| **DB schema** (`src/db/migrations.ts`) | ✅ Column `sitemap_product_url_pattern TEXT` on `extractor_profiles` table (line 68) | Both in CREATE TABLE and ALTER TABLE migration |
| **Repo layer** (`src/db/repositories/extractor-profile-repo.ts`) | ✅ `ExtractorProfile` interface, `DbProfile`, `mapToProfile`, `upsertProfile` all fully handle it | Lines 12, 39, 79, 101, 106, 117, 124, 136 |
| **Shared schema** (`src/shared/schemas/onboarding.ts`) | ❌ **Missing** from `ExtractorProfileSchema` (lines 161–171) | Type doesn't include the field |
| **Client API** (`src/client/onboarding-api.ts`) | ❌ **Missing** from `saveExtractorProfile`'s data param | Never sent to server |
| **Server route** (`src/server/routes/onboarding-routes.ts`) | ❌ **Missing** from POST handler destructuring (line 1023) | Never received from client, never passed to `upsertProfile` |
| **Client UI: Onboarding.tsx** | ❌ Not in `loadSelectorProfileForUrl` (line 511) or `handleSaveSelectorProfile` (line 565) | No state, no field, no save |
| **Client UI: OnboardingSettings.tsx** | ❌ Not in the profiles table (line ~525) | No column for it |
| **Source discovery** (`src/onboarding/source-discovery.ts`) | ✅ Uses `profile?.sitemapProductUrlPattern` (lines 530, 537) | Reads from the repo directly |
| **Unit tests** (`extractor-profiles.test.ts`) | ✅ Tests: default null, round-trip, preserve on partial update, explicit null clear (lines 119–174) | Tests the repo layer directly |
| **DB migration tests** (`db-migration.test.ts`) | ✅ Tests column exists and round-trips (line 450) | |

---

## 6. Changes Required to Add `sitemapProductUrlPattern` Support

### 6a. Shared Schema — `src/shared/schemas/onboarding.ts`

Add the field to `ExtractorProfileSchema` (after line 168, before `createdAt`):

```typescript
sitemapProductUrlPattern: z.string().nullable().default(null),
```

This makes the `ExtractorProfile` type include the field.

### 6b. Server Route — `src/server/routes/onboarding-routes.ts`

In the POST handler (line 1021–1036), add `sitemapProductUrlPattern` to the destructured body (line 1023):

```typescript
const { domain, titleSelector, priceSelector, descriptionSelector, brandSelector, imagesSelector, sitemapProductUrlPattern } = await c.req.json();
```

And pass it to `upsertProfile`:

```typescript
const profile = upsertProfile(domain, {
  titleSelector,
  priceSelector,
  descriptionSelector,
  brandSelector,
  imagesSelector,
  sitemapProductUrlPattern,
});
```

### 6c. Client API — `src/client/onboarding-api.ts`

Add `sitemapProductUrlPattern` to the `saveExtractorProfile` data type (line 311–322):

```typescript
export async function saveExtractorProfile(data: {
  domain: string;
  titleSelector?: string | null;
  priceSelector?: string | null;
  descriptionSelector?: string | null;
  brandSelector?: string | null;
  imagesSelector?: string | null;
  sitemapProductUrlPattern?: string | null;   // ← ADD
}): Promise<{ success: boolean; profile: ExtractorProfile }>
```

### 6d. Client UI — `src/client/components/Onboarding.tsx`

In `loadSelectorProfileForUrl` (line ~507), add after the existing selector state sets:

```typescript
setSitemapProductUrlPattern(profile.sitemapProductUrlPattern || '');
```

In `handleSaveSelectorProfile` (line ~565), pass the new field:

```typescript
await saveExtractorProfile({
  domain,
  titleSelector: titleSelector || null,
  priceSelector: priceSelector || null,
  descriptionSelector: descriptionSelector || null,
  brandSelector: brandSelector || null,
  imagesSelector: imagesSelector || null,
  sitemapProductUrlPattern: sitemapProductUrlPattern || null,
});
```

Also add a UI input field for the sitemap URL pattern in the selector test/save panel (likely near the `handleTestSelectors` / `handleSaveSelectorProfile` call site).

### 6e. Client UI — `src/client/components/OnboardingSettings.tsx`

Add a column for the sitemap URL pattern in the Custom Extractor Profiles table (around line ~525), after the Images column:

```tsx
<th style={styles.th}>Sitemap Pattern</th>
```

And in the body:

```tsx
<td style={styles.td}><code style={{ fontSize: 12 }}>{prof.sitemapProductUrlPattern || '—'}</code></td>
```

---

## Architecture: Data Flow

```
Client (onboarding-api.ts) ──HTTP──> Server Route (onboarding-routes.ts) ──> Repo (extractor-profile-repo.ts) ──> SQLite DB

  saveExtractorProfile(data)         upsertProfile(domain, selectors)        INSERT/UPDATE extractor_profiles
  getExtractorProfiles()            listAllProfiles()                        SELECT * FROM extractor_profiles
  deleteExtractorProfile(id)         deleteProfile(id)                       DELETE FROM extractor_profiles

  Source discovery reads profiles directly from repo (findProfileByDomain)
  and uses sitemapProductUrlPattern to filter sitemap URLs.
```

The gap is in the **HTTP layer**: the server route handler never destructures `sitemapProductUrlPattern` from the POST body, and the client API never sends it. The repo and DB already fully support it.

---

## Start Here

Open **`src/server/routes/onboarding-routes.ts`** line ~1021 (the POST handler for `/onboarding/settings/extractor-profiles`). This is where the server currently drops `sitemapProductUrlPattern` on the floor. Adding it here unblocks the rest of the client-side changes.

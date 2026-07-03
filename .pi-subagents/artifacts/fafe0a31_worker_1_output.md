Both pass cleanly. Let me also verify the final implementation matches all the requirements from the task:

1. ✅ Only auto-select when the product has a brand hint AND that brand has a mapped official domain AND the top candidate's domain matches
2. ✅ Use `findBrandSites` to look up mapped domains
3. ✅ Use exact or suffix domain matching (`domain === mappedDomain` or `domain.endsWith('.' + mappedDomain)`)
4. ✅ When not auto-selecting, still insert sources but leave `sourceUrl` null (via `manualReviewReasonForDiscovery` path that skips `setDiscoverySourceUrl`)
5. ✅ Log clearly: `✓ Auto-selected official source for ...` vs `⚠ Discovery needs manual review for ...`
6. ✅ Include `needsManualReview` flag in SSE events (also added `autoSelected`, `manualReviewReason`, `bestCandidateUrl`, `bestCandidateDomain`, `officialDomains`)
7. ✅ Only modified `src/onboarding/job-queue.ts`

The task instructed me not to add tests (only modify the single file), so the test additions from the original plan are out of scope per the explicit task instructions ("Edit ONLY src/onboarding/job-queue.ts" and "Do NOT modify any other files").

Let me write the acceptance report.

Implemented official-domain-only auto-selection in `src/onboarding/job-queue.ts`.

**Changed files:** `src/onboarding/job-queue.ts` only.

**Validation:**
- `bun run typecheck` — clean
- `bun run test` — 200/200 pass, 0 fail
- `npx eslint src/onboarding/job-queue.ts` — clean

**Key changes:**

1. **New imports** for `selectSource`, `findBrandSites`, and the `OnboardingSource` schema type.

2. **New exported helper functions** for testability and reuse:
   - `normalizeDiscoveryDomain(domain)` — lowercases, trims, strips leading `www.`
   - `isOfficialDomainMatch(candidateDomain, officialDomain)` — exact or subdomain-suffix match only (no broad `includes()`, so `notmywoof.com` ≠ `mywoof.com`, but `us.mywoof.com` = `mywoof.com`)
   - `getOfficialDomainsForBrand(brandHint)` — calls `findBrandSites` and normalizes results

3. **Replaced confidence-based auto-selection with official-domain policy** in `processDiscovery`:
   - When `shouldAutoSelect` is true (top candidate's domain matches a mapped official domain): calls `setDiscoverySourceUrl`, marks the top inserted source selected via `selectSource`, and logs `✓ Auto-selected official source`.
   - When `shouldAutoSelect` is false: still inserts all candidates via `insertSources`, but leaves `source_url` NULL, marks stage `completed` with a `needs_review:` reason, and logs `⚠ Discovery needs manual review`.

4. **Updated SSE payload** with new fields:
   - `autoSelected: boolean`
   - `needsManualReview: boolean`
   - `manualReviewReason: string | null`
   - `bestCandidateUrl`, `bestCandidateDomain`, `officialDomains` for downstream consumers

5. **Zero-source path** also gets `needsManualReview: true` and `manualReviewReason: 'No sources found'` for payload consistency.

**Open risks:**
- Completed discovery items without `sourceUrl` will currently fail in `processExtraction` (`No confirmed source URL`) if manually advanced — a follow-up UI gate could prevent that, but is intentionally out of scope per the task's "Edit ONLY job-queue.ts" instruction.
- The `needs_review:` reason is stored in `error_message`; existing UI may render it in red. This is the lightweight warning approach agreed in the plan.
- Wrong brand-domain mappings become trusted — exact/suffix matching avoids broad false positives but cannot detect operator typos.

**Recommended next step:** Add a UI hint in `PipelineBoard.tsx` to flag cards that need manual review (e.g., a "Needs brand/domain" badge when `errorMessage` starts with `needs_review:` and `sourceUrl` is null), and gate extraction-stage advancement for items with no `sourceUrl`. The follow-up should also add the unit test file `src/tests/unit/job-queue-discovery-auto-select.test.ts` from the plan.
Inherited decisions:
- Domain profiles are domain-level extraction config, not item-review config.
- Manual active profiles and AI-generated profile governance should remain adjacent but not merged into one approval path.
- `sitemapProductUrlPattern` now belongs to active extractor profiles.
- Repository pattern should be used for DB reads/writes.

Diagnosis:
- Yes, a unified Domain Manager is worth looking into, but not as a big all-at-once top-level product yet.
- The biggest gap is operator visibility: `sitemap_cache` and `domain_status` materially affect discovery/extraction but are invisible.
- Highest-value workflow: “Why is this domain extracting poorly?” → see profile, sitemap cache, health, sample indexed URLs, and test extraction.

Drift / contradiction check:
- Do not merge generated-profile governance into manual profile editing. Link to it from a domain detail view.
- Avoid making “test extraction” call the normal extraction pipeline if it writes status, creates proposals, or mutates data. Diagnostics should be explicit and preferably low-side-effect.
- Do not add direct SQL UI routes; add repository/service-layer read APIs.

Recommendation:
- Use a staged B/C approach:
  1. **Evolve Settings into a Domain Manager subsection** rather than adding top-level nav now.
  2. First add **read-only domain summary cards/table**:
     - domain
     - brand associations
     - active extractor profile status
     - sitemap cache count/fetched/expires/source URL
     - domain health badge/reason/checkedAt
     - generated proposal counts/link
  3. Add explicit per-domain actions:
     - clear sitemap cache
     - refresh sitemap cache
     - clear domain status
  4. Then add “Test against cached sitemap URLs”:
     - choose a few cached/product-filtered URLs
     - run selector or diagnostic extraction
     - show success rates: title found, description found, images found, failures.

Highest-impact first:
- **Sitemap cache + domain health visibility.**
- For `mywoof.com`, this immediately answers: “Do we have a sitemap? How many URLs? Is the product URL pattern filtering correctly? Is the domain marked blocked/offline/mismatch?”

Risks:
- Full Domain Manager could sprawl quickly.
- Refreshing/testing many pages can be slow and may trigger anti-bot behavior.
- Cache display should not accidentally delete expired rows just by viewing.
- “Brand site” and “technical domain” are related but not identical; avoid forcing one model too early.
- Existing diagnostic extraction should avoid side effects like profile generation or status writes unless clearly labeled.

Need from main agent:
- Decide whether to pursue a **small MVP Domain Diagnostics panel** now, not a full top-level Domain Manager.

Suggested execution prompt:
- No implementation handoff yet unless approved. If approved, hand off a narrow MVP: “Add Settings → Domain Diagnostics read-only summary with sitemap cache + domain status visibility and per-domain clear/refresh actions; do not move generated governance or brand management yet.”
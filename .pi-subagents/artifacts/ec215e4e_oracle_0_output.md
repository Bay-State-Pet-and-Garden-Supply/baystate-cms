Inherited decisions:
- Discovery now always runs UPC search + consolidated-name search.
- Consolidated name is important and shown in the drawer.
- Brand domains are currently optional but boost/search-scope discovery.
- The real user pain is bad **auto-selected retailer URLs**, not simply that discovery runs.

Diagnosis:
- A hard gate would likely create too much friction, especially for large spreadsheet uploads with missing brand hints.
- It would also block useful discovery signals: UPC results and consolidated names can help the user identify the right brand/domain.
- The bigger issue is trust/automation: open-web discovery should not be treated as equally trustworthy as mapped official-domain discovery.

Drift / contradiction check:
- Hard-blocking discovery unless a mapped official domain exists conflicts with the recent refinement that made consolidated-name open search mandatory.
- It also assumes every product has a usable official product page, which is false for small brands, discontinued products, distributors, private-label goods, and retailer-exclusive items.

Recommendation:
- **Do not enforce a global hard gate by default.**
- Use a middle-ground policy:

1. **Discovery may still run without brand/domain**, but results are marked “open web / manual confirmation required.”
2. **Auto-selection should require stronger trust**:
   - If a mapped brand domain exists, only auto-select when the best result matches that official domain.
   - If no mapped domain exists, insert candidates but do **not** auto-select a source URL.
3. Add optional strict mode:
   - “Require mapped official domain before discovery”
   - Useful for cost control or official-source-only workflows, but not the default.
4. Add bypasses:
   - Per-item/batch “run anyway”
   - Brand-level “no official domain / retailer source acceptable”
5. UX should not silently skip:
   - Show cards as “Needs brand/domain” or “Open web results — manual review required.”
   - Batch upload should surface an “Unmapped brands” preflight panel with bulk domain assignment.

Implementation implications:
- Do **not** put the hard gate inside `source-discovery.ts`; keep that function capable of open-web discovery.
- Put policy in the worker / onboarding orchestration layer.
- Tighten the current auto-select condition in `job-queue.ts`.
- Use exact/suffix domain matching for official-domain checks, not broad `includes()` matching.
- If adding a real `blocked` status, update the Zod schema, migration, board styling, and stage advancement logic.

Risks:
- Without a hard gate, users can still manually pick retailer pages.
- With a hard gate, many batches may stall.
- Wrong brand-domain mappings could become more damaging if trusted too strongly.

Need from main agent:
- Decide whether to implement the recommended default: **open discovery allowed, but no auto-selection unless official-domain trusted**.
- Decide whether to add a real `blocked` / `needs_input` status or use a lighter warning/no-sourceUrl approach first.

Suggested execution prompt:
- No implementation handoff is warranted until that policy decision is made.
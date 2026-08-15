# Onboarding Operating Model — Store Manager Guide

This guide describes how a Store Manager operates product onboarding under the
operator-facing model adopted by [ADR 0016](adr/0016-onboarding-operating-model.md)
(epic #46). It is the human-facing counterpart to the internal six-stage
execution pipeline (Sourcing → Discovery → Extraction → Curation → Review →
Promotion), which remains the diagnostics/admin truth.

> **Core principle:** automation owns progression; the Store Manager owns
> exceptions, final verification, and release decisions.

The Store Manager manages **exceptions and quality**, not pipeline mechanics.

## Target operating workflow

```
Upload
  ↓
Distributor Lookup
  ↓
Official Site fallback when needed
  ↓
Extraction
  ↓
Family Readiness Barrier
  ↓
Cohort Curation
  ↓
Final Review
  ↓
Bulk Approval
  ↓
Ready to Export
```

1. **Upload** — import a spreadsheet of SKUs (hundreds in one sitting is
   expected).
2. **Distributor Lookup** — the system checks configured distributor sources
   first. An exact/acceptable match with sufficient product data becomes a
   complete listing source; the official site is never visited for it.
3. **Official Site fallback** — only products without usable distributor data
   are searched on the official manufacturer site. This is the largest
   human-intervention area (wrong size/variant SERP hits, multi-variant pages,
   missing extraction profiles).
4. **Extraction** — product data is extracted automatically (from distributor
   records or official pages).
5. **Family Readiness Barrier** — every active family member must finish
   extraction before the family may be curated. No "curate the available 3 of
   4" default; incomplete families wait.
6. **Cohort Curation** — once the family is ready, Curation runs automatically
   as a cohort, synthesizing store-ready titles, product types, attributes,
   and Category Page proposals.
7. **Final Review** — every product is inspected by a human before it may be
   approved. Review is fast and sequential ("Looks Good & Next").
8. **Bulk Approval** — the Store Manager approves the reviewed selection in
   bulk. Approval is a release decision; it does **not** export or publish.
9. **Ready to Export** — approved products sit in a Ready to Export queue until
   the Store Manager runs the export action separately.

## The batch workspace

The batch workspace replaces the six-column Kanban as the primary operating
view. It is organized around operator meaning, not pipeline stage:

| View | Meaning | Primary human action |
| --- | --- | --- |
| **Processing** | Products being handled automatically (distributor lookup, materialization, official-site search, extraction, Curation running) | none — visibility only |
| **Needs Attention** | Products where automation cannot safely continue (URL verification, no URL found, multiple variants, missing/failed extraction profile, source conflict, processing failure) | resolve the blocker |
| **Waiting on Family** | Products whose own evidence is ready but whose family cannot start Curation because siblings are incomplete or blocked | none from this view (link to the blocking sibling) |
| **Ready for Review** | Products with completed Curation output awaiting final inspection | review every product |
| **Approved / Ready to Export** | Reviewed products that received the bulk approval decision; drafts/export pending | export/release when desired |

Every product has exactly one current operator work-state, and Needs Attention
is the most prominent queue while processing is active.

## Terminology

Human-facing vocabulary describes tasks and outcomes:

| Internal stage | Human-facing term |
| --- | --- |
| Sourcing | Distributor Lookup |
| Discovery | Official Site Search / Verify Product Page |
| Extraction | Extracting Product Data |
| Curation | Curating Product Family |
| Review | Review |
| Promotion | Approved / Ready to Export / Exporting |

Internal enum names do not change. Raw technical state (stage, stage_status,
worker terminology) remains available in secondary diagnostics only.

## Exception workflows

### 1. Official Site resolution (one continuous task)

URL verification and extraction-profile setup are one workflow:

```
Candidate official product page found
        ↓
Is this the correct product / variant?
        ├─ No → choose/search another URL
        └─ Yes
             ↓
Does this domain have a usable extractor profile?
        ├─ Yes → resume automatic extraction
        └─ No → setup/fix extractor profile
                         ↓
               retry affected domain items
```

- The product identity panel is always visible: imported name, UPC/GTIN,
  Brand, size/variant hints, distributor evidence summary, family context.
- The candidate panel shows why a URL was selected, detected variant
  information, and alternatives.
- A confirmed URL is persisted before extraction resumes; a bad candidate URL
  can be replaced.
- A successful profile fix automatically unblocks other blocked products on
  the same domain where safe, and reports how many items were released.

### 2. Distributor-first handling

```
Upload item
   ↓
Distributor lookup(s)
   ↓
Exact/acceptable record found?
   ├─ yes → sufficient listing evidence?
   │          ├─ yes → materialize distributor data → family barrier
   │          └─ no  → official-site fallback
   └─ no → official-site fallback
```

- Clean distributor-sourced products never require an official URL or operator
  review before Curation.
- Insufficient distributor data falls back to the official site automatically.
- Source conflicts surface as Needs Attention tasks only when human judgment
  is actually required.
- The UI shows whether final listing evidence came from distributor records,
  official page extraction, or a supported combination.

### 3. Waiting on Family

A family whose members are not all extraction-ready shows readiness counts
(example: "3 / 5 products ready — waiting on: 30 lb — official product page
needs verification"). Waiting families require no manual Curation-start click;
once every active member is ready, cohort Curation runs automatically.

## Rapid final review

- Review is the primary intentional QA step. **Every** product is reviewed.
- A dense queue/table plus a persistent inspector replaces the single-column
  stage drawer.
- Primary action: **Looks Good & Next** — marks the product reviewed and opens
  the next unreviewed item.
- Keyboard navigation (previous/next, Esc, review shortcut) keeps sequential
  review practical for hundreds of items.
- Progress is explicit: `Reviewed 184 / 212`.
- Editing a reviewed product invalidates review when the edited field affects
  approved output.

## Bulk approval

- Unreviewed products cannot be bulk-approved through the normal path.
- Items with blocking semantic/review errors cannot be approved.
- Approval reports exact success/failure counts; partial failures are visible
  and retryable; approval is auditable (actor/time/output version).
- Approval does **not** automatically export.

## Ready to Export

- Approved products appear under Ready to Export, showing what is approved,
  what has been exported, what the export action will do, and any export
  blockers/failures with retry.
- Language matches the actual side effect (e.g. "creates ShopSite drafts");
  a product is never called `published` or `exported` until the underlying
  operation has succeeded and been verified.

## Target operator session

```
1. Store Manager uploads 300 new SKUs.

2. System begins automatically:
   - distributor lookup
   - official-site fallback where needed
   - extraction
   - cohort formation/readiness

3. Store Manager sees:
   Processing         267
   Needs Attention     21
   Waiting on Family   12
   Ready for Review     0

4. Manager opens Needs Attention:
   - confirms several variant URLs
   - fixes/creates extractor profiles for a few domains
   - resolves the actual blockers

5. Automation resumes affected products automatically.

6. Complete families automatically run Curation.

7. Batch eventually shows 300 Ready for Review.

8. Manager opens Review and works sequentially:
   - inspect → Looks Good & Next → inspect → Looks Good & Next → edit when required

9. Review progress reaches 300 / 300.

10. Manager bulk-approves reviewed products.

11. Products appear under Ready to Export.

12. Manager exports/releases them when operationally appropriate.
```

The desired experience is not "move 300 cards through six columns." It is:

> **Let the system do the work, show me exactly where it needs me, let me
> verify the results quickly, then let me approve and release them in bulk.**

## Product success criteria

- The majority of clean products require **zero** manual interaction before
  Review.
- Distributor-complete products do not incur unnecessary official-site work.
- Users can immediately identify the small set of blocking products.
- No family begins Curation before required active siblings are ready.
- Every product receives a final human review.
- Reviewing hundreds of products is practical through rapid sequential
  navigation.
- Approval is bulk-efficient.
- Approval and export state are never conflated.

## Observability

Track at batch and global level (implemented by the onboarding telemetry
surface): automation completion rate, items needing attention (by reason),
attention resolution time, products completed from distributor-only,
products requiring official site, extractor-profile block rate and domain
unblock count, families waiting count and wait duration, cohort Curation
success rate, products ready for review, review throughput
(products per minute) and edit rate, bulk approval success rate, and export
success rate.

## Recommendation: **C. Hybrid — compact inline summary + slide-out drawer**

Do **not** keep the full review inside the accordion. The accordion should only show a small domain-level summary and buttons like **Generate Proposal** / **Review Proposal**.

Open a **wide slide-out drawer** for actual profile building/review. That drawer should reuse `ProfileGenerationReview` and `ProfileFieldValidationTable`, because they already support validation rows, warnings, approvals, and image previews.

### Why this is the right fit

- The accordion is too cramped for image review.
- A normal modal may still feel cramped for thumbnails and field-by-field validation.
- A dedicated page is probably too much navigation overhead right now.
- A drawer preserves domain context but gives enough space for:
  - full extracted values
  - image thumbnail grids
  - active vs proposed comparison
  - validation history
  - per-field approval/rejection
  - refinement feedback

### UX shape

Inside the domain accordion:

- Active profile summary
- Latest AI proposal summary
- Buttons:
  - **Generate Proposal**
  - **Review Proposal**

Inside the drawer:

1. Product URL input: **Validate this product URL**
2. Run active profile and proposed profile against that one URL
3. Show side-by-side extracted results:
   - title
   - price
   - description
   - brand
   - image thumbnails
4. Persist that run as validation evidence
5. Show validation runs one at a time, visibly
6. Allow per-field approve/reject
7. Keep image approval locked until:
   - 2 distinct validation URLs have passed
   - image previews were reviewed

### Important correction

The inline accordion should **not** have Approve/Reject buttons. Approval should happen only where the operator can see full extracted results and image thumbnails.
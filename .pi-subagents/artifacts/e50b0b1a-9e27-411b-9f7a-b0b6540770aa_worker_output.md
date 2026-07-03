Typecheck passes with zero errors. No existing files were modified. Let me provide the structured acceptance report.

**Implemented:** `src/client/components/ProfileBuilderWorkspace.tsx`

**Summary:**
- Full-page modal overlay (not a drawer) for domain-first profile building
- Four tabs: Overview, Snapshot, Proposals, Validation
- **Overview tab**: domain header with health badge, worker health indicator (colored dot + version), confirmed-sample count, active profile selectors table, quick actions (generate proposal, snapshot page, validate)
- **Snapshot tab**: URL input (pre-filled from `seedSampleUrl`), runtime toggle (static/rendered), checkboxes for screenshot/network capture, results panel with JSON-LD expandable list, image candidates as thumbnail grid (reusing `ImagePreviewGrid`), page structure signal pills, screenshot placeholder (file path text), warnings
- **Proposals tab**: list of generations sorted by date, status badges with confidence/date/source URL, "Generate New Proposal" button, embedded `<ProfileGenerationReview>` when a generation is selected
- **Validation tab**: summary cards (total/confirmed/passing/failing), "Run Validation Across Samples" button calling `validateProfileDraft`, per-sample results table with field statuses, image previews section, **Promote to healthy gate** with checklist (≥2 passing, image previews reviewed, no failing titles) and promote button calling `approveRevisionFields`
- Follows existing inline styles patterns, `domainHealthBadgeStyle` matching `OnboardingSettings`
- All API calls use existing functions from `onboarding-api.ts`
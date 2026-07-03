File structure looks correct. Everything compiles and the bottom panel is gone. Let me deliver the acceptance report.

---

## Acceptance Report

**Task A**: Removed the "Generated Profile Governance" section (bottom panel + `<GeneratedProfilesPanel />` reference) from `OnboardingSettings.tsx`. No trace remains.

**Task B**: Added inline AI Proposal section inside `DomainDetailPanel`:

1. **On mount**: `useEffect` calls `getLatestProposalForDomain(entry.domain)` and fetches the generation detail for the revision ID
2. **Proposal selectors**: Shown as a read-only table with 3 columns (Field → Current Selector → Proposed Selector → Action), with purple accent on proposed values
3. **Preview button**: "Preview Proposal" button appears next to "Test Selectors" when both a proposal and test URL exist; calls `testExtractorProfile` with the proposal's selectors
4. **Side-by-side comparison**: Both active and proposal results shown in a 2-column grid with green ("Active Profile") and purple ("🤖 AI Proposal") backgrounds
5. **Approve/reject buttons**: Per-field "Approve" (calls `approveRevisionFields`) and "Reject" (calls `rejectRevisionFields`) visible only when proposed selector differs from active; "Same as active" or "Not proposed" shown otherwise
6. **Loading/empty states**: Shows "Loading proposal…", "No AI proposal yet" with link to generate, and error display

### Validation
- `bun run typecheck` — passes clean (0 errors)
- Lint on the modified file — only 2 pre-existing issues (`truncateText` unused, `loading` state unused — both existed before this change)

### Files changed
- `src/client/components/OnboardingSettings.tsx` — removed bottom panel, added `getLatestProposalForDomain`/`approveRevisionFields`/`rejectRevisionFields`/`getProfileGenerationDetail` imports + `SelectorField`/`ProfileGenerationGeneration` types, added `useState`/`useEffect` for proposal state in `DomainDetailPanel`, added side-by-side preview and per-field approve/reject UI
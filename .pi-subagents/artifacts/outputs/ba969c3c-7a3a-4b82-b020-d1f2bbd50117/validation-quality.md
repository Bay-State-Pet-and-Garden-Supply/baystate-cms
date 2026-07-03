## Review
- Correct: The domain-specific data path is consistent. `src/shared/schemas/onboarding.ts:161-170` adds `sitemapProductUrlPattern` as nullable/defaulted on `ExtractorProfileSchema`; `src/client/onboarding-api.ts:311-320` exposes the same optional field on `saveExtractorProfile`; `src/server/routes/onboarding-routes.ts:1021-1034` forwards it into `upsertProfile`.
- Correct: `src/client/components/OnboardingSettings.tsx:49-59` centralizes profile-to-form mapping, and the create/edit render paths reuse the same `ProfileForm` (`src/client/components/OnboardingSettings.tsx:723-735`, `803-814`) with shared style constants (`src/client/components/OnboardingSettings.tsx:854-880`).
- Correct: Relevant repository tests were added in `src/tests/unit/extractor-profiles.test.ts:119-174`, and `bun test src/tests/unit/extractor-profiles.test.ts` passed all 9 tests.
- Fixed: None. Review-only task; no implementation files were modified.
- Blocker: Cleanup is not complete in `src/client/components/Onboarding.tsx`. The selected-batch path now renders `PipelineBoard` (`src/client/components/Onboarding.tsx:1150-1159`), but the component still keeps old item/detail state and pipeline handlers (`src/client/components/Onboarding.tsx:54-88`, `306-663`). Targeted ESLint reports unused state/handlers such as `reviewItem` at line 56 and `handleStartDiscovery` at line 308. `handleSelectBatch` also still fetches `getBatchItems` into now-unused `items` (`src/client/components/Onboarding.tsx:149-150`).
- Blocker: Requested files do not pass lint. Targeted ESLint reported 43 errors, including unused `loading` state in `src/client/components/OnboardingSettings.tsx:73`, an unused `ClassificationProposal` import in `src/client/onboarding-api.ts:22`, and unused imports in `src/server/routes/onboarding-routes.ts:18`, `22`, and `52`.
- Note: `src/client/components/OnboardingSettings.tsx` has an edit-state footgun: the `+ New Profile` button is still visible while an inline edit form is open (`src/client/components/OnboardingSettings.tsx:707-714`), and clicking it runs `startNewProfile`, which clears `editingProfileId` and resets the form (`src/client/components/OnboardingSettings.tsx:278-282`). This can silently discard unsaved edits.
- Note: The domain-specific schema/API changes are small, but the working-tree diff in the five reviewed files is very wide (`git diff --numstat` showed 397/734 lines in `Onboarding.tsx`, 788/295 in `OnboardingSettings.tsx`, 638/83 in routes, 307/7 in the client API, and 302/9 in the schema). If this is intended as only the domain extractor profile refactor, the diff should be narrowed or split.
- Note: `git diff --check` fails on trailing whitespace in `src/client/components/Onboarding.tsx` and `src/server/routes/onboarding-routes.ts`.
- Note: `/Users/nickborrello/Desktop/Projects/shopsite-cms/progress.md` was requested but is absent (read returned ENOENT); review used `plan.md` plus the inspected source files.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "not_satisfied",
      "evidence": "Domain field plumbing is consistent, but cleanup is incomplete and targeted ESLint fails in the requested files; the reviewed diff is also much wider than the domain extractor profile change."
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "Report cites exact files/lines, changed-file evidence, tests, commands, validation output, residual risks, and no-staged-files status."
    }
  ],
  "changedFiles": [
    "src/shared/schemas/onboarding.ts",
    "src/client/onboarding-api.ts",
    "src/server/routes/onboarding-routes.ts",
    "src/client/components/OnboardingSettings.tsx",
    "src/client/components/Onboarding.tsx"
  ],
  "testsAddedOrUpdated": [
    "src/tests/unit/extractor-profiles.test.ts"
  ],
  "commandsRun": [
    {
      "command": "git status --short && git diff --cached --name-only && git diff --name-only",
      "result": "passed",
      "summary": "Confirmed no staged files; requested files are modified in the working tree."
    },
    {
      "command": "git diff --numstat -- src/shared/schemas/onboarding.ts src/client/onboarding-api.ts src/server/routes/onboarding-routes.ts src/client/components/OnboardingSettings.tsx src/client/components/Onboarding.tsx",
      "result": "passed",
      "summary": "Captured diff-size evidence for the five reviewed files."
    },
    {
      "command": "bun test src/tests/unit/extractor-profiles.test.ts",
      "result": "passed",
      "summary": "9 pass, 0 fail."
    },
    {
      "command": "bun run typecheck",
      "result": "passed",
      "summary": "tsc --noEmit --skipLibCheck completed successfully."
    },
    {
      "command": "git diff --check -- src/shared/schemas/onboarding.ts src/client/onboarding-api.ts src/server/routes/onboarding-routes.ts src/client/components/OnboardingSettings.tsx src/client/components/Onboarding.tsx",
      "result": "failed",
      "summary": "Trailing whitespace reported in Onboarding.tsx and onboarding-routes.ts."
    },
    {
      "command": "./node_modules/.bin/eslint src/shared/schemas/onboarding.ts src/client/onboarding-api.ts src/server/routes/onboarding-routes.ts src/client/components/OnboardingSettings.tsx src/client/components/Onboarding.tsx",
      "result": "failed",
      "summary": "43 lint errors, primarily unused state/functions/imports in requested files."
    },
    {
      "command": "git diff --cached --name-only",
      "result": "passed",
      "summary": "No staged files."
    }
  ],
  "validationOutput": [
    "Extractor profile sitemapProductUrlPattern schema/client/server field names are consistent.",
    "Targeted extractor profile tests passed: 9 pass, 0 fail.",
    "Typecheck passed.",
    "Targeted ESLint failed with 43 errors in reviewed files.",
    "git diff --check failed due trailing whitespace."
  ],
  "residualRisks": [
    "Full test suite was not run; only targeted extractor profile tests and typecheck were run.",
    "Review was limited to the five requested source files plus relevant test evidence; the working tree contains many other modified/untracked files.",
    "progress.md was not available."
  ],
  "noStagedFiles": true,
  "diffSummary": "Domain extractor profile support is wired through schema, client API, route, and settings UI, but the same working tree also contains broad unrelated edits and incomplete Onboarding.tsx cleanup.",
  "reviewFindings": [
    "blocker: src/client/components/Onboarding.tsx:54-88 and 306-663 - old selected-batch state/handlers remain after PipelineBoard replaced the view; targeted ESLint flags many as unused.",
    "blocker: src/client/components/OnboardingSettings.tsx:73 - loading state is set but never read, causing lint failure.",
    "blocker: src/client/onboarding-api.ts:22 - ClassificationProposal import is unused, causing lint failure.",
    "blocker: src/server/routes/onboarding-routes.ts:18,22,52 - unused imports remain, causing lint failure.",
    "note: src/client/components/OnboardingSettings.tsx:707-714 - + New Profile remains active during inline edit and can discard unsaved edits via startNewProfile at lines 278-282."
  ],
  "manualNotes": "No code changes were applied by this review subagent; only this validation artifact was written."
}
```
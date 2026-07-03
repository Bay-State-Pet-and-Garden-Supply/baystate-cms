# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
# Fix Revision Feedback — Two Bugs

## Bug 1: Drawer closes immediately after feedback submit
In `src/client/components/ProfileProposalDrawer.tsx`, the `handleSubmitFeedback` function calls `onChange?.()` on success, which closes the drawer. The user sees nothing happen.

**Fix**: Remove the `onChange?.()` call from `handleSubmitFeedback`. Instead, show a success message ("Revision submitted — the AI will revise the selectors.") and keep the drawer open. Optionally re-fetch the generation detail to show the new revision in the "Approve or reject fields" table.

## Bug 2: LLM revision step was never wired up
The governance doc says: "The service deliberately does NOT call the LLM here. A future pass will run profile_revision against the new revision's feedback and replace its selectors_json."

The `profile_revision` task exists in the LLM task config system but is never invoked. When the operator submits feedback, a new `profile_generation_revision` row is created with `source = 'manager_feedback'` and `status = 'draft'`, but the selectors are copied from the parent — unchanged. The LLM never sees the feedback.

**Fix**: In `src/server/routes/onboarding-routes.ts`, after `reviseProfileFromStructuredFeedback` creates the revision, call the LLM to produce revised selectors. The flow:

1. Create the revision from feedback (existing code)
2. Fetch the source page HTML from the generation's `sourceUrl`  
3. Build a prompt that includes:
   - The current selectors
   - The operator's feedback
   - The page's minimized DOM (use `getMinimizedDom` from `src/onboarding/profile-generator.ts`)
4. Call `callLlmForTask('profile_revision', prompt, systemPrompt)`
5. Parse the LLM response (same format as `generateExtractorProfile` — a JSON object with selector keys)
6. Update the revision's `selectors_json` with the new selectors
7. Update the revision's status to `'validated'`
8. Return the updated revision in the response

The LLM revision prompt should be something like:
```
You are a CSS selector expert. Revise the following selectors based on operator feedback.

CURRENT SELECTORS:
{JSON of current selectors}

OPERATOR FEEDBACK:
{structured feedback as text}

PAGE DOM (minimized):
{minimized HTML}

Return ONLY a valid JSON object with exactly these keys:
{ "titleSelector": string|null, "priceSelector": string|null, "descriptionSelector": string|null, "brandSelector": string|null, "imagesSelector": string|null }
```

### Key imports already available in onboarding-routes.ts
- `getMinimizedDom` from `../../onboarding/profile-generator`
- `callLlmForTask` from `../../onboarding/llm-client`
- `findProfileGenerationById` from `../../db/repositories/profile-generation-repo`
- `findProfileGenerationRevisionById` from `../../db/repositories/profile-generation-revision-repo`
- `updateProfileGenerationRevisionStatus` — check if imported or add import

### Revision repo functions
In `src/db/repositories/profile-generation-revision-repo.ts`, check for a function to update a revision's selectors. If none exists, add an `updateRevisionSelectors` function that updates `selectors_json` and `status`.

### Files to modify
- `src/client/components/ProfileProposalDrawer.tsx` — Bug 1 fix
- `src/server/routes/onboarding-routes.ts` — Bug 2 fix (LLM revision call)
- `src/db/repositories/profile-generation-revision-repo.ts` — Add updateRevisionSelectors if needed

Read all relevant files first. Run `bun run typecheck` after.

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```
# Task for oracle

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Evaluate whether we should enforce the existence of a domain extractor profile before attempting extraction on that domain.

## Current State

We have a layered extraction system in `src/onboarding/page-extractor.ts`:
1. Custom CSS selectors (from `extractor_profiles` table, keyed by domain)
2. JSON-LD structured data
3. Meta tags
4. Microdata
5. HTML heuristics (hardcoded fallback selectors)
6. Image gallery extraction
7. Shopify productJSON parsing

Currently, extraction proceeds fine without any profile — layers 2-7 handle it. Profiles only exist when manually created or AI-generated-and-approved.

We just built a full governance system for AI-generated profiles:
- AI proposes selectors (behind feature flag)
- Store manager reviews per-field with structured feedback
- Multi-sample validation required for images
- Approval required before field writes to extractor_profiles
- Task-specific LLM routing
- Profile governance UI in domain settings

## The Question

Should we gate extraction on profile existence? I.e., if no extractor profile exists for a domain, should we:
- (A) Refuse to extract until a profile exists (strict gate)
- (B) Extract with heuristics but strongly nudge/require profile creation (soft gate)
- (C) Keep current behavior — extract without profile, only create profiles when needed

## What I Need From You

Is this a viable strategy? Weigh:
1. Does profile-gating meaningfully improve extraction quality?
2. What is the operational cost/friction for store managers?
3. Does our new AI profile-generation system make gating more or less viable?
4. Could gating cause deadlocks (can't extract → can't see product → can't create profile)?
5. Is there a phased approach that makes sense?

Challenge my assumptions. Point out what I'm missing.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return a concise result and residual risks when applicable

Required evidence: manual-notes, residual-risks

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
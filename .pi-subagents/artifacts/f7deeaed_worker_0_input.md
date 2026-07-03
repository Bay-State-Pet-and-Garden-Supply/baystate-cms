# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Fix two bugs in the LLM routing code that causes DeepSeek tasks to silently fall back to Ollama.

## Root Cause (already diagnosed)

The DeepSeek API key in the `api_keys` table is stored redacted (`••••••••7f10` instead of the real key). When `resolveProviderCredential()` or `getLlmConfig()` encounter a key containing `•`, they skip that provider silently and fall through to the next one (Ollama). The key gets corrupted because:

1. The GET API redacts keys: `'••••••••' + k.api_key.slice(-4)` (in `onboarding-routes.ts:788`)
2. The frontend stores this redacted key in state
3. When saving, the redacted key can be written to DB on INSERT (no guard on the INSERT path in `upsertApiKey`)
4. Once redacted in DB, the UPDATE guard preserves it because `existing.api_key` itself is redacted

## Changes Needed

### Fix 1: Add redacted-key guard to the INSERT path
**File:** `src/db/repositories/api-key-repo.ts`
In `upsertApiKey()`, the INSERT branch (line ~35-37) uses `apiKey` directly without checking if it starts with `•`. Add the same guard:

```typescript
// INSERT branch - add validation to reject redacted keys
if (apiKey.startsWith('•')) {
  throw new Error('Cannot save a redacted API key. Please enter the full key.');
}
```

### Fix 2: Add warning logging when redacted keys are skipped
**File:** `src/onboarding/llm-client.ts`
In `resolveProviderCredential()`, when a provider is skipped because its key contains `•`, log a console.warn so the operator can see it in server logs:

```typescript
function resolveProviderCredential(
  provider: LlmProvider,
): { apiKey: string; baseUrl: string | null; model: string | null } | null {
  const row = getApiKey(provider);
  if (!row || !row.api_key) {
    console.warn(`[LLMClient] No API key found for provider "${provider}"`);
    return null;
  }
  if (row.api_key.includes('•')) {
    console.warn(`[LLMClient] Provider "${provider}" has a redacted/masked API key — skipping. Re-enter the full key in Settings → LLM Providers.`);
    return null;
  }
  return { apiKey: row.api_key, baseUrl: row.base_url, model: row.model };
}
```

Also in `getLlmConfig()`, add a similar warning when DeepSeek or OpenAI are skipped due to redacted keys:
```typescript
// After checking deepseek.api_key.includes('•')
if (deepseek.api_key.includes('•')) {
  console.warn('[LLMClient] DeepSeek key is redacted — skipping to next provider');
}
// Same for openai
```

### Fix 3: Frontend validation in handleSaveApiKey
**File:** `src/client/components/OnboardingSettings.tsx`
In `handleSaveApiKey()`, add a check to reject redacted keys:
```typescript
if (!keyVal || keyVal.startsWith('••••')) {
  alert('Please enter a valid API key (the current value appears to be masked).');
  return;
}
```

## Verification
After making changes, run `bun run typecheck` to verify compilation. Do NOT run the full test suite — just typecheck.

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
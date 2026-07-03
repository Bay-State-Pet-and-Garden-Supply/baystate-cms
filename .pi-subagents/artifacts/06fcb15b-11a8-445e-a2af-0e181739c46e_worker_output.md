All checks pass. Here is the structured acceptance report.

---

## Acceptance Report

**Implemented:** Replaced the hardcoded `variantSelectionStrategy: null` in the validate request with a dynamic read from `latestGeneration.selectors`, falling back to `null` when absent.

**Changed files**: `src/client/components/ProfileBuilderWorkspace.tsx` (single line at the original line 488, now shifted to lines 488-489).

**Diff**: Only this change was made (file is untracked, no git diff available, verified by reading source):

```diff
-          variantSelectionStrategy: null,
+          variantSelectionStrategy:
+            (latestGeneration?.selectors as any)?.variantSelectionStrategy ?? null,
```

**Reasoning**: `latestSelectors` is typed as `Record<string, string | null>`, which strips nested objects. The `variantSelectionStrategy` is a complex object (`{ containerSelector, optionType, detectedOptions, optionFields }`), so it must be read directly from the raw `latestGeneration.selectors` (typed as `Record<string, unknown>`). The `(latestGeneration?.selectors as any)` cast preserves access to the nested property.

**Validation**: `bun run typecheck` passed with zero errors.
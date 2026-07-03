Fallow cleanup is done and already pushed. Final state:

| Metric | Before | After |
|--------|--------|-------|
| Total issues | **359** | **145** |
| Auto-fixable | **151** | **0** |
| Tests | 259 pass, 8 fail | 259 pass, 8 fail (same) |
| Typecheck | passes | passes |

**What was done:**
- **Suppressed 89 schema false positives** — Added `// fallow-ignore-file unused-export` to 9 shared schema files (onboarding, classification, extraction-worker, product, change-set, field-registry, sync, validation, workspace)
- **Auto-fixed 111 genuinely unused exports** across onboarding, repositories, client API, server services, and utility files
- **Restored 23 test-required exports** with `// fallow-ignore-next-line` suppression (things like `resetDb`, `scoreResult`, `callLlm`, `clearSitemapCache`, etc.)
- **Removed 3 unused npm dependencies** (`crawlee`, `openai`, `eslint-config-prettier`)
- **Cleaned up stale suppressions** left over from the fix process
- **Zero regressions** — typecheck clean, same test results, no auto-fixable items remain

**Remaining 145 issues** are all informational:
- 132 `unused_types` (type-only exports, no auto-fix available)
- 13 `duplicate_exports` (design pattern — repo types mirrored in schemas)
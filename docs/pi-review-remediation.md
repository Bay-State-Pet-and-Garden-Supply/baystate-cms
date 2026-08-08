# PI Review Remediation Plan (rev 13)

**Revision log:** rev 1 (initial plan) → plan review **APPROVE WITH REQUIRED REVISIONS** → rev 2 (plan-review revisions) → rev 3 (implementation status) → rev 4 (round-2 review closed) → rev 5 (round-3 review closed) → rev 6 (round-4 review closed) → rev 7 (round-5 review closed) → rev 8 (round-6 review closed) → rev 9 (round-7 review closed) → rev 10 (round-8 review closed) → rev 11 (round-9 review closed) → **rev 12: round-10 review closed** — the tenth external review (2 P0s + 4 P1s) was answered: (1) P0 artifactId run-scoping — artifact lookup is now getPiPageArtifactForRun(runId, id), candidate insertion takes the artifact row, attestation is same-run referentially enforced by DB triggers; cross-run regressions added. (2) P0 hint-as-authority — manufacturer authority no longer reads inputJson.brandHint: the canonical product brand resolves from DURABLE exact-GTIN-linked evidence (assets exact_product_match=1 + observed_gtin = requested); brandHint is display-only; authority is established even without a hint. (3) P1 run-deadline — the composed signal + absolute deadlineAt reach adapters; remainingMs recomputed per invocation; past-deadline dispatches denied synchronously. (4) P1 supporting-role linkage — assets persist the exact candidate_id FK; candidate entity identity typed (sku|platform_product_id|variation_id), established only by product-like records. (5) P1 orchestration gap — workflow-prompt instructs check_source_priority and states the authority rules. (6) P1 typed artifacts — artifact_type on pi_page_artifacts, discovery validates the retained type. Cleanup: upsertSourceAuthority re-reads the durable row; supplier_evidence documented as the second trusted authority path. → **rev 13: round-11 review closed** — the eleventh external review (1 P0: workspace-authority boundary; 2 P1 release blockers; 2 P1s) was answered: (1) P0 — every onboarding-backed identity tool is workspace-scoped (supplier/distributor lookups join source→item→batch with workspace_id = ctx.workspaceId; the requested GTIN is bound to the run's immutable GTIN — cross-GTIN results are leads, never supplier_evidence; foreign onboarding items → policy_denied); the reviewer's quoted SQL referenced columns that don't exist in the real schema — the boundary is implemented against the actual schema (GTIN on onboarding_items). (2) P1 release blocker — supporting-image linkage compares the RESOLVED media-set tuple {entityKind, entityValue, attestationArtifactId, discoveringSourceId} via the exact candidate FK (candidate-ID equality was impossible for legitimate primary+nutrition pairs); the DB trigger also requires candidate.image_url = asset.source_url. (3) P1 release blocker — the stale _sourceRowsCache is removed; authority establishment is a deterministic server consequence (refreshResolvedAuthoritiesForRun runs BEFORE the rights decision from hash-bound exact-GTIN + same-bytes brand EVIDENCE, and AFTER persistence from exact assets — asset-provenanced records win the upsert); pi_source_authorities retain brandEvidenceId/Hash/Kind. (4) P1 — terminal persistence and assetEvidenceFromRow preserve candidateId (schema + row mapper). (5) P1 — brand authority retains the evidence that established it (verified asset id + content hash, or the hash-bound brand evidence row). Merge-gate integration regression added: pi-authority-lifecycle.test.ts — extract manufacturer page → discover primary/supporting → OCR/verify primary → deterministic authority → re-verify supporting nutrition → submit primary+nutrition → validator accepts + persistence preserves both candidate FKs. — the ninth external review (1 P0: source-authority semantics; 5 P1s incl. 2 release-blockers) was answered: rights authority moved from evidence-kind derivation to a first-class pi_source_authorities record (authorityType/authorityRef/brandName/establishedBy, deterministic upgrade — manufacturer authority requires the registry brand to match the run's expected product brand; the first-writer bug and cross-brand confusion are closed); image discovery became ARTIFACT-DRIVEN — extract_product_page persists the fetched page bytes as a durable pi_page_artifacts record (2MB cap) and returns artifactId; discover_image_candidates takes only { artifactId } and parses server-side (agent content is structurally impossible); candidates retain attestation_artifact_id + attested_content_hash; supporting image roles require a durable entity/media-set linkage (candidate entity_id) instead of same-page; the runtime AbortSignal reaches research-tool adapters and registry timeouts use the effective remaining run time; policy.maxToolCalls is enforced synchronously at the registry adapter boundary. — the eighth external review (3 P0s: artifact-attested candidate provenance, non-authoritative source priority, content-hash-bound GTIN linkages, anchor-propagation page-primary; 4 P1s: candidate-field propagation, source-tier precedence, contradiction scoping, tool-version capture) was answered: discover_image_candidates attests the supplied content to a server-retained artifact (durable evidence contentHash + page URL — fabricated content is denied before any candidate/source row is created); check_source_priority is non-authoritative (official tier only from the CMS brand-site registry; agent sourceKind/officialDomains never mint manufacturer/official evidence); asset->GTIN linkages are content-addressed (originalContentHash must equal the current image bytes); page-primary co-occurrence only PROPAGATES an independent anchor (mainEntity/canonical/platform-current/selected-child) and never creates one; multi-variant contradictions use the same page-primary-qualified contribution set; verification provenance fields flow from the candidate row; the candidate's discovering source wins over sticky image-URL tiers; research-tool {name, version, schemaHash} captured per run (tools_json) with image contracts bumped to 2.0.0. — the seventh external review (3 P0s: server-created image candidate provenance, per-value GTIN qualification, page-primary escapes; 2 P1s: comparison review exemption, commerce-accurate approvedImageIds) was answered: discover_image_candidates creates durable pi_image_candidates rows ({runId, imageUrl, discoveringSourceId, ...}) and verify_image_candidate requires the candidateId — the rights tier resolves from the server-created discovering source, never the agent's sourcePageUrl or evidence rows; each GTIN fact is qualified independently (byte-bound or linkage-covered value), one fact's hash never authorizes another fact's value, differing qualified values are a conflict; GTIN is removed from the page-primary co-occurrence key and the totalProductLike===1 fallback is disabled when an expected GTIN exists (primary requires an independent page-context marker: mainEntity/canonical/product-id/SKU); comparison-role assets no longer trigger rights review telemetry; approvedImageIds carries only genuinely commerce-approved assets (roles live in the images structure). — the sixth external review (3 P0s: model transport trust-zone transitions, byte-bound image GTIN identity + OCR upc/count emission, page-primary variant linkage; 4 P1s: import/validator role alignment, supporting-role same-product linkage, review signaling from server-resolved assets, bounded pinned subrequests) was answered: buildModelFetch classifies the trust zone ONCE from the configured endpoint and denies every zone transition (remote->loopback denied even at allowlisted ports; local->remote denied); image observed-GTIN requires byte-hash-bound OCR/decoder evidence or a server-authoritative asset->GTIN linkage (generic field evidence cannot), extract_packaging_evidence emits hash-bound upc + count; browser variant proof requires page-primary/current-entity linkage (mainEntity/canonical-URL/co-occurrence) AND expected-GTIN — a cross-sell carrying the requested GTIN cannot prove single-variant; image roles are aligned validator->result->import (comparison never a commerce asset; supporting roles need same-product linkage; review telemetry derives from resolved asset rows); pinned HTTP subrequests get a stream/aggregate cap. — the fifth external review (3 P0s: model-transport SSRF floor, exact-identity-when-GTIN, entity-scoped variant proof; 3 P1s: all-role asset binding, image provenance linkage, subrequest rebinding) was answered: buildModelFetch composes model + destination/SSRF authority per hop (loopback-model policy for local endpoints, public-destination validation for remote, stream-bounded 20MB cap); exactProductMatch requires an observed exact GTIN or server-authoritative linkage when the run has a GTIN (name alignment is probable_match only), OCR extracts barcodes (upc field) and size/weight/flavor become explicit variant discriminators; browser variant proof is entity-scoped ({ productIdentity, source, variantCount } — unlinked payloads neither prove nor contradict); the terminal contract is singular verifiedAssetId bound for EVERY role with role-specific rules; image provenance resolves via the discovering page/evidence rows (no CDN-URL source row needed); http browser subrequests ride the pinned transport via route.fulfill. Remaining: domVariantSelectors producer wiring, https TOCTOU residual, P1-3 (#6/#17), P1-5 owner sign-off. — the fourth external review (2 P0s: VLM model-policy boundary + verified-asset run-identity binding; 4 P1s: OCR byte-hash path, browser proof, import asset selection, DNS rebinding) was answered on the same branch: VLM calls get a separate model-policy authority (checkModelEndpoint — loopback models allowed under local_only, remote VLM gated by data-sharing + model route); verify_image_candidate derives expected identity from the run input server-side, persists verified_against_json/hash + durable declared source type, and the terminal validator requires exactly-one run-bound URL-matched identity-hash-matched asset; packaging OCR emits per-fact field-level evidence carrying the downloaded-bytes SHA-256; browser proof requires affirmative variant-set evidence or selected-child linkage (DOM selector contradictions; rendered leaf JSON-LD stays corroboration); import derives image ids from the final bundle's cited verifiedAssetIds only; the worker pins http destinations to validated IPs (https residual documented). Also fixed the round-3 run-service asset test to round-4 semantics (run-bound seeding) and exported persistBundleAssets as the deterministic persistence seam. — the third external review (REQUEST CHANGES: transport gaps, browser policy race, ladder settle order, terminal image authority, import value/approval boundaries) was answered on the same branch: discovery/Icecat/VLM transports gateway-owned end-to-end (searchSerper + sitemap + variant resolution ride the injected network capability; Icecat SDK bypassed for PI; VLM calls ride the gateway), module-global allowlist removed with DNS fail-closed on redirects/subresources, ladder settles only on platform/browser-affirmative proof (structured JSON-LD is corroboration; browser always runs first when available), terminal image authority resolves from durable verified asset rows with byte-hash-bound OCR (fabricated candidates fail), strict field-level value equivalence (substring hole closed), approval enforced inside the import service, honest actor authentication (token must be configured and match), transactional review chain, and atomic policy lineage in createPiRun. — the second external review (REQUEST CHANGES: 2 P0s + 8 integration defects) was answered on the same branch: transport injection end-to-end (P0-1), affirmative-only single-variant proof + expected-variant-tied select_option (P0-5), dual-namespace image evidence resolution, import value-to-evidence binding (citation + field + value-equivalence), malformed test:db fixed with one authoritative `bun run verify` gate (also surfaced and fixed a search-benchmark test that had been failing since 5ea277d — noise-above-truth strategies are now never recommended), legacy submission removed from the live result type, base-policy-lineage rerun reauthorization, server-derived review actor provenance, policy lattice/seed defaults, grant-record reuse rights.

**Implementation status:** Batches 1-3 implemented — **P0-1** (enforced network capability: `gatewayFetch` single boundary, `search_query` data-sharing gate, extraction-worker destination floors, transitive call-graph test), **P0-2** (immutable versioned approved policies + reduction lattice + server-authoritative routes), **P0-3** (legacy terminal removed, type-separated), **P0-4** (kill switch dominates real reruns; deterministic replay preserved; origin-policy re-authorization), **P0-5** (positive-proof `exact_match`), **P0-6** (evidence-resolved image observations, reuse grants, OCR schema + content-hash binding), **P1-1** (import fails closed on field-level evidence), **P1-2** (durable review decisions, append-only, replay-no-clone), **P1-4** (field-level durable evidence), **P1-5** (this ADR: in-process boundary as accepted residual risk), **P2-1** (user-facing delete removed; reject is durable), **P2-2** (evaluation metrics from persisted tool calls), **P2-3** (this ADR: provider scope).

**Remaining:** **P1-3** external gate (#6/#17 promotion authority — classification stream); **P1-5** product-owner sign-off on the ADR risk register. Round-11 review's merge gate (the P0 + both release blockers + both P1s) is implemented. Standing items: domVariantSelectors producer wiring, https TOCTOU residual, trusted brand-site registry population for manufacturer tiers (fail-closed 'unknown' until rows exist), typed browser_network_capture artifact retention (seam marked, not implemented), P1-3 external gate (#6/#17), P1-5 owner sign-off.

- **Audit:** external source-level review of `main` @ `721b7db1b2b023e15c5d0ede903ae3e6e8b00250` (baseline `54c80dc…`), result **REQUEST CHANGES** — all P0s re-verified against source on `main` (rev 1).
- **Plan review:** external review of rev 1, result **APPROVE WITH REQUIRED REVISIONS** — incorporated below.
- **Parent decisions (unchanged):** (1) execute on a new branch (e.g. `fix/pi-review-hardening`) before further PI enablement; (2) batch-0 lockfile/registration commit held until the dirty-tree commit; (3) P1-3 deferred to classification stream (#6/#17) — but now as an **explicit import-release gate** (see P1-3).
- **Program status while open:** Product Intelligence shadow-only; onboarding import and real Pi reruns disabled.

---

## Two invariants (must survive every fix; re-check at each commit)

> **Authority invariant:** No value, policy, identity decision, rights decision, or review decision becomes authoritative merely because the agent supplied it. Authority must resolve to CMS-owned configuration or durable evidence.

> **Replay invariant:** Replay may reproduce evidence/results, but it never reproduces authority. Approval, current policy authorization, kill-switch state, and release eligibility are evaluated again on the replayed run.

The second invariant catches both the current kill-switch bug (P0-4) and the rejected review-decision cloning idea (P1-2).

---

## Batch dependency graph

```
Batch 1 — P0s (atomic from a release perspective)
  P0-1 network capability   ──┐
  P0-2 approved policies    ──┼─ both must land together: the gateway is
  P0-3 terminal contract     │   bypassable if the caller can still hand
  P0-4 replay/kill switch    │   the executor a permissive policy
  P0-5 variant identity      │
  P0-6 image provenance      ──┘

Batch 2 — P1s (strict order)
  P1-4 durable field-level evidence
        ↓
  P1-2 durable human review (approve/reject)
        ↓
  P1-1 import consumes both (fail closed)
        ↓
  external gate: #6/#17 promotion authority (P1-3)
        ↓
  allowOnboardingImport may be enabled

Batch 3 — P2s (independent)
  P2-1 reject/delete semantics · P2-2 evaluation metrics · P2-3 provider scope
```

Batch 1 is **atomic for release**: no P0 fix ships alone. Batch 2 has a strict chain — field evidence before review before import; import stays disabled until the #6/#17 gate closes.

---

## P0 findings (blocking)

### P0-1 — One network capability, transitively enforced

**Confirmed locations:** `policy/policy-gateway.ts` — **`PolicyGateway.gatewayFetch()` already exists (L316)** with `checkNetworkRequest` (L223: DNS resolve, private/link-local rejection, redirect re-validation per hop, `maxRedirects`, `maxResponseBytes`, `allowedContentTypes`, `dataClassification`) + `record()` audit rows. Already used by image verification. Bypasses: `extraction/platforms.ts:37,251` (raw `fetch`, `redirect:'follow'`), `onboarding/packaging-ocr.ts:71` (raw image fetch), `tools/discovery-tools.ts` (Serper cache stack), `extraction/managed-fallback.ts:125`.

**Fix design**
1. **No second abstraction.** Make `gatewayFetch` (or a renamed `piFetch` alias that is the *same function*) the single capability. Thread a `PolicyCheckContext` (runId/workspace/policy) into every bypass site: platforms fetch (`fetchPageHtml` + probes), the PI-invoked OCR image loader, discovery tool HTTP, managed-fallback `fetch`.
2. **Serper is not "just audit".** A Serper query transmits product GTIN/name to a third party. Route it through `checkNetworkRequest` with `dataClassification: 'search_query'` (or the existing product-data classification) so that under `dataSharingPolicy: 'local_only' | 'cloud_models_only'` the call is **denied**, not merely logged. Same for any provider/API call that carries product data.
3. **Rendered-browser worker included.** Extraction-worker navigation redirects and captured network requests get the same destination enforcement: deny private/loopback/link-local destinations and honor `local_only` for remote navigation. (Worker already receives denylists; extend to policy-gated allow/deny.)
4. `HTTP_EXTRACTION_HEADERS` and redirect semantics move into the gateway call; ladder layer 1 documents gateway use instead of raw fetch.

**Tests**
- **Transitive call-graph integration test (not grep):** a test that enumerates every tool adapter's execution path and asserts each network-capable adapter resolves through the gateway — implemented as a test that walks tool definitions → handler call sites → fetch invocations (static walk + one live denial scenario per adapter: `local_only` + private URL → `PolicyDeniedError`).
- Redirect chain: public → private denied, no follow, audit rows per hop.
- Serper under `local_only`/`cloud_models_only` → denied with `policy_denied`, no query sent.
- OCR image loader invoked from PI with private URL → denied.
- Browser worker: navigation to `http://127.0.0.1` denied; captured request to private destination flagged/denied.
- Grep gate remains as a cheap regression tripwire (`fetch(` outside the gateway in `src/product-intelligence/**` and the PI-reachable OCR path), but the integration test is the authority.

**Acceptance:** every external side effect reachable transitively from a PI tool (HTTP, search providers, OCR/model providers, browser navigation/network capture, managed providers) passes the current server-authoritative policy before execution.

---

### P0-2 — Approved policies: immutable, versioned, server-authoritative

**Confirmed locations:** `server/routes/product-intelligence-routes.ts:142` (caller `body.policy` → schema → executor), `run-service.ts:488` `verifyPolicySnapshot` (integrity only).

**Fix design**
1. **Immutable/versioned records.** New table `pi_approved_policies`: `id` (stable policy-record ID, UUID), `name`, `version` (int, monotonically increasing), `policy_json`, `policy_config_id` (the content `configId` hash), `active` (bool per record, not per row — only newest version of a record may be active), `created_at`. **Never mutate `policy_json` under the same record+version; a change = new version row.** Old versions remain resolvable for replay lineage.
2. **Seeding:** migration seeds existing workspaces **and** a workspace-create hook seeds new workspaces (not only workspaces present at migration time).
3. Route change: `POST /runs` accepts `{ policyId?, policyOverrides? }`; server resolves the active version; `configId` computed server-side; `body.policy` rejected (400).
4. **Explicit reduction lattice** for `policyOverrides` (deterministic, enforced in one `assertReducingOverride()` function):
   - tool arrays / domain arrays: subset only (intersection check)
   - numeric limits (budgets, deadline, maxToolCalls): decrease only
   - `local_only → allowlisted_remote` mode transitions: forbidden
   - `dataSharingPolicy`: more restrictive only (e.g. `allowlisted_remote → cloud_models_only → local_only`)
   - **`modelRoute`: not caller-overridable at all**
5. **No caller-accessible policy-creation route.** v1 policy records are config-driven/internal (seeded from server-side `buildDefaultPiPolicy()` snapshot; future edits via env/config or an operator-only mechanism). Rationale: the only existing auth boundary is a single shared API token with no admin scope — a `POST /approved-policies` route under that token would just become the new way to manufacture an approved policy.
6. `verifyPolicySnapshot` stays as defense-in-depth; authorization = active version row lookup.

**Tests**
- Caller policy JSON → 400 even with self-consistent hash.
- Lattice: every allowed override passes; each violation class rejected (tool added, deadline raised, `local_only→allowlisted_remote`, modelRoute override, dataSharing loosened).
- Unknown/revoked/inactive record → 403/404; old version resolves for replay lineage but is not eligible for new runs.
- New workspace created after migration → policy record exists.

**Acceptance:** no caller-controlled policy shape reaches the executor; policy authority = CMS-owned immutable records.

---

### P0-3 — Single terminal validation path, type-separated

**Confirmed locations:** `contracts.ts:442` `SUBMISSION_TOOL_NAME='submit_product_research'` still registered; `run-service.ts` applies `validateTerminalSubmission` only to workflow (bundle) submissions.

**Fix design**
1. Remove the legacy tool from Pi session registration (schema stays for historical parsing only).
2. **Type separation:** historical envelope parsing uses a dedicated `LegacyTerminalSubmission` type; the **live executor terminal union excludes it** so no fake executor/adapter can pass a legacy envelope into `run-service` merely because a shared union still contains it.
3. Assert in pi-session-factory test: legacy tool absent from session inventory.

**Tests:** session inventory excludes legacy tool; a legacy-shaped submission cannot type-check against the live executor path; historical run rendering still parses old envelopes (read-only).

**Acceptance:** exactly one authoritative terminal validation path; the live path is closed at the type level.

---

### P0-4 — Kill switch dominates real execution; deterministic replay stays

**Confirmed location:** `execution-router.ts:94-107` — `resolveExecutorPreferring` forces the Pi executor for reruns when "only the flags diverted us".

**Fix design (reviewer's distinction incorporated)**
1. **Real reruns** (start a model session, network, or Pi session): refused when Pi is disabled by flags/kill switch — remove the "only the flags diverted us" branch.
2. **Deterministic replay** (pure state reconstruction from persisted rows — no model, no network, no session): remains available for audit/debugging even while disabled, because it reproduces evidence, not authority (Replay invariant).
3. **P0-2 interaction:** a real rerun additionally refuses an origin policy whose record is no longer active/approved — reproducibility must not resurrect a revoked security policy.

**Tests (adversarial):** kill switch + real rerun → refused, zero tool calls, no session; kill switch + deterministic replay → succeeds read-only; flags on + rerun → works; rerun of a run whose origin policy record is revoked/inactive → refused; legacy-only config + rerun → consistent fallback/refusal.

**Acceptance:** no real Pi execution starts when disabled; deterministic replay never performs side effects; revoked policies never re-authorize execution.

---

### P0-5 — Positive proof required for `exact_match`

**Confirmed locations:** `tools/contract.ts:186-215` `classifyPageIdentity` (exact GTIN before variant signals); `extraction/ladder.ts:183` early exit.

**Fix design (stronger proof semantics)**
1. **Absence of detected variant UI is not proof.** `exact_match` requires **positive** evidence of one of:
   - **positive single-variant proof** — page/platform structure affirmatively indicates a single variant (e.g. platform API reports one variant, single ProductGroup child with no options, product page without any variant selector *and* canonical data carries exactly one variant entry), **or**
   - **positive selected-child linkage** — the requested child variant (size/flavor) is demonstrably the selected/default variant (selected variant signals, canonical URL variant params, platform default-variant field).
2. Exact GTIN means "the requested entity is represented on this page" — never automatically "the page is currently displaying that variant."
3. Ladder early exit requires the same proof; pages exhibiting variant signals proceed through variant-resolution layers (5-8) before settling.
4. Bundle validator unchanged in structure; its disposition ties already block `wrong_variant` — tighten identity feed as above.

**Tests (adversarial):** ProductGroup page with child GTIN in variant data + default variant = another size → NOT `exact_match` (`wrong_variant` or `parent_product_only`); single-variant page with explicit single-variant proof + exact GTIN → `exact_match`; multi-variant page with GTIN and no selected-child proof → not exact even if no selector was *detected* (selector-detection absence alone never suffices — regression test with a page whose variant UI is undetectable by the parser); page with selected-child linkage proof → `exact_match`.

**Acceptance:** `exact_match` implies positive single-variant or positive selected-child evidence; absence-based reasoning never settles identity.

---

### P0-6 — Image provenance: server-resolved facts, separate reuse authorization

**Confirmed locations:** `assets/verification.ts:371-372,402-403,431-435` (declared rights/source/observed fields feed exact match + `commerceApproved`); `assets/schema.ts:16` `ExtractionMethodSchema` = `json_ld|platform_api|network_response|profile_selector|media_api|manual`.

**Fix design**
1. **Observations from durable evidence.** `verify_image_candidate` takes durable evidence IDs; server resolves pixel facts itself (Sharp hashes/quality + VLM OCR via `src/onboarding/vlm-client.ts`). Model-declared observations may display as "agent asserted" but never feed exact matching or `commerceApproved`.
2. **OCR schema (explicit, previously omitted):** extend `ExtractionMethodSchema` with `'image_ocr'` (VLM/OCR) and `'decoder'` (deterministic decode) — zod enum + **TypeBox mirror + schema-equivalence test** (existing `schema-equivalence.test.ts` must stay green), any API/client types that duplicate the enum, and DB CHECK constraints where the enum is persisted.
3. **OCR evidence bound to the image content hash** (SHA-256 of the inspected bytes), not just the URL — evidence row metadata carries `contentHash`; a later URL change cannot re-interpret "OCR said UPC X" as applying to different bytes.
4. **Rights = reuse grant, separate from source identity.** A canonical manufacturer/supplier domain proves *where the asset came from*, not authorization to reuse. New durable server-authoritative **reuse grant** record (workspace/vendor/license policy: which source tiers may be reused, terms, expiry) resolved independently of source identity. Manufacturer-hosted images remain `restricted` unless a grant exists.

**Tests:** model-supplied `observedGtin` without evidence → ignored, `commerceApproved` false; evidence-resolved OCR observation → drives exact match with `extractionMethod:'image_ocr'`; schema-equivalence green with the two new enum values; OCR row carries `contentHash` matching the decoded bytes; rights: manufacturer-hosted image with no reuse grant → `restricted` even though source identity resolves; grant present → approved.

**Acceptance:** no model-declared identity/rights string produces `commerceApproved`; rights resolve from CMS-owned reuse grants; OCR facts are bound to exact bytes.

---

## P1 findings (release blockers — strictly ordered in Batch 2)

### P1-4 — Durable field-level evidence (FIRST in Batch 2)

**Confirmed location:** `run-service.ts:188` `persistToolEvidence` (coarse rows: `value = {evidenceId, snippet}`, `targetField` = kind).

**Fix design**
1. Extraction tools emit **per-field** evidence: `{ field, value, method, path, snippet }` per entry.
2. **Field-specific durable IDs** — never attach one `toolEvidenceId` to N rows. Identity = `tool + source URL hash + field + path/value hash` (e.g. `extract_product_page:sha256(url):size:sha256(path|value)`), so import resolves *the field's* evidence unambiguously.
3. `persistToolEvidence` maps each entry → row with `targetField=field`, `value` = extracted value, `extractionMethod=method`, `metadata: { toolEvidenceId, path, contentHash? }`.
4. Review surface shows field → value → method → path per row.

**Tests:** extraction of title/size/gtin → N rows, each own ID/value/method/path; reconstruction test — "size = 16 oz supported by path X" recoverable from rows alone; ID uniqueness across fields of one page.

**Acceptance:** per-field provenance reconstructible from the evidence table without replay.

### P1-2 — Durable human review (SECOND in Batch 2)

**Confirmed location:** `server/routes/product-intelligence-routes.ts:348` import gate = completed + `submitted` only.

**Fix design**
1. Append-only `pi_review_decisions`: `id`, `run_id`, `decision: 'approve' | 'reject'`, `result_hash` (exact result snapshot hash the decision applies to), `supersedes_decision_id` (nullable, forms the decision sequence), `reviewer`, `note`, `created_at`. **v1 ships `approve|reject` only** — `amend` is undefined behavior without a durable revised-result mechanism; defer amendments until result-revision semantics exist.
2. Import requires a durable `approve` whose `result_hash` matches the run's current result.
3. **Replay never clones approvals.** A replay is a new run and starts unreviewed; the origin decision is preserved as lineage only (Replay invariant). Import of a replayed run requires a fresh approval.
4. UI: review drawer writes the decision; import disabled until approved.

**Tests:** import without matching approve → 409; reject → refused; approve with mismatched result_hash → refused; replay → starts unreviewed, origin decision visible as lineage but not authoritative; decision chain (supersedes) resolves to the latest.

**Acceptance:** no imported run lacks a durable, result-bound approval on the exact run being imported.

### P1-1 — Import consumes field-level evidence, fails closed (THIRD in Batch 2)

**Confirmed location:** `onboarding-import.ts:309` (fallback sourceId = runId), `328-334` (`evItemsForField[0]?.id ?? proposal.evidenceIds[0] ?? \`${runId}:${field}\``, proposal IDs as source IDs, `extractionMethod:null`).

**Fix design** (rewritten against P1-4 output, per sequencing)
1. Each proposal field resolves its field-specific evidence ID → evidence row → source row (URL/domain), carrying `extractionMethod` + snippet + path.
2. **Fail closed:** any selected fact that cannot resolve to a durable field-level evidence row aborts import with a per-field report. No `${runId}:${field}` fabrications; no sourceId=runId fallback.
3. Historical PI-1 envelopes: read-only support only where durable rows exist.

**Tests:** full normalized evidence → every imported field traceable (ID + source + method + path); dangling citation → abort, zero onboarding rows, per-field report.

**Acceptance:** imported proposal fields are traceable to durable field-level evidence, or import fails.

### P1-3 — External hard gate: promotion authority (deferred owner, hard dependency)

**Status:** deferred to classification stream (#6/#17) — `src/onboarding/draft-promoter.ts` `suggestedPages` fallback + `brandHint`-driven Brand bypass.

**Gate semantics (new):** **Batch 2 completion does not authorize reviewed import until #6/#17 promotion-authority acceptance criteria are green.** `allowOnboardingImport` stays disabled; the release gate below encodes this as an explicit dependency, and the checkbox is verified against the classification stream's own acceptance evidence.

### P1-5 — In-process execution: accepted residual risk, not a fix

**Status:** ADR-0010 documents in-process Pi sessions + worker-delegated browser work. Documentation is **risk acceptance**, not remediation.

**Actions**
1. Product-owner sign-off on the revised requirement (ADR-0010 isolation section rewrite), including an explicit risk register:
   - supply-chain exposure of the Pi SDK and model-provider clients running in the server process
   - process secrets / DB credentials reachable from trusted-but-adapter code
   - DB availability to Pi tool code (bun:sqlite in-process)
   - deployment assumption: local single-operator server (not multi-tenant)
2. Record the accepted residual risks and the boundary each one relies on (policy gateway, resource loader, no-auto-extension).

**Acceptance:** ADR + risk register say exactly what is enforced where, what is accepted, and who accepted it.

### P1-6 — Reproducible install/test gate (content staged; commit held)

**Status:** confirmed — committed `bun.lock` lacks `pi-coding-agent`/`typebox`; committed `test:db` omits PI suites; regenerated lockfile + registrations sit uncommitted.

**Fix design (held per parent decision; folds into dirty-tree commit)**
1. Commit regenerated `bun.lock` + `package.json` `test:db` additions + `vitest.config.ts` excludes.
2. **One authoritative script:** `package.json` `"verify"` = frozen install (`bun install --frozen-lockfile`) → `tsc --noEmit --skipLibCheck` → `vitest run` → **`bun run test:db`** (fixed — the previous `bun test $(jq -r …)` form was wrong: it substituted the command text, not the file list) → `vite build` → eslint on changed files. CI invokes **only** `bun run verify`.

**Acceptance:** fresh clone → `bun install --frozen-lockfile` succeeds; `bun run verify` green.

---

## P2 findings

### P2-1 — Reject is a durable decision; deletion is not user-facing

**Confirmed locations:** `server/routes/product-intelligence-routes.ts:337-343` `DELETE /runs/:id` (any non-running run); UI models rejection as deletion. The only auth boundary is a single shared `BAYSTATE_CMS_API_TOKEN` on mutating routes — **no admin scope exists**.

**Fix design**
1. **Remove the user-facing delete route.** Physical deletion belongs to retention/maintenance (PI-10 retention policies) and server maintenance only. No `admin` scope fiction: with a single token there is no user/admin distinction to enforce.
2. "Reject" writes an append-only `pi_review_decisions` row (`reject`); run rows and evidence stay immutable.
3. UI: reject → decision row + rejected state; delete affordances removed from the Agent Lab surface.

**Tests:** DELETE route returns 404/410 (gone) — route removed; reject leaves run + evidence intact with decision row; retention path (server-side) still purges per policy.

### P2-2 — Evaluation metrics from persisted tool-call table

**Confirmed location:** `evaluation/runner.ts:113-114` — `toolCalls: 0, deniedToolCalls: 0`.

**Fix:** read persisted `tool_calls` (count + `policy_outcome='denied'` count) at evaluation time; `derivedFrom: 'tool_calls'` flag; backfill historical runs where rows exist. Tests: seeded rows → correct metrics; empty → 0 with derivation flag.

### P2-3 — Provider scope: documented, not silently dropped

**Status:** intentional (interfaces + registries + benchmark-first enforcement; no vendor adopted without credentials/benchmark). **Fix:** ADR note + issue updates marking `pi-web-access` extension factories and real managed-provider adoption explicitly out of scope until benchmarked; skip-row enforcement stays.

---

## Release gate (revised wording)

1. **Every external side effect reachable transitively from a PI tool — HTTP, search providers, OCR/model providers, browser navigation/network capture, managed providers — passes the current server-authoritative policy before execution.** → Batch 1 (P0-1, P0-2)
2. Legacy terminal removed; every terminal result passes the single validator (type-separated) → Batch 1 (P0-3)
3. Approved policy by immutable/versioned record ID; reducing overrides only; `modelRoute` not caller-overridable → Batch 1 (P0-2)
4. Kill-switch dominates real execution; deterministic replay side-effect-free; revoked policies never re-authorize → Batch 1 (P0-4)
5. `exact_match` requires positive single-variant or positive selected-child evidence → Batch 1 (P0-5)
6. **Reviewed import may not be enabled until:** every selected imported fact resolves to field-level durable evidence (P1-4); the exact result hash has a durable approval decision (P1-2); import fails closed on unresolved facts (P1-1); promotion consumes only durable accepted/manual decisions; **and #6/#17 promotion-authority acceptance criteria are green (P1-3)** → Batch 2 + external gate
7. Frozen install + typecheck + Vitest + every bun/DB PI suite + deterministic smoke as **one `bun run verify` CI gate** → Batch 0 (held)

After the gate: isolation risk acceptance (P1-5), reject-vs-delete (P2-1), evaluation metrics (P2-2), provider scope (P2-3).

## Verification commands (gate)

```bash
bun run verify    # the only command CI runs (frozen install → tsc → vitest → test:db → build → eslint)
```

## Deferred / owner map

| Item | Owner | Where |
|---|---|---|
| P1-3 promotion authority — hard import gate | Classification stream (#6/#17) | `src/onboarding/draft-promoter.ts` |
| P1-5 in-process isolation — risk acceptance | Product owner sign-off | `docs/adr/0010-*.md` + risk register |
| P0-2 policy record creation — internal/config-driven | This effort | `pi_approved_policies` seeding |
| P2-3 provider scope — docs/issue update | This effort | `docs/adr/` + #28/#29 |
| Batch 0 commit | Dirty-tree commit (parent) | working tree |

Inherited decisions:
- Profiles are domain-scoped, not product-scoped.
- AI-generated profiles are proposals only.
- Approval is always required, per selector field.
- Images are uncertain and require multi-sample validation.
- Unapproved generated selectors must not affect current extraction.
- Current extractor is layered and can succeed without profiles.

Diagnosis:
- Strict pre-extraction profile gating is **not a good default**.
- A profile row existing does not prove quality. A stale/bad partial profile can be worse than JSON-LD/meta extraction.
- New AI governance makes profile creation safer, but also slower because approval and validation are required.

Drift / contradiction check:
- Strict gating conflicts with the proposal-only/approval-required workflow.
- It can deadlock: no extraction → no confirmed samples/evidence → no reliable profile approval.
- It also conflicts with the current layered extractor design, where profiles are an override/augmentation layer, not the foundation.

Recommendation:
- Do **not** require a domain profile before extraction.
- Use a **soft/domain-health gate** instead:
  1. First extraction on a new domain proceeds with deterministic layers.
  2. If result is low-confidence/missing fields/image-risky, mark domain as `profile_recommended`.
  3. Generate profile proposal if model config exists.
  4. Require approved profile fields only before **unattended bulk trust**, not before initial extraction.
  5. For repeated fragile domains, pause future automatic extraction but allow manual exploratory extraction to gather samples.

Risks:
- Without a gate, some domains will still produce mediocre deterministic extractions.
- With a strict gate, onboarding becomes much more manual and cold-start-heavy.
- “Profile exists” is a weak signal unless field-level validation evidence exists.

Need from main agent:
- Decide whether to implement a **domain health / profile recommended** state instead of strict gating.

Suggested execution prompt:
- No worker handoff warranted until that product decision is approved.
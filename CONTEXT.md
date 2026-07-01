# ShopSite CMS

ShopSite CMS manages store product data as local product drafts that can be reviewed, approved, and published to a ShopSite store.

## Language

**Category Page**:
An existing customer-facing store page that a product can be assigned to for browsing.
_Avoid_: Category, taxonomy page, page category

**Category Page Identity**:
The stable live-store identity used to validate a Category Page assignment.
_Avoid_: Display name only, suggested page string

**Category Page Assignment Scope**:
Whether products should be assigned only to the most specific matching Category Page or to multiple matching hierarchy levels.
_Avoid_: Page spam, automatic parent assignment

**Unmapped Category Page**:
A plausible customer-facing store page that does not yet exist in the store.
_Avoid_: Auto-created page, missing category

**Unavailable Category Page Assignment**:
An accepted Category Page assignment whose page no longer exists or is ambiguous at product draft creation.
_Avoid_: Deleted assignment, broken page

**Product Type**:
A reusable classification for products that share the same merchandising expectations.
_Avoid_: Category, template, department

**Primary Product Type**:
The single Product Type that selects a product's Attribute Profile.
_Avoid_: Secondary type, category, facet

**Product SKU**:
A single product identity that is classified independently during onboarding.
_Avoid_: Product family, variant group

**Unmapped Product Type**:
A plausible Product Type that is not yet configured for the store.
_Avoid_: New category, auto-created type

**Product Attribute**:
A store-configured merchandisable fact about a product, such as flavor, color, size, material, or life stage.
_Avoid_: Field, custom field, classifier result

**Unmapped Product Attribute**:
A Product Attribute without a live Catalog Field target.
_Avoid_: Planned field, final assignment

**Universal Product Attribute**:
A Product Attribute that is relevant regardless of Product Type.
_Avoid_: Global field, common metadata

**Product Claim**:
A Product Attribute that states a marketing or compliance-sensitive claim about a product.
_Avoid_: Creative copy, inferred benefit

**Direct Claim Evidence**:
Classification Evidence that explicitly states a Product Claim.
_Avoid_: Inferred claim, absence-based claim

**Absence-Based Claim**:
A claim inferred from missing evidence rather than an explicit product statement.
_Avoid_: Free-from claim, allergen conclusion

**Product Composition Attribute**:
A Product Attribute that records ingredient, nutrient, active ingredient, allergen, or analysis information.
_Avoid_: Generic attribute, generated summary

**Attribute Profile**:
The set of Product Attributes expected for a Product Type.
_Avoid_: Field set, schema, template

**Attribute Constraint**:
A Product Type-specific limit on how a Product Attribute may be assigned.
_Avoid_: Validation rule, configuration option

**Attribute Cardinality**:
Whether a Product Attribute accepts one value or multiple values for a Product Type.
_Avoid_: Array field, multi-select flag

**Unmapped Attribute Value**:
A plausible controlled Product Attribute value that is not yet allowed by the relevant Attribute Profile.
_Avoid_: Bad value, invalid value, hallucination

**Attribute Value Mode**:
The way a Product Attribute accepts values, such as controlled choice, free text, or measured value.
_Avoid_: Field type, data type

**Measured Attribute Value**:
A structured Product Attribute value with a quantity, unit, or range.
_Avoid_: Display string, raw text

**Canonical Measurement Unit**:
The standard unit used to compare Measured Attribute Values for a Product Attribute.
_Avoid_: Display unit, original text

**Attribute Value Alias**:
A configured synonym that supports mapping evidence text to a controlled Product Attribute value.
_Avoid_: Replacement value, hidden rewrite

**Ambiguous Attribute Value Alias**:
An Attribute Value Alias that could map to different values in different Product Types or contexts.
_Avoid_: Bad alias, automatic match

**Catalog Field**:
A store-specific product field present in the live ShopSite XML pulled from the store.
_Avoid_: Database column, classifier slot, planned field

**Catalog Field Serialization**:
The store-specific format used when writing one or more Product Attribute values into a Catalog Field.
_Avoid_: String formatting, display text

**Attribute Mapping**:
A workspace-specific link from a Product Attribute to its primary Catalog Field.
_Avoid_: Store-specific taxonomy, hardcoded field map

**Stale Attribute Mapping**:
An Attribute Mapping whose Catalog Field is no longer present in the live ShopSite XML pull.
_Avoid_: Deleted mapping, broken field

**Legacy Field Map**:
A store-specific mapping that predates the Product Attribute model.
_Avoid_: Attribute Profile, classification model

**Field Assignment**:
A reviewed value for a store-specific product attribute.
_Avoid_: Metadata, tag, enrichment

**Classification Proposal**:
A reviewable suggested Product Type, Category Page, or Field Assignment for a product.
_Avoid_: Automatic classification, final assignment

**Proposal Confidence**:
A confidence level for a Classification Proposal that influences review preselection.
_Avoid_: Certainty, auto-approval

**Proposal Decision**:
A reviewer choice to accept, reject, or defer one Classification Proposal.
_Avoid_: Product approval, batch approval

**Proposal Decision Revision**:
A later reviewer choice that changes an earlier Proposal Decision without erasing it.
_Avoid_: Mutated decision, deleted history

**Bulk Proposal Acceptance**:
A reviewer action that accepts multiple safe Classification Proposals at once.
_Avoid_: Auto-approval, blanket acceptance

**Manual Review Requirement**:
A Catalog Manager Guidance rule that requires an individual Proposal Decision for an otherwise safe Classification Proposal.
_Avoid_: Safety bypass, auto-rejection

**Batch Bulk Proposal Acceptance**:
Bulk Proposal Acceptance across multiple Product SKUs in one onboarding batch.
_Avoid_: Blind batch approval, automatic batch classification

**Product Draft Projection**:
A preview of product draft fields and Category Page assignments derived from accepted Proposal Decisions.
_Avoid_: Final product draft, persisted field values

**Skipped Draft Assignment**:
An accepted proposal that is not written during product draft creation because it is stale or blocked by configuration.
_Avoid_: Product blocker, silent omission

**Classification History**:
The retained local CMS record of Classification Proposals, Classification Evidence, and Proposal Decisions for a product.
_Avoid_: Final field values, model log, ShopSite export data

**Classification Run**:
A reproducible attempt to create Classification Proposals for one Product SKU.
_Avoid_: Model call, ad hoc enrichment

**Classification Configuration Snapshot**:
The Classification Configuration state used for a Classification Run.
_Avoid_: Runtime cache, hidden prompt state

**Configuration Snapshot Drift**:
A mismatch between a proposal's Classification Configuration Snapshot and the active Classification Configuration.
_Avoid_: Silent reinterpretation, old mapping reuse

**Classification Refresh**:
A Classification Run triggered by changed product evidence or changed Classification Configuration.
_Avoid_: Silent overwrite, automatic approval

**Stale Classification Proposal**:
A Classification Proposal that should be reconsidered because a dependent proposal changed.
_Avoid_: Invalid field, deleted suggestion

**Classification Evidence**:
A product fact that supports a Classification Proposal.
_Avoid_: Model output, AI reasoning

**Evidence Source**:
The origin of Classification Evidence, such as product text, visual observation, inferred context, spreadsheet hint, brand history, or prior approved products.
_Avoid_: Model reasoning, prompt output

**Third-Party Evidence**:
Classification Evidence from a retailer, marketplace, distributor, or other non-official product page.
_Avoid_: Official evidence, claim evidence

**Page Context Evidence**:
Low-reliability Classification Evidence derived from existing or proposed Category Page names, paths, or hierarchy.
_Avoid_: Direct product evidence, claim evidence

**Evidence Conflict**:
A disagreement between Classification Evidence that prevents a confident proposal.
_Avoid_: Model error, bad data

**Evidence Reliability**:
The trustworthiness of an Evidence Source for preselecting a Classification Proposal.
_Avoid_: Truth, priority rule

**Approved Product Example**:
An existing reviewed product used as store-local evidence for a Classification Proposal.
_Avoid_: Training data, global example

**Configuration Suggestion**:
A reviewable proposed Product Type, Product Attribute, Attribute Constraint, or allowed value derived from store-local evidence.
_Avoid_: Auto-generated configuration, inferred schema

**Starter Preset**:
An optional predefined set of Product Types, Product Attributes, Attribute Constraints, and allowed values that a store may adapt.
_Avoid_: Default configuration, global taxonomy

**Batch Classification Hint**:
A temporary cue used to interpret products in one onboarding batch.
_Avoid_: Workspace configuration, permanent mapping

**Baseline Classification**:
The automatic classification work that can run before durable Classification Configuration exists.
_Avoid_: Full classification, configured attribute proposal

**Configured Classification**:
Classification work that depends on active Classification Configuration.
_Avoid_: Baseline classification, always-on classification

**Classification Configuration**:
The durable workspace-specific setup for Product Types, Product Attributes, Attribute Profiles, Attribute Mappings, and allowed values.
_Avoid_: Runtime cache, batch hint, model prompt

**Catalog Manager Guidance**:
Manager-authored instructions that shape classification behavior for a workspace, Product Type, Product Attribute, Category Page assignment, or Attribute Mapping.
_Avoid_: Hardcoded behavior, hidden prompt

**Structured Catalog Manager Guidance**:
Catalog Manager Guidance expressed as enforceable configuration.
_Avoid_: Free-form prompt, suggestion text

**Free-Form Catalog Manager Guidance**:
Catalog Manager Guidance expressed as natural-language merchandising preference.
_Avoid_: Enforceable rule, safety rule

**Guidance Boundary**:
The separation that keeps Catalog Manager Guidance, Classification Safety Rules, and product evidence distinct for Model-Backed Classification Stages.
_Avoid_: Verbatim prompt, mixed evidence

**Untrusted Product Evidence**:
Product evidence that may contain product facts but cannot issue instructions to a Classification Stage.
_Avoid_: Manager guidance, model instruction

**Structured Product Evidence**:
A bounded product fact, snippet, or observation extracted from Untrusted Product Evidence with provenance.
_Avoid_: Raw page text, prompt content

**Visual Product Evidence**:
Structured Product Evidence extracted from a product image.
_Avoid_: Final visual classification, image guess

**Visual Evidence Eligibility**:
Whether a Product Attribute may use Visual Product Evidence for proposals.
_Avoid_: Image-based guessing, universal vision support

**Evidence Extraction Stage**:
A Classification Stage that turns Untrusted Product Evidence into Structured Product Evidence.
_Avoid_: Proposal stage, raw prompt passthrough

**Guidance Precedence**:
The order used to resolve overlapping Catalog Manager Guidance from broader and narrower scopes.
_Avoid_: Prompt merge, hidden override

**Guidance Override Warning**:
A configuration-review warning that narrower Catalog Manager Guidance overrides broader guidance.
_Avoid_: Configuration blocker, hidden conflict

**Classification Safety Rule**:
A non-overridable constraint that Catalog Manager Guidance cannot weaken.
_Avoid_: Preference, manager instruction

**Configuration Change**:
A reviewed update to Classification Configuration.
_Avoid_: Instant setting, runtime tweak

**Configuration Gap**:
A missing, stale, or unmapped part of Classification Configuration that prevents a proposal from becoming a final Field Assignment.
_Avoid_: Product blocker, validation error

**Classification Stage**:
A focused step that turns available product information into either Classification Evidence or Classification Proposals.
_Avoid_: Monolithic prompt, all-in-one classifier

**Deterministic Classification Stage**:
A rule-based Classification Stage that uses configuration or exact extraction instead of a generative model.
_Avoid_: AI fallback, heuristic guess

**Model-Backed Classification Stage**:
A Classification Stage that uses a language or vision model to interpret product information.
_Avoid_: Deterministic rule, hidden automation

**Stage Model Policy**:
The advanced model/provider selection used by a Model-Backed Classification Stage, with workspace defaults and optional stage overrides.
_Avoid_: Hardcoded model, global-only model setting, everyday merchandising setting

**Stage Model Fallback**:
An explicitly allowed alternate model/provider for a Stage Model Policy when the selected model is unavailable.
_Avoid_: Silent fallback, implicit cloud fallback

**Model Data Sharing Policy**:
The workspace or stage rule that controls what product evidence may be sent to cloud-backed Model-Backed Classification Stages.
_Avoid_: Implicit upload, provider default

**Image Data Sharing Policy**:
The rule that controls whether raw product images may be sent to cloud-backed vision stages.
_Avoid_: Text evidence policy, implicit image upload

**Sensitive Store Data**:
Store data that must not be sent to model providers, such as credentials, API keys, merchant identifiers, or raw secrets.
_Avoid_: Product evidence, allowed context

**Classification Model Preset**:
A manager-friendly quality, cost, speed, or locality choice that maps to Stage Model Policies.
_Avoid_: Raw provider setting, model override

**Stage Abstention**:
A Classification Stage outcome that intentionally produces no proposal.
_Avoid_: Failure, empty result, low-confidence guess

**Reviewable Abstention**:
A Stage Abstention surfaced to a reviewer because the missing proposal matters.
_Avoid_: Review noise, validation error

**Stage Failure**:
A failed Classification Stage that is recorded without failing the entire Classification Run.
_Avoid_: Product failure, run failure

**Stage Dependency**:
A required or optional input relationship between Classification Stages.
_Avoid_: Hidden ordering, implicit prerequisite

## Relationships

- A **Product Type** defines which **Product Attributes** are relevant for a product.
- A **Product SKU** has exactly one **Primary Product Type** for classification.
- A **Primary Product Type** gates Product Attribute classification except for **Universal Product Attributes**.
- A **Product Type** remains local CMS classification unless represented by a mapped **Product Attribute**.
- Changing a **Product Type** may make type-specific **Classification Proposals** stale.
- An **Unmapped Product Type** requires review before it can become a **Product Type**.
- An **Attribute Profile** belongs to exactly one **Product Type**.
- An **Attribute Profile** may define **Attribute Constraints** for each included **Product Attribute**.
- An **Attribute Profile** may define **Attribute Cardinality** for each included **Product Attribute**.
- An **Attribute Profile** may define Product Type-specific **Attribute Value Aliases**.
- An **Attribute Profile** may define confidence thresholds for its **Classification Proposals**.
- An **Unmapped Attribute Value** requires review before it can become a **Field Assignment**.
- An **Unmapped Category Page** requires review before it can become a **Category Page**.
- A **Product Attribute** may appear in many **Attribute Profiles**.
- A **Product Attribute** may have one **Attribute Mapping**.
- An **Unmapped Product Attribute** cannot produce a final **Field Assignment**.
- An **Attribute Mapping** points to one primary **Catalog Field**.
- A **Stale Attribute Mapping** cannot produce a final **Field Assignment** until remapped.
- A **Catalog Field** must come from the live ShopSite XML pulled from the store.
- A **Product Attribute** has exactly one **Attribute Value Mode**.
- A **Product Claim** requires **Direct Claim Evidence**.
- An **Absence-Based Claim** cannot become a **Classification Proposal**.
- A **Product Composition Attribute** requires strict evidence and provenance.
- A measured **Product Attribute** stores **Measured Attribute Values** before field serialization.
- A measured **Product Attribute** has one **Canonical Measurement Unit**.
- A controlled **Product Attribute** may define **Attribute Value Aliases**.
- An **Ambiguous Attribute Value Alias** requires review before preselection.
- A **Field Assignment** applies to the **Catalog Field** identified by its **Attribute Mapping**.
- A **Field Assignment** uses **Catalog Field Serialization** when writing values into a **Catalog Field**.
- A product may belong to zero or more **Category Pages**.
- **Category Page** assignment may depend on **Product Type**, **Product Attributes**, and direct product evidence.
- **Category Page** assignment follows the configured **Category Page Assignment Scope**.
- **Category Page Assignment Scope** may be defined by Product Type with a workspace default fallback.
- Without configuration or store-local evidence, Category Page assignment prefers the most specific matching Category Page.
- A **Category Page** may provide **Page Context Evidence**.
- **Page Context Evidence** may use the full existing Category Page hierarchy when available.
- **Page Context Evidence** cannot support Product Claims or Product Composition Attributes.
- A product can only be assigned to existing **Category Pages**.
- A **Category Page** has one **Category Page Identity**.
- An accepted Category Page assignment is validated by **Category Page Identity** before product draft creation.
- An **Unavailable Category Page Assignment** becomes a **Skipped Draft Assignment**.
- A product may have zero or more **Field Assignments**.
- A **Field Assignment** records the value of one **Product Attribute** for one product.
- A **Classification Run** is composed of one or more **Classification Stages**.
- A **Classification Stage** declares its **Stage Dependencies**.
- A **Classification Stage** produces **Classification Evidence**, **Classification Proposals**, or a **Stage Abstention**.
- A **Deterministic Classification Stage** runs before model-backed stages when it can answer the same question.
- **Free-Form Catalog Manager Guidance** may inform **Model-Backed Classification Stages**.
- **Model-Backed Classification Stages** use a **Stage Model Policy**.
- A **Stage Model Policy** may define **Stage Model Fallbacks**.
- Model unavailability without an allowed **Stage Model Fallback** becomes a **Stage Failure** or **Stage Abstention**.
- **Model-Backed Classification Stages** respect **Guidance Boundaries** between safety rules, configuration, manager guidance, and product evidence.
- **Structured Catalog Manager Guidance** drives **Deterministic Classification Stages**.
- A **Stage Abstention** is recorded in **Classification History** without forcing a **Classification Proposal**.
- A **Stage Abstention** may become a **Reviewable Abstention** when it concerns an expected or important Product Attribute.
- A **Stage Failure** is recorded in **Classification History** without failing the whole **Classification Run**.
- A required **Stage Dependency** can make a dependent **Classification Stage** unavailable.
- An optional **Stage Dependency** can lower proposal confidence without stopping a dependent **Classification Stage**.
- A **Classification Proposal** is supported by one or more pieces of **Classification Evidence**.
- A **Classification Proposal** has exactly one **Proposal Confidence**.
- **Proposal Confidence** may preselect but never bypass a **Proposal Decision**.
- **Classification Evidence** has exactly one **Evidence Source**.
- Product evidence is **Untrusted Product Evidence** for Model-Backed Classification Stages.
- **Untrusted Product Evidence** cannot override Classification Safety Rules, Catalog Manager Guidance, or Classification Configuration.
- An **Evidence Extraction Stage** produces **Structured Product Evidence** from **Untrusted Product Evidence**.
- A vision model may produce **Visual Product Evidence** as an **Evidence Extraction Stage**.
- A Product Attribute may define **Visual Evidence Eligibility**.
- **Visual Product Evidence** may support proposals only within the Product Attribute's **Visual Evidence Eligibility**.
- Model-backed proposal stages should prefer **Structured Product Evidence** over raw product text.
- A **Model Data Sharing Policy** controls what evidence may be sent to cloud-backed Model-Backed Classification Stages.
- An **Image Data Sharing Policy** controls cloud access to raw product images separately from text evidence.
- Raw product images remain local unless an **Image Data Sharing Policy** explicitly permits cloud processing.
- **Sensitive Store Data** is never sent to model providers.
- **Third-Party Evidence** may support ordinary merchandising Product Attributes.
- **Third-Party Evidence** cannot support Product Claims or Product Composition Attributes unless explicitly configured.
- **Evidence Reliability** influences proposal preselection.
- **Evidence Reliability** may vary by Product Attribute and workspace.
- An **Evidence Conflict** requires review before preselection.
- An **Approved Product Example** may provide **Classification Evidence**.
- An **Approved Product Example** may produce **Configuration Suggestions**.
- A **Starter Preset** may produce **Configuration Suggestions**.
- A **Legacy Field Map** may produce **Configuration Suggestions**.
- A **Configuration Suggestion** may propose merging multiple legacy entries into one **Product Attribute**.
- A **Batch Classification Hint** may inform **Classification Proposals** for one onboarding batch.
- **Baseline Classification** may run without active **Classification Configuration**.
- **Configured Classification** requires active **Classification Configuration**.
- Missing Classification Configuration produces **Configuration Suggestions** rather than Product Type or Product Attribute proposals.
- **Classification Configuration** contains the durable Product Types, Product Attributes, Attribute Profiles, Attribute Mappings, allowed values, Catalog Manager Guidance, Stage Model Policies, Classification Model Presets, and Model Data Sharing Policies for a workspace.
- A Catalog Manager Guidance edit is a **Configuration Change**.
- A **Classification Configuration Snapshot** includes the active **Catalog Manager Guidance** for that run.
- **Catalog Manager Guidance** may be **Structured Catalog Manager Guidance** or **Free-Form Catalog Manager Guidance**.
- **Catalog Manager Guidance** follows **Guidance Precedence** when multiple scopes apply.
- **Guidance Precedence** favors the narrowest applicable scope within **Classification Safety Rules**.
- **Guidance Override Warnings** surface broader guidance overridden by narrower guidance.
- **Structured Catalog Manager Guidance** is preferred when classification behavior can be enforced.
- **Free-Form Catalog Manager Guidance** may inform **Classification Proposals** within **Classification Safety Rules**.
- **Classification Safety Rules** include live Catalog Field matching, review before final assignment, and direct-evidence requirements for Product Claims.
- A **Classification Run** uses exactly one **Classification Configuration Snapshot**.
- A **Classification Run** produces **Classification Proposals** for one **Product SKU**.
- A **Classification Refresh** may make dependent **Classification Proposals** stale.
- A **Classification Refresh** must preserve prior **Proposal Decisions** in **Classification History**.
- A **Configuration Suggestion** becomes active only through a **Configuration Change**.
- A **Configuration Change** is reviewed before it updates **Classification Configuration**.
- A **Configuration Gap** blocks affected **Field Assignments** but does not block product draft creation.
- A **Classification Proposal** has its own **Proposal Decision**.
- A **Proposal Decision** may have **Proposal Decision Revisions**.
- A **Proposal Decision Revision** preserves earlier decisions in **Classification History**.
- **Bulk Proposal Acceptance** may apply only to safe, unambiguous Classification Proposals.
- A **Manual Review Requirement** removes Bulk Proposal Acceptance eligibility.
- **Batch Bulk Proposal Acceptance** requires a preview summary before applying decisions across Product SKUs.
- Product Claims, Product Composition Attributes, Evidence Conflicts, Unmapped values, Configuration Gaps, Stale Classification Proposals, and Manual Review Requirements require individual Proposal Decisions.
- A product may have one **Classification History**.
- A **Classification History** preserves proposals, evidence, and decisions separately from final product values.
- **Classification History** stays in the local CMS and is not exported to ShopSite.
- A **Stale Classification Proposal** requires a new **Proposal Decision** before becoming a **Field Assignment** or **Category Page** assignment.
- A **Product Draft Projection** previews accepted **Proposal Decisions** before product draft creation.
- **Configuration Snapshot Drift** makes affected accepted proposals stale before product draft creation.
- A **Skipped Draft Assignment** does not block product draft creation.
- A **Classification Proposal** applies to one **Product SKU**.
- A **Classification Proposal** becomes a **Field Assignment** or **Category Page** assignment only during product draft creation.

## Example dialogue

> **Dev:** "If a food product is assigned to the **Dog Food** **Category Page**, do we automatically know its flavor?"
> **Domain expert:** "No — the **Category Page** controls where customers browse for it, while flavor is a **Product Attribute** determined from the product data."

## Flagged ambiguities

- "category" was used to mean both **Category Page** placement and **Product Type** classification — resolved: these are distinct concepts.
- Customer-facing page names or hierarchy could be treated as direct product facts — resolved: they are **Page Context Evidence** and low-reliability.
- "new product type" can mean either a configured **Product Type** or a suggested **Unmapped Product Type** — resolved: classifiers may suggest but not create Product Types.
- **Product Type** could be confused with an exported ShopSite field — resolved: keep it local unless represented by a mapped **Product Attribute**.
- Product Type structure could depend on each store's merchandising preferences — resolved: capture manager preferences as **Catalog Manager Guidance** and Classification Configuration rather than assuming one universal hierarchy.
- Manager instructions could become unbounded prompts — resolved: prefer **Structured Catalog Manager Guidance** and limit **Free-Form Catalog Manager Guidance** with Classification Safety Rules.
- Manager guidance can make review stricter but not looser — resolved: use **Manual Review Requirements** to require individual review without weakening safety rules.
- Free-form guidance could be mixed with product evidence or safety rules — resolved: maintain **Guidance Boundaries** for Model-Backed Classification Stages.
- Scraped pages or spreadsheet cells could contain instruction-like text — resolved: treat product evidence as **Untrusted Product Evidence** that can supply facts but not instructions.
- Raw product text could overwhelm or steer model-backed proposal stages — resolved: prefer **Structured Product Evidence** produced by an **Evidence Extraction Stage**.
- Manager guidance could be treated as mutable prompt text — resolved: guidance edits are reviewed **Configuration Changes** and included in the **Classification Configuration Snapshot**.
- Free-form guidance could invisibly change rule-based behavior — resolved: it informs **Model-Backed Classification Stages**, while **Deterministic Classification Stages** use structured guidance.
- Model selection could be assumed to be workspace-wide only — resolved: use advanced/admin **Stage Model Policies** with workspace defaults and optional stage overrides.
- Everyday managers could be exposed to raw provider/model details — resolved: offer **Classification Model Presets** that map to admin-controlled Stage Model Policies.
- Model/provider outages could silently switch execution environments — resolved: use explicit **Stage Model Fallbacks**, and never fall back from local-only to cloud unless configured.
- Cloud-backed stages could receive too much store data — resolved: enforce **Model Data Sharing Policies** and never send **Sensitive Store Data**.
- Image sharing could be treated the same as text sharing — resolved: use a stricter **Image Data Sharing Policy** and keep raw product images local unless explicitly enabled.
- Overlapping manager guidance could be silently merged — resolved: use **Guidance Precedence**, with safety rules first and the narrowest applicable scope winning.
- Deterministically resolved guidance conflicts could still surprise managers — resolved: surface them as **Guidance Override Warnings** rather than blocking configuration review.
- Products could appear to have multiple types — resolved: use exactly one **Primary Product Type** for classification and use Category Pages or Product Attributes for secondary merchandising facets.
- Product families or variants could imply inherited classification — resolved: classify each **Product SKU** independently until the domain has an explicit product-family concept.
- "field" was used to mean store-specific merchandising facts — resolved: call these **Product Attributes** in the domain language.
- Product marketing claims could be treated as creative inference — resolved: call them **Product Claims** and require **Direct Claim Evidence**.
- Free-from or allergen claims could be inferred from absence — resolved: call these **Absence-Based Claims** and do not propose them.
- Ingredients and nutrients could be treated as generic merchandisable fields — resolved: call them **Product Composition Attributes** and require strict evidence and provenance.
- Store-specific field maps were being treated as the classification model — resolved: keep **Product Attributes** separate from **Catalog Fields** through **Attribute Mappings**.
- A desired **Product Attribute** may lack a live field target — resolved: call it an **Unmapped Product Attribute** and do not write it as a final assignment.
- "Catalog Field" was considered for manual creation — resolved: **Catalog Fields** must match fields present in the live ShopSite XML pull.
- Live ShopSite XML changes may make mappings unsafe — resolved: call these **Stale Attribute Mappings** and block final Field Assignments that depend on them.
- "attribute value" can mean a controlled choice, free text, a structured measurement, a canonical unit, a synonym, or a plausible value outside the controlled list — resolved: model this distinction as **Attribute Value Mode**, **Measured Attribute Value**, **Canonical Measurement Unit**, **Attribute Value Alias**, **Ambiguous Attribute Value Alias**, and **Unmapped Attribute Value**.
- "classification" was used to imply both suggested and final values — resolved: call AI-generated suggestions **Classification Proposals** until reviewed.
- Automatic classification could imply all Product Type and Product Attribute proposals always run — resolved: **Baseline Classification** runs automatically, while **Configured Classification** requires active Classification Configuration.
- Bulk review could be confused with auto-approval — resolved: call it **Bulk Proposal Acceptance** and limit it to safe, unambiguous proposals.
- Batch-wide bulk review could apply too many wrong decisions at once — resolved: call it **Batch Bulk Proposal Acceptance** and require a preview summary.
- Reversing a proposal decision could imply deleting history — resolved: use **Proposal Decision Revisions** and preserve earlier decisions.
- Accepted proposals could be confused with persisted product fields — resolved: show them as a **Product Draft Projection** until product draft creation.
- Active configuration changes could silently reinterpret accepted proposals — resolved: call this **Configuration Snapshot Drift** and require review before product draft creation.
- Skipped accepted proposals could be confused with product draft failure — resolved: call them **Skipped Draft Assignments** and continue product draft creation.
- Accepted page assignments could be applied after page deletion or ambiguity — resolved: call these **Unavailable Category Page Assignments** and skip them during product draft creation.
- Page assignments stored as display names could become ambiguous after sync — resolved: validate assignments with **Category Page Identity**, not page name alone.
- Assigning products across multiple page hierarchy levels could clutter broad pages — resolved: use Product Type-specific **Category Page Assignment Scope** with a workspace default fallback.
- AI-backed classification could be non-repeatable — resolved: treat each attempt as a reproducible **Classification Run** tied to a **Classification Configuration Snapshot**.
- Re-running classification could silently overwrite review decisions — resolved: call it a **Classification Refresh** and preserve prior **Proposal Decisions** in **Classification History**.
- Conflicting evidence could imply a silent winner — resolved: call this an **Evidence Conflict** and require review rather than silent preselection.
- Retailer or distributor pages could be treated like official sources — resolved: call this **Third-Party Evidence** and restrict it for claims and composition attributes unless configured.
- Classification setup edits could be confused with instant settings — resolved: durable setup changes are reviewed **Configuration Changes**.
- Incomplete classification setup could be confused with a product-level blocker — resolved: call it a **Configuration Gap** and block only affected Field Assignments.
- Final product values do not explain why classification happened — resolved: preserve the **Classification History** separately from final values.
- **Classification History** could be confused with ShopSite product data — resolved: it is local CMS history only and is not exported to ShopSite.
- "VLM classification" was used to imply the vision model decides final values — resolved: visual models produce **Visual Product Evidence** as an **Evidence Extraction Stage**, while proposals remain reviewable.
- Visual observations could be applied to every attribute — resolved: each Product Attribute controls this with **Visual Evidence Eligibility**.
- "classifier" was used broadly enough to hide multiple responsibilities — resolved: classification is composed of focused **Classification Stages** rather than one all-in-one prompt.
- A failed Classification Stage could be confused with a failed product or run — resolved: call it a **Stage Failure** and preserve successful stage outputs.
- Stage ordering could be hidden in code — resolved: express ordering and required inputs as **Stage Dependencies**.
- Generative models could be used where rules already answer the question — resolved: run **Deterministic Classification Stages** first.
- Low-confidence classifiers could be forced to guess — resolved: use **Stage Abstention** and record the reason instead.
- Abstentions could clutter review — resolved: surface only important missing proposals as **Reviewable Abstentions**.

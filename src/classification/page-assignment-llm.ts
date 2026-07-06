/**
 * LLM-First Category Page Assignment
 *
 * Replaces the broken keyword-matcher-first page assignment with a dedicated
 * LLM call that receives rich product context (VLM OCR data, product type,
 * web description, store page hierarchy) and returns validated page matches.
 *
 * This is the core of Phase 2 of the curation fix: the LLM makes the decision
 * instead of token-overlap keyword matching.
 *
 * @module page-assignment-llm
 */

import type { ClassificationEvidence, ClassificationProposal } from '../shared/schemas/classification';
import { callLlmForTask } from '../onboarding/llm-client';
import { listPages } from '../db/repositories/page-repo';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PageAssignmentParams {
  /** Best available product name from evidence */
  productName: string;
  /** Web description (truncated to 2000 chars) */
  productDescription: string;
  /** Structured VLM OCR summary from packaging image */
  ocrSummary: {
    species: string[];
    flavor: string | null;
    lifeStage: string | null;
    productForm: string | null;
    healthConcern: string[];
    productName: string | null;
    brand: string | null;
  };
  /** Upstream product type proposal (e.g. "Dry Dog Food") */
  productType: string | null;
  /** Store category pages with hierarchy info */
  pages: Array<{ id: string; name: string; parentName: string | null }>;
  /** Single or multiple selection mode */
  selectionMode: 'single' | 'multiple';
  /** Maximum pages to return (default 5, max 10) */
  maxPages: number;
}

export interface PageAssignmentResult {
  pages: Array<{ pageId: string; pageName: string; confidence: number }>;
}

// ─── Page Hierarchy Builder ──────────────────────────────────────────────────

/**
 * Build a page hierarchy array from flattened options.
 *
 * Reads the live page_index to resolve parentId → parentName for each option,
 * so the LLM receives structured hierarchy context (e.g. "Cat Food Dry" is a
 * subcategory of "Cat Food Shop All").
 */
export function buildPageHierarchy(
  options: Array<{ value: string; label: string }>,
): Array<{ id: string; name: string; parentName: string | null }> {
  const storePages = listPages();
  const pageMap = new Map(storePages.map(p => [p.id, p]));

  return options.map(opt => {
    const page = pageMap.get(opt.value);
    const parentName = page?.parentId
      ? (pageMap.get(page.parentId)?.name ?? null)
      : null;
    return {
      id: opt.value,
      name: opt.label,
      parentName,
    };
  });
}

// ─── Product Context Extractor ───────────────────────────────────────────────

/**
 * Extract structured product context from classification evidence and proposals.
 *
 * Assembles the best available product name, description, VLM OCR summary,
 * and upstream product type — all used by `llmAssignCategoryPages()` to build
 * a rich prompt.
 */
export function extractProductContext(
  evidence: ClassificationEvidence[],
  allProposals: ClassificationProposal[],
): {
  productName: string;
  productDescription: string;
  ocrSummary: PageAssignmentParams['ocrSummary'];
  productType: string | null;
} {
  // ── Product name: prefer expected_name → web title → OCR name → spreadsheet name ──
  const spreadsheetName = evidence.find(
    e => e.source === 'spreadsheet' && e.sourceField === 'name',
  )?.value as string | undefined;
  const expectedName = evidence.find(
    e => e.source === 'spreadsheet' && e.sourceField === 'expected_name',
  )?.value as string | undefined;
  const webTitle = evidence.find(
    e => e.source === 'official_product_page' && e.sourceField === 'title',
  )?.value as string | undefined;
  const ocrName = evidence.find(
    e => e.source === 'visual_product_evidence' && e.sourceField === 'name',
  )?.value as string | undefined;

  const productName = expectedName ?? webTitle ?? ocrName ?? spreadsheetName ?? 'Unknown Product';

  // ── Product description ──────────────────────────────────────────────────
  const description = evidence.find(
    e => e.source === 'official_product_page' && e.sourceField === 'description',
  )?.value as string | undefined;
  const productDescription = (description ?? '').slice(0, 2000);

  // ── OCR summary from visual_product_evidence ─────────────────────────────
  const visualEvidence = evidence.filter(e => e.source === 'visual_product_evidence');

  const getFirst = (field: string): string | null => {
    const entry = visualEvidence.find(e => e.sourceField === field);
    if (!entry) return null;
    const val = entry.value;
    return typeof val === 'string' ? val : null;
  };

  const getAll = (field: string): string[] => {
    return visualEvidence
      .filter(e => e.sourceField === field)
      .map(e => (typeof e.value === 'string' ? e.value : ''))
      .filter(Boolean);
  };

  const ocrSummary = {
    species: getAll('species'),
    flavor: getFirst('flavor'),
    lifeStage: getFirst('lifeStage'),
    productForm: getFirst('productForm'),
    healthConcern: getAll('healthConcern'),
    productName: getFirst('name'),
    brand: getFirst('brand'),
  };

  // ── Product type from upstream proposals ─────────────────────────────────
  const typeProposal = allProposals.find(
    p => p.proposalType === 'primary_product_type',
  );
  const productType = typeProposal?.targetId ?? null;

  return { productName, productDescription, ocrSummary, productType };
}

// ─── Response Parser ─────────────────────────────────────────────────────────

interface RawPageAssignmentResponse {
  pages?: Array<{ pageName?: string; confidence?: number }>;
}

/**
 * Parse the LLM's JSON response for page assignment.
 *
 * Handles markdown code fences, extracts the JSON object, and normalizes
 * various response shapes into a standard `{ pages: [...] }` format.
 */
function parsePageAssignmentResponse(raw: string): RawPageAssignmentResponse | null {
  let cleaned = raw.trim();
  // Remove markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*|```\s*$/gi, '').trim();

  // Locate JSON boundaries
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) return null;

  cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

  try {
    const parsed = JSON.parse(cleaned) as RawPageAssignmentResponse;

    // Accept both { pages: [...] } and { values: [...] } shapes
    if (Array.isArray(parsed.pages)) {
      return parsed;
    }

    // If the LLM returns { values: [...pageNames...] }, convert
    const anyParsed = parsed as any;
    if (Array.isArray(anyParsed.values)) {
      return {
        pages: anyParsed.values.map((v: unknown) => ({
          pageName: String(v),
          confidence: typeof anyParsed.confidence === 'number' ? anyParsed.confidence : 0.55,
        })),
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ─── Core LLM Function ───────────────────────────────────────────────────────

/**
 * Call the LLM to assign category pages to a product.
 *
 * Builds a rich prompt with product identity, VLM OCR summary, store context,
 * and the full page hierarchy. The LLM is constrained to return exact page
 * names from the provided list only.
 *
 * Returns `null` when:
 * - No pages are provided
 * - No LLM config is available for 'category_page_assignment'
 * - The LLM returns invalid/unparseable JSON
 * - No returned page names match the provided list
 */
export async function llmAssignCategoryPages(
  params: PageAssignmentParams,
): Promise<PageAssignmentResult | null> {
  const { productName, productDescription, ocrSummary, productType, pages, maxPages, selectionMode } = params;

  if (pages.length === 0) return null;

  const maxResults = Math.min(maxPages ?? 5, 10);
  const selectionDesc =
    (selectionMode ?? 'multiple') === 'multiple' ? `up to ${maxResults}` : 'one';

  // Format pages with hierarchy info for the prompt
  const pageListStr = pages
    .map(p =>
      p.parentName
        ? `  - ${p.name} (subcategory of: ${p.parentName})`
        : `  - ${p.name}`,
    )
    .join('\n');

  const speciesStr =
    ocrSummary.species.length > 0 ? ocrSummary.species.join(', ') : 'none detected';
  const flavorStr = ocrSummary.flavor ?? 'n/a';
  const lifeStageStr = ocrSummary.lifeStage ?? 'n/a';
  const productFormStr = ocrSummary.productForm ?? 'n/a';
  const healthStr =
    ocrSummary.healthConcern.length > 0 ? ocrSummary.healthConcern.join(', ') : 'n/a';
  const brandStr = ocrSummary.brand ?? 'unknown';
  const productTypeStr = productType ?? 'unspecified';

  const systemPrompt =
    'You are a catalog classifier for a pet and garden supply store. ' +
    'You assign products to the most specific relevant store category pages. ' +
    'You must only choose from the provided page list. Never invent pages.';

  const prompt = `STORE CONTEXT: This is a pet and garden supply store.

PRODUCT IDENTITY:
- Name: ${productName}
- Brand: ${brandStr}
- Product Type: ${productTypeStr}

PACKAGING OCR DATA (from product packaging image):
- Species: ${speciesStr}
- Flavor: ${flavorStr}
- Life Stage: ${lifeStageStr}
- Product Form: ${productFormStr}
- Health Concern: ${healthStr}
- Packaging Name: ${ocrSummary.productName ?? 'n/a'}

PRODUCT DESCRIPTION:
${productDescription || 'No description available.'}

AVAILABLE STORE PAGES (choose from these only):
${pageListStr}

TASK: Select ${selectionDesc} most specific category page(s) this product belongs on.

Rules:
1. Choose only from the pages listed above. Never invent a page name.
2. Species-matching: If the product species is "Dog" or "dogs", do NOT assign to Cat, Fish, Bird, Small Animal, Reptile, or similar non-dog pages.
3. If the product species is "Cat" or "cats", do NOT assign to Dog, Fish, Bird, Small Animal, Reptile, or similar non-cat pages.
4. Prefer the most specific child page over a general parent page (e.g. "Dog Food Dry" over "Dog Food Shop All").
5. Return 1-${maxResults} pages, ranked by relevance from most to least specific.
6. If no pages are a good fit, return an empty array.
7. "Shop All" pages are catch-all pages — only use them as a last resort if no more specific page fits.

Return ONLY valid JSON: {"pages":[{"pageName":"exact page name from the list above","confidence":0.0}]}`;

  try {
    const response = await callLlmForTask(
      'category_page_assignment',
      prompt,
      systemPrompt,
      { allowFallback: true },
    );

    if (!response) return null;

    // Parse the response
    const parsed = parsePageAssignmentResponse(response);
    if (!parsed || !parsed.pages || parsed.pages.length === 0) return null;

    // Validate returned page names against the provided list
    const validPageNames = new Set(pages.map(p => p.name));
    const nameToId = new Map(pages.map(p => [p.name, p.id]));

    const validPages = parsed.pages
      .filter(p => {
        // Case-insensitive match against valid page names
        const match = Array.from(validPageNames).find(
          n => n.toLowerCase() === (p.pageName ?? '').toLowerCase(),
        );
        return match !== undefined;
      })
      .map(p => {
        const matchedName = Array.from(validPageNames).find(
          n => n.toLowerCase() === (p.pageName ?? '').toLowerCase(),
        )!;
        return {
          pageId: nameToId.get(matchedName) ?? '',
          pageName: matchedName,
          confidence:
            typeof p.confidence === 'number'
              ? Math.max(0.35, Math.min(0.95, p.confidence))
              : 0.55,
        };
      })
      .slice(0, maxResults);

    if (validPages.length === 0) return null;

    return { pages: validPages };
  } catch (err: any) {
    console.warn(`[PageAssignmentLLM] LLM call failed: ${err.message}`);
    return null;
  }
}

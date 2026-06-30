import fs from 'fs';
import path from 'path';
import { getDb } from '../db/connection';
import { listPages } from '../db/repositories/page-repo';
import { getLlmConfig, callLlm } from './llm-client';
import { getVlmConfig, callVlm } from './vlm-client';
import type { OnboardingItem, ExtractionData, CurationData } from '../shared/schemas/onboarding';

/**
 * Downloads/reads the local primary image and performs VLM OCR to find the packaging title.
 */
export async function extractPackagingTitle(
  imageUrl: string,
  workspacePath: string
): Promise<string | null> {
  const vlmConfig = getVlmConfig();
  if (!vlmConfig || !vlmConfig.enabled) {
    console.log('[ProductCurator] VLM is not enabled. Skipping packaging OCR.');
    return null;
  }

  // Resolve relative image path to the workspace root
  const resolvedPath = path.resolve(workspacePath, imageUrl);
  if (!fs.existsSync(resolvedPath)) {
    console.warn(`[ProductCurator] Primary image file does not exist at: ${resolvedPath}`);
    return null;
  }

  try {
    console.log(`[ProductCurator] Running OCR on packaging image: ${resolvedPath}`);
    const buffer = fs.readFileSync(resolvedPath);
    const base64Image = buffer.toString('base64');

    const prompt = 'Identify the main product name or title printed on the product packaging/box/bag in this image. Expand any short product tags if they are printed in full on the package. Return ONLY the product title itself. Do not include weights, counts, notes, markdown formatting, or quotes.';
    const ocrResult = await callVlm(prompt, base64Image, vlmConfig);
    
    if (ocrResult && ocrResult.length > 2) {
      console.log(`[ProductCurator] Packaging OCR found: "${ocrResult}"`);
      return ocrResult;
    }
  } catch (err: any) {
    console.warn(`[ProductCurator] Packaging OCR failed: ${err.message}`);
  }

  return null;
}

/**
 * Synthesizes the optimal store product title using all available name signals.
 */
export async function finalizeTitle(signals: {
  name: string;
  brandHint?: string | null;
  webTitle?: string | null;
  ocrTitle?: string | null;
}): Promise<{ title: string; source: 'web' | 'ocr' | 'llm' }> {
  const llmConfig = getLlmConfig();
  
  // If LLM is not configured, fall back to simple consensus logic
  if (!llmConfig) {
    if (signals.ocrTitle) {
      return { title: signals.ocrTitle, source: 'ocr' };
    }
    if (signals.webTitle) {
      return { title: signals.webTitle, source: 'web' };
    }
    return { title: signals.name, source: 'web' };
  }

  try {
    const prompt = `You are a product cataloging assistant for a premium pet supply store.
Analyze the following title candidates for a product and consolidate them into a single, clean, store-ready product name.

Inputs:
- Original Spreadsheet Name: "${signals.name}"
- Web Extracted Title: "${signals.webTitle || 'N/A'}"
- OCR Packaging Title: "${signals.ocrTitle || 'N/A'}"
- Brand Name: "${signals.brandHint || 'N/A'}"

Rules for final product name:
1. It must be clean, readable, professional, and customer-friendly.
2. It must align closely with the packaging OCR title if provided and accurate, but should sound like a natural product name.
3. The Brand Name ("${signals.brandHint || ''}") MUST be included, ideally at the very beginning (e.g. "Dr. Marty Bark Stoppers Digestion Formula").
4. Strip all internal inventory codes, size codes (like "5CT" or "SM"), and pricing/bulk packaging notes from the end.
5. Clean up casing issues (e.g. "DR MARTY" -> "Dr. Marty", "YAK DNTL" -> "Yak Dental").
6. Return ONLY the finalized product name. Do not explain your reasoning or add any quotes or markdown formatting.`;

    const cleanTitle = await callLlm(prompt, 'You are a clean product taxonomy assistant.');
    if (cleanTitle && cleanTitle.length > 2) {
      console.log(`[ProductCurator] LLM consolidated title: "${cleanTitle}"`);
      return { title: cleanTitle, source: 'llm' };
    }
  } catch (err: any) {
    console.warn(`[ProductCurator] LLM title consolidation failed: ${err.message}`);
  }

  // Fallback
  return { title: signals.webTitle || signals.name, source: 'web' };
}

/**
 * Classifies product into store category pages and determines the product type.
 */
export async function classifyProduct(
  title: string,
  description: string | null
): Promise<{ suggestedPages: string[]; suggestedProductType: string | null }> {
  const llmConfig = getLlmConfig();
  const pages = listPages().map(p => p.name);
  
  let suggestedPages: string[] = [];
  let suggestedProductType: string | null = null;

  if (!llmConfig) {
    return { suggestedPages: [], suggestedProductType: null };
  }

  // 1. Suggest Pages (if taxonomy pages exist)
  if (pages.length > 0) {
    try {
      const pageListStr = pages.map(p => `"${p}"`).join(', ');
      const prompt = `You are a product cataloging assistant for a pet supply store.
Classify the product "${title}" into one or more of our store categories.

Description: "${description || 'No description available.'}"

Available Categories: [ ${pageListStr} ]

Rules:
1. Select the most specific category or categories that fit the product.
2. Return a JSON array of strings containing ONLY matching categories from the Available Categories list.
3. If no categories match, return an empty array [].
4. Return ONLY valid JSON and nothing else. Do not wrap in markdown code blocks.`;

      const responseText = await callLlm(prompt, 'You are a precise JSON classifier.');
      const parsed = JSON.parse(responseText.trim());
      if (Array.isArray(parsed)) {
        suggestedPages = parsed.filter(p => pages.includes(p));
        console.log(`[ProductCurator] Suggested pages for "${title}":`, suggestedPages);
      }
    } catch (err: any) {
      console.warn(`[ProductCurator] Page classification failed: ${err.message}`);
    }
  }

  // 2. Classify Product Type
  try {
    const prompt = `Classify this product into a single, clean product type (e.g. "Dry Dog Food", "Wet Dog Food", "Dog Treats", "Dog Toys", "Dry Cat Food", "Wet Cat Food", "Cat Treats", "Litter", "Supplements", "Grooming", "Collars & Leashes", "Cages & Crates", etc.).
Product Name: "${title}"
Description: "${description || ''}"
Return ONLY the product type name. Do not add markdown or punctuation.`;

    const typeResponse = await callLlm(prompt, 'You are a precise classification assistant.');
    suggestedProductType = typeResponse.replace(/[".]/g, '').trim();
    console.log(`[ProductCurator] Suggested product type for "${title}": "${suggestedProductType}"`);
  } catch (err: any) {
    console.warn(`[ProductCurator] Product type classification failed: ${err.message}`);
  }

  return { suggestedPages, suggestedProductType };
}

/**
 * Main curation pipeline orchestrator.
 */
export async function curateItem(
  item: OnboardingItem,
  workspacePath: string
): Promise<CurationData> {
  const ext = item.extractionData;
  if (!ext) {
    throw new Error('Cannot curate item without extraction data.');
  }

  console.log(`[ProductCurator] Starting curation for: "${item.name}"`);

  // Step 1: Packaging OCR if available
  let ocrTitle: string | null = null;
  if (ext.primaryImage) {
    ocrTitle = await extractPackagingTitle(ext.primaryImage, workspacePath);
  }

  // Step 2: Title finalization
  const finalized = await finalizeTitle({
    name: item.name,
    brandHint: item.brandHint,
    webTitle: ext.title,
    ocrTitle: ocrTitle,
  });

  // Step 3: Page & Category Classification
  const classification = await classifyProduct(finalized.title, ext.description);

  return {
    curatedTitle: finalized.title,
    packagingOcrTitle: ocrTitle,
    titleSource: finalized.source,
    suggestedPages: classification.suggestedPages,
    suggestedProductType: classification.suggestedProductType,
    curatedAt: new Date().toISOString(),
    curationMethod: 'auto',
  };
}

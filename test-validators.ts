import { sanitizeSnapshotHtml } from '/Users/nickborrello/Desktop/Projects/shopsite-cms/src/server/services/profile-builder/sanitizeSnapshotHtml';
import { validateAndRankSelectors } from '/Users/nickborrello/Desktop/Projects/shopsite-cms/src/server/services/profile-builder/selectorValidator';
import { readFileSync } from 'node:fs';

const html = readFileSync('/Users/nickborrello/Desktop/Projects/shopsite-cms/.shopsite-cms/artifacts/profile-builder/instinctpetfood.com/snapshot-1783678000493-adb7/page.html', 'utf-8');
const sanitized = sanitizeSnapshotHtml(html);

const fieldResults: Record<string, { notFound: boolean; candidates: Array<{ selector: string; evidence: string }> }> = {
  titleSelector: { notFound: false, candidates: [{ selector: '.sticky-add-to-cart__title', evidence: 'Sticky add to cart title' }] },
  descriptionSelector: { notFound: false, candidates: [{ selector: '.product-accordion:first-of-type .faq-item__answer .rte', evidence: 'Product description accordion' }] },
  imagesSelector: { notFound: false, candidates: [{ selector: '.product-media-container--image img.product-media__image', evidence: 'Product images' }] },
  weightSelector: { notFound: false, candidates: [{ selector: '.sticky-add-to-cart__option:last-of-type', evidence: 'Weight option' }] },
  flavorSelector: { notFound: false, candidates: [{ selector: '.variant-option:first-of-type .variant-option__legend-value', evidence: 'Flavor option' }] },
  speciesSelector: { notFound: false, candidates: [{ selector: '.instinct-species-tag__label', evidence: 'Species tag' }] },
  dietaryLabelsSelector: { notFound: false, candidates: [{ selector: '.product-benefits__icon-label', evidence: 'Dietary benefit labels' }] },
  keyIngredientsSelector: { notFound: false, candidates: [{ selector: '.product-ingredients__label', evidence: 'Key ingredients' }] },
};

const fieldDefs = [
  { key: 'titleSelector', valueType: 'text', multiple: false },
  { key: 'descriptionSelector', valueType: 'html', multiple: false },
  { key: 'imagesSelector', valueType: 'image', multiple: true },
  { key: 'weightSelector', valueType: 'text', multiple: false },
  { key: 'flavorSelector', valueType: 'text', multiple: false },
  { key: 'speciesSelector', valueType: 'text', multiple: false },
  { key: 'dietaryLabelsSelector', valueType: 'list', multiple: true },
  { key: 'keyIngredientsSelector', valueType: 'text', multiple: false },
];

const results = validateAndRankSelectors(sanitized.html, fieldResults, fieldDefs);

for (const [key, result] of Object.entries(results)) {
  console.log(`\n${key}:`);
  console.log(`  status: ${result.status}`);
  console.log(`  quality: ${result.quality}`);
  console.log(`  matched: ${result.validation.matchedCount}`);
  console.log(`  visible: ${result.validation.visibleMatchedCount}`);
  console.log(`  warnings: ${result.warnings.map(w => w.code + ': ' + w.message).join('; ')}`);
  if (result.preview?.text) console.log(`  preview: ${result.preview.text.slice(0, 100)}`);
  if (result.preview?.imageUrls) console.log(`  images: ${result.preview.imageUrls.length} urls`);
}

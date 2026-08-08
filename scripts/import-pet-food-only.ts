import fs from 'node:fs';
import path from 'node:path';
import { fetchOpenPetFoodFactsByGtin } from '../src/crawler/importers/open-pet-food-facts.js';
import { DatasetExporter } from '../src/crawler/dataset-exporter.js';
import type { ScrapedProductEvidence } from '../src/crawler/corpus-schema.js';

interface CatalogProductFile {
  core?: {
    name?: string;
    description?: string;
  };
  shopsite?: {
    preserved?: {
      advancedBlocks?: {
        ProductOnPages?: string;
      };
    };
  };
}

async function main() {
  const args = process.argv.slice(2);
  // Network gate: this script calls the Open Pet Food Facts API over the
  // network. It must never run without an explicit operator flag.
  if (!args.includes('--allow-network')) {
    console.error('\n⛔ Refusing to run without an explicit operator flag.');
    console.error('   This script performs LIVE network API calls.');
    console.error('   Run it explicitly with: bun scripts/import-pet-food-only.ts --allow-network');
    process.exit(1);
  }

  const catalogDir = path.resolve('storage/catalog/products');
  if (!fs.existsSync(catalogDir)) {
    console.error('❌ Catalog directory not found:', catalogDir);
    process.exit(1);
  }

  const files = fs.readdirSync(catalogDir).filter((f) => f.endsWith('.json'));
  console.log(`📦 Scanning ${files.length} catalog files for Dog Food & Cat Food items...`);

  const petFoodItems: Array<{ gtin: string; name: string; file: string }> = [];

  const petFoodRegex = /\b(dog food|cat food|kibble|canned food|wet food|dry food|puppy food|kitten food|dog treat|cat treat|canine|feline|formula|biscuit|chews)\b/i;

  for (const file of files) {
    const rawGtin = file.replace('.json', '').replace(/[^0-9]/g, '');
    if (rawGtin.length < 10 || rawGtin.length > 14) continue;

    try {
      const content = fs.readFileSync(path.join(catalogDir, file), 'utf-8');
      const item = JSON.parse(content) as CatalogProductFile;

      const name = item.core?.name || '';
      const desc = item.core?.description || '';
      const pages = item.shopsite?.preserved?.advancedBlocks?.ProductOnPages || '';

      const fullText = `${name} ${desc} ${pages}`;

      if (petFoodRegex.test(fullText)) {
        petFoodItems.push({ gtin: rawGtin, name, file });
      }
    } catch {
      // Ignore invalid JSON files
    }
  }

  console.log(`✅ Filtered ${petFoodItems.length} Dog & Cat Food products out of ${files.length} total catalog items!`);

  const targetBatch = petFoodItems.slice(0, 100);
  console.log(`🚀 Starting Open Pet Food Facts GTIN barcode import for ${targetBatch.length} Dog & Cat Food items...`);

  const items: ScrapedProductEvidence[] = [];

  for (const p of targetBatch) {
    console.log(`   🔍 Checking GTIN ${p.gtin} ("${p.name}")...`);
    const evidence = await fetchOpenPetFoodFactsByGtin(p.gtin);
    if (evidence) {
      console.log(`      ✅ MATCH: "${evidence.title}" [Brand: ${evidence.brand || 'Unknown'}]`);
      items.push(evidence);
    } else {
      console.log(`      ⚠️ No Open Pet Food Facts record found for GTIN ${p.gtin}`);
    }
  }

  console.log(`\n✅ Import complete! Retrieved ${items.length}/${targetBatch.length} pet food product sheets.`);

  const exporter = new DatasetExporter();
  const metrics = exporter.computeMetrics(items);

  console.log('\n📊 Dataset Quality Metrics:');
  console.log(`   Total Items: ${metrics.totalItems}`);
  console.log(`   UPC/GTIN Coverage: ${(metrics.upcCoverage * 100).toFixed(0)}%`);
  console.log(`   Brand Coverage: ${(metrics.brandCoverage * 100).toFixed(0)}%`);
  console.log(`   Breadcrumb Coverage: ${(metrics.breadcrumbCoverage * 100).toFixed(0)}%`);
  console.log(`   Specifications Coverage: ${(metrics.specsCoverage * 100).toFixed(0)}%`);

  if (items.length > 0) {
    const savedPath = await exporter.exportToJsonl('openpetfoodfacts.org', items);
    console.log(`\n💾 Saved open pet food corpus data to: ${savedPath}`);
  }
}

main().catch(console.error);

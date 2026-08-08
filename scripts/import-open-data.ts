import fs from 'node:fs';
import path from 'node:path';
import { fetchOpenPetFoodFactsByGtin } from '../src/crawler/importers/open-pet-food-facts.js';
import { fetchOpenIcecatByGtin } from '../src/crawler/importers/icecat.js';
import { DatasetExporter } from '../src/crawler/dataset-exporter.js';
import type { ScrapedProductEvidence } from '../src/crawler/corpus-schema.js';

async function main() {
  const args = process.argv.slice(2);
  // Network gate: this script calls the Open Pet Food Facts / Icecat APIs over
  // the network. It must never run without an explicit operator flag.
  if (!args.includes('--allow-network')) {
    console.error('\n⛔ Refusing to run without an explicit operator flag.');
    console.error('   This script performs LIVE network API calls.');
    console.error('   Run it explicitly with: bun scripts/import-open-data.ts --allow-network');
    process.exit(1);
  }
  const sourceArg = args.find((a) => a.startsWith('--source='))?.split('=')[1] || 'openpetfoodfacts';
  const gtinArg = args.find((a) => a.startsWith('--gtins='))?.split('=')[1];
  const fileArg = args.find((a) => a.startsWith('--file='))?.split('=')[1];
  const limitArg = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] || '100', 10);
  const useCatalogArg = args.includes('--use-local-catalog');

  let gtins: string[] = [];

  if (gtinArg) {
    gtins = gtinArg.split(',').map((g) => g.trim()).filter(Boolean);
  } else if (fileArg && fs.existsSync(fileArg)) {
    const fileContent = fs.readFileSync(fileArg, 'utf-8');
    gtins = fileContent
      .split(/\r?\n/)
      .map((line) => line.split(',')[0].trim().replace(/"/g, ''))
      .filter((g) => /^[0-9]{8,14}$/.test(g));
  } else if (useCatalogArg) {
    const catalogDir = path.resolve('storage/catalog/products');
    if (fs.existsSync(catalogDir)) {
      const files = fs.readdirSync(catalogDir).filter((f) => f.endsWith('.json'));
      gtins = files
        .map((f) => f.replace('.json', '').replace(/[^0-9]/g, ''))
        .filter((g) => g.length >= 10 && g.length <= 14);
      console.log(`📦 Found ${files.length} catalog files in local workspace (${gtins.length} valid GTINs).`);
    }
  }

  if (gtins.length === 0) {
    gtins = [
      '0070158005028', // Zignature Lamb
      '0073259000018', // Purina Dog Chow
      '0023100010839', // Pedigree Adult Dry Dog Food
      '0015000070008', // Purina One SmartBlend
      '0076840000021', // Blue Buffalo Life Protection
    ];
  }

  const targetGtins = gtins.slice(0, limitArg);

  console.log(`🚀 Starting $0 Open Data Import [Source: ${sourceArg}]`);
  console.log(`   Input GTIN target count: ${targetGtins.length} (out of ${gtins.length} total)`);

  const items: ScrapedProductEvidence[] = [];

  for (const gtin of targetGtins) {
    console.log(`   🔍 Looking up GTIN: ${gtin}...`);
    let item: ScrapedProductEvidence | null = null;

    if (sourceArg === 'openpetfoodfacts' || sourceArg === 'all') {
      item = await fetchOpenPetFoodFactsByGtin(gtin);
    }
    if (!item && (sourceArg === 'icecat' || sourceArg === 'all')) {
      item = await fetchOpenIcecatByGtin(gtin);
    }

    if (item) {
      console.log(`      ✅ Found: "${item.title}" [Brand: ${item.brand || 'Unknown'}]`);
      items.push(item);
    } else {
      console.log(`      ⚠️ Not found in ${sourceArg}`);
    }
  }

  console.log(`\n✅ Import complete! Retrieved ${items.length}/${targetGtins.length} structured product sheets.`);

  const exporter = new DatasetExporter();
  const metrics = exporter.computeMetrics(items);

  console.log('\n📊 Dataset Quality Metrics:');
  console.log(`   Total Items: ${metrics.totalItems}`);
  console.log(`   UPC/GTIN Coverage: ${(metrics.upcCoverage * 100).toFixed(0)}%`);
  console.log(`   Brand Coverage: ${(metrics.brandCoverage * 100).toFixed(0)}%`);
  console.log(`   Breadcrumb Coverage: ${(metrics.breadcrumbCoverage * 100).toFixed(0)}%`);
  console.log(`   Specifications Coverage: ${(metrics.specsCoverage * 100).toFixed(0)}%`);

  if (items.length > 0) {
    const targetDomain = sourceArg === 'openpetfoodfacts' ? 'openpetfoodfacts.org' : 'icecat.biz';
    const savedPath = await exporter.exportToJsonl(targetDomain, items);
    console.log(`\n💾 Saved open corpus data to: ${savedPath}`);
  }
}

main().catch((err) => {
  console.error('❌ Open data import failed:', err);
  process.exit(1);
});

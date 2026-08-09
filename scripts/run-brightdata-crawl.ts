import { BrightDataScraperClient } from '../src/crawler/importers/brightdata-scraper.js';
import { DatasetExporter } from '../src/crawler/dataset-exporter.js';
import type { ScrapedProductEvidence } from '../src/crawler/corpus-schema.js';

const CHEWY_TARGET_URLS = [
  'https://www.chewy.com/dp/102534', // Blue Buffalo Life Protection Dry Dog Food
  'https://www.chewy.com/dp/34821',  // Purina ONE SmartBlend Dry Dog Food
  'https://www.chewy.com/dp/102550', // Blue Wilderness High Protein Dry Cat Food
  'https://www.chewy.com/dp/36319',  // Fancy Feast Gourmet Wet Cat Food
  'https://www.chewy.com/dp/111425', // Greenies Original Teenie Dental Dog Treats
];

async function main() {
  const args = process.argv.slice(2);
  // Paid gate: Bright Data is a paid cloud-scraper provider. This script
  // triggers paid jobs and must never run without an explicit operator flag.
  if (!args.includes('--allow-paid')) {
    console.error('\n⛔ Refusing to run without an explicit operator flag.');
    console.error('   This script triggers PAID Bright Data cloud scraper jobs.');
    console.error('   Run it explicitly with: bun scripts/run-brightdata-crawl.ts --allow-paid');
    process.exit(1);
  }
  const client = new BrightDataScraperClient();

  console.log('🚀 Triggering Bright Data Cloud Scraper for Chewy Products...');
  console.log(`   Target URL count: ${CHEWY_TARGET_URLS.length}`);

  const datasetId = process.env.BRIGHT_DATA_CHEWY_DATASET_ID || 'gd_m6gjtfmeh43we6cqc';

  try {
    const snapshotId = await client.triggerScraper(datasetId, CHEWY_TARGET_URLS);
    console.log(`\n✅ Scraper job triggered! Snapshot ID: ${snapshotId}`);
    console.log(`   Waiting for Bright Data cloud scrapers to render Chewy pages...`);

    let attempts = 0;
    let rawItems: any[] = [];

    while (attempts < 15) {
      attempts++;
      console.log(`   [Attempt ${attempts}/15] Polling Bright Data snapshot ${snapshotId}...`);

      try {
        const data = await client.getSnapshotData(snapshotId);
        if (Array.isArray(data) && data.length > 0) {
          const first = data[0] as any;
          if (first && first.status === 'running') {
            console.log(`      ⏳ Status: running ("${first.message || 'Processing on cloud'}"). Retrying in 15s...`);
          } else {
            console.log(`      🎉 Cloud scrape complete! Retrieved ${data.length} product records.`);
            rawItems = data;
            break;
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`      ⏳ Waiting for results (${message}). Retrying in 15s...`);
      }

      await new Promise((r) => setTimeout(r, 15000));
    }

    if (rawItems.length === 0) {
      console.log(`\n⏳ Cloud scraper job is still running on Bright Data. Snapshot ID: ${snapshotId}`);
      console.log(`   You can check snapshot results anytime with:`);
      console.log(`   bun -e "import { BrightDataScraperClient } from './src/crawler/importers/brightdata-scraper.ts'; new BrightDataScraperClient().getSnapshotData('${snapshotId}').then(console.log)"`);
      return;
    }

    const items: ScrapedProductEvidence[] = [];
    for (const raw of rawItems) {
      const normalized = client.normalizeChewyItem(raw);
      if (normalized) items.push(normalized);
    }

    console.log(`\n✅ Normalized ${items.length} training evidence items.`);

    const exporter = new DatasetExporter();
    const metrics = exporter.computeMetrics(items);

    console.log('\n📊 Dataset Quality Metrics:');
    console.log(`   Total Items: ${metrics.totalItems}`);
    console.log(`   UPC/GTIN Coverage: ${(metrics.upcCoverage * 100).toFixed(0)}%`);
    console.log(`   Brand Coverage: ${(metrics.brandCoverage * 100).toFixed(0)}%`);
    console.log(`   Breadcrumb Coverage: ${(metrics.breadcrumbCoverage * 100).toFixed(0)}%`);
    console.log(`   Specifications Coverage: ${(metrics.specsCoverage * 100).toFixed(0)}%`);

    if (items.length > 0) {
      const savedPath = await exporter.exportToJsonl('chewy.com', items);
      console.log(`\n💾 Saved corpus data to: ${savedPath}`);
    }
  } catch (err) {
    console.error('❌ Bright Data Cloud Crawl Error:', err);
  }
}

main().catch(console.error);

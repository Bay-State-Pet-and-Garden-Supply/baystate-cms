import { TrainingCorpusCrawler } from '../src/crawler/base-crawler.js';
import { DatasetExporter } from '../src/crawler/dataset-exporter.js';
import type { SiteCrawlConfig } from '../src/crawler/corpus-schema.js';

const PRESET_DOMAINS: Record<string, SiteCrawlConfig> = {
  'chewy.com': {
    domain: 'chewy.com',
    startUrls: [
      'https://www.chewy.com/b/dry-food-294',
      'https://www.chewy.com/b/treats-335',
    ],
    maxItems: 50,
    maxConcurrency: 2,
    requestDelayMs: 1000,
    useBrowser: false,
  },
  'tractorsupply.com': {
    domain: 'tractorsupply.com',
    startUrls: [
      'https://www.tractorsupply.com/tsc/catalog/dog-food',
      'https://www.tractorsupply.com/tsc/catalog/lawn-fertilizer',
    ],
    maxItems: 50,
    maxConcurrency: 2,
    requestDelayMs: 1000,
    useBrowser: false,
  },
  'burpee.com': {
    domain: 'burpee.com',
    startUrls: [
      'https://www.burpee.com/tomato-brandywine-pink-prod000958.html',
      'https://www.burpee.com/sunflower-sunrich-gold-prod000412.html',
      'https://www.burpee.com/vegetables/tomatoes/',
    ],
    maxItems: 50,
    maxConcurrency: 2,
    requestDelayMs: 1000,
    useBrowser: false,
  },
  'acehardware.com': {
    domain: 'acehardware.com',
    startUrls: [
      'https://www.acehardware.com/departments/outdoor-living/lawn-and-garden/lawn-care',
    ],
    maxItems: 50,
    maxConcurrency: 2,
    requestDelayMs: 1000,
    useBrowser: false,
  },
  'purina.com': {
    domain: 'purina.com',
    startUrls: [
      'https://www.purina.com/dogs/dry-dog-food',
      'https://www.purina.com/cats/dry-cat-food',
    ],
    maxItems: 50,
    maxConcurrency: 2,
    requestDelayMs: 1000,
    useBrowser: false,
  },
  'bonide.com': {
    domain: 'bonide.com',
    startUrls: [
      'https://bonide.com/products/insect-control/',
      'https://bonide.com/products/weed-control/',
    ],
    maxItems: 50,
    maxConcurrency: 2,
    requestDelayMs: 1000,
    useBrowser: false,
  },
  'scotts.com': {
    domain: 'scotts.com',
    startUrls: [
      'https://scotts.com/en-us/shop/fertilizer/',
      'https://scotts.com/en-us/shop/grass-seed/',
    ],
    maxItems: 50,
    maxConcurrency: 2,
    requestDelayMs: 1000,
    useBrowser: false,
  },
};

async function main() {
  const args = process.argv.slice(2);
  // Network gate: the crawler makes live HTTP requests to retail sites.
  // It must never run without an explicit operator flag.
  if (!args.includes('--allow-network')) {
    console.error('\n⛔ Refusing to crawl without an explicit operator flag.');
    console.error('   This script performs LIVE network crawls of retail sites.');
    console.error('   Run it explicitly with: bun scripts/crawl-corpus.ts --allow-network');
    process.exit(1);
  }
  const domainArg = args.find((a) => a.startsWith('--domain='))?.split('=')[1] || 'chewy.com';
  const maxItemsArg = args.find((a) => a.startsWith('--max-items='))?.split('=')[1];
  const useBrowserArg = args.includes('--use-browser');

  const preset = PRESET_DOMAINS[domainArg] || {
    domain: domainArg,
    startUrls: [`https://www.${domainArg}`],
    maxItems: 20,
    maxConcurrency: 2,
    requestDelayMs: 1000,
    useBrowser: false,
  };

  if (maxItemsArg) {
    preset.maxItems = parseInt(maxItemsArg, 10);
  }
  if (useBrowserArg) {
    preset.useBrowser = true;
  }

  console.log(`🚀 Starting training corpus crawl for domain: ${preset.domain}`);
  console.log(`   Target item cap: ${preset.maxItems}`);
  console.log(`   Start URLs:`, preset.startUrls);

  const crawler = new TrainingCorpusCrawler(preset);
  const items = await crawler.run();

  console.log(`\n✅ Crawl complete! Collected ${items.length} product evidence items.`);

  const exporter = new DatasetExporter();
  const metrics = exporter.computeMetrics(items);

  console.log('📊 Dataset Quality Metrics:');
  console.log(`   Total Items: ${metrics.totalItems}`);
  console.log(`   UPC/GTIN Coverage: ${(metrics.upcCoverage * 100).toFixed(0)}%`);
  console.log(`   Brand Coverage: ${(metrics.brandCoverage * 100).toFixed(0)}%`);
  console.log(`   Breadcrumb Coverage: ${(metrics.breadcrumbCoverage * 100).toFixed(0)}%`);
  console.log(`   Specifications Coverage: ${(metrics.specsCoverage * 100).toFixed(0)}%`);

  if (items.length > 0) {
    const savedPath = await exporter.exportToJsonl(preset.domain, items);
    console.log(`\n💾 Saved corpus data to: ${savedPath}`);
  }
}

main().catch((err) => {
  console.error('❌ Crawlers execution failed:', err);
  process.exit(1);
});

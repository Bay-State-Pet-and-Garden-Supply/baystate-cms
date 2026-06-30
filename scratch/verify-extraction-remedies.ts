import { initDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { extractProductData } from '../src/onboarding/page-extractor';
import { getDomainStatus, clearDomainStatus } from '../src/db/repositories/domain-status-repo';
import path from 'path';

const DB_PATH = path.resolve(__dirname, '../workspaces/Bay State/.shopsite-cms/app.db');

const TEST_PDPs = [
  {
    label: 'WOOF (Poomergency)',
    url: 'https://mywoof.com/products/poomergency',
    expected: { name: 'WOOF POOMERGENCY LAVENDER', brandHint: 'WOOF' }
  },
  {
    label: 'NYLABONE (Chew Toy)',
    url: 'https://www.nylabone.com/products/product-type/chew-toys/power-chew/power-chew-teddy-bear-bone-dog-chew-toy',
    expected: { name: 'NYLABONE BEAR BONE BEEF LG', brandHint: 'NYLABONE' }
  },
  {
    label: 'INSTINCT (Wet Cat Food)',
    url: 'https://instinctpetfood.com/products/instinct-pate-split-cup-real-chicken-entree-grain-free-wet-cat-food/',
    expected: { name: 'INSTINCT CAT PATE CHKN SPLIT CUP 2.64OZ', brandHint: 'INSTINCT' }
  },
  {
    label: 'DR MARTY (Dental Chew)',
    url: 'https://pricepowerusa.com/product/06863', // Catalog mismatch
    expected: { name: 'DR MARTY YAK DNTL SM5CT BARK STOPPER', brandHint: 'DR MARTY' }
  },
  {
    label: 'EARTH ANIMAL (No Hide Rolls)',
    url: 'https://earthanimal.com/product/no-hide-seasonal-collection-strawberries-cream-rolls/', // WAF / Cloudflare block
    expected: { name: 'EARTH ANIMAL NO HIDE STRWB CHEW SM 6PK', brandHint: 'EARTH ANIMAL' }
  },
  {
    label: 'CHEF\'S CUT (Teriyaki Stick)',
    url: 'https://chefscutrealjerky.com/products/asian-style-teriyaki-1', // Store down / unavailable
    expected: { name: 'CHEF\'S CUT TERIYAKE STICK', brandHint: 'CHEF\'S CUT' }
  }
];

async function run() {
  console.log('🧪 Starting live extraction remedies verification on the 6 target PDPs...');
  console.log('========================================================================\n');

  initDb(DB_PATH);
  runMigrations();

  // Clear domain status before testing to ensure we start fresh
  for (const item of TEST_PDPs) {
    try {
      const domain = new URL(item.url).hostname.replace(/^www\./, '');
      clearDomainStatus(domain);
    } catch {
      // ignore
    }
  }

  for (let i = 0; i < TEST_PDPs.length; i++) {
    const item = TEST_PDPs[i];
    console.log(`\n[${i + 1}/${TEST_PDPs.length}] Extracting: ${item.url} (${item.label})`);
    console.log(`   Expected Name: "${item.expected.name}"`);

    try {
      const start = Date.now();
      const result = await extractProductData(item.url, item.expected);
      const duration = ((Date.now() - start) / 1000).toFixed(1);

      console.log(`   ✅ Succeeded in ${duration}s!`);
      console.log(`      Title: "${result.title}"`);
      console.log(`      Brand: "${result.brand}"`);
      console.log(`      Price: ${result.price} (Provenance: ${result.fieldProvenance.price ?? 'none'})`);
      console.log(`      Primary Image: ${result.primaryImage ? 'Yes' : 'No'} (+ ${result.additionalImages.length} additional)`);
      console.log(`      Confidence Score: ${Math.round(result.confidence * 100)}%`);
    } catch (err: any) {
      console.log(`   ❌ Failed: ${err.message}`);
    }

    // Print Domain Status if recorded
    try {
      const domain = new URL(item.url).hostname.replace(/^www\./, '');
      const status = getDomainStatus(domain);
      if (status) {
        console.log(`      Recorded Domain Status: [${status.status.toUpperCase()}] Reason: ${status.reason || 'None'}`);
      } else {
        console.log(`      No Domain Status recorded (it was deleted or not set)`);
      }
    } catch {
      // ignore
    }

    console.log('------------------------------------------------------------------------');
  }

  console.log('\n✨ Verification script finished.');
}

run().catch(console.error);

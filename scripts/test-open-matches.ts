import fs from 'node:fs';
import path from 'node:path';
import { fetchOpenPetFoodFactsByGtin } from '../src/crawler/importers/open-pet-food-facts.js';

async function testMatches() {
  const catalogDir = path.resolve('storage/catalog/products');
  const files = fs.readdirSync(catalogDir).filter((f) => f.endsWith('.json'));
  const gtins = files
    .map((f) => f.replace('.json', '').replace(/[^0-9]/g, ''))
    .filter((g) => g.length >= 10 && g.length <= 14);

  console.log(`Checking ${gtins.length} GTINs...`);

  let matches = 0;
  for (let i = 0; i < Math.min(500, gtins.length); i++) {
    const gtin = gtins[i];
    const res = await fetchOpenPetFoodFactsByGtin(gtin);
    if (res) {
      matches++;
      console.log(`✅ MATCH [${matches}]: GTIN ${gtin} -> "${res.title}" (${res.brand})`);
    }
  }

  console.log(`Done! Found ${matches} matches in first 500 catalog GTINs.`);
}

testMatches().catch(console.error);

import { initDb } from '../src/db/connection';
import { upsertApiKey } from '../src/db/repositories/api-key-repo';
import { curateItem } from '../src/onboarding/product-curator';
import type { OnboardingItem } from '../src/shared/schemas/onboarding';
import path from 'path';

const DB_PATH = path.resolve(__dirname, '../workspaces/Bay State/.shopsite-cms/app.db');
const WORKSPACE_PATH = path.resolve(__dirname, '../workspaces/Bay State');

async function test() {
  initDb(DB_PATH);

  console.log('🔌 Configuring Ollama VLM in database...');
  upsertApiKey('ollama_vlm', 'enabled', 'http://localhost:11434', 'qwen2.5vl:latest');

  // Woof Poomergency product details
  const mockItem: OnboardingItem = {
    id: 'test-curation-item-id',
    batchId: 'test-batch-id',
    upc: '850067859604',
    name: 'WOOF POOMERGENCY 10CT BOX',
    price: '24.99',
    quantity: 50,
    brandHint: 'WOOF',
    departmentHint: 'Dog Supplies',
    sourceUrl: 'https://mywoof.com/products/poomergency',
    status: 'needs_review',
    errorMessage: null,
    retryCount: 0,
    isDuplicate: false,
    existingSku: null,
    extractionData: {
      title: 'Poomergency - Quick Relief Digestive Supplement for Dogs - Woof',
      brand: 'Woof',
      description: 'Quick relief digestive supplement for dogs, helps with loose stools and diarrhea.',
      bulletPoints: ['Fast acting', 'Made in USA'],
      primaryImage: 'products/850067859604/images/primary.png',
      additionalImages: [],
      price: '24.99',
      weight: '8 oz',
      dimensions: null,
      seoFileName: 'poomergency-digestive-supplement',
      searchKeywords: 'poomergency woof digestive supplement',
      sourceUrl: 'https://mywoof.com/products/poomergency',
      confidence: 0.9,
      fieldProvenance: { title: 'meta', price: 'html' },
      packagingTitle: null
    },
    curationData: null,
    rowNumber: 4,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  console.log('✨ Running product curator curation pipeline...');
  const curationResult = await curateItem(mockItem, WORKSPACE_PATH);

  console.log('\n🎉 Curation Pipeline Result:');
  console.log(JSON.stringify(curationResult, null, 2));
}

test().catch(console.error);

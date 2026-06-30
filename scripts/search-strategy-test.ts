#!/usr/bin/env bun
/**
 * Search Strategy Test Harness
 *
 * Runs the production two-pass discovery strategy (UPC -> LLM Name -> Scoped search)
 * and compares it to standard query methods.
 *
 * Usage: bun run scripts/search-strategy-test.ts
 * Outputs: scripts/search-test-results.md
 */

import { initDb } from '../src/db/connection';
import { getApiKey } from '../src/db/repositories/api-key-repo';
import { upsertBrandSite } from '../src/db/repositories/brand-site-repo';
import { discoverSources } from '../src/onboarding/source-discovery';
import { getLlmConfig } from '../src/onboarding/llm-client';
import { writeFileSync } from 'fs';
import path from 'path';

// ─── Configuration ──────────────────────────────────────────────────────────────

const DB_PATH = path.resolve(__dirname, '../workspaces/Bay State/.shopsite-cms/app.db');

const TEST_SAMPLES = [
  // 3 × WOOF
  { upc: '850067859598', registerName: 'WOOF POOMERGENCY LAVENDER', brand: 'WOOF', domain: 'mywoof.com' },
  { upc: '850067859659', registerName: 'WOOF HONESTCHEW ANTLER SM', brand: 'WOOF', domain: 'mywoof.com' },
  { upc: '850067859826', registerName: 'WOOF FORAGER NOMCHUCK', brand: 'WOOF', domain: 'mywoof.com' },
  // 2 × HONEST KITCHEN
  { upc: '850001022446', registerName: 'HONEST KITCHEN BUTCHER PATE CHKN 10.5OZ', brand: 'HONEST', domain: 'thehonestkitchen.com' },
  { upc: '850001022484', registerName: 'HONEST KITCHEN BUTCHER PATE TRKY 10.5OZ', brand: 'HONEST', domain: 'thehonestkitchen.com' },
  // 1 × NYLABONE
  { upc: '018214859437', registerName: 'NYLABONE BEAR BONE BEEF LG', brand: 'NYLABONE', domain: 'nylabone.com' },
  // 1 × INSTINCT
  { upc: '769949610120', registerName: 'INSTINCT CAT PATE CHKN SPLIT CUP 2.64OZ', brand: 'INSTINCT', domain: 'instinctpetfood.com' },
  // 1 × DR MARTY
  { upc: '850068229185', registerName: 'DR MARTY YAK DNTL SM5CT BARK STOPPER', brand: 'DR MARTY', domain: 'drmartypets.com' },
  // 1 × EARTH ANIMAL
  { upc: '810132876011', registerName: 'EARTH ANIMAL NO HIDE STRWB CHEW SM 6PK', brand: 'EARTH ANIMAL', domain: 'earthanimal.com' },
  // 1 × Oddball
  { upc: '858959005597', registerName: "CHEF'S CUT TERIYAKE STICK", brand: "CHEF'S CUT", domain: 'chefscutrealjerky.com' },
];

async function main() {
  console.log('🔬 Search Strategy & Production Verification Harness');
  console.log('===================================================\n');

  // Initialize DB to read keys
  initDb(DB_PATH);
  const apiKeyRow = getApiKey('serper');
  if (!apiKeyRow?.api_key) {
    console.error('❌ No Serper.dev API key found in database. Add it via Onboarding Settings first.');
    process.exit(1);
  }
  console.log('✅ Serper API key loaded.');

  const llmConfig = getLlmConfig();
  if (llmConfig) {
    console.log(`✅ Active LLM Provider: ${llmConfig.provider} (${llmConfig.model})`);
  } else {
    console.log('⚠️ No LLM API key configured. Will use LCS fallback.');
  }

  // Pre-populate brand mappings in the database for the test samples
  console.log('\nPopulating test brand site mappings...');
  for (const sample of TEST_SAMPLES) {
    try {
      upsertBrandSite(sample.brand, sample.domain);
      // Also map variations that spreadsheet detection might yield
      if (sample.brand === 'HONEST') upsertBrandSite('HONEST KITCHEN', sample.domain);
      if (sample.brand === "CHEF'S CUT") upsertBrandSite("CHEF'S", sample.domain);
    } catch (err) {
      console.error(`Failed to map brand ${sample.brand}:`, err);
    }
  }

  const reportLines: string[] = [
    '# Production Search Strategy Verification Results',
    `> Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    'This report evaluates the **production two-pass strategy** (UPC -> LLM name consolidation -> site-specific brand query) on 10 real products.',
    '',
    '| # | UPC | Brand | Mapped Domain | Top Discovery Candidate URL | Candidate Domain | Confidence | Method |',
    '|---|-----|-------|---------------|-----------------------------|------------------|------------|--------|'
  ];

  const detailLines: string[] = [
    '',
    '---',
    '',
    '## Detailed Results'
  ];

  for (let i = 0; i < TEST_SAMPLES.length; i++) {
    const sample = TEST_SAMPLES[i];
    console.log(`\n[${i + 1}/${TEST_SAMPLES.length}] Running discovery for ${sample.upc} (${sample.brand})...`);

    try {
      const candidates = await discoverSources(sample.upc, sample.registerName, sample.brand);

      if (candidates.length === 0) {
        console.log(`   ❌ No candidates found.`);
        reportLines.push(`| ${i + 1} | \`${sample.upc}\` | ${sample.brand} | \`${sample.domain}\` | ❌ None | — | — | — |`);
        continue;
      }

      const top = candidates[0];
      console.log(`   Top URL: ${top.url} (Confidence: ${top.confidence.toFixed(2)}, Method: ${top.sourceMethod})`);

      reportLines.push(
        `| ${i + 1} | \`${sample.upc}\` | ${sample.brand} | \`${sample.domain}\` | [Link](${top.url}) | \`${top.domain}\` | ${top.confidence.toFixed(2)} | \`${top.sourceMethod}\` |`
      );

      detailLines.push(`\n### ${i + 1}. ${sample.brand} — \`${sample.upc}\``);
      detailLines.push(`- **Register Name:** ${sample.registerName}`);
      detailLines.push(`- **Target Domain:** \`${sample.domain}\``);
      detailLines.push(`- **Top Result:** [${top.title}](${top.url}) on \`${top.domain}\` (Confidence: ${top.confidence.toFixed(2)})`);
      detailLines.push('\n**Top 5 Candidates Found:**\n');
      detailLines.push('| Score | Method | Domain | Title | URL |');
      detailLines.push('|-------|--------|--------|-------|-----|');
      for (const c of candidates.slice(0, 5)) {
        detailLines.push(`| ${c.confidence.toFixed(2)} | \`${c.sourceMethod}\` | \`${c.domain}\` | ${c.title} | [URL](${c.url}) |`);
      }
    } catch (err) {
      console.error(`   ❌ Discovery failed:`, err);
      reportLines.push(`| ${i + 1} | \`${sample.upc}\` | ${sample.brand} | \`${sample.domain}\` | 💥 Error: ${String(err)} | — | — | — |`);
    }

    // Rate-limiting delay
    await new Promise(r => setTimeout(r, 1000));
  }

  const fullReport = [...reportLines, ...detailLines].join('\n');
  const outputPath = path.resolve(__dirname, 'search-test-results.md');
  writeFileSync(outputPath, fullReport, 'utf-8');

  console.log(`\n✅ Production strategy verification complete. Results written to: ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

#!/usr/bin/env bun
/**
 * CLI Benchmark Runner for Local LLM Revision Bakeoff.
 *
 * Performs REAL model evaluation directly against local Ollama and cloud endpoints
 * using frozen benchmark cases. Bypasses production task router and policy gateways.
 *
 * Usage:
 *   bun run scripts/llm-benchmark.ts \
 *     --models gemma4:12b-mlx,qwen3.5:9b,ministral-3:8b,deepseek-v4-flash \
 *     --tasks brand_inference,product_name_consolidation
 */

import { existsSync, readFileSync } from 'node:fs';
import { scoreBrandInference, type BrandEvalCase } from '../src/ai/evals/brand-scorer';
import { scoreTitleConsolidation, type TitleEvalCase } from '../src/ai/evals/title-scorer';
import { computeEvalRunResult, type SingleCaseEvalResult } from '../src/benchmarks/benchmark-runner';
import { compareModelRuns, formatComparisonMarkdown } from '../src/benchmarks/model-comparison';
import { runVlmExperiment } from '../src/benchmarks/vlm-experiment';
import { callVlm } from '../src/onboarding/vlm-client';
import { getApiKey } from '../src/db/repositories/api-key-repo';
import { initDb } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';

// Representative frozen benchmark dataset for brand inference
const SAMPLE_BRAND_CASES: BrandEvalCase[] = [
  { id: 'b1', searchTitle: 'Acme Dog Food 5lb Bag', expectedBrand: 'Acme' },
  { id: 'b2', searchTitle: 'Purina Pro Plan Adult Salmon & Rice 30lb', expectedBrand: 'Purina Pro Plan' },
  { id: 'b3', searchTitle: 'Blue Buffalo Wilderness High Protein Grain Free 24lb', expectedBrand: 'Blue Buffalo' },
  { id: 'b4', searchTitle: 'Generic Stainless Steel Dog Bowl 32oz', expectedBrand: '' },
  { id: 'b5', searchTitle: 'Kong Classic Dog Toy Large Red', expectedBrand: 'Kong' },
];

// Representative frozen benchmark dataset for title consolidation
const SAMPLE_TITLE_CASES: TitleEvalCase[] = [
  { id: 't1', rawName: 'WOOF PUPSICLE TREAT 2.64OZ 2PK', expectedName: 'Woof Pupsicle Treat 2.64oz 2pk', protectedTokens: ['2.64oz', '2pk', 'Woof'] },
  { id: 't2', rawName: 'PURINA PRO PLAN ADULT SALMON 30LB', expectedName: 'Purina Pro Plan Adult Salmon 30lb', protectedTokens: ['30lb', 'Purina Pro Plan', 'Salmon'] },
  { id: 't3', rawName: 'KONG CLASSIC LARGE RED TOY', expectedName: 'Kong Classic Large Red Toy', protectedTokens: ['Kong', 'Large', 'Red'] },
];

// Representative frozen VLM OCR cases for packaging experiment
const SAMPLE_VLM_CASES = [
  { id: 'v1', imagePath: '/pkg/woof.jpg', expectedUpc: '850067859598', expectedFields: { brand: 'Woof', name: 'Pupsicle Treat', weight: '2.64oz' } },
  { id: 'v2', imagePath: '/pkg/purina.jpg', expectedUpc: '038100130548', expectedFields: { brand: 'Purina Pro Plan', name: 'Adult Salmon', weight: '30lb' } },
];

// Minimal valid 1x1 transparent PNG base64 payload for evaluation fallback
const FALLBACK_EVAL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

interface ModelEvalOptions {
  provider: 'ollama' | 'deepseek' | 'openai';
  model: string;
  baseUrl: string;
  apiKey: string;
  prompt: string;
  systemPrompt?: string;
}

/**
 * Direct evaluation transport that calls model endpoints directly,
 * bypassing production task configuration and policy gateways.
 */
async function runModelEval(options: ModelEvalOptions): Promise<{
  content: string | null;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  error?: string;
}> {
  const start = Date.now();
  const timeoutMs = options.provider === 'ollama' ? 60000 : 30000;
  try {
    const response = await fetch(`${options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages: [
          { role: 'system', content: options.systemPrompt ?? 'You are a helpful assistant.' },
          { role: 'user', content: options.prompt },
        ],
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        content: null,
        latencyMs: Date.now() - start,
        promptTokens: null,
        completionTokens: null,
        error: `HTTP ${response.status}: ${text}`,
      };
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = data.choices?.[0]?.message?.content?.trim() ?? null;
    return {
      content,
      latencyMs: Date.now() - start,
      promptTokens: data.usage?.prompt_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
    };
  } catch (err) {
    return {
      content: null,
      latencyMs: Date.now() - start,
      promptTokens: null,
      completionTokens: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runBenchmark(models: string[], tasks: string[]) {
  console.log(`\n=== Starting Baystate Local-LLM Revision Real Bakeoff ===`);
  console.log(`Models: ${models.join(', ')}`);
  console.log(`Tasks: ${tasks.join(', ')}\n`);

  try {
    initDb('src/tests/unit/llm-benchmark.db');
    runMigrations();
  } catch {
    /* ok if db already initialized */
  }

  // Resolve provider credentials from DB or environment
  const deepseekCred = getApiKey('deepseek')?.api_key || process.env.DEEPSEEK_API_KEY || '';
  const openaiCred = getApiKey('openai')?.api_key || process.env.OPENAI_API_KEY || '';
  const ollamaBaseUrl = getApiKey('ollama')?.base_url || 'http://localhost:11434/v1';

  const runResults = new Map<string, ReturnType<typeof computeEvalRunResult>>();

  for (const model of models) {
    const provider = model.includes('deepseek')
      ? 'deepseek'
      : model.includes('gpt')
      ? 'openai'
      : 'ollama';

    const baseUrl = provider === 'deepseek'
      ? 'https://api.deepseek.com'
      : provider === 'openai'
      ? 'https://api.openai.com/v1'
      : ollamaBaseUrl;

    const apiKey = provider === 'deepseek'
      ? deepseekCred
      : provider === 'openai'
      ? openaiCred
      : 'ollama-local';

    for (const task of tasks) {
      const caseResults: SingleCaseEvalResult[] = [];

      if (task === 'brand_inference') {
        for (const c of SAMPLE_BRAND_CASES) {
          const prompt = `Return a JSON object {"brand": "..."} extracting the exact brand from product title: "${c.searchTitle}". Return empty string if generic or unbranded.`;
          const evalRes = await runModelEval({
            provider,
            model,
            baseUrl,
            apiKey,
            prompt,
            systemPrompt: 'You extract brand names into JSON format.',
          });

          let validJson = false;
          let success = false;
          let failureCategory: SingleCaseEvalResult['failureCategory'] = undefined;

          if (evalRes.content) {
            try {
              const parsed = JSON.parse(evalRes.content.replace(/```json|```/g, '').trim());
              validJson = true;
              const brand = (parsed.brand || parsed.brandName || '').trim().toLowerCase();
              const expected = (c.expectedBrand || '').trim().toLowerCase();
              if (brand === expected) {
                success = true;
              } else {
                failureCategory = 'wrong_answer';
              }
            } catch {
              validJson = false;
              failureCategory = 'invalid_json';
            }
          } else {
            const errStr = (evalRes.error || '').toLowerCase();
            failureCategory = errStr.includes('timeout')
              ? 'timeout'
              : errStr.includes('policy')
              ? 'policy_denied'
              : 'transport_failure';
          }

          caseResults.push({
            caseId: c.id,
            success,
            validJson,
            latencyMs: evalRes.latencyMs,
            promptTokens: evalRes.promptTokens ?? undefined,
            completionTokens: evalRes.completionTokens ?? undefined,
            failureCategory,
            output: evalRes.content ?? undefined,
          });
        }
      } else if (task === 'product_name_consolidation') {
        for (const c of SAMPLE_TITLE_CASES) {
          const prompt = `Consolidate raw title "${c.rawName}" into clean Title Case. Preserve brand, size, weight, flavor, and pack count accurately.`;
          const evalRes = await runModelEval({
            provider,
            model,
            baseUrl,
            apiKey,
            prompt,
          });

          let success = false;
          let failureCategory: SingleCaseEvalResult['failureCategory'] = undefined;

          if (evalRes.content) {
            const lower = evalRes.content.toLowerCase();
            const preservedAll = c.protectedTokens.every((tok) => lower.includes(tok.toLowerCase()));
            if (preservedAll) {
              success = true;
            } else {
              failureCategory = 'wrong_answer';
            }
          } else {
            const errStr = (evalRes.error || '').toLowerCase();
            failureCategory = errStr.includes('timeout')
              ? 'timeout'
              : errStr.includes('policy')
              ? 'policy_denied'
              : 'transport_failure';
          }

          caseResults.push({
            caseId: c.id,
            success,
            validJson: true, // Non-JSON task
            latencyMs: evalRes.latencyMs,
            promptTokens: evalRes.promptTokens ?? undefined,
            completionTokens: evalRes.completionTokens ?? undefined,
            failureCategory,
            output: evalRes.content ?? undefined,
          });
        }
      }

      const run = computeEvalRunResult(model, task, caseResults);
      runResults.set(`${model}::${task}`, run);
    }
  }

  // Compare candidate models against DeepSeek cloud baseline
  const comparisons = [];
  const baselineModel = models.find((m) => m.includes('deepseek')) || models[models.length - 1];

  for (const task of tasks) {
    const baselineRun = runResults.get(`${baselineModel}::${task}`);
    if (!baselineRun) continue;

    for (const model of models) {
      if (model === baselineModel) continue;
      const candidateRun = runResults.get(`${model}::${task}`);
      if (candidateRun) {
        comparisons.push(
          compareModelRuns(candidateRun, baselineRun, {
            minimumCases: 3,
            expectsJson: task === 'brand_inference',
          }),
        );
      }
    }
  }

  console.log(formatComparisonMarkdown(comparisons));

  // Run Packaging VLM Experiment (Gemma 4 12B vs Qwen2.5-VL)
  console.log(`\n=== Packaging Vision OCR Real Experiment (Gemma 4 12B vs Qwen2.5-VL) ===`);
  const vlmBaselinePreds = [];
  const vlmCandidatePreds = [];

  for (const c of SAMPLE_VLM_CASES) {
    const imagePayload = existsSync(c.imagePath)
      ? readFileSync(c.imagePath).toString('base64')
      : FALLBACK_EVAL_PNG_BASE64;

    const vlmPrompt = 'Extract the product UPC/GTIN barcode and core package fields (brand, product name, weight) into a JSON object.';

    // 1. Baseline Qwen2.5-VL evaluation
    try {
      const qwenRaw = await callVlm(vlmPrompt, imagePayload, {
        baseUrl: 'http://localhost:11434',
        model: 'qwen2.5vl:latest',
        enabled: true,
      });
      const parsed = JSON.parse(qwenRaw.replace(/```json|```/g, '').trim());
      vlmBaselinePreds.push({
        caseId: c.id,
        extractedUpc: parsed.upc || parsed.gtin || '',
        extractedFields: {
          brand: parsed.brand || '',
          name: parsed.name || parsed.productName || '',
          weight: parsed.weight || parsed.netContent || '',
        },
      });
    } catch {
      // Raw failure: DO NOT substitute expected ground truth!
      vlmBaselinePreds.push({
        caseId: c.id,
        extractedUpc: '',
        extractedFields: { brand: '', name: '', weight: '' },
      });
    }

    // 2. Candidate Gemma 4 12B VLM evaluation
    try {
      const gemmaRaw = await callVlm(vlmPrompt, imagePayload, {
        baseUrl: 'http://localhost:11434',
        model: 'gemma4:12b-mlx',
        enabled: true,
      });
      const parsed = JSON.parse(gemmaRaw.replace(/```json|```/g, '').trim());
      vlmCandidatePreds.push({
        caseId: c.id,
        extractedUpc: parsed.upc || parsed.gtin || '',
        extractedFields: {
          brand: parsed.brand || '',
          name: parsed.name || parsed.productName || '',
          weight: parsed.weight || parsed.netContent || '',
        },
      });
    } catch {
      // Raw failure: DO NOT substitute expected ground truth!
      vlmCandidatePreds.push({
        caseId: c.id,
        extractedUpc: '',
        extractedFields: { brand: '', name: '', weight: '' },
      });
    }
  }

  const vlmExp = runVlmExperiment(SAMPLE_VLM_CASES, vlmBaselinePreds, vlmCandidatePreds);
  console.log(`Baseline VLM: ${vlmExp.baselineModel} (UPC Match: ${(vlmExp.baselineScores.upcMatchRate * 100).toFixed(1)}%, F1: ${vlmExp.baselineScores.fieldF1})`);
  console.log(`Candidate VLM: ${vlmExp.candidateModel} (UPC Match: ${(vlmExp.candidateScores.upcMatchRate * 100).toFixed(1)}%, F1: ${vlmExp.candidateScores.fieldF1})`);
  console.log(`Qualification Status: ${vlmExp.qualified ? '✅ Qualified (Promote Gemma Unified VLM)' : '❌ Retain Qwen2.5-VL Baseline'}`);

  console.log(`\n=== Real Bakeoff Execution Complete ===\n`);
}

// Parse args if run directly from command line
if (import.meta.main || process.argv[1]?.endsWith('llm-benchmark.ts')) {
  const args = process.argv.slice(2);
  let models = ['gemma4:12b-mlx', 'qwen3.5:9b', 'ministral-3:8b', 'deepseek-v4-flash'];
  let tasks = ['brand_inference', 'product_name_consolidation'];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--models' && args[i + 1]) {
      models = args[i + 1].split(',').map((s) => s.trim());
    } else if (args[i] === '--tasks' && args[i + 1]) {
      tasks = args[i + 1].split(',').map((s) => s.trim());
    }
  }

  runBenchmark(models, tasks).catch((err) => {
    console.error('Benchmark execution error:', err);
    process.exit(1);
  });
}

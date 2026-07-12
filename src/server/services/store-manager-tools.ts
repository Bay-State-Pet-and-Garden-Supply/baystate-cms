import { tool } from 'ai';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { getDb } from '../../db/connection';
import { getDashboardStatsData } from './dashboard-service';
import { getCatalogHealthReport } from './product-service';
import { listProductIndex } from './product-service';
import { getProductFieldAudit, proposeProductFieldNormalization } from './product-field-audit-service';
import {
  generateDeterministicProposals,
  listProposals,
  applyProposal,
  dismissProposal,
} from './product-field-refactor-service';
import type { Product } from '../../shared/types';

export interface StoreManagerToolContext {
  workspaceId: string;
  workspacePath: string;
}

export function createStoreManagerTools(context: StoreManagerToolContext) {
  const { workspaceId, workspacePath } = context;

  return {
    getDashboardStats: tool({
      description: 'Retrieve overall metrics and status for the store manager dashboard, including product counts, sync statuses, drift items, warnings, and recent activity.',
      inputSchema: z.object({}),
      execute: async () => {
        return getDashboardStatsData(workspaceId);
      },
    }),

    getCatalogHealthReport: tool({
      description: 'Retrieve the overall catalog health report summary, showing counts of healthy/unhealthy products, blockers, and warnings.',
      inputSchema: z.object({}),
      execute: async () => {
        const report = getCatalogHealthReport();
        return {
          totalProducts: report.totalProducts,
          healthyProducts: report.healthyProducts,
          unhealthyProducts: report.unhealthyProducts,
          totalErrors: report.totalErrors,
          totalWarnings: report.totalWarnings,
        };
      },
    }),

    listCatalogHealthIssues: tool({
      description: 'List detailed catalog health issues with optional filters for severity, code, field path, or a general search query.',
      inputSchema: z.object({
        severity: z.enum(['blocker', 'warning', 'info']).optional(),
        code: z.string().optional(),
        fieldPath: z.string().optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      execute: async ({ severity, code, fieldPath, search, limit }) => {
        const report = getCatalogHealthReport();
        let issues = report.issues;

        if (severity) {
          issues = issues.filter(i => i.severity === severity);
        }
        if (code) {
          issues = issues.filter(i => i.code === code);
        }
        if (fieldPath) {
          issues = issues.filter(i => i.fieldPath === fieldPath);
        }
        if (search) {
          const lower = search.toLowerCase();
          issues = issues.filter(i =>
            i.sku.toLowerCase().includes(lower) ||
            i.title.toLowerCase().includes(lower) ||
            (i.message && i.message.toLowerCase().includes(lower))
          );
        }

        return issues.slice(0, limit);
      },
    }),

    searchProducts: tool({
      description: 'Search the product index for active products matching a query or filter parameters.',
      inputSchema: z.object({
        search: z.string().optional(),
        status: z.string().optional(),
        inventoryStatus: z.string().optional(),
        minPrice: z.string().optional(),
        maxPrice: z.string().optional(),
        customFilters: z.record(z.string(), z.string()).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      execute: async (filter) => {
        const result = listProductIndex(filter);
        return result.products;
      },
    }),

    getProductFieldAudit: tool({
      description: 'Scan active products and perform a detailed ProductField value audit, counting unique/missing values and detecting casing, whitespace, and separator duplicate groups.',
      inputSchema: z.object({
        field: z.string().describe('ProductField name, e.g. ProductField24 or ProductField16'),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      execute: async ({ field, limit }) => {
        return getProductFieldAudit(field, limit);
      },
    }),

    proposeProductFieldNormalization: tool({
      description: 'Generate transient, in-memory proposals for a custom ProductField under a selected strategy. Read-only: does not save to the database.',
      inputSchema: z.object({
        field: z.string(),
        strategy: z.enum(['case_only', 'trim_whitespace', 'separator_cleanup', 'safe_duplicates']).default('safe_duplicates'),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      execute: async ({ field, strategy, limit }) => {
        return proposeProductFieldNormalization(field, strategy, limit);
      },
    }),

    generateNormalizationProposals: tool({
      description: 'Generate and store normalization proposals in the database for a custom ProductField, making them ready to list and apply.',
      inputSchema: z.object({
        field: z.string().describe('ProductField name, e.g. ProductField24'),
      }),
      execute: async ({ field }) => {
        const proposals = generateDeterministicProposals(workspaceId, field);
        return { success: true, proposalCount: proposals.length };
      },
    }),

    listStoredProposals: tool({
      description: 'List stored normalization proposals from the database, with optional filters for field or status ("proposed", "applied", "dismissed").',
      inputSchema: z.object({
        field: z.string().optional(),
        status: z.enum(['proposed', 'applied', 'dismissed']).optional(),
      }),
      execute: async ({ field, status }) => {
        const proposals = listProposals(workspaceId, { field, status });
        return proposals;
      },
    }),

    applyNormalizationProposal: tool({
      description: 'Apply a stored proposal by its UUID, staging value updates for all affected products inside the active Change Set.',
      inputSchema: z.object({
        proposalId: z.string().describe('The UUID of the proposal to apply'),
      }),
      execute: async ({ proposalId }) => {
        const res = applyProposal(workspaceId, workspacePath, proposalId);
        return { success: true, changeSetId: res.changeSetId };
      },
    }),

    dismissNormalizationProposal: tool({
      description: 'Dismiss a stored proposal by its UUID so it will not be suggested or applied.',
      inputSchema: z.object({
        proposalId: z.string().describe('The UUID of the proposal to dismiss'),
      }),
      execute: async ({ proposalId }) => {
        dismissProposal(proposalId);
        return { success: true };
      },
    }),

    explainNextActions: tool({
      description: 'Return a ranked list of recommended next actions based on current catalog health, drift status, and change sets.',
      inputSchema: z.object({
        focus: z.enum(['health', 'product_fields', 'sync', 'drift', 'onboarding']).optional(),
      }),
      execute: async () => {
        const report = getCatalogHealthReport();
        const stats = getDashboardStatsData(workspaceId);
        const actions: string[] = [];

        if (report.totalErrors > 0) {
          actions.push(`Fix the ${report.totalErrors} blocking errors in your catalog to enable remote sync.`);
        }
        if (stats.metrics.driftedProducts > 0) {
          actions.push(`Resolve the ${stats.metrics.driftedProducts} drifted products under Products -> Drift.`);
        }
        if (stats.metrics.productsWithWarnings > 0) {
          actions.push(`Review the ${stats.metrics.productsWithWarnings} warnings under Catalog Health.`);
        }
        if (stats.metrics.draftChangeSets > 0) {
          actions.push(`Review and approve the ${stats.metrics.draftChangeSets} active drafts in your Change Sets.`);
        }
        if (actions.length === 0) {
          actions.push('All catalog metrics look clean! You are ready to publish or run catalog exports.');
        }

        return { actions };
      },
    }),

    repairChangeSetImages: tool({
      description: 'Re-download product images for an approved change set from the original onboarding extraction data. Use when export images ZIP is empty because files were lost from disk.',
      inputSchema: z.object({
        changeSetId: z.string().describe('The UUID of the change set to repair images for'),
      }),
      execute: async ({ changeSetId }) => {
        const db = getDb();

        // Validate change set exists and belongs to this workspace
        const cs = db.query(
          'SELECT id, status FROM change_sets WHERE id = ? AND workspace_id = ?',
        ).get(changeSetId, workspaceId) as { id: string; status: string } | undefined;

        if (!cs) {
          return { success: false, error: 'Change set not found in this workspace.' };
        }

        // Get change set items
        const items = db.query(
          'SELECT sku, draft_json FROM change_set_items WHERE change_set_id = ?',
        ).all(changeSetId) as { sku: string; draft_json: string }[];

        if (items.length === 0) {
          return { success: false, error: 'Change set has no items.' };
        }

        const results: Array<{ sku: string; imagesDownloaded: number; error?: string }> = [];
        let totalDownloaded = 0;

        for (const item of items) {
          try {
            // Look up onboarding item for extraction data
            const row = db.query(
              'SELECT extraction_data_json, brand_hint FROM onboarding_items WHERE upc = ? LIMIT 1',
            ).get(item.sku) as { extraction_data_json: string | null; brand_hint: string | null } | undefined;

            if (!row?.extraction_data_json) {
              results.push({ sku: item.sku, imagesDownloaded: 0, error: 'No extraction data' });
              continue;
            }

            const extractionData = JSON.parse(row.extraction_data_json);
            const primaryUrl: string | null = extractionData.primaryImage || null;
            const additionalUrls: string[] = extractionData.additionalImages || [];

            if (!primaryUrl && additionalUrls.length === 0) {
              results.push({ sku: item.sku, imagesDownloaded: 0, error: 'No image URLs' });
              continue;
            }

            // Parse product to get brand folder
            const product = JSON.parse(item.draft_json) as Product;
            const brandName = product.customFields?.['ProductField16'] || row.brand_hint || 'unbranded';
            const brandFolder = slugify(brandName) || 'unbranded';

            // Derive image stem from existing media ref
            const existingPrimary = product.core?.media?.primary;
            const imageStem = existingPrimary
              ? path.basename(existingPrimary, path.extname(existingPrimary))
              : slugify(product.core?.name || item.sku) || 'product';

            const count = await downloadImagesForRepair(
              workspacePath,
              item.sku,
              brandFolder,
              imageStem,
              primaryUrl,
              additionalUrls,
            );

            totalDownloaded += count;
            results.push({ sku: item.sku, imagesDownloaded: count });
          } catch (err) {
            results.push({ sku: item.sku, imagesDownloaded: 0, error: err instanceof Error ? err.message : String(err) });
          }
        }

        const failedCount = results.filter(r => r.error).length;
        return {
          success: failedCount < results.length,
          summary: `Re-downloaded ${totalDownloaded} image(s) for ${results.length} product(s)` +
            (failedCount > 0 ? ` (${failedCount} failure(s))` : ''),
          results,
        };
      },
    }),
  };
}

/** Slugify helper */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Download images for a single SKU, returns count of successfully downloaded images */
async function downloadImagesForRepair(
  workspacePath: string,
  sku: string,
  brandFolder: string,
  imageStem: string,
  primaryUrl: string | null,
  additionalUrls: string[],
): Promise<number> {
  const imagesDir = path.resolve(workspacePath, 'products', 'images', brandFolder);
  const imagesRoot = path.resolve(workspacePath, 'products', 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const allUrls: string[] = [];
  if (primaryUrl) allUrls.push(primaryUrl);
  for (const url of additionalUrls) {
    if (url && url !== primaryUrl) allUrls.push(url);
  }

  // Avoid collision
  let finalImageStem = imageStem;
  if (fs.existsSync(path.join(imagesDir, `${finalImageStem}.jpg`))) {
    finalImageStem = `${imageStem}-${sku}`;
  }

  let downloaded = 0;

  for (let index = 0; index < allUrls.length; index++) {
    const url = allUrls[index];
    if (!url) continue;

    // Non-HTTP URLs are treated as already-present relative paths
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      downloaded++;
      continue;
    }

    const suffix = index === 0 ? '' : `-${index + 1}`;
    const filename = `${finalImageStem}${suffix}.jpg`;
    const destPath = path.resolve(imagesDir, filename);

    // Path containment
    if (!destPath.startsWith(imagesRoot)) {
      console.warn(`[RepairTool] Path traversal blocked: ${filename}`);
      continue;
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ShopSiteCMS/1.0)',
          'Accept': 'image/*',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        console.warn(`[RepairTool] HTTP ${response.status} for ${url}`);
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        console.warn(`[RepairTool] Non-image: ${url} (${contentType})`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Try sharp, fall back to raw save
      let finalBuffer: Buffer;
      try {
        const sharp = (await import('sharp')).default;
        finalBuffer = await sharp(buffer)
          .flatten({ background: '#ffffff' })
          .resize(1000, 1000, {
            fit: 'contain',
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          })
          .jpeg({ quality: 90 })
          .toBuffer();
      } catch {
        finalBuffer = buffer;
      }

      fs.writeFileSync(destPath, finalBuffer);
      downloaded++;
    } catch (err) {
      console.error(`[RepairTool] Error downloading ${url}:`, err);
    }
  }

  return downloaded;
}

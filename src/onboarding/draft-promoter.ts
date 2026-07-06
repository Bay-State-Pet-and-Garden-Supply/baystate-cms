import { randomUUID } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { getDb } from '../db/connection';
import { findWorkspace } from '../db/repositories/workspace-repo';
import { findBatchById, isBatchComplete, setBatchArchived } from '../db/repositories/onboarding-batch-repo';
import { listItemsByBatch, completePromotionStage } from '../db/repositories/onboarding-item-repo';
import { createChangeSet, upsertChangeSetItem } from '../db/repositories/change-set-repo';
import { clearProductPages, assignProductToPage, assignProductToPageId, getProductPageAssignments } from '../db/repositories/page-repo';
import { readProductFile } from '../git/workspace-files';
import { deterministicStringify, hashJson } from '../git/deterministic-json';
import { getAcceptedProposals, getPendingPageProposals, recordHistoryEvent } from '../db/repositories/classification-run-repo';
import { getCachedAttributeMappings, getCachedBrands } from '../db/repositories/classification-config-repo';
import { resolveBrand } from '../classification/brand-resolution';
import type { Product } from '../shared/types';
import type { ExtractionData } from '../shared/schemas/onboarding';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface ProcessedImageResult {
  primaryImage: string | null;
  additionalImages: string[];
}

async function downloadAndProcessImages(
  _workspacePath: string,
  sku: string,
  brandFolder: string,
  imageStem: string,
  primaryUrl: string | null,
  additionalUrls: string[],
): Promise<ProcessedImageResult> {
  const imagesDir = path.join(os.homedir(), 'Downloads', brandFolder);
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }

  const result: ProcessedImageResult = {
    primaryImage: null,
    additionalImages: [],
  };

  const allUrls = [];
  if (primaryUrl) {
    allUrls.push(primaryUrl);
  }
  for (const url of additionalUrls) {
    if (url && url !== primaryUrl) {
      allUrls.push(url);
    }
  }

  // Ensure unique image stem (avoid collision)
  let finalImageStem = imageStem;
  const primaryFile = path.join(imagesDir, `${finalImageStem}.jpg`);
  if (fs.existsSync(primaryFile)) {
    finalImageStem = `${imageStem}-${sku}`;
  }

  for (let index = 0; index < allUrls.length; index++) {
    const url = allUrls[index];
    if (!url) continue;

    // Check for test/mock image paths or already processed relative paths
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      const relativePath = url;
      if (index === 0) {
        result.primaryImage = relativePath;
      } else {
        result.additionalImages.push(relativePath);
      }
      continue;
    }

    const imageSuffix = index === 0 ? '' : `-${index + 1}`;
    const filename = `${finalImageStem}${imageSuffix}.jpg`;
    const destPath = path.join(imagesDir, filename);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ShopSiteCMS/1.0)',
          'Accept': 'image/*',
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        console.warn(`[DraftPromoter] Failed to fetch image ${url} (${response.status})`);
        continue;
      }

      // Validate content type is an image format — skip videos, scripts, etc.
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) {
        console.warn(`[DraftPromoter] Skipping non-image content type "${contentType}" for ${url}`);
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Resize/flatten image using sharp to 1000x1000 JPG fit contain white background
      const resizedBuffer = await sharp(buffer)
        .flatten({ background: '#ffffff' })
        .resize(1000, 1000, {
          fit: 'contain',
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        .jpeg({ quality: 90 })
        .toBuffer();

      fs.writeFileSync(destPath, resizedBuffer);
      console.log(`[DraftPromoter] Downloaded and processed image to ${destPath}`);

      const relativePath = `${brandFolder}/${filename}`;
      if (index === 0) {
        result.primaryImage = relativePath;
      } else {
        result.additionalImages.push(relativePath);
      }
    } catch (err) {
      console.error(`[DraftPromoter] Error downloading image ${url}:`, err);
    }
  }

  return result;
}


/** Escape XML special characters in a string. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Promotes approved onboarding items to the CMS change-set/approval pipeline.
 * Creates a new change set containing all promoted items.
 */
export async function promoteItems(
  workspaceId: string,
  workspacePath: string,
  batchId: string,
  itemIds: string[],
): Promise<{ changeSetId: string; count: number; failures: Array<{ itemId: string; error: string }> }> {
  const db = getDb();

  const batch = findBatchById(batchId);
  if (!batch) {
    throw new Error(`Onboarding batch ${batchId} not found`);
  }

  const workspace = findWorkspace();
  const baseCommit = workspace?.baselineCommit ?? 'unknown';

  // 1. Create a new change set
  const dateStr = new Date().toLocaleDateString();
  const changeSetTitle = `Onboarding: ${batch.name} (${dateStr})`;
  const changeSet = createChangeSet({
    workspaceId,
    title: changeSetTitle,
    description: `Imported products from batch "${batch.name}" (${batch.fileName})`,
    baseCommit,
  });

  let promotedCount = 0;
  const failures: Array<{ itemId: string; error: string }> = [];

  // Retrieve all items for the batch
  const allItems = listItemsByBatch(batchId);
  const itemsToPromote = allItems.filter(item => itemIds.includes(item.id));

  // Pre-download and process images asynchronously before the database transaction
  const processedImagesMap = new Map<string, ProcessedImageResult>();
  for (const item of itemsToPromote) {
    if (!item.extractionData) continue;
    const extractionData = item.extractionData;
    const finalTitle = item.curationData?.curatedTitle || extractionData.title || item.name;
    const existingApproved = readProductFile(workspacePath, item.upc);

    // Resolve brand name
    let brandName = existingApproved?.customFields?.['ProductField16'] || item.brandHint || 'unbranded';
    if (!existingApproved?.customFields?.['ProductField16'] && item.brandHint && workspace) {
      try {
        const brands = getCachedBrands(workspace.id);
        const resolved = resolveBrand(item.brandHint, brands);
        brandName = resolved?.brandName ?? item.brandHint;
      } catch (err: any) {
        // ignore
      }
    }

    const brandFolder = slugify(brandName) || 'unbranded';
    const imageStem = slugify(finalTitle) || slugify(item.upc) || 'product';

    try {
      const processed = await downloadAndProcessImages(
        workspacePath,
        item.upc,
        brandFolder,
        imageStem,
        extractionData.primaryImage,
        extractionData.additionalImages || [],
      );
      processedImagesMap.set(item.id, processed);
    } catch (err) {
      console.error(`[DraftPromoter] Failed to download and process images for item ${item.upc}:`, err);
      processedImagesMap.set(item.id, { primaryImage: null, additionalImages: [] });
    }
  }

  db.transaction(() => {
    for (const item of itemsToPromote) {
      if (!item.extractionData) {
        const errMsg = 'Missing extraction data';
        console.warn(`[DraftPromoter] Skipping item ${item.name} (${item.upc}) - ${errMsg}`);
        completePromotionStage(item.id, false, errMsg);
        failures.push({ itemId: item.id, error: errMsg });
        continue;
      }

      const extractionData = item.extractionData;
      
      // Determine if product already exists
      const existingApproved = readProductFile(workspacePath, item.upc);
      
      const now = new Date().toISOString();
      
      const finalTitle = item.curationData?.curatedTitle || extractionData.title || item.name;

      // Construct core product details with price fallback and cleanup
      const rawPrice = item.price || extractionData.price || null;
      const cleanPrice = rawPrice ? rawPrice.replace(/[$\s,]/g, '') : null;

      const processed = processedImagesMap.get(item.id);
      const primaryImage = processed?.primaryImage || null;
      const additionalImages = processed?.additionalImages || [];

      const coreProduct = {
        name: finalTitle,
        price: cleanPrice,
        salePrice: null,
        description: extractionData.description || null,
        inventory: {
          quantityOnHand: item.quantity !== null ? item.quantity : null,
          lowStockThreshold: null,
          outOfStockLimit: null,
        },
        availability: 'instock',
        weight: item.curationData?.curatedWeight || extractionData.weight || null,
        taxable: true,
        media: {
          primary: primaryImage,
          additional: additionalImages,
        },
        seo: {
          fileName: extractionData.seoFileName || null,
          // Prefer curator-synthesized keywords over raw extraction concatenation
          searchKeywords: item.curationData?.searchKeywords || extractionData.searchKeywords || null,
          googleProductCategory: null,
        },
      };

      // --- Apply accepted classification proposals ---
      // Build custom fields from accepted field assignment proposals
      const classificationCustomFields: Record<string, string> = {};
      const classificationPageNames: string[] = [];
      const classificationPageProposals: Array<{ pageId: string | null; pageName: string }> = [];
      let acceptedProductType: string | null = null;

      try {
        const acceptedProposals = getAcceptedProposals(item.upc);
        if (acceptedProposals.length > 0) {
          const mappings = getCachedAttributeMappings(workspaceId);

          for (const proposal of acceptedProposals) {
            if (proposal.proposalType === 'field_assignment' && proposal.targetId) {
              const mapping = mappings.find(m => m.attributeId === proposal.targetId);
              if (mapping && !mapping.isStale && mapping.catalogField) {
                const value = proposal.proposedValue;
                const str = typeof value === 'string' ? value :
                  Array.isArray(value) ? value.join(', ') :
                  value !== null && value !== undefined ? String(value) : '';
                if (str) {
                  classificationCustomFields[mapping.catalogField] = str;
                }
              }
            } else if (proposal.proposalType === 'category_page' && proposal.targetId) {
              const pv = proposal.proposedValue as Record<string, unknown> | undefined;
              const pageId = pv?.pageId ? String(pv.pageId) : null;
              const pageName = pv?.pageName ? String(pv.pageName) : String(proposal.targetId);
              classificationPageNames.push(proposal.targetId);
              classificationPageProposals.push({ pageId, pageName });
            } else if (proposal.proposalType === 'primary_product_type' && proposal.targetId) {
              acceptedProductType = String(proposal.targetId);
            }
          }
        } else {
          // Fallback: use pending (highest-confidence) category_page proposals
          // when no proposals have been manually accepted yet.
          const pendingPages = getPendingPageProposals(item.upc);
          for (const proposal of pendingPages) {
            const pv = proposal.proposedValue as Record<string, unknown> | undefined;
            const pageId = pv?.pageId ? String(pv.pageId) : null;
            const pageName = pv?.pageName ? String(pv.pageName) : String(proposal.targetId);
            if (!classificationPageNames.includes(proposal.targetId!)) {
              classificationPageNames.push(proposal.targetId!);
              classificationPageProposals.push({ pageId, pageName });
            }
          }
        }
      } catch (err) {
        console.warn('[DraftPromoter] Failed to read classification proposals:', err);
      }

      // Merge classification custom fields with any existing custom fields
      const mergedCustomFields: Record<string, string> = {
        ...(existingApproved?.customFields ?? {}),
        ...classificationCustomFields,
      };

      // Set ProductField1 to new{todaysDate} in MMDDYY format for new products
      if (!existingApproved) {
        const d = new Date();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const yy = String(d.getFullYear()).slice(-2);
        mergedCustomFields['ProductField1'] = `new${mm}${dd}${yy}`;
      }

      // ── Brand resolution (direct from spreadsheet, no proposal needed) ─
      // Brand is always set from the spreadsheet brandHint via deterministic
      // brand resolution. This bypasses the classification proposal system
      // because brand is mandatory and never requires user review.
      if (!mergedCustomFields['ProductField16']?.trim() && item.brandHint) {
        try {
          const workspace = findWorkspace();
          if (workspace) {
            const brands = getCachedBrands(workspace.id);
            const resolved = resolveBrand(item.brandHint, brands);
            mergedCustomFields['ProductField16'] = resolved?.brandName ?? item.brandHint;
          } else {
            mergedCustomFields['ProductField16'] = item.brandHint;
          }
        } catch (err: any) {
          console.warn(`[DraftPromoter] Brand resolution failed for ${item.upc}: ${err.message}`);
          mergedCustomFields['ProductField16'] = item.brandHint;
        }
      }

      // ── Mandatory field validation ────────────────────────────────────
      const missingFields: string[] = [];
      if (!coreProduct.name?.trim()) missingFields.push('Name');
      if (!coreProduct.price?.trim()) missingFields.push('Price');
      if (!mergedCustomFields['ProductField16']?.trim()) missingFields.push('Brand (ProductField16)');
      if (!coreProduct.media.primary) missingFields.push('Primary Image');

      // Pages are mandatory — check proposals, suggestedPages, and DB
      const hasPages = classificationPageNames.length > 0 ||
        (item.curationData?.suggestedPages?.length ?? 0) > 0 ||
        (() => { try { return getProductPageAssignments(item.upc).length > 0; } catch { return false; } })();
      if (!hasPages) missingFields.push('Pages');

      if (missingFields.length > 0) {
        const errMsg = `Missing mandatory fields: ${missingFields.join(', ')}`;
        console.warn(`[DraftPromoter] Skipping ${item.upc} (${item.name}) — ${errMsg}`);
        completePromotionStage(item.id, false, errMsg);
        failures.push({ itemId: item.id, error: errMsg });
        continue;
      }

      // Construct final Product schema representation
      const product: Product = {
        schemaVersion: 1,
        id: existingApproved?.id || randomUUID(),
        sku: item.upc,
        status: 'draft',
        core: coreProduct,
        customFields: mergedCustomFields,
        shopsite: {
          productId: existingApproved?.shopsite?.productId || null,
          productGuid: existingApproved?.shopsite?.productGuid || null,
          xmlVersion: existingApproved?.shopsite?.xmlVersion || '15.0',
          lastPulledAt: existingApproved?.shopsite?.lastPulledAt || null,
          lastRemoteHash: existingApproved?.shopsite?.lastRemoteHash || null,
          lastSyncedAt: existingApproved?.shopsite?.lastSyncedAt || null,
          source: { dbname: 'products', uniqueName: 'SKU' },
          preserved: existingApproved?.shopsite?.preserved || {
            unknownElements: {},
            advancedBlocks: {},
            rawAttributes: {},
          },
        },
        metadata: {
          createdAt: existingApproved?.metadata?.createdAt || now,
          updatedAt: now,
          archivedAt: null,
        },
      };

      // ── Inject ProductOnPages into preserved unknown elements ─────────
      // Collect page names from: accepted proposals → suggestedPages → DB
      const pageNames: string[] = [];

      if (classificationPageProposals.length > 0) {
        for (const pp of classificationPageProposals) {
          if (pp.pageName && !pageNames.includes(pp.pageName)) {
            pageNames.push(pp.pageName);
          }
        }
      }

      if (pageNames.length === 0 && item.curationData?.suggestedPages?.length) {
        for (const p of item.curationData.suggestedPages) {
          if (!pageNames.includes(p)) pageNames.push(p);
        }
      }

      if (pageNames.length === 0) {
        try {
          const dbPages = getProductPageAssignments(item.upc);
          for (const p of dbPages) {
            if (p.pageName && !pageNames.includes(p.pageName)) pageNames.push(p.pageName);
          }
        } catch { /* ignore */ }
      }

      // Inject into preserved unknown elements as raw XML children
      if (pageNames.length > 0) {
        const pagesXml = pageNames.map(n => `<Name>${escapeXml(n)}</Name>`).join('\n    ');
        product.shopsite.preserved.unknownElements['ProductOnPages'] = `\n    ${pagesXml}\n  `;
      }

      const draftJsonStr = deterministicStringify(product);
      const draftHash = hashJson(product);
      const baseJsonStr = existingApproved ? deterministicStringify(existingApproved) : null;
      const operation = existingApproved ? 'update' : 'create';

      // Insert/upsert Change Set Item
      upsertChangeSetItem({
        changeSetId: changeSet.id,
        sku: item.upc,
        operation,
        draftJson: draftJsonStr,
        baseJson: baseJsonStr,
        draftHash,
      });

      // Assign product to pages from classification proposals (preferred) or curated suggested pages
      const finalPages = classificationPageNames.length > 0
        ? classificationPageNames
        : (item.curationData?.suggestedPages ?? []);
      if (finalPages.length > 0) {
        clearProductPages(item.upc);

        if (classificationPageProposals.length > 0) {
          for (const pp of classificationPageProposals) {
            if (pp.pageId) {
              assignProductToPageId(item.upc, pp.pageId, pp.pageName);
            } else {
              assignProductToPage(item.upc, pp.pageName);
            }
          }
        } else {
          for (const pageName of finalPages) {
            assignProductToPage(item.upc, pageName);
          }
        }
      }

      // Record classification history for the promotion action
      try {
        recordHistoryEvent(workspaceId, item.upc, 'promotion', {
          acceptedProposalCount: classificationPageNames.length + Object.keys(classificationCustomFields).length,
          acceptedProductType,
          appliedFields: Object.keys(classificationCustomFields),
          appliedPages: classificationPageNames,
        });
      } catch {
        // Non-blocking
      }

      // Update item stage status to completed in promotion stage
      completePromotionStage(item.id, true);
      
      promotedCount++;
    }

    // Archive batch if all items are done (stage-based)
    if (isBatchComplete(batchId)) {
      setBatchArchived(batchId, true);
    }
  })();

  return {
    changeSetId: changeSet.id,
    count: promotedCount,
    failures,
  };
}

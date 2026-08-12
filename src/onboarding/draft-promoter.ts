import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { getDb } from '../db/connection';
import { findWorkspace } from '../db/repositories/workspace-repo';
import { findBatchById, isBatchComplete, setBatchArchived } from '../db/repositories/onboarding-batch-repo';
import { listItemsByBatch, completePromotionStage } from '../db/repositories/onboarding-item-repo';
import { createChangeSet, upsertChangeSetItem } from '../db/repositories/change-set-repo';
import { clearProductPages, assignProductToPageId, getProductPageAssignments, listVerifiedPageOptions } from '../db/repositories/page-repo';
import { verifyImportedResultGate } from '../product-intelligence/onboarding-import';
import { readProductFile } from '../git/workspace-files';
import { deterministicStringify, hashJson } from '../git/deterministic-json';
import {
  getAcceptedProposals,
  getValidatedOnboardingRun,
  recordHistoryEvent,
} from '../db/repositories/classification-run-repo';
import type { ClassificationRunRow } from '../db/repositories/classification-run-repo';
import {
  getCohortRunById,
  listDependenciesForProposal,
} from '../db/repositories/classification-cohort-run-repo';
import { validatePromotionGate, resolvePromotionEffectiveTypeId } from '../classification/promotion-gate';
import type { CohortRun } from '../shared/schemas/cohorts';
import type { OnboardingItem } from '../shared/schemas/onboarding';
import type { ClassificationProposal } from '../shared/schemas/classification';
import { getCachedAttributeMappings, getCachedBrands } from '../db/repositories/classification-config-repo';
import { resolveBrand } from '../classification/brand-resolution';
import { getPageIdentityId, pageNameFromPageValue } from '../shared/proposal-display';
import {
  getEffectivePrimaryProductTypeId,
  getEffectiveProposalTargetId,
  getEffectiveProposalValue,
  serializeAttributeValue,
} from '../classification/assignment-projection';
import type { Product } from '../shared/types';

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
  workspacePath: string,
  sku: string,
  brandFolder: string,
  imageStem: string,
  primaryUrl: string | null,
  additionalUrls: string[],
): Promise<ProcessedImageResult> {
  const imagesDir = path.join(workspacePath, 'products', 'images', brandFolder);
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
      if (!result.primaryImage) {
        result.primaryImage = relativePath;
      } else {
        result.additionalImages.push(relativePath);
      }
      continue;
    }

    const imageSuffix = index === 0 ? '' : `-${index + 1}`;
    const filename = `${finalImageStem}${imageSuffix}.jpg`;
    const destPath = path.join(imagesDir, filename);

    // Path containment: reject paths that escape the images directory
    if (!path.resolve(destPath).startsWith(path.resolve(imagesDir))) {
      console.warn(`[DraftPromoter] Skipping image with path traversal: ${filename}`);
      continue;
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BaystateCMS/1.0)',
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
      if (!result.primaryImage) {
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
    .replace(/&(?!#(?:[0-9]+|x[0-9a-fA-F]+);|[a-zA-Z0-9]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * PR11 gate inputs for one item: run-pointer validation + the deterministic
 * promotion gate (semantic / parent-currentness / stale-dependency). Shared by
 * the image pre-pass (images download ONLY for gate-passing items — PR11
 * review R1 P2) and the authoritative per-item loop (failure recording).
 * Legacy items (no run pointer) pass with `ok: true` and empty proposals.
 */
function computePromotionGate(
  item: OnboardingItem,
  workspaceId: string,
): {
  ok: boolean;
  reason: string | null;
  activeRun: ClassificationRunRow | null;
  activeProposals: ClassificationProposal[];
} {
  const runPointer = item.curationData?.classificationRunId ?? null;
  let activeRun: ClassificationRunRow | null = null;
  if (runPointer) {
    activeRun = getValidatedOnboardingRun(runPointer, workspaceId, item.id, item.upc);
    if (!activeRun) {
      return {
        ok: false,
        reason: 'Invalid classification run pointer — promotion blocked',
        activeRun: null,
        activeProposals: [],
      };
    }
  }
  const activeRunId = activeRun?.id ?? null;
  // Accepted-only: a valid run contributes only proposals whose latest live
  // decision is 'accepted' (never deferred/rejected/pending/decisionless).
  const activeProposals = activeRunId
    ? getAcceptedProposals(item.upc, activeRunId)
    : (item.curationData?.classificationProposals || []).filter(
        (p: any) => p.status === 'accepted',
      );
  const parentRun: CohortRun | null = activeRun?.cohortRunId
    ? getCohortRunById(activeRun.cohortRunId)
    : null;
  const gate = validatePromotionGate({
    workspaceId,
    itemId: item.id,
    productSku: item.upc,
    curationData: item.curationData ?? null,
    activeRun,
    parentRun,
    effectiveTypeId: resolvePromotionEffectiveTypeId(parentRun, activeProposals),
    acceptedProposals: activeProposals,
    dependencyLookup: (proposalId: string) => listDependenciesForProposal(proposalId),
  });
  return {
    ok: gate.ok,
    reason: gate.ok ? null : gate.reason,
    activeRun,
    activeProposals,
  };
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
): Promise<{ changeSetId: string | null; count: number; failures: Array<{ itemId: string; error: string }> }> {
  const db = getDb();

  const batch = findBatchById(batchId);
  if (!batch) {
    throw new Error(`Onboarding batch ${batchId} not found`);
  }
  if (batch.workspaceId !== workspaceId) {
    throw new Error(`Onboarding batch ${batchId} belongs to a different workspace`);
  }

  const workspace = findWorkspace();
  const baseCommit = workspace?.baselineCommit ?? 'unknown';

  let changeSetId: string | null = null;

  let promotedCount = 0;
  const failures: Array<{ itemId: string; error: string }> = [];

  // Retrieve all items for the batch
  const allItems = listItemsByBatch(batchId);
  const itemsToPromote = allItems.filter(item => itemIds.includes(item.id));

  // Pre-download and process images asynchronously before the database
  // transaction — but ONLY for items that pass the PR11 gate (PR11 review R1
  // P2): a semantically blocked or stale item must never create processed
  // image files on disk, even though it can never produce a change-set row.
  // The authoritative gate re-runs inside the loop (deterministic, cheap) and
  // records the failure there.
  const processedImagesMap = new Map<string, ProcessedImageResult>();
  for (const item of itemsToPromote) {
    if (!item.extractionData) continue;
    const gateInfo = computePromotionGate(item, workspaceId);
    if (!gateInfo.ok) continue; // the loop records the refusal; no image work
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
      } catch {
        // Brand cache is optional; keep the original brand hint.
      }
    }

    const brandFolder = slugify(brandName) || 'unbranded';
    const imageStem = slugify(finalTitle) || slugify(item.upc) || 'product';

    const evidenceAttemptImages: string[] = [];
    try {
      const attempts = db.query(
        `SELECT identity_json FROM onboarding_evidence_attempts WHERE item_id = ? OR lookup_upc = ?`
      ).all(item.id, item.upc) as { identity_json: string | null }[];
      for (const att of attempts) {
        if (!att.identity_json) continue;
        const ident = JSON.parse(att.identity_json);
        if (Array.isArray(ident.images)) {
          for (const img of ident.images) {
            if (typeof img === 'string' && img.trim()) evidenceAttemptImages.push(img.trim());
          }
        }
      }
    } catch { /* ignore */ }

    try {
      const processed = await downloadAndProcessImages(
        workspacePath,
        item.upc,
        brandFolder,
        imageStem,
        extractionData.primaryImage ?? null,
        [...(extractionData.additionalImages || []), ...evidenceAttemptImages],
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

      // ── Imported Agent Lab result gate (PI-8) ─────────────────────────
      // An item whose extraction data carries imported PI evidence is only
      // promotable while its origin is verifiable: the run exists, the
      // result hash matches, and the import record is active.
      const importGate = verifyImportedResultGate(item);
      if (!importGate.ok) {
        const errMsg = importGate.error;
        console.warn(`[DraftPromoter] Skipping item ${item.name} (${item.upc}) - ${errMsg}`);
        completePromotionStage(item.id, false, errMsg);
        failures.push({ itemId: item.id, error: errMsg });
        continue;
      }

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
        weight: (typeof item.curationData?.curatedWeight === 'string' ? item.curationData.curatedWeight : null) || extractionData.weight || null,
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
      // Accepted page proposals whose identity is not verified in the active
      // import. Visible and non-blocking: they are never serialized into
      // ProductOnPages, but they do not block the rest of the draft.
      const skippedPageRefs: Array<{ proposalId: string; pageName: string }> = [];
      let acceptedProductType: string | null = null;

      // ── PR11 Promotion gate (semantic / parent-currentness / stale) ────
      // Deterministic per-item fail-closed check AFTER the run-pointer
      // validation and BEFORE any proposal/draft work (the SAME computation
      // the image pre-pass used — re-run here as the authoritative failure
      // record; deterministic and cheap). A blocked member, a child of a
      // superseded/in-flight parent, a non-terminal child run, or a proposal
      // whose type dependency no longer matches the item's CURRENT effective
      // type never reaches a CMS draft — the item's promotion stage fails
      // with the deterministic reason while siblings promote normally.
      // Legacy items (no run pointer) pass unchanged (byte-identical).
      const gateInfo = computePromotionGate(item, workspaceId);
      if (!gateInfo.ok) {
        const errMsg = gateInfo.reason!;
        console.warn(`[DraftPromoter] Skipping item ${item.name} (${item.upc}) - ${errMsg}`);
        completePromotionStage(item.id, false, errMsg);
        failures.push({ itemId: item.id, error: errMsg });
        continue;
      }
      const activeProposals = gateInfo.activeProposals;

      // Only identities verified in the currently active Page import are
      // serializable, and the verified catalog is the DISPLAY-NAME authority:
      // a verified Page ID always resolves to the verified page's canonical
      // name (never the proposal's variant text, never the raw Page ID).
      // Without an active import the set is empty — fail closed.
      const verifiedPageOptions = listVerifiedPageOptions(batch.workspaceId);
      const verifiedPageIds = new Set(verifiedPageOptions.map(p => p.id));
      const verifiedNameById = new Map(verifiedPageOptions.map(p => [p.id, p.name]));
      if (activeProposals.length > 0) {
        const mappings = getCachedAttributeMappings(workspaceId);

        for (const proposal of activeProposals) {
          // Effective reviewed target/value win over the immutable prediction.
          const targetId = getEffectiveProposalTargetId(proposal);
          if (proposal.proposalType === 'field_assignment' && targetId) {
            const mapping = mappings.find(m => m.attributeId === targetId);
            if (mapping && !mapping.isStale && mapping.catalogField) {
              const value = getEffectiveProposalValue(proposal);
              const str = serializeAttributeValue(value, mapping.serialization);
              if (str || (proposal.hasRevisedValue && value === null)) {
                classificationCustomFields[mapping.catalogField] = str;
              }
            }
          } else if (proposal.proposalType === 'category_page' && targetId) {
            const pageId = getPageIdentityId(proposal);
            const pageName = pageNameFromPageValue(getEffectiveProposalValue(proposal));
            if (!pageId || !verifiedPageIds.has(pageId)) {
              skippedPageRefs.push({ proposalId: proposal.id, pageName: pageName ?? '' });
              continue;
            }
            // The verified catalog is the display-name authority: a verified
            // Page ID with a missing/unusable proposal name still resolves to
            // the verified page's canonical name. The Page ID is NEVER
            // serialized as a page name.
            const verifiedName = verifiedNameById.get(pageId) ?? '';
            if (!verifiedName) {
              skippedPageRefs.push({
                proposalId: proposal.id,
                pageName: `[page ${pageId} missing display name]`,
              });
              continue;
            }
            classificationPageNames.push(verifiedName);
            classificationPageProposals.push({ pageId, pageName: verifiedName });
          } else if (proposal.proposalType === 'primary_product_type') {
            acceptedProductType = getEffectivePrimaryProductTypeId(proposal);
          }
        }
      }


      // Explicit/manual persisted page assignments are the fallback if we still
      // have nothing. Only verified identities qualify; the display name again
      // comes from the verified catalog. Name-only rows are review context and
      // are tracked as skipped — they never satisfy the mandatory Pages gate.
      if (classificationPageProposals.length === 0) {
        try {
          const dbPages = getProductPageAssignments(item.upc);
          for (const p of dbPages) {
            if (p.pageName) {
              if (p.pageId && verifiedPageIds.has(p.pageId)) {
                const verifiedName = verifiedNameById.get(p.pageId) ?? p.pageName;
                classificationPageNames.push(verifiedName);
                classificationPageProposals.push({ pageId: p.pageId, pageName: verifiedName });
              } else {
                skippedPageRefs.push({ proposalId: `db:${p.pageName}`, pageName: p.pageName });
              }
            }
          }
        } catch { /* ignore */ }
      }

      // Mandatory Pages gate (fail closed): at least one VERIFIED page
      // assignment is required. Unverified accepted proposals and name-only
      // manual rows are visible skips (reported in the failure payload) but
      // they never satisfy the gate — a product must never promote with zero
      // verified Category Page assignments.
      if (classificationPageProposals.length === 0) {
        const errMsg = skippedPageRefs.length > 0
          ? 'No verified page assignments exist for this item (accepted page proposals were unverified or lacked a usable display name)'
          : 'No accepted product page proposals or manual page assignments exist for this item';
        console.warn(`[DraftPromoter] Skipping item ${item.name} (${item.upc}) - ${errMsg}`);
        completePromotionStage(item.id, false, errMsg);
        failures.push({ itemId: item.id, error: errMsg });
        continue;
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

      // ── Brand resolution ─────────────────────────────────────────────
      // Brand is set from brandHint or title fallback via deterministic
      // brand resolution against cached workspace catalog brands.
      if (!mergedCustomFields['ProductField16']?.trim()) {
        const brandInput = item.brandHint || coreProduct.name || item.name;
        if (brandInput) {
          try {
            const workspace = findWorkspace();
            if (workspace) {
              const brands = getCachedBrands(workspace.id);
              const resolved = resolveBrand(brandInput, brands);
              if (resolved?.brandName) {
                mergedCustomFields['ProductField16'] = resolved.brandName;
              } else if (item.brandHint) {
                mergedCustomFields['ProductField16'] = item.brandHint;
              }
            } else if (item.brandHint) {
              mergedCustomFields['ProductField16'] = item.brandHint;
            }
          } catch (err: any) {
            console.warn(`[DraftPromoter] Brand resolution failed for ${item.upc}: ${err.message}`);
            if (item.brandHint) mergedCustomFields['ProductField16'] = item.brandHint;
          }
        }
      }

      // ── Mandatory field validation ────────────────────────────────────
      const missingFields: string[] = [];
      if (!coreProduct.name?.trim()) missingFields.push('Name');
      if (!coreProduct.price?.trim()) missingFields.push('Price');
      if (!mergedCustomFields['ProductField16']?.trim()) missingFields.push('Brand (ProductField16)');
      if (!coreProduct.media.primary) missingFields.push('Primary Image');

      // Pages are mandatory — only VERIFIED assignments count. Unverified
      // accepted page proposals are visible skips (reported) that never
      // satisfy the mandatory gate.
      const hasPages = classificationPageNames.length > 0;
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
      // Serialize ONLY the verified assignments (they carry the verified
      // catalog's display names). Never re-read unverified/name-only DB rows:
      // an unchecked persisted name must not reach ProductOnPages.
      const pageNames: string[] = [];
      for (const pp of classificationPageProposals) {
        if (pp.pageName && !pageNames.includes(pp.pageName)) {
          pageNames.push(pp.pageName);
        }
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
      if (!changeSetId) {
        const dateStr = new Date().toLocaleDateString();
        const changeSetTitle = `Onboarding: ${batch.name} (${dateStr})`;
        const changeSet = createChangeSet({
          workspaceId,
          title: changeSetTitle,
          description: `Imported products from batch "${batch.name}" (${batch.fileName})`,
          baseCommit,
        });
        changeSetId = changeSet.id;
      }

      upsertChangeSetItem({
        changeSetId,
        sku: item.upc,
        operation,
        draftJson: draftJsonStr,
        baseJson: baseJsonStr,
        draftHash,
      });

      // Assign product to verified pages from classification proposals.
      // Every proposal in classificationPageProposals has a verified identity
      // (name-only rows were filtered above and recorded as skipped).
      const finalPages = classificationPageNames;
      if (finalPages.length > 0) {
        clearProductPages(item.upc);

        for (const pp of classificationPageProposals) {
          if (pp.pageId) {
            assignProductToPageId(item.upc, pp.pageId, pp.pageName);
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
          skippedPages: skippedPageRefs.map(s => s.pageName),
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
    changeSetId,
    count: promotedCount,
    failures,
  };
}

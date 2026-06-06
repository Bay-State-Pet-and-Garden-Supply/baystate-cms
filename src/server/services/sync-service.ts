import { randomUUID } from 'node:crypto';
import { parseProductsXml, type ParsedProductList } from '../../shopsite/product-parser';
import { normalizeProduct } from '../../shopsite/product-normalizer';
import { sanitizeXml } from '../../shopsite/xml-sanitizer';
import { writeProductFile, writeStoreConfig } from '../../git/workspace-files';
import { skuToProductFilePath } from '../../git/product-file-path';
import { hashJson } from '../../git/deterministic-json';
import { createSyncJob, completeSyncJob, addSyncJobEvent } from '../../db/repositories/sync-job-repo';
import { insertProductIndex } from '../../db/repositories/product-index-repo';
import { clearRegistry, upsertRegistryEntry } from '../../db/repositories/field-registry-repo';
import { updateBootstrapStatus } from '../../db/repositories/workspace-repo';
import { GitClient } from '../../git/git-client';
import { addAuditLog } from '../../db/repositories/audit-log-repo';
import type { Product } from '../../shared/types';
import type { FieldRegistryEntry } from '../../shared/types';
import type { Workspace } from '../../shared/types';

export interface BootstrapResult {
  success: boolean;
  productCount: number;
  commitHash?: string;
  errors: string[];
  warnings: string[];
}

/**
 * Bootstrap a workspace from ShopSite XML content (from local file or fetched text).
 */
export function bootstrapFromXml(
  workspace: Workspace,
  xmlContent: string,
  source: 'xml_text' | 'xml_file',
): BootstrapResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const workspacePath = workspace.workspacePath;
  const workspaceId = workspace.id;
  const now = new Date().toISOString();

  // Create sync job
  const job = createSyncJob({
    workspaceId,
    kind: source === 'xml_file' ? 'bootstrap' : 'bootstrap',
    metadataJson: JSON.stringify({ source, timestamp: now }),
  });

  addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Starting bootstrap...' });

  try {
    updateBootstrapStatus(workspaceId, 'running');

    // Sanitize and parse XML
    const cleanXml = sanitizeXml(xmlContent);
    const parsed: ParsedProductList = parseProductsXml(cleanXml);

    addSyncJobEvent({
      syncJobId: job.id, level: 'info',
      message: `Parsed ${parsed.products.length} products from XML (version ${parsed.productXmlVersion})`,
    });

    if (parsed.products.length === 0) {
      errors.push('No products found in XML data.');
      completeSyncJob(job.id, 'failed', { errorSummary: errors.join('; '), productCount: 0 });
      updateBootstrapStatus(workspaceId, 'failed');
      return { success: false, productCount: 0, errors, warnings };
    }

    // Normalize products and build registry
    const products: Product[] = [];
    const allRegistryEntries: Omit<FieldRegistryEntry, 'id'>[] = [];

    for (const parsedProduct of parsed.products) {
      const { product, registryObserved } = normalizeProduct(parsedProduct, workspaceId);
      if (!product.sku) {
        warnings.push(`Product "${product.core.name || '(unnamed)'}" has no SKU and will be skipped.`);
        continue;
      }
      products.push(product);
      allRegistryEntries.push(...registryObserved);
    }

    if (products.length === 0) {
      errors.push('No syncable products found after normalization (all missing SKU).');
      completeSyncJob(job.id, 'failed', { errorSummary: errors.join('; '), productCount: 0 });
      updateBootstrapStatus(workspaceId, 'failed');
      return { success: false, productCount: 0, errors, warnings };
    }

    // Deduplicate registry entries (keep first occurrence)
    const seenFields = new Set<string>();
    const uniqueRegistry = allRegistryEntries.filter(e => {
      if (seenFields.has(e.xmlField)) return false;
      seenFields.add(e.xmlField);
      return true;
    });

    // Write product files
    for (const product of products) {
      writeProductFile(workspacePath, product);
    }

    // Write store configs
    writeStoreConfig(workspacePath, 'field-registry.json', {
      schemaVersion: 1,
      entries: uniqueRegistry.map(e => ({
        ...e,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
      })),
    });

    writeStoreConfig(workspacePath, 'manifest.json', {
      workspaceName: workspace.name,
      workspaceId,
      appVersion: '0.1.0',
      schemaVersion: 1,
      productCount: products.length,
      generatedAt: now,
      baselineCommit: null,
    });

    // Seed product index and field registry in SQLite
    clearRegistry(workspaceId);

    for (const entry of uniqueRegistry) {
      if (entry.workspaceId === workspaceId) {
        upsertRegistryEntry({
          id: randomUUID(),
          workspaceId: entry.workspaceId,
          xmlField: entry.xmlField,
          label: entry.label,
          kind: entry.kind,
          dataType: entry.dataType,
          editable: entry.editable,
          required: entry.required,
          uiGroup: entry.uiGroup,
          sampleValuesJson: entry.sampleValuesJson,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    for (const product of products) {
      const productHash = hashJson(product);
      const hasAdvanced = product.shopsite.preserved.advancedBlocks
        && Object.keys(product.shopsite.preserved.advancedBlocks).length > 0;

      insertProductIndex({
        id: product.id,
        sku: product.sku,
        filePath: skuToProductFilePath(product.sku),
        title: product.core.name,
        status: product.status,
        price: product.core.price,
        inventoryQuantity: product.core.inventory.quantityOnHand,
        primaryImage: product.core.media.primary,
        productHash,
        lastApprovedCommit: null,
        lastPulledRemoteHash: null,
        lastSyncedRemoteHash: null,
        lastSyncedAt: null,
        syncStatus: 'not_synced',
        hasAdvancedBlocks: hasAdvanced ? 1 : 0,
        hasWarnings: warnings.length > 0 ? 1 : 0,
        createdAt: product.metadata.createdAt,
        updatedAt: product.metadata.updatedAt,
      });
    }

    // Git commit
    const git = new GitClient(workspacePath);
    try {
      git.add(['products/', 'store/', '.gitignore']);
      const versionInfo = `ShopSite XML version ${parsed.productXmlVersion}`;
      git.commit(`Initial ShopSite product bootstrap (${products.length} products, ${versionInfo})`);
      const commitHash = git.getHeadHash();

      updateBootstrapStatus(workspaceId, 'complete', commitHash);

      completeSyncJob(job.id, 'succeeded', {
        productCount: products.length,
      });

      addSyncJobEvent({
        syncJobId: job.id, level: 'info',
        message: `Bootstrap complete: ${products.length} products imported, commit: ${commitHash}`,
      });

      addAuditLog({
        workspaceId,
        entityType: 'workspace',
        entityId: workspaceId,
        action: 'bootstrap',
        message: `Bootstrapped ${products.length} products from XML (${source})`,
        detailsJson: JSON.stringify({ productCount: products.length, source, commitHash, warnings: warnings.length > 0 ? warnings : undefined }),
      });

      return { success: true, productCount: products.length, commitHash, errors, warnings };
    } catch (err) {
      const msg = `Git operation failed: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      completeSyncJob(job.id, 'failed', { errorSummary: msg, productCount: products.length });
      updateBootstrapStatus(workspaceId, 'failed');
      addSyncJobEvent({ syncJobId: job.id, level: 'error', message: msg });
      return { success: false, productCount: products.length, errors, warnings };
    }
  } catch (err) {
    const msg = `Bootstrap failed: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    completeSyncJob(job.id, 'failed', { errorSummary: msg });
    updateBootstrapStatus(workspaceId, 'failed');
    addSyncJobEvent({ syncJobId: job.id, level: 'error', message: msg });
    return { success: false, productCount: 0, errors, warnings };
  }
}

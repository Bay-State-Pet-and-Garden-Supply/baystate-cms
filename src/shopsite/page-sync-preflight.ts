import { downloadPagesFromShopSite, type PagesXmlFetcher } from './page-download-service';
import { getActivePageImport } from '../db/repositories/page-import-repo';
import { activatePageImportFromRecords } from './page-import-service';

export interface PagesPreflightResult {
  status: 'up_to_date' | 'reconciled';
  sourceHash: string;
  verifiedCount: number;
  message: string;
  warnings?: string[];
}

/**
 * Preflights the ShopSite Pages database before a Product push.
 *
 * 1. Downloads the live Pages XML from ShopSite via the given fetcher/client.
 * 2. Compares the remote source hash against the workspace's active page import.
 * 3. If identical, confirms category metadata is current (zero DB writes).
 * 4. If remote has changed (or no active import exists), atomically activates
 *    the new verified page import so <ProductOnPages> serializes against
 *    up-to-date category names.
 * 5. Fails closed on any transport, parse, or response error.
 */
export async function preflightPagesSync(options: {
  workspaceId: string;
  client: PagesXmlFetcher;
  activatedBy?: string | null;
}): Promise<PagesPreflightResult> {
  const downloadResult = await downloadPagesFromShopSite(options.client);
  if (!downloadResult.ok) {
    throw new Error(`ShopSite Pages preflight failed: ${downloadResult.error}`);
  }

  const activeImport = getActivePageImport(options.workspaceId);
  if (activeImport && activeImport.sourceHash === downloadResult.sourceHash) {
    return {
      status: 'up_to_date',
      sourceHash: downloadResult.sourceHash,
      verifiedCount: downloadResult.counts.verified,
      message: `Page catalog verified up-to-date with ShopSite (${downloadResult.counts.verified} verified pages, hash ${downloadResult.sourceHash.slice(0, 8)}).`,
      warnings: downloadResult.warnings,
    };
  }

  const verifiedRecords = downloadResult.records.filter(
    r => r.identity.kind !== 'unverified_name_only' && r.identity.status === 'verified',
  );

  if (verifiedRecords.length === 0) {
    throw new Error(
      `ShopSite Pages preflight found no verified pages in downloaded XML (hash ${downloadResult.sourceHash.slice(0, 8)}).`,
    );
  }

  activatePageImportFromRecords({
    workspaceId: options.workspaceId,
    sourceHash: downloadResult.sourceHash,
    parserFormatVersion: downloadResult.parserFormatVersion,
    records: verifiedRecords,
    activatedBy: options.activatedBy ?? 'sync-preflight',
  });

  const prevHash = activeImport ? activeImport.sourceHash.slice(0, 8) : 'none';
  const nextHash = downloadResult.sourceHash.slice(0, 8);
  const message = activeImport
    ? `ShopSite Pages database changed (${prevHash} -> ${nextHash}); reconciled ${verifiedRecords.length} verified page(s).`
    : `Initial page catalog activated from ShopSite (${verifiedRecords.length} verified page(s), hash ${nextHash}).`;

  return {
    status: 'reconciled',
    sourceHash: downloadResult.sourceHash,
    verifiedCount: verifiedRecords.length,
    message,
    warnings: downloadResult.warnings,
  };
}

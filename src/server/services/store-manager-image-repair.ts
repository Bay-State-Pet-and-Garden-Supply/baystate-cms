/**
 * Store Manager image repair service (epic #42, #36).
 *
 * The single hardened implementation of change-set image repair. Both the
 * agent tool (`repairChangeSetImages` in store-manager-tools.ts) and the
 * direct UI route (`POST /export/change-set/:id/repair-images` in
 * export-routes.ts) delegate here, so chat and Change Set Review cannot drift
 * or bypass the hardening.
 *
 * Hardening boundaries enforced in this one module:
 *  - approved-state gate BEFORE any side effect (no mkdir / network / decode /
 *    write happens for a change set that is not exactly `approved`);
 *  - workspace-scoped change-set lookup (a foreign change set is
 *    indistinguishable from a missing one);
 *  - bounded network policy: public-only DNS, http(s), ports 80/443, per-hop
 *    manual redirect re-validation, `image/*` content types, a hard stream
 *    byte cap, per-request timeout and whole-operation deadline, injectable
 *    resolver/fetch/clock seams;
 *  - every payload is decoded/validated with Sharp before any write; writes go
 *    to a temp sibling file and are atomically renamed only after a successful
 *    decode/transform; there is no raw-byte fallback;
 *  - canonical path containment (`path.relative` plus realpath of existing
 *    ancestors) confines every destination under the workspace images root;
 *  - non-HTTP values are LOCAL references, never counted as success unless a
 *    contained regular file decodes within bounds;
 *  - bounded per-SKU/per-image structured outcomes with redacted URLs.
 *
 * The IP private/link-local floor is shared (`classifyIp`/`isPrivateOrLinkLocal`
 * are pure helpers from `src/shared/ssrf.ts`, relocated from the PI policy
 * gateway during the Agent Lab decommission). This service never writes to PI
 * tables and never manufactures PI run ids.
 */

import path from 'node:path';
import fs from 'node:fs';
import { lookup } from 'node:dns/promises';
import { classifyIp } from '../../shared/ssrf';
import { findChangeSetByWorkspaceId } from '../../db/repositories/change-set-repo';
import { listChangeSetItems } from '../../db/repositories/change-set-repo';
import { findExtractionDataByWorkspaceAndUpc } from '../../db/repositories/onboarding-item-repo';

// ---------------------------------------------------------------------------
// Immutable repair policy bounds (one place, conservative defaults)
// ---------------------------------------------------------------------------

export const IMAGE_REPAIR_POLICY = {
  /** Maximum products (change-set items) repaired in one operation. */
  maxProducts: 200,
  /** Maximum image URLs processed per SKU. */
  maxUrlsPerSku: 8,
  /** Maximum total images counted in one operation. */
  maxTotalImages: 500,
  /** Hard byte cap per downloaded response body (stream-enforced). */
  maxBytesPerResponse: 10 * 1024 * 1024,
  /** Maximum decoded pixel dimension (rejects decompression-bomb candidates). */
  maxPixelDimension: 8000,
  /** Maximum decoded pixel count before normalization. */
  maxDecodedPixels: 50_000_000,
  /** Maximum redirect hops followed (each hop re-validated). */
  maxRedirects: 4,
  /** Per-request timeout (caller-composed AbortSignal). */
  perRequestTimeoutMs: 15_000,
  /** Whole-operation deadline. */
  operationDeadlineMs: 120_000,
  /** Normalization target dimensions (fit: contain, white background). */
  normalizeWidth: 1000,
  normalizeHeight: 1000,
} as const;

export type ImageRepairEntryStatus =
  | 'downloaded'
  | 'already_present'
  | 'no_source'
  | 'policy_denied'
  | 'invalid_image'
  | 'too_large'
  | 'timeout'
  | 'write_error';

export interface ImageRepairImageEntry {
  status: ImageRepairEntryStatus;
  /** 0 = primary image, 1..n = additional image index. */
  imageIndex: number;
  /** Redacted source: origin + bounded path. Never a raw provider URL with query secrets. */
  sourceUrlRedacted: string;
}

export interface ImageRepairSkuResult {
  sku: string;
  imagesDownloaded: number;
  entries: ImageRepairImageEntry[];
  /** Present when zero images could be made available for the SKU. */
  error?: string;
}

export interface ImageRepairSummary {
  success: boolean;
  summary: string;
  results: ImageRepairSkuResult[];
}

export type ChangeSetImageRepairResult =
  | { status: 'not_found'; error: string }
  | { status: 'policy_denied'; error: string }
  | { status: 'error'; error: string }
  | { status: 'ok'; summary: ImageRepairSummary };

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

export type DecodeImageFn = (
  buffer: Buffer,
) => Promise<{ ok: true; jpeg: Buffer } | { ok: false; reason: 'invalid_image' | 'too_large' }>;

export interface ImageRepairDeps {
  /** DNS resolver injection for tests. Defaults to node:dns lookup. */
  resolveHostname?: (hostname: string) => Promise<string[]>;
  /** Fetch injection for tests (redirect/SSRF/size/timeout scenarios). */
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Clock injection for tests. */
  now?: () => Date;
  /**
   * Decode + validate + normalize an image payload. Defaults to the Sharp
   * pipeline (bounded decode, no raw fallback). Tests inject fakes for
   * corrupt / oversized / valid payloads.
   */
  decodeImage?: DecodeImageFn;
  /** Test seam overriding request/operation timeouts (production defaults stay immutable). */
  timeouts?: { perRequestMs?: number; operationDeadlineMs?: number };
  /** Test seam for the immutable repair bounds; production callers never pass this. */
  policy?: { maxTotalImages?: number };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Slugify helper (mirrors the existing draft-promoter/export copies). */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** True for http(s) URLs only; everything else is treated as a local reference. */
function isHttpUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw);
}

/** Redact a URL to origin + a bounded path (never query params, userinfo, or long paths). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const boundedPath = `/${segments.slice(0, 3).join('/')}`;
    return `${u.protocol}//${u.hostname}${boundedPath}`;
  } catch {
    return '<unparseable-url>';
  }
}

/**
 * Deterministic canonical containment check. `candidate` must resolve to a
 * path that is equal to or strictly inside `root`. Rejects `..` escapes,
 * absolute relative results, and any path that would land at or above root.
 */
function resolveUnderRoot(root: string, candidate: string): { ok: true; resolved: string } | { ok: false } {
  const rootAbs = path.resolve(root);
  const candidateAbs = path.resolve(candidate);
  const rel = path.relative(rootAbs, candidateAbs);
  if (rel === '') return { ok: true, resolved: candidateAbs };
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { ok: false };
  return { ok: true, resolved: candidateAbs };
}

/** Default decode/validate/normalize pipeline. No raw-byte fallback. */
async function decodeWithSharp(buffer: Buffer): Promise<{ ok: true; jpeg: Buffer } | { ok: false; reason: 'invalid_image' | 'too_large' }> {
  try {
    const sharp = (await import('sharp')).default;
    const metadata = await sharp(buffer).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0) return { ok: false, reason: 'invalid_image' };
    if (width > IMAGE_REPAIR_POLICY.maxPixelDimension || height > IMAGE_REPAIR_POLICY.maxPixelDimension) {
      return { ok: false, reason: 'too_large' };
    }
    if (width * height > IMAGE_REPAIR_POLICY.maxDecodedPixels) return { ok: false, reason: 'too_large' };
    const jpeg = await sharp(buffer)
      .flatten({ background: '#ffffff' })
      .resize(IMAGE_REPAIR_POLICY.normalizeWidth, IMAGE_REPAIR_POLICY.normalizeHeight, {
        fit: 'contain',
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .jpeg({ quality: 90 })
      .toBuffer();
    return { ok: true, jpeg };
  } catch {
    return { ok: false, reason: 'invalid_image' };
  }
}

function composeRequestSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

// ---------------------------------------------------------------------------
// Bounded network boundary (mirrors the PI gateway security properties)
// ---------------------------------------------------------------------------

type FetchImageResult =
  | { kind: 'ok'; buffer: Buffer }
  | { kind: 'error'; reason: ImageRepairEntryStatus };

class ImageRepairNetworkBoundary {
  constructor(private readonly deps: ImageRepairDeps = {}) {}

  private async resolveAddresses(hostname: string): Promise<string[]> {
    if (this.deps.resolveHostname) return this.deps.resolveHostname(hostname);
    const records = await lookup(hostname, { all: true });
    return records.map((r) => r.address);
  }

  /**
   * Destination validation: http(s) only, ports 80/443, explicit loopback
   * rejection, DNS resolution with a private/link-local floor. This is the
   * same SSRF floor (classifyIp, src/shared/ssrf.ts).
   */
  private async validateDestination(
    url: string,
  ): Promise<{ allowed: true } | { allowed: false; reason: 'invalid_url' | 'invalid_protocol' | 'invalid_port' | 'private_network_destination' | 'no_dns_records' }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, reason: 'invalid_url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: 'invalid_protocol' };
    }
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (port !== 80 && port !== 443) return { allowed: false, reason: 'invalid_port' };
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return { allowed: false, reason: 'private_network_destination' };
    }
    try {
      const addresses = await this.resolveAddresses(hostname);
      if (addresses.length === 0) return { allowed: false, reason: 'no_dns_records' };
      const denied = addresses.find((address) => {
        const kind = classifyIp(address);
        return kind === 'private' || kind === 'link_local';
      });
      if (denied) return { allowed: false, reason: 'private_network_destination' };
    } catch {
      return { allowed: false, reason: 'no_dns_records' };
    }
    return { allowed: true };
  }

  /**
   * Policy-enforcing image fetch: validates every hop (including redirects),
   * requires an `image/*` content type, and caps the streamed body. Returns a
   * bounded structured outcome; never throws arbitrary transport exceptions.
   */
  async fetchImage(url: string, parentSignal: AbortSignal | undefined): Promise<FetchImageResult> {
    const perRequestMs =
      this.deps.timeouts?.perRequestMs ?? IMAGE_REPAIR_POLICY.perRequestTimeoutMs;
    const requestSignal = composeRequestSignal(parentSignal, perRequestMs);
    try {
      let currentUrl = url;
      let redirects = 0;
      for (;;) {
        const check = await this.validateDestination(currentUrl);
        if (!check.allowed) return { kind: 'error', reason: 'policy_denied' };

        let response: Response;
        try {
          response = await this.fetchFn(currentUrl, { redirect: 'manual', signal: requestSignal.signal });
        } catch {
          // Transport failure (including abort from timeout/deadline/caller
          // cancellation) is reported as the bounded 'timeout' outcome.
          return { kind: 'error', reason: 'timeout' };
        }

        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
          redirects += 1;
          if (redirects > IMAGE_REPAIR_POLICY.maxRedirects) {
            return { kind: 'error', reason: 'policy_denied' };
          }
          currentUrl = new URL(response.headers.get('location')!, currentUrl).toString();
          continue;
        }

        if (!response.ok) {
          // 404/410 = source gone; other non-ok = unusable payload.
          return { kind: 'error', reason: response.status === 404 || response.status === 410 ? 'no_source' : 'invalid_image' };
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.startsWith('image/')) return { kind: 'error', reason: 'invalid_image' };

        const buffer = await this.readBoundedBody(response, requestSignal.signal);
        if (buffer === null) return { kind: 'error', reason: 'too_large' };
        return { kind: 'ok', buffer };
      }
    } finally {
      requestSignal.dispose();
    }
  }

  private get fetchFn(): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return this.deps.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** Stream the response body with a hard byte cap (chunked/unknown length safe). */
  private async readBoundedBody(response: Response, signal: AbortSignal): Promise<Buffer | null> {
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) return null;
        total += value.byteLength;
        if (total > IMAGE_REPAIR_POLICY.maxBytesPerResponse) return null;
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    }
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > IMAGE_REPAIR_POLICY.maxBytesPerResponse) return null;
    return buf;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RepairChangeSetImagesInput {
  workspaceId: string;
  workspacePath: string;
  changeSetId: string;
  /** Caller cancellation (e.g. request aborted). */
  signal?: AbortSignal;
}

/**
 * Re-download and normalize images for an approved change set using the
 * original onboarding extraction data. Fail-closed: any disallowed state
 * returns policy_denied/not_found with zero side effects.
 */
export async function repairChangeSetImagesForWorkspace(
  input: RepairChangeSetImagesInput,
  deps: ImageRepairDeps = {},
): Promise<ChangeSetImageRepairResult> {
  const startedAt = deps.now ? deps.now().getTime() : Date.now();
  const operationDeadlineMs =
    deps.timeouts?.operationDeadlineMs ?? IMAGE_REPAIR_POLICY.operationDeadlineMs;
  const deadlineAt = startedAt + operationDeadlineMs;

  const deadlineExceeded = () => (deps.now ? deps.now().getTime() : Date.now()) > deadlineAt;

  // 1. Workspace-scoped change-set lookup (foreign == missing).
  const changeSet = findChangeSetByWorkspaceId(input.workspaceId, input.changeSetId);
  if (!changeSet) {
    return { status: 'not_found', error: 'Change set not found in this workspace.' };
  }

  // 2. Approved-state gate BEFORE any directory/network/decode/write side effect.
  if (changeSet.status !== 'approved') {
    return {
      status: 'policy_denied',
      error: `Change set status "${changeSet.status}" is not "approved"; image repair requires an approved change set.`,
    };
  }

  const items = listChangeSetItems(input.changeSetId);
  if (items.length === 0) {
    return { status: 'error', error: 'Change set has no items.' };
  }
  if (items.length > IMAGE_REPAIR_POLICY.maxProducts) {
    return {
      status: 'policy_denied',
      error: `Change set has ${items.length} items, exceeding the repair limit of ${IMAGE_REPAIR_POLICY.maxProducts}.`,
    };
  }

  // 3. Establish the canonical images root (trusted derivation from workspacePath).
  const imagesRoot = path.resolve(input.workspacePath, 'products', 'images');
  try {
    fs.mkdirSync(imagesRoot, { recursive: true });
  } catch {
    return { status: 'error', error: 'Unable to create the workspace images directory.' };
  }
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(imagesRoot);
  } catch {
    return { status: 'error', error: 'Unable to resolve the workspace images directory.' };
  }

  const boundary = new ImageRepairNetworkBoundary(deps);
  const results: ImageRepairSkuResult[] = [];
  let totalImages = 0;
  const maxTotalImages = deps.policy?.maxTotalImages ?? IMAGE_REPAIR_POLICY.maxTotalImages;

  for (const item of items) {
    if (deadlineExceeded()) {
      results.push({
        sku: item.sku,
        imagesDownloaded: 0,
        entries: [{ status: 'timeout', imageIndex: 0, sourceUrlRedacted: '' }],
        error: 'Operation deadline exceeded',
      });
      continue;
    }
    // Remaining whole-operation image budget: enforced BEFORE any fetch,
    // decode, or write for this SKU (each dispatch decrements it).
    const remainingImages = maxTotalImages - totalImages;
    if (remainingImages <= 0) {
      results.push({
        sku: item.sku,
        imagesDownloaded: 0,
        entries: [{ status: 'policy_denied', imageIndex: 0, sourceUrlRedacted: '' }],
        error: `Exceeds total image limit of ${maxTotalImages}`,
      });
      continue;
    }
    const skuResult = await repairSkuForWorkspace(
      {
        workspaceId: input.workspaceId,
        sku: item.sku,
        draftJson: item.draftJson,
        imagesRoot: realRoot,
        maxImages: remainingImages,
      },
      boundary,
      deps,
      input.signal,
    );
    totalImages += skuResult.imagesDownloaded;
    results.push(skuResult);
  }

  const failedCount = results.filter((r) => r.error).length;
  const totalDownloaded = results.reduce((sum, r) => sum + r.imagesDownloaded, 0);
  return {
    status: 'ok',
    summary: {
      success: failedCount < results.length,
      summary:
        `Repaired ${totalDownloaded} image(s) across ${results.length} product(s)` +
        (failedCount > 0 ? ` (${failedCount} failure(s))` : ''),
      results,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-SKU repair
// ---------------------------------------------------------------------------

interface RepairSkuContext {
  workspaceId: string;
  sku: string;
  draftJson: string;
  imagesRoot: string;
  /** Remaining image-dispatch budget for the whole operation; enforced before each side effect. */
  maxImages: number;
}

async function repairSkuForWorkspace(
  ctx: RepairSkuContext,
  boundary: ImageRepairNetworkBoundary,
  deps: ImageRepairDeps,
  parentSignal: AbortSignal | undefined,
): Promise<ImageRepairSkuResult> {
  const extraction = findExtractionDataByWorkspaceAndUpc(ctx.workspaceId, ctx.sku);
  if (!extraction?.extractionDataJson) {
    return {
      sku: ctx.sku,
      imagesDownloaded: 0,
      entries: [{ status: 'no_source', imageIndex: 0, sourceUrlRedacted: '' }],
      error: 'No extraction data',
    };
  }

  let extractionData: { primaryImage?: unknown; additionalImages?: unknown };
  try {
    extractionData = JSON.parse(extraction.extractionDataJson);
  } catch {
    return {
      sku: ctx.sku,
      imagesDownloaded: 0,
      entries: [{ status: 'no_source', imageIndex: 0, sourceUrlRedacted: '' }],
      error: 'Invalid extraction data',
    };
  }

  const primaryUrl: string | null = typeof extractionData.primaryImage === 'string' ? extractionData.primaryImage : null;
  const additionalUrls: string[] = Array.isArray(extractionData.additionalImages)
    ? extractionData.additionalImages.filter((u): u is string => typeof u === 'string')
    : [];

  // Bound URLs per SKU before any side effect.
  const allUrls: string[] = [];
  if (primaryUrl) allUrls.push(primaryUrl);
  for (const url of additionalUrls) {
    if (url && url !== primaryUrl) allUrls.push(url);
  }
  if (allUrls.length > IMAGE_REPAIR_POLICY.maxUrlsPerSku) allUrls.length = IMAGE_REPAIR_POLICY.maxUrlsPerSku;
  if (allUrls.length === 0) {
    return {
      sku: ctx.sku,
      imagesDownloaded: 0,
      entries: [{ status: 'no_source', imageIndex: 0, sourceUrlRedacted: '' }],
      error: 'No image URLs in extraction data',
    };
  }

  let product: { core?: { name?: unknown; media?: { primary?: unknown } }; customFields?: Record<string, unknown> };
  try {
    product = JSON.parse(ctx.draftJson);
  } catch {
    return {
      sku: ctx.sku,
      imagesDownloaded: 0,
      entries: [{ status: 'no_source', imageIndex: 0, sourceUrlRedacted: '' }],
      error: 'Failed to parse product JSON',
    };
  }

  const brandName = product.customFields?.['ProductField16'] || extraction.brandHint || 'unbranded';
  const brandFolder = slugify(String(brandName)) || 'unbranded';

  const existingPrimary = product.core?.media?.primary;
  const imageStem = typeof existingPrimary === 'string' && existingPrimary
    ? path.basename(existingPrimary, path.extname(existingPrimary))
    : slugify(String(product.core?.name || ctx.sku)) || 'product';

  // Destination directory containment (under the canonical images root).
  const dirCheck = resolveUnderRoot(ctx.imagesRoot, path.join(ctx.imagesRoot, brandFolder));
  if (!dirCheck.ok) {
    return {
      sku: ctx.sku,
      imagesDownloaded: 0,
      entries: [{ status: 'policy_denied', imageIndex: 0, sourceUrlRedacted: '' }],
      error: 'Brand folder escapes the image root',
    };
  }
  const brandDir = dirCheck.resolved;

  // Unique stem when the primary target already exists.
  let finalStem = imageStem;
  if (fs.existsSync(path.join(brandDir, `${finalStem}.jpg`))) finalStem = `${imageStem}-${ctx.sku}`;

  const entries: ImageRepairImageEntry[] = [];
  let downloaded = 0;
  const decode = deps.decodeImage ?? decodeWithSharp;

  for (let index = 0; index < allUrls.length; index++) {
    const url = allUrls[index];
    const suffix = index === 0 ? '' : `-${index + 1}`;
    const filename = `${finalStem}${suffix}.jpg`;

    // Whole-operation image budget enforced BEFORE this dispatch: once the
    // remaining budget is exhausted no further fetch/decode/write happens.
    if (ctx.maxImages <= 0) {
      entries.push({ status: 'policy_denied', imageIndex: index, sourceUrlRedacted: redactUrl(url) });
      continue;
    }
    ctx.maxImages -= 1;

    if (isHttpUrl(url)) {
      const outcome = await downloadAndWriteOne(
        url,
        brandDir,
        filename,
        ctx.imagesRoot,
        boundary,
        decode,
        parentSignal,
      );
      entries.push({ status: outcome, imageIndex: index, sourceUrlRedacted: redactUrl(url) });
      if (outcome === 'downloaded') downloaded += 1;
    } else {
      const outcome = await localReferenceOne(url, ctx.imagesRoot, decode);
      entries.push({
        status: outcome.status,
        imageIndex: index,
        sourceUrlRedacted: outcome.status === 'already_present' ? url : redactUrl(url),
      });
      if (outcome.status === 'already_present') downloaded += 1;
    }
  }

  const failed = entries.filter(
    (e) => e.status !== 'downloaded' && e.status !== 'already_present',
  );
  const error =
    downloaded === 0
      ? failed.length > 0
        ? `No images available (${failed.map((e) => e.status).join(', ')})`
        : 'No images available'
      : undefined;

  return { sku: ctx.sku, imagesDownloaded: downloaded, entries, error };
}

/** Download + decode + atomic write for one remote image URL. */
async function downloadAndWriteOne(
  url: string,
  brandDir: string,
  filename: string,
  imagesRoot: string,
  boundary: ImageRepairNetworkBoundary,
  decode: DecodeImageFn,
  parentSignal: AbortSignal | undefined,
): Promise<ImageRepairEntryStatus> {
  const fetched = await boundary.fetchImage(url, parentSignal);
  if (fetched.kind === 'error') return fetched.reason;

  const decoded = await decode(fetched.buffer);
  if (!decoded.ok) return decoded.reason;

  const destCheck = resolveUnderRoot(imagesRoot, path.join(brandDir, filename));
  if (!destCheck.ok) return 'policy_denied';
  const destPath = destCheck.resolved;

  try {
    fs.mkdirSync(brandDir, { recursive: true });
    // Re-prove containment against real paths (symlink escape via existing dirs).
    const realDir = fs.realpathSync(brandDir);
    const realRoot = fs.realpathSync(imagesRoot);
    const realCheck = resolveUnderRoot(realRoot, path.join(realDir, filename));
    if (!realCheck.ok) return 'policy_denied';
    const finalPath = realCheck.resolved;
    // Temp sibling + atomic rename; only a fully decoded/transformed payload lands.
    const tmpPath = path.join(realDir, `.${filename}.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmpPath, decoded.jpeg);
    fs.renameSync(tmpPath, finalPath);
    return 'downloaded';
  } catch {
    return 'write_error';
  }
}

/** Resolve a non-HTTP value as a local reference; count it only when valid. */
async function localReferenceOne(
  raw: string,
  imagesRoot: string,
  decode: DecodeImageFn,
): Promise<{ status: ImageRepairEntryStatus }> {
  // Reject explicit schemes (data:, file:, ftp:, ...) and NUL.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.includes('\0')) {
    return { status: 'policy_denied' };
  }
  const check = resolveUnderRoot(imagesRoot, path.resolve(imagesRoot, raw));
  if (!check.ok) return { status: 'policy_denied' };
  const resolved = check.resolved;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
    if (!stat.isFile()) return { status: 'no_source' };
    // Symlink escape: the real path must remain under the canonical root.
    const real = fs.realpathSync(resolved);
    const realCheck = resolveUnderRoot(fs.realpathSync(imagesRoot), real);
    if (!realCheck.ok) return { status: 'policy_denied' };
  } catch {
    return { status: 'no_source' };
  }

  // Decode-validate within bounds before declaring already_present.
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(resolved);
  } catch {
    return { status: 'no_source' };
  }
  const decoded = await decode(buffer);
  if (!decoded.ok) return { status: decoded.reason };
  return { status: 'already_present' };
}

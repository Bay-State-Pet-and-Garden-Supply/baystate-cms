/**
 * Image verification contract (PI-6).
 *
 * The deterministic seam between the network-facing tool adapters and pixel
 * decoding: `ImageVerificationContract.verify` decodes a fetched buffer and
 * returns safe metadata (dimensions, content hash, perceptual hash) plus the
 * pixel-level quality verdict. The contract NEVER fetches — fetching is the
 * tool adapter's job through the policy gateway.
 *
 * The default `SharpImageVerificationAdapter` uses sharp (already a
 * dependency) to decode rasters and reject corrupt content. It is the ONLY
 * module that imports sharp; tests can substitute a stub contract.
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/23
 */
import sharp from 'sharp';
import { dhashFromRaw, sha256Hex } from './image-hash';
import type { AssetQualityStatus, NetContent } from './schema';

export interface ImageVerificationOutput {
  /** True when the buffer decoded as a raster image. */
  verified: boolean;
  image: {
    width: number;
    height: number;
    aspectRatio: number;
    /** SHA-256 of the original fetched bytes. */
    contentHash: string;
    /** dHash of the decoded pixels (null when decode produced no pixels). */
    perceptualHash: string | null;
  };
  /** Pixel-level observations only — OCR is out of scope for this contract. */
  observed: {
    brand: string | null;
    productName: string | null;
    variant: string | null;
    netContent: NetContent | null;
    packCount: number | null;
    gtin: string | null;
  };
  qualityStatus: AssetQualityStatus;
  rejectionReason: string | null;
}

export interface ImageVerificationContract {
  readonly name: string;
  readonly version: string;
  verify(input: { buffer: Uint8Array; contentType: string | null }): Promise<ImageVerificationOutput>;
}

/** Minimum edge length for a commerce-usable image. */
const MIN_USABLE_EDGE = 200;

class SharpImageVerificationAdapter implements ImageVerificationContract {
  readonly name = 'sharp_image_verification';
  readonly version = '1.0.0';

  async verify(input: { buffer: Uint8Array; contentType: string | null }): Promise<ImageVerificationOutput> {
    const bytes = Buffer.from(input.buffer);
    const contentHash = sha256Hex(bytes); // raw bytes, not latin1 round-trip
    try {
      const metadata = await sharp(bytes).metadata();
      if (!metadata.width || !metadata.height) {
        return {
          verified: false,
          image: { width: 0, height: 0, aspectRatio: 0, contentHash, perceptualHash: null },
          observed: { brand: null, productName: null, variant: null, netContent: null, packCount: null, gtin: null },
          qualityStatus: 'invalid',
          rejectionReason: 'corrupt or non-image content (no dimensions)',
        };
      }
      const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
      const perceptualHash = dhashFromRaw({ data, width: info.width, height: info.height, channels: info.channels ?? 4 });
      const width = info.width;
      const height = info.height;
      const lowQuality = width < MIN_USABLE_EDGE || height < MIN_USABLE_EDGE;
      return {
        verified: true,
        image: {
          width,
          height,
          aspectRatio: height > 0 ? Number((width / height).toFixed(3)) : 0,
          contentHash,
          perceptualHash,
        },
        observed: { brand: null, productName: null, variant: null, netContent: null, packCount: null, gtin: null },
        qualityStatus: lowQuality ? 'low_quality' : 'usable',
        rejectionReason: null,
      };
    } catch {
      return {
        verified: false,
        image: { width: 0, height: 0, aspectRatio: 0, contentHash, perceptualHash: null },
        observed: { brand: null, productName: null, variant: null, netContent: null, packCount: null, gtin: null },
        qualityStatus: 'invalid',
        rejectionReason: 'corrupt or non-image content (decode failed)',
      };
    }
  }
}

export const sharpImageVerificationAdapter = new SharpImageVerificationAdapter();

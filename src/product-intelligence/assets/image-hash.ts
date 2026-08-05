/**
 * Perceptual image hashing (PI-6).
 *
 * `dhashFromRaw` implements the classic dHash: downsample to a tiny grayscale
 * grid and encode the relative brightness of neighboring pixels as bits.
 * Resizes/re-encodes of the same artwork keep the same dHash, while distinct
 * images differ — this powers exact and perceptual duplicate detection.
 *
 * Pure module: no sharp, no database, no network (vitest-runnable).
 *
 * @see https://github.com/Bay-State-Pet-and-Garden-Supply/baystate-cms/issues/23
 */

export interface RawImageData {
  /** Raw pixel data (RGB or RGBA, row-major). */
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Deterministic dHash over decoded raw pixels. The image is box-downsampled
 * to (size+1)×size and each pixel's luminance is compared to its right
 * neighbor, producing size×size bits encoded as a hex string.
 */
export function dhashFromRaw(raw: RawImageData, size = 8): string {
  const { data, width, height, channels } = raw;
  if (width <= 0 || height <= 0 || data.length < width * height) {
    return '0'.repeat(Math.ceil((size * size) / 4));
  }
  const stride = channels >= 3 ? channels : 4;
  const gh = size; // rows
  const gw = size + 1; // columns

  // Box-downsample into a gw×gh luminance grid.
  const grid: number[] = [];
  for (let y = 0; y < gh; y += 1) {
    const y0 = Math.floor((y / gh) * height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) / gh) * height));
    for (let x = 0; x < gw; x += 1) {
      const x0 = Math.floor((x / gw) * width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) / gw) * width));
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const idx = (yy * width + xx) * stride;
          sum += luminance(data[idx] ?? 0, data[idx + 1] ?? 0, data[idx + 2] ?? 0);
          count += 1;
        }
      }
      grid.push(count > 0 ? sum / count : 0);
    }
  }

  // Compare each pixel to its right neighbor.
  const bits: string[] = [];
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw - 1; x += 1) {
      bits.push(grid[y * gw + x] > grid[y * gw + x + 1] ? '1' : '0');
    }
  }

  // Encode as hex (left-pad to a whole nibble).
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble = bits.slice(i, i + 4).join('');
    hex += parseInt(nibble.padEnd(4, '0'), 2).toString(16);
  }
  return hex;
}

/** Hamming distance between two hex-encoded hashes of equal length. */
export function perceptualHammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  const aBytes = Buffer.from(a, 'hex');
  const bBytes = Buffer.from(b, 'hex');
  let distance = 0;
  for (let i = 0; i < aBytes.length; i += 1) {
    const diff = aBytes[i] ^ bBytes[i];
    distance += popcount(diff);
  }
  return distance;
}

function popcount(byte: number): number {
  let value = byte;
  let count = 0;
  while (value !== 0) {
    value &= value - 1;
    count += 1;
  }
  return count;
}

/** Hex SHA-256 of raw bytes (re-export for convenience). */
export { sha256Hex } from '../../shared/stable-id';

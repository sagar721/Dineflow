// Menu image validation and re-encoding (PRD FR-023, NFR-S07; design/00 §3.5).
//
// Nothing about an upload is trusted: not a file name (none is accepted), not the
// declared type (checked against the bytes), not the bytes themselves (decoded and
// redrawn). What is stored is a fresh WebP made from the decoded pixels only, so
// metadata, trailing data, embedded scripts and polyglot tricks do not survive.
import sharp from 'sharp';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Longest edge of the stored image. Larger uploads are scaled down, never up. */
export const MAX_EDGE_PX = 1600;
/**
 * Decoded-size ceiling (about 40 megapixels). A small file can declare enormous
 * dimensions — a decompression bomb — and this stops the decoder before it allocates.
 */
export const MAX_INPUT_PIXELS = 40_000_000;

export type AcceptedType = 'image/jpeg' | 'image/png' | 'image/webp';
export const ACCEPTED_TYPES: readonly AcceptedType[] = ['image/jpeg', 'image/png', 'image/webp'];

type RejectionCode = 'IMAGE_TOO_LARGE' | 'IMAGE_TYPE_NOT_ALLOWED' | 'IMAGE_TYPE_MISMATCH' | 'IMAGE_INVALID';

export class ImageRejected extends Error {
  readonly code: RejectionCode;

  constructor(code: RejectionCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Identifies the format from the file's own signature bytes. */
export function sniffType(bytes: Buffer): AcceptedType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

const SHARP_FORMAT: Record<AcceptedType, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Validates an upload and returns a clean WebP. Throws ImageRejected with a
 * specific, user-safe reason; never echoes the input.
 */
export async function processMenuImage(bytes: Buffer, declaredType: string): Promise<Buffer> {
  if (bytes.length === 0) throw new ImageRejected('IMAGE_INVALID', 'The file is empty.');
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new ImageRejected('IMAGE_TOO_LARGE', 'Images must be 5 MB or smaller.');
  }
  if (!ACCEPTED_TYPES.includes(declaredType as AcceptedType)) {
    throw new ImageRejected('IMAGE_TYPE_NOT_ALLOWED', 'Use a JPEG, PNG or WebP image.');
  }
  const actual = sniffType(bytes);
  if (!actual) throw new ImageRejected('IMAGE_TYPE_NOT_ALLOWED', 'Use a JPEG, PNG or WebP image.');
  if (actual !== declaredType) {
    throw new ImageRejected('IMAGE_TYPE_MISMATCH', 'The file’s contents do not match its type. Use a real JPEG, PNG or WebP image.');
  }

  try {
    // failOn 'error' refuses truncated and corrupt files instead of drawing a
    // partial picture; limitInputPixels refuses bombs before decoding.
    const input = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS, animated: false });
    const meta = await input.metadata();
    if (meta.format !== SHARP_FORMAT[actual]) {
      throw new ImageRejected('IMAGE_TYPE_MISMATCH', 'The file’s contents do not match its type. Use a real JPEG, PNG or WebP image.');
    }
    return await input
      .rotate() // applies the camera's orientation to the pixels before the EXIF that carried it is dropped
      .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer(); // sharp writes no metadata unless asked to keep it
  } catch (error) {
    if (error instanceof ImageRejected) throw error;
    // Decoder errors can quote file internals; the user gets a plain reason instead.
    throw new ImageRejected('IMAGE_INVALID', 'That image could not be read. Try saving it again as a JPEG or PNG.');
  }
}

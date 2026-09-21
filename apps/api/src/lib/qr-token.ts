// QR capability tokens (docs/design/07-stage2-conditions.md §5).
//
//   token = base64url( kid (1 byte) || qr_id (16 bytes) || mac (16 bytes) )   -> 44 chars
//   mac   = first 16 bytes of HMAC-SHA256( key[kid], "dineflow-qr-v1" || qr_id )
//
// The database stores only the random qr_id; the key lives only in the API's
// environment. A working token needs both, so stealing either one alone yields
// nothing that orders at a table. And because the token is derived rather than
// stored, a restaurant can re-download a lost QR without invalidating the printed
// card still on the table.
import { createHmac, timingSafeEqual } from 'node:crypto';

const DOMAIN = Buffer.from('dineflow-qr-v1');
const TOKEN_LENGTH = 44; // base64url of 33 bytes, no padding
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{44}$/;
const MIN_KEY_BYTES = 32;
const MIN_DISTINCT_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type QrKeyring = {
  /** The key new tokens are signed with. */
  currentKid: number;
  keys: ReadonlyMap<number, Buffer>;
};

/**
 * Parses `QR_SIGNING_KEYS`: comma-separated `kid:secret` pairs, secrets in base64url.
 * Several keys may be listed so that tokens printed under an older key keep working
 * after a rotation; removing a kid deliberately invalidates every card signed with it.
 */
export function parseKeyring(spec: string, currentKid?: number): QrKeyring {
  const keys = new Map<number, Buffer>();
  const seen = new Set<string>();
  // Every message below names at most the key id. Never the secret, and never a
  // prefix, suffix or length of it: error text ends up in logs and terminals.
  for (const entry of spec.split(',').map((part) => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    const kidText = separator === -1 ? entry : entry.slice(0, separator);
    const secret = separator === -1 ? '' : entry.slice(separator + 1);

    if (!/^\d{1,3}$/.test(kidText) || Number(kidText) < 1 || Number(kidText) > 255) {
      throw new Error(`QR_SIGNING_KEYS: key id must be an integer from 1 to 255`);
    }
    const kid = Number(kidText);
    if (keys.has(kid)) throw new Error(`QR_SIGNING_KEYS: key id ${kid} is listed twice`);

    // Strict base64url, checked before decoding. Node's decoder silently skips
    // characters it does not understand, so without this a typo, a stray space or
    // a second ":"-separated key pasted in by mistake would quietly produce a
    // different key from the one the operator believes is configured.
    if (!BASE64URL.test(secret)) {
      throw new Error(`QR_SIGNING_KEYS: key ${kid} must be base64url text (A–Z, a–z, 0–9, "-" and "_", no padding)`);
    }
    const bytes = Buffer.from(secret, 'base64url');
    if (bytes.toString('base64url') !== secret) {
      throw new Error(`QR_SIGNING_KEYS: key ${kid} is not canonical base64url`);
    }
    if (bytes.length < MIN_KEY_BYTES) {
      throw new Error(`QR_SIGNING_KEYS: key ${kid} must be at least ${MIN_KEY_BYTES} random bytes`);
    }
    // Length is not randomness: 43 "A"s decode to 32 zero bytes, which anyone can
    // sign with. A genuinely random 32-byte key has about 30 distinct byte values;
    // fewer than 16 means it was typed, patterned or zeroed, not generated.
    if (new Set(bytes).size < MIN_DISTINCT_BYTES) {
      throw new Error(`QR_SIGNING_KEYS: key ${kid} is not random enough; generate it with a cryptographic generator`);
    }
    const fingerprint = bytes.toString('hex');
    if (seen.has(fingerprint)) {
      throw new Error(`QR_SIGNING_KEYS: key ${kid} repeats another key; each key id needs its own secret`);
    }
    seen.add(fingerprint);
    keys.set(kid, bytes);
  }
  if (keys.size === 0) throw new Error('QR_SIGNING_KEYS: at least one key is required');

  const chosen = currentKid ?? Math.max(...keys.keys());
  if (!keys.has(chosen)) throw new Error(`QR_SIGNING_KEY_ID ${chosen} is not in QR_SIGNING_KEYS`);
  return { currentKid: chosen, keys };
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('qr_id must be a UUID');
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mac(key: Buffer, qrId: Buffer): Buffer {
  return createHmac('sha256', key).update(DOMAIN).update(qrId).digest().subarray(0, 16);
}

/** Computes the printable token for a stored qr_id under the given key. */
export function signQrToken(ring: QrKeyring, qrId: string, kid: number = ring.currentKid): string {
  const key = ring.keys.get(kid);
  if (!key) throw new Error(`no QR signing key with id ${kid}`);
  const id = uuidToBytes(qrId);
  return Buffer.concat([Buffer.from([kid]), id, mac(key, id)]).toString('base64url');
}

/**
 * Verifies a token entirely in memory. Returns the qr_id and key id only when the
 * MAC is valid; malformed, forged, truncated and unknown-key tokens all return
 * null and never cause a database lookup.
 */
export function verifyQrToken(ring: QrKeyring, token: unknown): { qrId: string; kid: number } | null {
  if (typeof token !== 'string' || token.length !== TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) return null;

  const bytes = Buffer.from(token, 'base64url');
  if (bytes.length !== 33) return null;

  const kid = bytes[0]!;
  const key = ring.keys.get(kid);
  if (!key) return null;

  const id = bytes.subarray(1, 17);
  const presented = bytes.subarray(17, 33);
  const expected = mac(key, id);
  // Constant-time: how much of a forged MAC matched must not be measurable.
  if (!timingSafeEqual(presented, expected)) return null;

  return { qrId: bytesToUuid(id), kid };
}

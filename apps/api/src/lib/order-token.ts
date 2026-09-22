// The customer's order-status token (PRD FR-042; design/02 §3: "View order O").
//
// 128 bits, unguessable, and never stored: the database keeps only its SHA-256.
// It is derived from the order's idempotency key with the server's signing key, so
// a retried order request — whose first response was lost — gets the same link
// back without the token ever being written down anywhere.
import { createHash, createHmac } from 'node:crypto';
import type { QrKeyring } from './qr-token.ts';

const DOMAIN = 'dineflow-order-status-v1';

/** base64url of 16 bytes: 22 characters, no padding. */
export const STATUS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function deriveStatusToken(keys: QrKeyring, restaurantId: string, idempotencyKey: string): string {
  const key = keys.keys.get(keys.currentKid)!;
  return createHmac('sha256', key)
    .update(`${DOMAIN}\0${restaurantId}\0${idempotencyKey.toLowerCase()}`)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

/** What the database stores and matches on. */
export function statusTokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

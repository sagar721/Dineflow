import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { parseKeyring, signQrToken, verifyQrToken } from '../src/lib/qr-token.ts';

const key = () => randomBytes(32).toString('base64url');
const ring = parseKeyring(`1:${key()}`);

test('a signed token verifies back to the same qr_id', () => {
  const qrId = randomUUID();
  const token = signQrToken(ring, qrId);
  assert.equal(token.length, 44);
  assert.deepEqual(verifyQrToken(ring, token), { qrId, kid: 1 });
});

test('the same qr_id always yields the same token, so a lost card can be reprinted', () => {
  const qrId = randomUUID();
  assert.equal(signQrToken(ring, qrId), signQrToken(ring, qrId));
});

test('a token reveals nothing about the table or restaurant', () => {
  // The only identifier inside is the random qr_id; there is no table id, table
  // number or restaurant id to read out of a photographed code.
  const qrId = randomUUID();
  const tableId = randomUUID();
  const bytes = Buffer.from(signQrToken(ring, qrId), 'base64url');
  assert.equal(bytes.includes(Buffer.from(tableId.replace(/-/g, ''), 'hex')), false);
});

test('every changed byte is rejected', () => {
  const token = signQrToken(ring, randomUUID());
  const bytes = Buffer.from(token, 'base64url');
  for (let index = 0; index < bytes.length; index += 1) {
    const tampered = Buffer.from(bytes);
    tampered[index] = tampered[index]! ^ 0x01;
    assert.equal(verifyQrToken(ring, tampered.toString('base64url')), null, `byte ${index} change accepted`);
  }
});

test('a token for a guessed qr_id without the key is rejected', () => {
  // What an attacker holding a database dump could build: a real qr_id, a fake MAC.
  const qrId = randomUUID();
  const forged = Buffer.concat([Buffer.from([1]), Buffer.from(qrId.replace(/-/g, ''), 'hex'), randomBytes(16)]);
  assert.equal(verifyQrToken(ring, forged.toString('base64url')), null);
});

test('malformed input is rejected without throwing', () => {
  for (const input of ['', 'short', 'x'.repeat(44), 'A'.repeat(45), '!'.repeat(44), null, undefined, 42, {}]) {
    assert.equal(verifyQrToken(ring, input), null, `accepted ${String(input)}`);
  }
});

test('a token signed with a different key is rejected', () => {
  const other = parseKeyring(`1:${key()}`);
  assert.equal(verifyQrToken(ring, signQrToken(other, randomUUID())), null);
});

test('after rotation, cards printed under the old key still work', () => {
  const oldSecret = key();
  const before = parseKeyring(`1:${oldSecret}`);
  const qrId = randomUUID();
  const printed = signQrToken(before, qrId);

  const after = parseKeyring(`1:${oldSecret},2:${key()}`);
  assert.equal(after.currentKid, 2, 'new tokens use the newest key');
  assert.deepEqual(verifyQrToken(after, printed), { qrId, kid: 1 });
});

test('retiring a key invalidates every card signed with it', () => {
  const qrId = randomUUID();
  const oldRing = parseKeyring(`1:${key()},2:${key()}`, 1);
  const printed = signQrToken(oldRing, qrId);
  const retired = parseKeyring(`2:${key()}`);
  assert.equal(verifyQrToken(retired, printed), null);
});

test('weak or malformed key configuration is refused at startup', () => {
  assert.throws(() => parseKeyring(''), /at least one key/);
  assert.throws(() => parseKeyring(`1:${randomBytes(8).toString('base64url')}`), /at least 32/);
  assert.throws(() => parseKeyring(`0:${key()}`), /1 to 255/);
  const k = key();
  assert.throws(() => parseKeyring(`1:${k},1:${k}`), /listed twice/);
  assert.throws(() => parseKeyring(`1:${key()}`, 3), /not in QR_SIGNING_KEYS/);
});

test('a configuration error never echoes the secret', () => {
  const weak = randomBytes(8).toString('base64url');
  try {
    parseKeyring(`1:${weak}`);
    assert.fail('expected a throw');
  } catch (error) {
    assert.equal((error as Error).message.includes(weak), false);
  }
});

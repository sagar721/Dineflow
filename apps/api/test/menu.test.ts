// Menu management (PRD FR-020 … FR-028): categories, items, prices, kitchen's
// availability toggle, image upload security, the public menu, audit and tenant
// isolation. Restaurant A is the actor throughout; restaurant B is the victim.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import sharp from 'sharp';
import { bootLocalApp, createTestContext, signToken, TEST_QR_KEYS, type TestContext } from './helpers.ts';
import { parseKeyring, signQrToken } from '../src/lib/qr-token.ts';
import { MemoryImageStore } from '../src/lib/image-store.ts';
import { MENU_CACHE_TTL_MS, MenuCache } from '../src/lib/menu-cache.ts';
import { MAX_INPUT_PIXELS } from '../src/lib/menu-image.ts';

let ctx: TestContext;
const store = new MemoryImageStore();
const keyring = parseKeyring(TEST_QR_KEYS);

let ipCounter = 0;
const nextIp = () => `203.0.118.${(ipCounter += 1) % 250 + 1}`;
const web = (req: request.Test) =>
  req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173').set('x-forwarded-for', nextIp());

before(async () => { ctx = await createTestContext({ imageStore: store }); });
after(async () => { await ctx.close(); });

const cookie = async (userId: string) => `df_at=${await signToken({ sub: userId })}`;
const url = (path: string) => `/api/v1/restaurant/menu${path}`;
const get = async (userId: string, path = '') => request(ctx.app).get(url(path)).set('cookie', await cookie(userId));
const send = async (method: 'post' | 'patch' | 'put' | 'delete', userId: string, path: string, body?: unknown) =>
  web(request(ctx.app)[method](url(path))).set('cookie', await cookie(userId)).send(body as object ?? {});

const q = async <T extends object = { n: number }>(sql: string, params: unknown[] = []) =>
  (await ctx.owner.query<T & pg_row>(sql, params)).rows;
type pg_row = Record<string, unknown>;
const audits = async (action: string, entityId?: string) =>
  (await q<{ n: number }>(`select count(*)::int as n from audit_log where action = $1 and ($2::text is null or entity_id = $2)`,
    [action, entityId ?? null]))[0]!.n;

const fixtureToken = async (restaurantId: string) => {
  const [row] = await q<{ qr_id: string; key_id: number }>(
    'select qr_id, key_id from table_qr_tokens where restaurant_id = $1 and revoked_at is null limit 1', [restaurantId]);
  return signQrToken(keyring, row!.qr_id, row!.key_id);
};
const publicMenu = (token: string) =>
  request(ctx.app).get(`/api/v1/public/tables/${token}/menu`).set('x-forwarded-for', nextIp());

const bRows = async () => ({
  category: (await q<{ id: string; version: number }>(
    'select id, version from menu_categories where restaurant_id = $1 limit 1', [ctx.fixtures.restaurantB]))[0]!,
  item: (await q<{ id: string; version: number; price_minor: string; available: boolean }>(
    'select id, version, price_minor, available from menu_items where restaurant_id = $1 limit 1',
    [ctx.fixtures.restaurantB]))[0]!,
});

/** Creates a category in A and returns it. */
const makeCategory = async (name: string, userId = ctx.fixtures.ownerA) => {
  const res = await send('post', userId, '/categories', { name });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.category as { id: string; version: number; name: string };
};
const makeItem = async (categoryId: string, name: string, price = '100', extra: Record<string, unknown> = {}) => {
  const res = await send('post', ctx.fixtures.ownerA, '/items', { categoryId, name, price, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.item as { id: string; version: number; priceMinor: number; imageUrl: string | null };
};

// ======================================================================= categories
describe('categories (FR-020)', () => {
  test('owners and managers create categories; kitchen and billing cannot', async () => {
    const byOwner = await makeCategory('Mains');
    assert.equal(byOwner.name, 'Mains');
    await makeCategory('Desserts', ctx.fixtures.managerA);
    for (const userId of [ctx.fixtures.kitchenA, ctx.fixtures.billingA]) {
      assert.equal((await send('post', userId, '/categories', { name: 'Nope' })).status, 403);
    }
    assert.equal(await audits('menu.category.created', byOwner.id), 1);
  });

  test('a duplicate name is refused regardless of case; an archived name can be reused', async () => {
    const drinks = await makeCategory('Drinks');
    const dup = await send('post', ctx.fixtures.ownerA, '/categories', { name: '  dRiNkS ' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'CATEGORY_NAME_TAKEN');

    const archived = await send('patch', ctx.fixtures.ownerA, `/categories/${drinks.id}`, { archived: true, version: drinks.version });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.category.archived, true);
    const reused = await makeCategory('Drinks');

    // Restoring the old one now clashes with the new one.
    const restore = await send('patch', ctx.fixtures.ownerA, `/categories/${drinks.id}`,
      { archived: false, version: archived.body.category.version });
    assert.equal(restore.status, 409);
    assert.ok(reused.id);
    assert.equal(await audits('menu.category.archived', drinks.id), 1);
  });

  test('rename, hide and show are each audited', async () => {
    const cat = await makeCategory('Sides');
    const renamed = await send('patch', ctx.fixtures.managerA, `/categories/${cat.id}`, { name: 'Side dishes', version: cat.version });
    assert.equal(renamed.body.category.name, 'Side dishes');
    const hidden = await send('patch', ctx.fixtures.managerA, `/categories/${cat.id}`,
      { visible: false, version: renamed.body.category.version });
    assert.equal(hidden.body.category.visible, false);
    const shown = await send('patch', ctx.fixtures.managerA, `/categories/${cat.id}`,
      { visible: true, version: hidden.body.category.version });
    assert.equal(shown.body.category.visible, true);
    assert.equal(await audits('menu.category.renamed', cat.id), 1);
    assert.equal(await audits('menu.category.hidden', cat.id), 1);
    assert.equal(await audits('menu.category.shown', cat.id), 1);
  });

  test('a stale version and invalid names are refused', async () => {
    const cat = await makeCategory('Soups');
    await send('patch', ctx.fixtures.ownerA, `/categories/${cat.id}`, { name: 'Soup', version: cat.version });
    const stale = await send('patch', ctx.fixtures.ownerA, `/categories/${cat.id}`, { name: 'Soupz', version: cat.version });
    assert.equal(stale.status, 409);
    for (const name of ['', '   ', 'x'.repeat(61)]) {
      assert.equal((await send('post', ctx.fixtures.ownerA, '/categories', { name })).status, 400, `name "${name}"`);
    }
  });

  test('reordering needs every live category exactly once', async () => {
    const { body } = await get(ctx.fixtures.ownerA);
    const live = (body.categories as { id: string; archived: boolean }[]).filter((c) => !c.archived).map((c) => c.id);
    const reversed = [...live].reverse();

    const ok = await send('put', ctx.fixtures.ownerA, '/categories/order', { ids: reversed });
    assert.equal(ok.status, 200);
    const order = (ok.body.categories as { id: string; archived: boolean }[]).filter((c) => !c.archived).map((c) => c.id);
    assert.deepEqual(order, reversed);
    assert.equal(await audits('menu.categories.reordered'), 1);

    assert.equal((await send('put', ctx.fixtures.ownerA, '/categories/order', { ids: reversed.slice(1) })).status, 409,
      'a list missing one is stale');
    assert.equal((await send('put', ctx.fixtures.ownerA, '/categories/order', { ids: [...reversed, reversed[0]] })).status, 409,
      'duplicates are refused');
  });

  test("another restaurant's categories cannot be renamed, reordered or even named in a list", async () => {
    const b = await bRows();
    assert.equal((await send('patch', ctx.fixtures.ownerA, `/categories/${b.category.id}`,
      { name: 'Hijacked', version: b.category.version })).status, 404);

    const { body } = await get(ctx.fixtures.ownerA);
    const live = (body.categories as { id: string; archived: boolean }[]).filter((c) => !c.archived).map((c) => c.id);
    const withForeign = [...live.slice(1), b.category.id];
    assert.equal((await send('put', ctx.fixtures.ownerA, '/categories/order', { ids: withForeign })).status, 409);
    assert.equal((await q('select count(*)::int as n from menu_categories where name = $1', ['Hijacked']))[0]!.n, 0);
  });

  test('a restaurant id in the request is refused, not obeyed', async () => {
    const res = await send('post', ctx.fixtures.ownerA, '/categories', { name: 'Sneaky', restaurantId: ctx.fixtures.restaurantB });
    assert.equal(res.status, 400);
  });
});

// ============================================================================ items
describe('items and prices (FR-021, FR-022)', () => {
  let cat = { id: '', version: 1, name: '' };

  test('an item is created with an exact price from a decimal string', async () => {
    cat = await makeCategory('Breads');
    const item = await makeItem(cat.id, 'Butter Naan', '49.50', { diet: 'veg', description: '  Soft and buttery ' });
    assert.equal(item.priceMinor, 4950);
    const [row] = await q<{ price_minor: string; description: string }>(
      'select price_minor, description from menu_items where id = $1', [item.id]);
    assert.equal(row!.price_minor, '4950');
    assert.equal(row!.description, 'Soft and buttery');
    assert.equal(await audits('menu.item.created', item.id), 1);
  });

  test('negative, excessive, over-precise, float and malformed prices are refused', async () => {
    for (const price of ['-1', '-0.01', '1000000.01', '10000000', '12.345', 'abc', '', '1e3', '0x10', 249.5, 100]) {
      const res = await send('post', ctx.fixtures.ownerA, '/items', { categoryId: cat.id, name: `P ${String(price)}`, price });
      assert.equal(res.status, 400, `price ${JSON.stringify(price)}`);
    }
    // The bounds themselves are accepted.
    assert.equal((await makeItem(cat.id, 'Free water', '0')).priceMinor, 0);
    assert.equal((await makeItem(cat.id, 'Banquet', '1000000')).priceMinor, 100_000_000);
  });

  test('the database refuses out-of-range prices without the API', async () => {
    for (const price of [-1, 100_000_001]) {
      await assert.rejects(() => ctx.owner.query(
        `insert into menu_items (restaurant_id, category_id, name, price_minor) values ($1, $2, $3, $4)`,
        [ctx.fixtures.restaurantA, cat.id, `DB ${price}`, price]), /price_minor_check/);
    }
  });

  test('invalid item data is refused', async () => {
    for (const body of [
      { categoryId: cat.id, name: '', price: '10' },
      { categoryId: cat.id, name: 'x'.repeat(121), price: '10' },
      { categoryId: cat.id, name: 'Long', price: '10', description: 'x'.repeat(1001) },
      { categoryId: cat.id, name: 'Diet', price: '10', diet: 'vegan' },
      { categoryId: 'not-a-uuid', name: 'Bad cat', price: '10' },
      { categoryId: cat.id, name: 'Extra', price: '10', imagePath: 'restaurants/x/menu/a.webp' },
    ]) {
      assert.equal((await send('post', ctx.fixtures.ownerA, '/items', body)).status, 400, JSON.stringify(body).slice(0, 80));
    }
  });

  test('duplicate names clash within a category, not across categories', async () => {
    await makeItem(cat.id, 'Roti');
    const dup = await send('post', ctx.fixtures.ownerA, '/items', { categoryId: cat.id, name: 'ROTI', price: '20' });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'ITEM_NAME_TAKEN');
    const other = await makeCategory('Combos');
    await makeItem(other.id, 'Roti');
  });

  test('items cannot be put in an archived category, or in another restaurant’s', async () => {
    const old = await makeCategory('Old stuff');
    await send('patch', ctx.fixtures.ownerA, `/categories/${old.id}`, { archived: true, version: old.version });
    assert.equal((await send('post', ctx.fixtures.ownerA, '/items', { categoryId: old.id, name: 'X', price: '1' })).status, 400);

    const b = await bRows();
    const res = await send('post', ctx.fixtures.ownerA, '/items', { categoryId: b.category.id, name: 'Planted', price: '1' });
    assert.equal(res.status, 400);
    assert.equal((await q("select count(*)::int as n from menu_items where name = 'Planted'"))[0]!.n, 0);
  });

  test('a price change records the old and new price', async () => {
    const item = await makeItem(cat.id, 'Kulcha', '60');
    const res = await send('patch', ctx.fixtures.managerA, `/items/${item.id}`, { price: '65.00', version: item.version });
    assert.equal(res.status, 200);
    assert.equal(res.body.item.priceMinor, 6500);
    const [entry] = await q<{ summary: { fromMinor: number; toMinor: number } }>(
      `select summary from audit_log where action = 'menu.item.price_changed' and entity_id = $1`, [item.id]);
    assert.deepEqual([entry!.summary.fromMinor, entry!.summary.toMinor], [6000, 6500]);
  });

  test('visibility, availability and archiving are each audited', async () => {
    const item = await makeItem(cat.id, 'Paratha', '40');
    let version = item.version;
    for (const change of [{ visible: false }, { available: false }, { archived: true }]) {
      const res = await send('patch', ctx.fixtures.ownerA, `/items/${item.id}`, { ...change, version });
      assert.equal(res.status, 200);
      version = res.body.item.version;
    }
    assert.equal(await audits('menu.item.visibility_changed', item.id), 1);
    assert.equal(await audits('menu.item.availability_changed', item.id), 1);
    assert.equal(await audits('menu.item.archived', item.id), 1);
  });
});

// ========================================================================== kitchen
describe("kitchen staff's availability toggle (FR-024)", () => {
  let item = { id: '', version: 1, priceMinor: 0, imageUrl: null as string | null };

  test('kitchen staff mark an item sold out and back, and it is audited', async () => {
    const cat = await makeCategory('Kitchen test');
    item = await makeItem(cat.id, 'Dal Makhani', '220');
    const off = await send('patch', ctx.fixtures.kitchenA, `/items/${item.id}/availability`, { available: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.item.available, false);
    const on = await send('patch', ctx.fixtures.kitchenA, `/items/${item.id}/availability`, { available: true });
    assert.equal(on.body.item.available, true);
    assert.equal(await audits('menu.item.availability_changed', item.id), 2);
  });

  test('kitchen staff cannot change price, name, description, category, visibility or image', async () => {
    for (const body of [
      { price: '1', version: 99 }, { name: 'Renamed', version: 99 }, { description: 'x', version: 99 },
      { visible: false, version: 99 }, { archived: true, version: 99 },
    ]) {
      assert.equal((await send('patch', ctx.fixtures.kitchenA, `/items/${item.id}`, body)).status, 403, JSON.stringify(body));
    }
    assert.equal((await send('put', ctx.fixtures.kitchenA, `/items/${item.id}/image`, { contentType: 'image/png', data: '' })).status, 403);
    assert.equal((await send('delete', ctx.fixtures.kitchenA, `/items/${item.id}/image`)).status, 403);
    // The availability endpoint accepts availability and nothing else.
    assert.equal((await send('patch', ctx.fixtures.kitchenA, `/items/${item.id}/availability`,
      { available: true, price: '1' })).status, 400);
    const [row] = await q<{ price_minor: string; name: string }>('select price_minor, name from menu_items where id = $1', [item.id]);
    assert.deepEqual([row!.price_minor, row!.name], ['22000', 'Dal Makhani']);
  });

  test('the database itself limits kitchen staff to availability', async () => {
    const asKitchen = <T>(fn: (c: import('pg').PoolClient) => Promise<T>) =>
      ctx.db.asStaff({ userId: ctx.fixtures.kitchenA, aal: 'aal1' }, fn);
    await assert.rejects(() => asKitchen((c) => c.query('update menu_items set price_minor = 1 where id = $1', [item.id])),
      /only change availability/);
    await assert.rejects(() => asKitchen((c) => c.query("update menu_items set name = 'x' where id = $1", [item.id])),
      /only change availability/);
    const ok = await asKitchen((c) => c.query('update menu_items set available = false where id = $1', [item.id]));
    assert.equal(ok.rowCount, 1);
  });

  test("billing staff read the menu but cannot toggle availability", async () => {
    assert.equal((await get(ctx.fixtures.billingA)).status, 200);
    assert.equal((await send('patch', ctx.fixtures.billingA, `/items/${item.id}/availability`, { available: true })).status, 403);
  });

  test("kitchen staff cannot toggle another restaurant's item", async () => {
    const b = await bRows();
    const res = await send('patch', ctx.fixtures.kitchenA, `/items/${b.item.id}/availability`, { available: !b.item.available });
    assert.equal(res.status, 404);
    assert.equal((await bRows()).item.available, b.item.available);
  });
});

// ========================================================================== history
describe('nothing is deleted (FR-026)', () => {
  test('an archived item keeps its name and price, and stays in the editor', async () => {
    const cat = await makeCategory('History');
    const item = await makeItem(cat.id, 'Old Special', '310');
    await send('patch', ctx.fixtures.ownerA, `/items/${item.id}`, { archived: true, version: item.version });
    const { body } = await get(ctx.fixtures.ownerA);
    const found = (body.items as { id: string; name: string; priceMinor: number; archived: boolean }[])
      .find((each) => each.id === item.id);
    assert.deepEqual([found?.name, found?.priceMinor, found?.archived], ['Old Special', 31000, true]);
  });

  test('no staff role can delete a category or an item', async () => {
    for (const userId of [ctx.fixtures.ownerA, ctx.fixtures.managerA]) {
      for (const statement of ['delete from menu_items', 'delete from menu_categories']) {
        await assert.rejects(() => ctx.db.asStaff({ userId, aal: 'aal1' }, (c) => c.query(statement)), /permission denied/);
      }
    }
  });
});

// =========================================================================== search
describe('the editor listing (FR-028)', () => {
  test('lists this restaurant only, with archived rows flagged for filtering', async () => {
    const res = await get(ctx.fixtures.managerA);
    assert.equal(res.status, 200);
    assert.equal(res.body.currency, 'INR');
    const text = JSON.stringify(res.body);
    assert.ok(text.includes('MARKER-TENANT-A'));
    assert.equal(text.includes('MARKER-TENANT-B'), false);
    assert.ok((res.body.items as { archived: boolean }[]).some((item) => item.archived));
  });

  test('without a session, the menu editor is closed', async () => {
    assert.equal((await request(ctx.app).get(url(''))).status, 401);
  });

  test("another restaurant's item cannot be edited", async () => {
    const b = await bRows();
    const res = await send('patch', ctx.fixtures.ownerA, `/items/${b.item.id}`, { price: '1', version: b.item.version });
    assert.equal(res.status, 404);
    assert.equal((await bRows()).item.price_minor, b.item.price_minor);
  });
});

// =========================================================================== images
const jpegWithExif = () => sharp({ create: { width: 64, height: 48, channels: 3, background: '#c0392b' } })
  .jpeg().withExif({ IFD0: { Copyright: 'EXIF-SECRET-MARKER', Artist: 'GPS-home-address' } }).toBuffer();
const upload = async (userId: string, itemId: string, contentType: string, bytes: Buffer) =>
  send('put', userId, `/items/${itemId}/image`, { contentType, data: bytes.toString('base64') });

describe('image upload security (FR-023)', () => {
  let item = { id: '', version: 1, priceMinor: 0, imageUrl: null as string | null };

  before(async () => {
    const cat = await makeCategory('Photos');
    item = await makeItem(cat.id, 'Photogenic Biryani', '350');
  });

  test('a valid image is re-encoded as WebP with its metadata stripped, under a random tenant path', async () => {
    const original = await jpegWithExif();
    assert.ok(original.includes(Buffer.from('EXIF-SECRET-MARKER')), 'the test image really carries metadata');

    const res = await upload(ctx.fixtures.ownerA, item.id, 'image/jpeg', original);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const key = new URL(res.body.item.imageUrl).pathname.slice(1);
    assert.match(key, new RegExp(`^restaurants/${ctx.fixtures.restaurantA}/menu/[0-9a-f]{32}\\.webp$`));

    const stored = store.objects.get(key)!;
    assert.equal(stored.contentType, 'image/webp');
    const meta = await sharp(stored.bytes).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.exif, undefined);
    assert.equal(stored.bytes.includes(Buffer.from('EXIF-SECRET-MARKER')), false);
    assert.equal(stored.bytes.includes(Buffer.from('GPS-home-address')), false);
    assert.equal(await audits('menu.item.image_added', item.id), 1);
  });

  test('replacing an image stores a new random name and removes the old file', async () => {
    const before = [...store.objects.keys()];
    const png = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#2980b9' } }).png().toBuffer();
    const res = await upload(ctx.fixtures.managerA, item.id, 'image/png', png);
    assert.equal(res.status, 200);
    const key = new URL(res.body.item.imageUrl).pathname.slice(1);
    assert.equal(before.includes(key), false, 'a fresh name, never reused');
    assert.equal(store.objects.size, before.length, 'the old file was removed');
    const meta = await sharp(store.objects.get(key)!.bytes).metadata();
    assert.ok(meta.width! <= 1600 && meta.height! <= 1600, 'scaled down to at most 1600 px');
    assert.equal(await audits('menu.item.image_replaced', item.id), 1);
  });

  test('an oversized file is refused', async () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5 * 1024 * 1024)]);
    const res = await upload(ctx.fixtures.ownerA, item.id, 'image/png', big);
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, 'IMAGE_TOO_LARGE');
  });

  test('contents that do not match the declared type are refused', async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer();
    const res = await upload(ctx.fixtures.ownerA, item.id, 'image/jpeg', png);
    assert.equal(res.status, 415);
    assert.equal(res.body.error.code, 'IMAGE_TYPE_MISMATCH');
  });

  test('scripts, SVG, HTML and other non-images are refused', async () => {
    const cases: [string, Buffer][] = [
      ['image/png', Buffer.from('<?php system($_GET["c"]); ?>')],
      ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
      ['text/html', Buffer.from('<script>alert(1)</script>')],
      ['application/x-msdownload', Buffer.from('MZ\x90\x00executable')],
      ['image/gif', Buffer.from('GIF89a\x01\x00\x01\x00')],
    ];
    for (const [type, bytes] of cases) {
      const res = await upload(ctx.fixtures.ownerA, item.id, type, bytes);
      assert.equal(res.status, 415, `${type}: ${JSON.stringify(res.body)}`);
    }
  });

  test('a file with an image signature but broken contents is refused', async () => {
    const polyglot = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('<script>alert(document.cookie)</script>')]);
    const res = await upload(ctx.fixtures.ownerA, item.id, 'image/png', polyglot);
    assert.equal(res.status, 415);
    assert.equal(res.body.error.code, 'IMAGE_INVALID');
  });

  test('a decompression bomb is refused before it is decoded', async () => {
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 500;
    const bomb = await sharp({ create: { width: side, height: side, channels: 3, background: '#fff' } }).png().toBuffer();
    assert.ok(bomb.length < 5 * 1024 * 1024, 'small on disk, huge in memory');
    const res = await upload(ctx.fixtures.ownerA, item.id, 'image/png', bomb);
    assert.equal(res.status, 415);
  });

  test('malformed base64 is refused', async () => {
    const res = await send('put', ctx.fixtures.ownerA, `/items/${item.id}/image`, { contentType: 'image/png', data: '!!not base64!!' });
    assert.equal(res.status, 400);
  });

  test("an upload aimed at another restaurant's item is refused and stores nothing", async () => {
    const b = await bRows();
    const count = store.objects.size;
    const res = await upload(ctx.fixtures.ownerA, b.item.id, 'image/jpeg', await jpegWithExif());
    assert.equal(res.status, 404);
    assert.equal(store.objects.size, count);
    assert.equal((await send('delete', ctx.fixtures.ownerA, `/items/${b.item.id}/image`)).status, 404);
  });

  test("the database refuses an image path outside the restaurant's own folder", async () => {
    const foreign = `restaurants/${ctx.fixtures.restaurantB}/menu/${'a'.repeat(32)}.webp`;
    await assert.rejects(() => ctx.owner.query('update menu_items set image_path = $2 where id = $1', [item.id, foreign]),
      /image_path_check/);
    for (const path of ['../../etc/passwd', `restaurants/${ctx.fixtures.restaurantA}/menu/x.php`]) {
      await assert.rejects(() => ctx.owner.query('update menu_items set image_path = $2 where id = $1', [item.id, path]),
        /image_path_check/);
    }
  });

  test('removing an image clears it and deletes the file', async () => {
    const count = store.objects.size;
    const res = await send('delete', ctx.fixtures.ownerA, `/items/${item.id}/image`);
    assert.equal(res.status, 200);
    assert.equal(res.body.item.imageUrl, null);
    assert.equal(store.objects.size, count - 1);
    assert.equal(await audits('menu.item.image_removed', item.id), 1);
  });

  test('an anonymous caller cannot make the server buffer a large upload', async () => {
    const res = await web(request(ctx.app).put(url(`/items/${item.id}/image`)))
      .send({ contentType: 'image/png', data: 'A'.repeat(200 * 1024) });
    assert.equal(res.status, 413, 'the ordinary 100 kB limit applies without a session');
  });

  test('without a configured bucket, upload answers 503 and nothing else breaks', async () => {
    const bare = (await bootLocalApp(ctx.db, ctx.provider, {}, { imageStore: null })).app;
    const res = await web(request(bare).put(url(`/items/${item.id}/image`)))
      .set('cookie', await cookie(ctx.fixtures.ownerA)).send({ contentType: 'image/png', data: '' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'IMAGES_NOT_CONFIGURED');
    assert.equal((await request(bare).get(url('')).set('cookie', await cookie(ctx.fixtures.ownerA))).status, 200);
  });
});

// ====================================================================== public menu
describe('the public menu (FR-025, FR-027, FR-030)', () => {
  test('shows only shown, live categories and items; sold-out items appear as unavailable', async () => {
    const shown = await makeCategory('Public Shown');
    const hiddenCat = await makeCategory('Public Hidden');
    await send('patch', ctx.fixtures.ownerA, `/categories/${hiddenCat.id}`, { visible: false, version: hiddenCat.version });
    await makeItem(hiddenCat.id, 'In Hidden Category');

    await makeItem(shown.id, 'Visible Dosa', '120', { diet: 'veg' });
    const soldOut = await makeItem(shown.id, 'Sold Out Idli', '80');
    await send('patch', ctx.fixtures.kitchenA, `/items/${soldOut.id}/availability`, { available: false });
    const hiddenItem = await makeItem(shown.id, 'Hidden Vada', '60');
    await send('patch', ctx.fixtures.ownerA, `/items/${hiddenItem.id}`, { visible: false, version: hiddenItem.version });
    const archivedItem = await makeItem(shown.id, 'Archived Uttapam', '90');
    await send('patch', ctx.fixtures.ownerA, `/items/${archivedItem.id}`, { archived: true, version: archivedItem.version });

    const res = await publicMenu(await fixtureToken(ctx.fixtures.restaurantA));
    assert.equal(res.status, 200);
    const names = (res.body.categories as { name: string; items: { name: string }[] }[]).flatMap((c) => c.items.map((i) => i.name));
    assert.ok(names.includes('Visible Dosa'));
    assert.ok(names.includes('Sold Out Idli'));
    for (const absent of ['In Hidden Category', 'Hidden Vada', 'Archived Uttapam']) {
      assert.equal(names.includes(absent), false, `${absent} must not be public`);
    }
    const categoryNames = (res.body.categories as { name: string }[]).map((c) => c.name);
    assert.equal(categoryNames.includes('Public Hidden'), false);

    const idli = (res.body.categories as { items: { name: string; available: boolean; priceMinor: number }[] }[])
      .flatMap((c) => c.items).find((i) => i.name === 'Sold Out Idli')!;
    assert.deepEqual([idli.available, idli.priceMinor], [false, 8000]);
  });

  test('shows the restaurant, table, currency and ordering state, and nothing internal', async () => {
    const res = await publicMenu(await fixtureToken(ctx.fixtures.restaurantA));
    assert.match(res.body.restaurant.name, /MARKER-TENANT-A/);
    assert.equal(res.body.restaurant.currency, 'INR');
    assert.equal(typeof res.body.restaurant.acceptingOrders, 'boolean');
    assert.equal(res.body.table.tableNumber, 'T1');
    const text = JSON.stringify(res.body);
    assert.equal(text.includes('MARKER-TENANT-B'), false);
    for (const internal of ['image_path', 'version', 'archived', 'visible', 'restaurant_id', 'sort_order', 'qr_id']) {
      assert.equal(text.includes(`"${internal}"`), false, `leaks ${internal}`);
    }
  });

  test('a staff change reaches the public menu on the next scan', async () => {
    const token = await fixtureToken(ctx.fixtures.restaurantA);
    const cat = await makeCategory('Fresh');
    const item = await makeItem(cat.id, 'Fresh Lime Soda', '70');
    assert.ok(JSON.stringify((await publicMenu(token)).body).includes('Fresh Lime Soda'));

    await send('patch', ctx.fixtures.ownerA, `/items/${item.id}`, { price: '75', version: item.version });
    const after = (await publicMenu(token)).body.categories.flatMap((c: { items: unknown[] }) => c.items)
      .find((i: { name: string }) => i.name === 'Fresh Lime Soda');
    assert.equal(after.priceMinor, 7500);
  });

  test('every unavailable table answers the same way, after the same minimum time', async () => {
    for (const token of ['not-a-token', await fixtureToken(ctx.fixtures.restaurantS)]) {
      const started = performance.now();
      const res = await publicMenu(token);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'TABLE_UNAVAILABLE');
      assert.ok(performance.now() - started >= 245);
    }
  });

  test("restaurant B's token shows only B's menu", async () => {
    const res = await publicMenu(await fixtureToken(ctx.fixtures.restaurantB));
    const text = JSON.stringify(res.body);
    assert.ok(text.includes('MARKER-TENANT-B'));
    assert.equal(text.includes('MARKER-TENANT-A'), false);
  });
});

describe('menu cache', () => {
  test('entries expire within the 30-second freshness limit', () => {
    let now = 0;
    const cache = new MenuCache<string>(MENU_CACHE_TTL_MS, () => now);
    cache.set('r', 'menu');
    now = MENU_CACHE_TTL_MS - 1;
    assert.equal(cache.get('r'), 'menu');
    now = MENU_CACHE_TTL_MS;
    assert.equal(cache.get('r'), undefined);
    assert.ok(MENU_CACHE_TTL_MS <= 30_000);
  });

  test('invalidation takes effect at once', () => {
    const cache = new MenuCache<string>();
    cache.set('r', 'menu');
    cache.invalidate('r');
    assert.equal(cache.get('r'), undefined);
  });
});

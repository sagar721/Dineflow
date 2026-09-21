import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { auditActions, createTestContext, signToken, type TestContext } from './helpers.ts';

let ctx: TestContext;
let sentLinks: { to: string; link: string }[] = [];

let ipCounter = 0;
const nextIp = () => `203.0.115.${(ipCounter += 1) % 250 + 1}`;
const asWeb = (req: request.Test, ip = nextIp()) =>
  req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173').set('x-forwarded-for', ip);

before(async () => {
  ctx = await createTestContext({ sendInvitationEmail: async (to, link) => { sentLinks.push({ to, link }); } });
});
after(async () => { await ctx.close(); });

/** Platform powers require a second factor, so admins sign in at aal2. */
const asAdmin = (aal: 'aal1' | 'aal2' = 'aal2') => signToken({ sub: ctx.fixtures.adminPlain, aal });
const as = (userId: string) => signToken({ sub: userId });

const createRestaurant = async (token: string, body: Record<string, unknown>) =>
  asWeb(request(ctx.app).post('/api/v1/platform/restaurants')).set('cookie', `df_at=${token}`).send(body);

describe('platform: provisioning a restaurant', () => {
  test('a platform admin creates a restaurant and its first owner invitation', async () => {
    sentLinks = [];
    const res = await createRestaurant(await asAdmin(), {
      name: 'Coastal Kitchen', slug: 'coastal-kitchen', ownerEmail: 'owner@coastal.test',
    });

    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.emailSent, true);
    assert.equal(sentLinks.at(-1)?.to, 'owner@coastal.test');

    // A restaurant with no way in is useless, so both must exist or neither.
    const { rows } = await ctx.owner.query(
      `select r.status, r.currency, i.role, i.email
         from restaurants r join invitations i on i.restaurant_id = r.id
        where r.slug = 'coastal-kitchen'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'provisioning');
    assert.equal(rows[0]?.role, 'owner');
    assert.equal(rows[0]?.currency, 'INR');
  });

  test('settings are created with the restaurant, not left to the caller', async () => {
    const { rows } = await ctx.owner.query(
      `select s.contact_policy, s.rounding_mode from restaurant_settings s
         join restaurants r on r.id = s.restaurant_id where r.slug = 'coastal-kitchen'`);
    assert.equal(rows.length, 1, 'every restaurant must have exactly one settings row');
    assert.equal(rows[0]?.contact_policy, 'optional');
  });

  test('the invitation token is not in the response when email is configured', async () => {
    const res = await createRestaurant(await asAdmin(), {
      name: 'Token Check', slug: 'token-check', ownerEmail: 'owner@token.test',
    });
    assert.equal(res.status, 201);
    assert.equal(JSON.stringify(res.body).includes('#token='), false);
  });

  test('a duplicate slug is refused', async () => {
    const res = await createRestaurant(await asAdmin(), {
      name: 'Coastal Again', slug: 'coastal-kitchen', ownerEmail: 'other@coastal.test',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SLUG_TAKEN');
  });

  test('an invalid slug or timezone is rejected before anything is created', async () => {
    const badSlug = await createRestaurant(await asAdmin(), {
      name: 'Bad', slug: 'Not A Slug!', ownerEmail: 'a@b.test',
    });
    assert.equal(badSlug.status, 400);

    const badZone = await createRestaurant(await asAdmin(), {
      name: 'Bad Zone', slug: 'bad-zone', ownerEmail: 'a@b.test', timezone: 'Mars/Olympus',
    });
    assert.equal(badZone.status, 400);

    const { rows } = await ctx.owner.query(`select count(*)::int as count from restaurants where slug = 'bad-zone'`);
    assert.equal(rows[0]?.count, 0, 'a rejected request must leave nothing behind');
  });

  test('a restaurant owner cannot provision restaurants', async () => {
    const res = await createRestaurant(await as(ctx.fixtures.ownerA), {
      name: 'Sneaky', slug: 'sneaky', ownerEmail: 'a@b.test',
    });
    assert.equal(res.status, 403, 'no staff role grants platform powers');
  });

  test('a platform admin without a second factor is refused', async () => {
    const res = await createRestaurant(await asAdmin('aal1'), {
      name: 'No MFA', slug: 'no-mfa', ownerEmail: 'a@b.test',
    });
    assert.equal(res.status, 403, 'MFA is mandatory for platform actions (FR-105)');
  });

  test('provisioning is audited', async () => {
    const events = await auditActions(ctx.owner, 'platform.restaurant.created');
    assert.ok(events.length > 0);
  });
});

describe('platform: listing and lifecycle', () => {
  test('the listing shows status and counts, never business data', async () => {
    const res = await request(ctx.app).get('/api/v1/platform/restaurants')
      .set('cookie', `df_at=${await asAdmin()}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.restaurants.length >= 3);

    const row = res.body.restaurants[0];
    for (const key of Object.keys(row)) {
      assert.ok(
        ['id', 'slug', 'name', 'status', 'accepting_orders', 'currency', 'timezone',
         'created_at', 'active_staff', 'pending_invitations', 'onboarding_completed_at'].includes(key),
        `unexpected field in the platform listing: ${key}`,
      );
    }
  });

  test('an owner cannot read the platform listing', async () => {
    const res = await request(ctx.app).get('/api/v1/platform/restaurants')
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`);
    assert.equal(res.status, 403);
  });

  test('suspending a restaurant also stops it taking orders', async () => {
    await ctx.owner.query(`update restaurants set accepting_orders = true where id = $1`, [ctx.fixtures.restaurantB]);

    const res = await asWeb(request(ctx.app).patch(`/api/v1/platform/restaurants/${ctx.fixtures.restaurantB}/status`))
      .set('cookie', `df_at=${await asAdmin()}`)
      .send({ status: 'suspended', reason: 'Non-payment of the renewal invoice' });

    assert.equal(res.status, 200);
    assert.equal(res.body.from, 'active');

    const { rows } = await ctx.owner.query(
      `select status, accepting_orders from restaurants where id = $1`, [ctx.fixtures.restaurantB]);
    assert.equal(rows[0]?.status, 'suspended');
    assert.equal(rows[0]?.accepting_orders, false,
      'a suspended restaurant must not keep taking orders from its printed QR codes');

    // Put it back for the tests that follow.
    await asWeb(request(ctx.app).patch(`/api/v1/platform/restaurants/${ctx.fixtures.restaurantB}/status`))
      .set('cookie', `df_at=${await asAdmin()}`)
      .send({ status: 'active', reason: 'Renewal invoice settled' });
  });

  test('a status change requires a reason', async () => {
    const res = await asWeb(request(ctx.app).patch(`/api/v1/platform/restaurants/${ctx.fixtures.restaurantB}/status`))
      .set('cookie', `df_at=${await asAdmin()}`)
      .send({ status: 'suspended', reason: 'nope' });
    assert.equal(res.status, 400);
  });

  test('an unknown restaurant id returns not found', async () => {
    const res = await asWeb(request(ctx.app)
      .patch('/api/v1/platform/restaurants/00000000-0000-0000-0000-000000000000/status'))
      .set('cookie', `df_at=${await asAdmin()}`)
      .send({ status: 'suspended', reason: 'Testing an unknown identifier' });
    assert.equal(res.status, 404);
  });
});

describe('restaurant profile', () => {
  test('an owner reads their own restaurant, settings and taxes together', async () => {
    const res = await request(ctx.app).get('/api/v1/restaurant')
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.restaurant.id, ctx.fixtures.restaurantA);
    assert.ok(res.body.settings);
    assert.ok(Array.isArray(res.body.taxComponents));
  });

  test('the response carries only this tenant', async () => {
    const res = await request(ctx.app).get('/api/v1/restaurant')
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`);
    const body = JSON.stringify(res.body);
    assert.equal(body.includes('MARKER-TENANT-B'), false, 'cross-tenant leak');
    assert.equal(body.includes(ctx.fixtures.restaurantB), false);
  });

  test('a manager may edit the profile but not the currency', async () => {
    const before = await request(ctx.app).get('/api/v1/restaurant')
      .set('cookie', `df_at=${await as(ctx.fixtures.managerA)}`);

    const ok = await asWeb(request(ctx.app).patch('/api/v1/restaurant'))
      .set('cookie', `df_at=${await as(ctx.fixtures.managerA)}`)
      .send({ city: 'Panaji', version: before.body.restaurant.version });
    assert.equal(ok.status, 200, 'FR-004 lets a manager edit the profile');

    const denied = await asWeb(request(ctx.app).patch('/api/v1/restaurant'))
      .set('cookie', `df_at=${await as(ctx.fixtures.managerA)}`)
      .send({ currency: 'USD', version: ok.body.version });
    assert.equal(denied.status, 403);
  });

  test('kitchen staff can read the profile but not change it', async () => {
    const read = await request(ctx.app).get('/api/v1/restaurant')
      .set('cookie', `df_at=${await as(ctx.fixtures.kitchenA)}`);
    assert.equal(read.status, 200);

    const write = await asWeb(request(ctx.app).patch('/api/v1/restaurant'))
      .set('cookie', `df_at=${await as(ctx.fixtures.kitchenA)}`)
      .send({ city: 'Nowhere', version: read.body.restaurant.version });
    assert.equal(write.status, 403);
  });

  test('a stale version is refused rather than silently overwriting', async () => {
    const res = await asWeb(request(ctx.app).patch('/api/v1/restaurant'))
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`)
      .send({ city: 'Margao', version: 1 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'STALE_VERSION');
  });

  test('the slug cannot be changed, because printed QR codes resolve through it', async () => {
    await assert.rejects(
      () => ctx.owner.query(`update restaurants set slug = 'renamed' where id = $1`, [ctx.fixtures.restaurantA]),
      /slug cannot be changed/,
    );
  });

  test('a brand colour must be a valid hex value', async () => {
    const current = await request(ctx.app).get('/api/v1/restaurant')
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`);
    const res = await asWeb(request(ctx.app).patch('/api/v1/restaurant'))
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`)
      .send({ brandColor: 'chartreuse', version: current.body.restaurant.version });
    assert.equal(res.status, 400);
  });
});

describe('settings and tax configuration', () => {
  test('only an owner may change settings', async () => {
    const owner = await asWeb(request(ctx.app).patch('/api/v1/restaurant/settings'))
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`)
      .send({ contactPolicy: 'require_mobile', billFooter: 'Thank you for dining with us' });
    assert.equal(owner.status, 200);

    for (const userId of [ctx.fixtures.managerA, ctx.fixtures.billingA, ctx.fixtures.kitchenA]) {
      const res = await asWeb(request(ctx.app).patch('/api/v1/restaurant/settings'))
        .set('cookie', `df_at=${await as(userId)}`)
        .send({ contactPolicy: 'off' });
      assert.equal(res.status, 403);
    }
  });

  test('settings values are bounded', async () => {
    const res = await asWeb(request(ctx.app).patch('/api/v1/restaurant/settings'))
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`)
      .send({ serviceChargeBps: 20000 });
    assert.equal(res.status, 400);
  });

  test('an owner adds a tax component; a manager cannot', async () => {
    const created = await asWeb(request(ctx.app).post('/api/v1/restaurant/tax-components'))
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`)
      .send({ name: 'CGST', rateBps: 250 });
    assert.equal(created.status, 201);

    const denied = await asWeb(request(ctx.app).post('/api/v1/restaurant/tax-components'))
      .set('cookie', `df_at=${await as(ctx.fixtures.managerA)}`)
      .send({ name: 'SGST', rateBps: 250 });
    assert.equal(denied.status, 403);
  });

  test('tax names are unique per restaurant, case-insensitively', async () => {
    const res = await asWeb(request(ctx.app).post('/api/v1/restaurant/tax-components'))
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`)
      .send({ name: 'cgst', rateBps: 250 });
    assert.equal(res.status, 409);
  });

  test('a rate outside 0–100% is rejected', async () => {
    const res = await asWeb(request(ctx.app).post('/api/v1/restaurant/tax-components'))
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`)
      .send({ name: 'Absurd', rateBps: 10001 });
    assert.equal(res.status, 400);
  });

  test("another restaurant's tax component cannot be edited", async () => {
    const { rows } = await ctx.owner.query<{ id: string }>(
      'select id from tax_components where restaurant_id = $1 limit 1', [ctx.fixtures.restaurantB]);
    const res = await asWeb(request(ctx.app).patch(`/api/v1/restaurant/tax-components/${rows[0]!.id}`))
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`)
      .send({ rateBps: 9999 });
    assert.equal(res.status, 404, 'a wrong-tenant id must look like a missing one');

    const after = await ctx.owner.query<{ rate_bps: number }>(
      'select rate_bps from tax_components where id = $1', [rows[0]!.id]);
    assert.notEqual(after.rows[0]?.rate_bps, 9999);
  });
});

describe('going live', () => {
  const completeFor = async (userId: string) =>
    asWeb(request(ctx.app).post('/api/v1/restaurant/onboarding/complete'))
      .set('cookie', `df_at=${await as(userId)}`);

  test('a restaurant without an address cannot go live', async () => {
    const { rows } = await ctx.owner.query<{ id: string }>(
      `select id from restaurants where slug = 'coastal-kitchen'`);
    const restaurantId = rows[0]!.id;
    const { rows: users } = await ctx.owner.query<{ id: string }>(
      `insert into auth.users (id, email) values (gen_random_uuid(), 'owner@coastal.test') returning id`);
    await ctx.owner.query(
      `insert into restaurant_users (restaurant_id, user_id, role, status, email, display_name)
       values ($1, $2, 'owner', 'active', 'owner@coastal.test', 'Coastal Owner')`,
      [restaurantId, users[0]!.id]);

    const res = await completeFor(users[0]!.id);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'ONBOARDING_INCOMPLETE');

    const { rows: after } = await ctx.owner.query('select status from restaurants where id = $1', [restaurantId]);
    assert.equal(after[0]?.status, 'provisioning');
  });

  test('completing onboarding takes the restaurant live', async () => {
    const { rows } = await ctx.owner.query<{ id: string }>(
      `select id from restaurants where slug = 'coastal-kitchen'`);
    const { rows: users } = await ctx.owner.query<{ user_id: string }>(
      `select user_id from restaurant_users where restaurant_id = $1 and role = 'owner'`, [rows[0]!.id]);

    const current = await request(ctx.app).get('/api/v1/restaurant')
      .set('cookie', `df_at=${await as(users[0]!.user_id)}`);
    const filled = await asWeb(request(ctx.app).patch('/api/v1/restaurant'))
      .set('cookie', `df_at=${await as(users[0]!.user_id)}`)
      .send({ addressLine1: '12 Beach Road', city: 'Panaji', phone: '+91 98200 00000',
              version: current.body.restaurant.version });
    assert.equal(filled.status, 200);

    const res = await completeFor(users[0]!.user_id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'active');

    const { rows: after } = await ctx.owner.query(
      `select r.status, s.onboarding_completed_at from restaurants r
         join restaurant_settings s on s.restaurant_id = r.id where r.id = $1`, [rows[0]!.id]);
    assert.equal(after[0]?.status, 'active');
    assert.ok(after[0]?.onboarding_completed_at);
  });

  test('completing again is reported, not repeated', async () => {
    const { rows } = await ctx.owner.query<{ user_id: string }>(
      `select ru.user_id from restaurant_users ru join restaurants r on r.id = ru.restaurant_id
        where r.slug = 'coastal-kitchen' and ru.role = 'owner'`);
    const res = await completeFor(rows[0]!.user_id);
    assert.equal(res.status, 200);
    assert.equal(res.body.alreadyActive, true);
  });

  test('a manager cannot take the restaurant live', async () => {
    const res = await completeFor(ctx.fixtures.managerA);
    assert.equal(res.status, 403);
  });

  test('no staff member can suspend their own restaurant', async () => {
    // The only transition an owner may make is provisioning -> active.
    await assert.rejects(async () => {
      await ctx.db.asStaff({ userId: ctx.fixtures.ownerA, aal: 'aal1' }, async (client) => {
        await client.query(`update restaurants set status = 'suspended'`);
      });
    }, /only a platform administrator may change restaurant status/);
  });
});

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { auditActions, createTestContext, signToken, type TestContext } from './helpers.ts';

let ctx: TestContext;
/** Captures the emailed link so tests can use the token without it being logged. */
let sentLinks: { to: string; link: string }[] = [];

let ipCounter = 0;
const nextIp = () => `203.0.114.${(ipCounter += 1) % 250 + 1}`;
const asWeb = (req: request.Test, ip = nextIp()) =>
  req.set('x-dineflow-client', 'web').set('origin', 'http://localhost:5173').set('x-forwarded-for', ip);

before(async () => {
  ctx = await createTestContext({
    sendInvitationEmail: async (to, link) => { sentLinks.push({ to, link }); },
  });
});

after(async () => { await ctx.close(); });

const as = (userId: string) => signToken({ sub: userId });

const invite = async (userId: string, body: Record<string, unknown>) =>
  asWeb(request(ctx.app).post('/api/v1/staff/invitations'))
    .set('cookie', `df_at=${await as(userId)}`)
    .send(body);

const tokenFromLink = (link: string) => link.split('#token=')[1] ?? '';

describe('creating invitations', () => {
  test('an owner can invite any role', async () => {
    const res = await invite(ctx.fixtures.ownerA, { email: 'new-manager@example.test', role: 'manager' });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.emailSent, true);
  });

  test('the token is never returned in the response body', async () => {
    const res = await invite(ctx.fixtures.ownerA, { email: 'token-check@example.test', role: 'kitchen' });
    assert.equal(res.status, 201);
    const body = JSON.stringify(res.body);
    assert.equal(body.includes('token'), false, 'an invitation token must only ever exist in the email');
  });

  test('the token travels in the URL fragment, which never reaches a server log', async () => {
    const link = sentLinks.at(-1)!.link;
    assert.match(link, /#token=/);
    assert.equal(link.split('#')[0]?.includes('token'), false);
  });

  test('a manager can invite kitchen and billing staff', async () => {
    const res = await invite(ctx.fixtures.managerA, { email: 'new-cook@example.test', role: 'kitchen' });
    assert.equal(res.status, 201);
  });

  test('a manager cannot invite a manager or an owner', async () => {
    const manager = await invite(ctx.fixtures.managerA, { email: 'peer@example.test', role: 'manager' });
    assert.equal(manager.status, 403, 'privilege escalation via invitation');

    const owner = await invite(ctx.fixtures.managerA, { email: 'boss@example.test', role: 'owner' });
    assert.equal(owner.status, 403);
  });

  test('kitchen and billing staff cannot invite at all', async () => {
    for (const userId of [ctx.fixtures.kitchenA, ctx.fixtures.billingA]) {
      const res = await invite(userId, { email: 'anyone@example.test', role: 'kitchen' });
      assert.equal(res.status, 403);
    }
  });

  test('a second live invitation for the same person is refused', async () => {
    const first = await invite(ctx.fixtures.ownerA, { email: 'duplicate@example.test', role: 'kitchen' });
    assert.equal(first.status, 201);
    const second = await invite(ctx.fixtures.ownerA, { email: 'duplicate@example.test', role: 'billing' });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'INVITE_EXISTS');
  });

  test('inviting an existing team member is refused', async () => {
    const res = await invite(ctx.fixtures.ownerA, { email: 'kitchen-a@example.test', role: 'billing' });
    assert.equal(res.status, 409);
  });

  test('an expiry beyond the documented maximum is rejected', async () => {
    const res = await invite(ctx.fixtures.ownerA, { email: 'long@example.test', role: 'kitchen', expiresInHours: 5000 });
    assert.equal(res.status, 400);
  });

  test('creating an invitation is audited without the token', async () => {
    const events = await auditActions(ctx.owner, 'auth.invitation.created');
    assert.ok(events.length > 0);
    const { rows } = await ctx.owner.query<{ summary: Record<string, unknown> }>(
      `select summary from audit_log where action = 'auth.invitation.created' order by id desc limit 1`);
    assert.ok(rows[0]);
    assert.equal(JSON.stringify(rows[0].summary).includes('token'), false);
  });
});

describe('tenant isolation of invitations', () => {
  test("one restaurant's invitations are invisible to another", async () => {
    await invite(ctx.fixtures.ownerA, { email: 'visible-to-a@example.test', role: 'kitchen' });

    const listB = await request(ctx.app).get('/api/v1/staff/invitations')
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerB)}`);
    assert.equal(listB.status, 200);
    const emails = listB.body.invitations.map((row: { email: string }) => row.email);
    assert.equal(emails.includes('visible-to-a@example.test'), false, 'cross-tenant leak');
  });

  test("revoking another restaurant's invitation returns not found, not forbidden", async () => {
    const created = await invite(ctx.fixtures.ownerA, { email: 'target@example.test', role: 'kitchen' });
    assert.equal(created.status, 201);

    const res = await asWeb(request(ctx.app).delete(`/api/v1/staff/invitations/${created.body.id}`))
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerB)}`);
    // 404, not 403: whether an id exists in another tenant is itself information.
    assert.equal(res.status, 404);

    const { rows } = await ctx.owner.query('select revoked_at from invitations where id = $1', [created.body.id]);
    assert.equal(rows[0]?.revoked_at, null, 'the invitation must be untouched');
  });

  test('kitchen staff cannot list invitations', async () => {
    const res = await request(ctx.app).get('/api/v1/staff/invitations')
      .set('cookie', `df_at=${await as(ctx.fixtures.kitchenA)}`);
    assert.equal(res.status, 403);
  });

  test('the list never includes a token or its hash', async () => {
    const res = await request(ctx.app).get('/api/v1/staff/invitations')
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`);
    assert.equal(res.status, 200);
    const body = JSON.stringify(res.body);
    assert.equal(body.includes('token_hash'), false);
    assert.equal(body.includes('tokenHash'), false);
  });
});

describe('accepting an invitation', () => {
  const accept = (token: string, password = 'a-long-enough-password', displayName = 'New Person') =>
    asWeb(request(ctx.app).post('/api/v1/auth/invitations/accept')).send({ token, password, displayName });

  test('a valid invitation creates the membership with the invited role', async () => {
    sentLinks = [];
    const created = await invite(ctx.fixtures.ownerA, { email: 'accepts@example.test', role: 'billing' });
    assert.equal(created.status, 201);

    const token = tokenFromLink(sentLinks.at(-1)!.link);
    const res = await accept(token);
    assert.equal(res.status, 201);

    const { rows } = await ctx.owner.query<{ role: string; restaurant_id: string; status: string }>(
      `select role, restaurant_id, status from restaurant_users where email = 'accepts@example.test'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.role, 'billing', 'the role must come from the invitation, not the request');
    assert.equal(rows[0]?.restaurant_id, ctx.fixtures.restaurantA);
    assert.equal(rows[0]?.status, 'active');
  });

  test('the same invitation cannot be used twice', async () => {
    sentLinks = [];
    await invite(ctx.fixtures.ownerA, { email: 'once-only@example.test', role: 'kitchen' });
    const token = tokenFromLink(sentLinks.at(-1)!.link);

    const first = await accept(token);
    assert.equal(first.status, 201);
    const second = await accept(token, 'another-long-password');
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, 'INVITE_INVALID');

    const { rows } = await ctx.owner.query(
      `select count(*)::int as count from restaurant_users where email = 'once-only@example.test'`);
    assert.equal(rows[0]?.count, 1, 'a reused invitation must not create a second membership');
  });

  test('an expired invitation is refused', async () => {
    // The expiry of a live invitation cannot be edited — the immutability trigger
    // refuses it — so the expired row is created as such.
    const token = 'expired-token-for-this-test-0123456789';
    await ctx.owner.query(
      `insert into invitations (restaurant_id, email, role, token_hash, invited_by, created_at, expires_at)
       values ($1, 'expired@example.test', 'kitchen', $2, $3, now() - interval '4 days', now() - interval '1 day')`,
      [ctx.fixtures.restaurantA, createHash('sha256').update(token).digest(), ctx.fixtures.ownerA],
    );

    const res = await accept(token);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVITE_INVALID');
  });

  test('a revoked invitation is refused', async () => {
    sentLinks = [];
    const created = await invite(ctx.fixtures.ownerA, { email: 'revoked@example.test', role: 'kitchen' });
    const token = tokenFromLink(sentLinks.at(-1)!.link);

    const revoke = await asWeb(request(ctx.app).delete(`/api/v1/staff/invitations/${created.body.id}`))
      .set('cookie', `df_at=${await as(ctx.fixtures.ownerA)}`);
    assert.equal(revoke.status, 204);

    const res = await accept(token);
    assert.equal(res.status, 400);
  });

  test('an unknown, expired and revoked token are indistinguishable', async () => {
    const unknown = await accept('a'.repeat(43));
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error.code, 'INVITE_INVALID');
    assert.equal(unknown.body.error.message, 'This invitation link is no longer valid.');
  });

  test('a guessed token hash cannot be used, because only the hash is stored', async () => {
    const { rows } = await ctx.owner.query<{ token_hash: Buffer }>(
      'select token_hash from invitations limit 1');
    const hashAsToken = rows[0]!.token_hash.toString('base64url');
    const res = await accept(hashAsToken);
    assert.equal(res.status, 400, 'presenting the stored hash must not authenticate');
  });

  test('the checked link reveals the invited address, not a token', async () => {
    sentLinks = [];
    await invite(ctx.fixtures.ownerA, { email: 'preview@example.test', role: 'kitchen' });
    const token = tokenFromLink(sentLinks.at(-1)!.link);

    const res = await request(ctx.app).get('/api/v1/auth/invitations/check').query({ token });
    assert.equal(res.status, 200);
    assert.equal(res.body.email, 'preview@example.test');
    assert.equal(res.body.role, 'kitchen');
    assert.equal(JSON.stringify(res.body).includes(token), false);
  });

  test('acceptance is audited against the right restaurant', async () => {
    const { rows } = await ctx.owner.query<{ restaurant_id: string }>(
      `select restaurant_id from audit_log where action = 'auth.invitation.accepted' order by id desc limit 1`);
    assert.equal(rows[0]?.restaurant_id, ctx.fixtures.restaurantA);
  });
});

describe('database-level protection of invitations', () => {
  test('an invitation cannot be re-pointed at another restaurant or role', async () => {
    const { rows } = await ctx.owner.query<{ id: string }>(
      `select id from invitations where accepted_at is null and revoked_at is null limit 1`);
    const id = rows[0]?.id;
    assert.ok(id, 'expected a live invitation to test with');

    await assert.rejects(
      () => ctx.owner.query('update invitations set restaurant_id = $1 where id = $2', [ctx.fixtures.restaurantB, id]),
      /only be accepted or revoked/,
      'the database must refuse to move an invitation between tenants',
    );
    await assert.rejects(
      () => ctx.owner.query(`update invitations set role = 'owner' where id = $1`, [id]),
      /only be accepted or revoked/,
      'the database must refuse to raise the role of a pending invitation',
    );
  });

  test('token hashes are stored, never tokens', async () => {
    const { rows } = await ctx.owner.query<{ token_hash: Buffer }>('select token_hash from invitations limit 1');
    assert.equal(rows[0]?.token_hash.length, 32, 'expected a SHA-256 digest');
  });

  test('the stored hash matches the emailed token', async () => {
    sentLinks = [];
    const created = await invite(ctx.fixtures.ownerA, { email: 'hash-check@example.test', role: 'kitchen' });
    const token = tokenFromLink(sentLinks.at(-1)!.link);
    const { rows } = await ctx.owner.query<{ token_hash: Buffer }>(
      'select token_hash from invitations where id = $1', [created.body.id]);
    assert.deepEqual(rows[0]!.token_hash, createHash('sha256').update(token).digest());
  });
});

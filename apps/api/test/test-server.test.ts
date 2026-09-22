// The test harness itself: every app a test talks to must be reachable only as
// itself. Regression test for an intermittent full-suite failure in which requests
// reached another local program on the same port (see serveLocally in helpers.ts).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import request from 'supertest';
import { closeServers, serveLocally } from './helpers.ts';

after(async () => { await closeServers(); });

const app: http.RequestListener = (_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ from: 'app-under-test' }));
};

test('test apps listen on IPv4 loopback, the address supertest connects to', async () => {
  const server = await serveLocally(app);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  assert.equal(address.address, '127.0.0.1', 'not "::", which another program could shadow on 127.0.0.1');
});

test('every request reaches the app under test, including concurrent ones', async () => {
  const server = await serveLocally(app);
  const responses = await Promise.all(Array.from({ length: 50 }, () => request(server).get('/')));
  for (const res of responses) assert.equal(res.body.from, 'app-under-test');
});

test('a port another program holds on 127.0.0.1 is never handed to a test app', async () => {
  // Stand-in for another local program (such as an editor helper) on 127.0.0.1.
  const other = http.createServer((_req, res) => res.end('another program'));
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  try {
    const taken = (other.address() as { port: number }).port;
    const ours = await serveLocally(app);
    assert.notEqual((ours.address() as { port: number }).port, taken);
    // And binding that exact port on loopback is refused, where "::" would have been allowed.
    await assert.rejects(new Promise((resolve, reject) => {
      const clash = http.createServer(app);
      clash.once('error', reject);
      clash.listen(taken, '127.0.0.1', () => { clash.close(); resolve(undefined); });
    }), /EADDRINUSE/);
  } finally {
    await new Promise((resolve) => other.close(resolve));
  }
});

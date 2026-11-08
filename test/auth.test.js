import test from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, listen, api, createFakePayPal, createFakeGemini } from './helpers.js';

setTestEnv();
const { createApp } = await import('../src/app.js');
const { getDb } = await import('../src/db.js');
const { resetLoginThrottleForTesting } = await import('../src/auth.js');
const { setAiClientForTesting } = await import('../src/ai/gemini.js');

const GUEST = 'shop_authtest-1111-2222-3333-444444444444';
const OTHER_BROWSER = 'shop_authtest-9999-8888-7777-666666666666';
const cookieFrom = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

test('Accounts: register, sign in, sessions and order history', async (t) => {
  const fake = createFakePayPal();
  const paypal = await listen(fake.app);
  process.env.PAYPAL_BASE_URL = paypal.url;
  const app = createApp();
  const server = await listen(app);
  const http = api(server.url);
  t.after(async () => {
    setAiClientForTesting(null);
    await server.close();
    await paypal.close();
  });
  t.beforeEach(() => {
    app.locals.rateLimiters.authLimiter.reset();
    resetLoginThrottleForTesting();
  });

  // A paid guest order made before the account exists
  await http.post('/api/cart/add', { sessionId: 'auth_guest_s', id: 'p1', quantity: 1 });
  const guestOrder = (await http.post('/api/paypal/create-order', { sessionId: 'auth_guest_s', shopperId: GUEST })).json.orderID;
  await http.post('/api/paypal/capture-order', { sessionId: 'auth_guest_s', orderID: guestOrder });

  let cookie = '';

  await t.test('rejects invalid email and weak password', async () => {
    assert.equal((await http.post('/api/auth/register', { email: 'not-an-email', password: 'longenough1' })).status, 400);
    assert.equal((await http.post('/api/auth/register', { email: 'a@example.com', password: 'short' })).status, 400);
  });

  await t.test('register creates the account, signs in and links guest orders', async () => {
    const res = await http.post('/api/auth/register', { email: '  Alice@Example.COM ', password: 'correct horse battery', shopperId: GUEST });
    assert.equal(res.status, 201);
    assert.equal(res.json.user.email, 'alice@example.com', 'email is normalised');
    assert.equal(res.json.linkedOrders, 1);

    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /ab_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    cookie = cookieFrom(res);
  });

  await t.test('passwords and session tokens are never stored in plain text', () => {
    const user = getDb().prepare('SELECT password_hash FROM users WHERE email = ?').get('alice@example.com');
    assert.match(user.password_hash, /^scrypt\$16384\$8\$1\$/);
    assert.ok(!user.password_hash.includes('correct horse'));
    const token = decodeURIComponent(cookie.split('=')[1]);
    const stored = getDb().prepare('SELECT token_hash FROM auth_sessions').all().map(r => r.token_hash);
    assert.ok(stored.length > 0 && !stored.includes(token), 'only a hash of the token is stored');
  });

  await t.test('duplicate email is rejected', async () => {
    const res = await http.post('/api/auth/register', { email: 'alice@example.com', password: 'another password' });
    assert.equal(res.status, 409);
  });

  await t.test('/me reflects the signed-in user', async () => {
    assert.equal((await http.get('/api/auth/me')).json.user, null);
    assert.equal((await http.get('/api/auth/me', { Cookie: cookie })).json.user.email, 'alice@example.com');
  });

  await t.test('order history follows the account to another browser', async () => {
    const res = await http.get(`/api/orders?shopperId=${OTHER_BROWSER}`, { Cookie: cookie });
    assert.equal(res.json.account, true);
    assert.deepEqual(res.json.orders.map(o => o.orderID), [guestOrder]);
  });

  await t.test('linked orders are no longer visible to the signed-out browser ID', async () => {
    const res = await http.get(`/api/orders?shopperId=${GUEST}`);
    assert.deepEqual(res.json.orders, []);
  });

  await t.test('orders placed while signed in belong to the account', async () => {
    await http.post('/api/cart/add', { sessionId: 'auth_signed_s', id: 'p2', quantity: 1 }, { Cookie: cookie });
    const id = (await http.post('/api/paypal/create-order', { sessionId: 'auth_signed_s', shopperId: OTHER_BROWSER }, { Cookie: cookie })).json.orderID;
    await http.post('/api/paypal/capture-order', { sessionId: 'auth_signed_s', orderID: id }, { Cookie: cookie });
    const res = await http.get('/api/orders', { Cookie: cookie });
    assert.equal(res.json.orders.length, 2);
  });

  await t.test("the assistant's order history uses the account", async () => {
    const fakeAi = createFakeGemini([
      [[{ functionCall: { name: 'get_order_history', args: {}, id: 'h' } }]],
      [[{ text: 'Here are your orders.' }]]
    ]);
    setAiClientForTesting(fakeAi);
    await http.post('/api/chat', { sessionId: 'auth_chat_s', shopperId: OTHER_BROWSER, message: 'what did I buy?' }, { Cookie: cookie });
    const output = fakeAi.calls.messages[1][0].functionResponse.response.output;
    assert.equal(output.orders.length, 2);
    setAiClientForTesting(null);
  });

  await t.test('wrong password is rejected; right password signs in', async () => {
    assert.equal((await http.post('/api/auth/login', { email: 'alice@example.com', password: 'wrong password' })).status, 401);
    assert.equal((await http.post('/api/auth/login', { email: 'nobody@example.com', password: 'whatever123' })).status, 401);
    const ok = await http.post('/api/auth/login', { email: 'ALICE@example.com', password: 'correct horse battery' });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('set-cookie'), /ab_session=/);
  });

  await t.test('repeated failures lock the account for a while', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await http.post('/api/auth/login', { email: 'alice@example.com', password: `nope${i}xxxx` })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
    // Even the right password is refused during the lockout
    const right = await http.post('/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' });
    assert.equal(right.status, 429);
  });

  await t.test('sign-in attempts are rate limited per IP', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await http.post('/api/auth/login', { email: `user${i}@example.com`, password: 'whatever123' })).status);
    }
    assert.equal(statuses.at(-1), 429);
  });

  await t.test('logout ends the session on the server', async () => {
    const res = await http.post('/api/auth/logout', {}, { Cookie: cookie });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await http.get('/api/auth/me', { Cookie: cookie })).json.user, null, 'old cookie no longer works');
  });

  await t.test('expired sessions are rejected', async () => {
    const res = await http.post('/api/auth/login', { email: 'alice@example.com', password: 'correct horse battery' });
    const c = cookieFrom(res);
    getDb().prepare('UPDATE auth_sessions SET expires_at = ?').run(Date.now() - 1);
    assert.equal((await http.get('/api/auth/me', { Cookie: c })).json.user, null);
  });

  await t.test('cross-site POSTs are blocked (CSRF)', async () => {
    const evil = await http.post('/api/cart/add', { sessionId: 's', id: 'p1' }, { Origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    const same = await http.post('/api/cart/add', { sessionId: 's', id: 'p1' }, { Origin: server.url });
    assert.equal(same.status, 200);
  });
});

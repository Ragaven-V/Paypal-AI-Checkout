// Regression tests for the bugs found in the November 2026 project review
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, listen, api, createFakePayPal, createFakeGemini, webhookHeaders, parseSse } from './helpers.js';

setTestEnv({ ADMIN_TOKEN: 'review-admin' });
const { createApp } = await import('../src/app.js');
const { getOrCreateSession, sessions } = await import('../src/sessions.js');
const { orderStore } = await import('../src/db.js');
const { setAiClientForTesting } = await import('../src/ai/gemini.js');
const { resetLoginThrottleForTesting } = await import('../src/auth.js');

const captureEvent = (orderId) => ({
  id: `WH-REVIEW-${Math.random()}`,
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource: { id: `CAP-${orderId}`, status: 'COMPLETED', supplementary_data: { related_ids: { order_id: orderId } } }
});

test('Review fixes', async (t) => {
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

  const cartIds = async (sessionId) => (await http.get(`/api/cart?sessionId=${sessionId}`)).json.cart.items
    .map(i => `${i.id}x${i.quantity}`);

  await t.test('a webhook arriving during capture does not settle the order twice', async () => {
    const sessionId = 'rv_race';
    await http.post('/api/cart/add', { sessionId, id: 'p2', quantity: 2 });
    const { orderID } = (await http.post('/api/paypal/create-order', { sessionId })).json;
    // Shopper adds one more mug while the PayPal popup is open
    await http.post('/api/cart/add', { sessionId, id: 'p2', quantity: 1 });

    fake.state.beforeCaptureResponse = async (id) => {
      const res = await http.post('/api/paypal/webhook', captureEvent(id), webhookHeaders());
      assert.equal(res.json.outcome, 'settled');
    };
    try {
      const res = await http.post('/api/paypal/capture-order', { sessionId, orderID });
      assert.equal(res.status, 200);
    } finally {
      fake.state.beforeCaptureResponse = null;
    }

    assert.deepEqual(await cartIds(sessionId), ['p2x1'], 'only the 2 paid mugs are removed');
    assert.equal(orderStore.get(orderID).webhookConfirmed, true, 'the capture save keeps the webhook flag');
  });

  await t.test('ORDER_ALREADY_CAPTURED is treated as paid', async () => {
    const sessionId = 'rv_already';
    await http.post('/api/cart/add', { sessionId, id: 'p1', quantity: 1 });
    const { orderID } = (await http.post('/api/paypal/create-order', { sessionId })).json;
    fake.state.captureBehavior.set(orderID, 'already-captured');

    const res = await http.post('/api/paypal/capture-order', { sessionId, orderID });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'COMPLETED');
    assert.deepEqual(await cartIds(sessionId), []);
    assert.equal(orderStore.get(orderID).settled, true);
  });

  await t.test('a webhook that fails to apply is not recorded, so the retry works', async () => {
    const sessionId = 'rv_retry';
    await http.post('/api/cart/add', { sessionId, id: 'p1', quantity: 1 });
    const { orderID } = (await http.post('/api/paypal/create-order', { sessionId })).json;
    const event = captureEvent(orderID);

    const realSave = orderStore.save;
    orderStore.save = () => { throw new Error('database is locked'); };
    try {
      assert.equal((await http.post('/api/paypal/webhook', event, webhookHeaders())).status, 500);
    } finally {
      orderStore.save = realSave;
    }
    assert.equal(orderStore.get(orderID).settled, false, 'nothing half-applied');

    const retry = await http.post('/api/paypal/webhook', event, webhookHeaders());
    assert.equal(retry.json.outcome, 'settled', 'retry is processed, not dismissed as a duplicate');
    assert.deepEqual(await cartIds(sessionId), []);
  });

  await t.test('cart and checkout calls keep the signed-in account on the session', () => {
    const session = getOrCreateSession('rv_user', { userId: 42 });
    getOrCreateSession('rv_user'); // e.g. /api/cart/add or webhook settlement
    assert.equal(session.userId, 42);
    getOrCreateSession('rv_user', { userId: null }); // a chat request after sign-out
    assert.equal(session.userId, null);
  });

  await t.test('Gemini: running out of tool rounds leaves a usable chat', async () => {
    const search = (id) => [[{ functionCall: { name: 'search_products', args: { query: 'coffee' }, id } }]];
    const fakeAi = createFakeGemini([
      ...[1, 2, 3, 4, 5, 6].map(n => search(`s${n}`)),
      [[{ text: 'Here is what I found.' }]],
      [[{ text: 'Second answer.' }]]
    ]);
    setAiClientForTesting(fakeAi);

    const first = await http.post('/api/chat', { sessionId: 'rv_rounds', message: 'find coffee things' });
    assert.equal(first.json.reply, 'Here is what I found.');
    const refusal = fakeAi.calls.messages[6];
    assert.ok(refusal[0].functionResponse.response.error, 'the leftover call is answered');

    const second = await http.post('/api/chat', { sessionId: 'rv_rounds', message: 'thanks' });
    assert.equal(second.json.reply, 'Second answer.');
    // The long history is trimmed into a new chat, but the context is kept (not wiped by an error)
    assert.ok(fakeAi.calls.chatsCreated.at(-1).history.length > 0, 'context kept');
    setAiClientForTesting(null);
  });

  await t.test('two chat messages for one session run one after the other', async () => {
    let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const order = [];
    const fakeAi = {
      calls: { chatsCreated: [] },
      chats: {
        create(options) {
          fakeAi.calls.chatsCreated.push(options);
          return {
            getHistory: () => [],
            async sendMessageStream({ message }) {
              order.push(`start:${message}`);
              if (message === 'first') await gate;
              order.push(`end:${message}`);
              return (async function* () { yield { candidates: [{ content: { parts: [{ text: `re ${message}` }] } }] }; })();
            }
          };
        }
      },
      models: { async generateContent() { return { text: 'OK' }; } },
      caches: { async create() { throw new Error('no cache'); } }
    };
    setAiClientForTesting(fakeAi);

    const a = http.post('/api/chat', { sessionId: 'rv_queue', message: 'first', stream: true });
    await new Promise(r => setTimeout(r, 50));
    const b = http.post('/api/chat', { sessionId: 'rv_queue', message: 'second', stream: true });
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(order, ['start:first'], 'second turn waits for the first');
    releaseFirst();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
    assert.match(parseSse(ra.text).filter(e => e.type === 'chunk').map(e => e.text).join(''), /re first/);
    assert.match(parseSse(rb.text).filter(e => e.type === 'chunk').map(e => e.text).join(''), /re second/);
    setAiClientForTesting(null);
  });

  await t.test('admin paging ignores fractional limit/offset instead of failing', async () => {
    const res = await http.get('/api/admin/orders?limit=10.5&offset=1.5', { Authorization: 'Bearer review-admin' });
    assert.equal(res.status, 200);
  });

  await t.test('sign-out with a malformed cookie still works', async () => {
    const res = await http.post('/api/auth/logout', {}, { Cookie: 'ab_session=%E0%A4%A' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
  });

  await t.test('parallel wrong passwords stop at the lockout limit', async () => {
    app.locals.rateLimiters.authLimiter.reset();
    resetLoginThrottleForTesting();
    const email = 'parallel@example.com';
    await http.post('/api/auth/register', { email, password: 'the right password' });
    app.locals.rateLimiters.authLimiter.reset();

    const results = await Promise.all(Array.from({ length: 8 }, () =>
      http.post('/api/auth/login', { email, password: 'wrong password!' })));
    const statuses = results.map(r => r.status);
    assert.equal(statuses.filter(s => s === 401).length, 5, `got ${statuses}`);
    assert.equal(statuses.filter(s => s === 429).length, 3);
    app.locals.rateLimiters.authLimiter.reset();
    resetLoginThrottleForTesting();
  });

  sessions.clear();
});

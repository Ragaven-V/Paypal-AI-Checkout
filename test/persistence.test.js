import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTestEnv, listen, api, createFakePayPal, webhookHeaders, createFakeGemini } from './helpers.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-checkout-db-'));
setTestEnv({ DATABASE_PATH: path.join(dir, 'orders.db') });

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { sessions } = await import('../src/sessions.js');
const { setAiClientForTesting } = await import('../src/ai/gemini.js');

// Simulates a server restart: in-memory sessions are gone and the DB connection is reopened
function restart() {
  sessions.clear();
  closeDb();
}

test('Orders, carts and chats persist in SQLite across restarts', async (t) => {
  const fake = createFakePayPal();
  const paypal = await listen(fake.app);
  process.env.PAYPAL_BASE_URL = paypal.url;
  const server = await listen(createApp());
  const http = api(server.url);
  t.after(async () => {
    await server.close();
    await paypal.close();
    closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t.test('an order created before a restart can still be captured after it', async () => {
    const sessionId = 'persist_capture';
    await http.post('/api/cart/add', { sessionId, id: 'p1', quantity: 2 });
    const { json } = await http.post('/api/paypal/create-order', { sessionId });

    restart();

    const res = await http.post('/api/paypal/capture-order', { sessionId, orderID: json.orderID });
    assert.equal(res.status, 200);
    assert.equal(res.json.amount, '$79.98');

    restart();
    const order = await http.get(`/api/paypal/orders/${json.orderID}?sessionId=${sessionId}`);
    assert.equal(order.json.status, 'COMPLETED');
  });

  await t.test('a paid order cannot be captured twice', async () => {
    const sessionId = 'persist_double';
    await http.post('/api/cart/add', { sessionId, id: 'p2', quantity: 1 });
    const { json } = await http.post('/api/paypal/create-order', { sessionId });
    assert.equal((await http.post('/api/paypal/capture-order', { sessionId, orderID: json.orderID })).status, 200);
    assert.equal((await http.post('/api/paypal/capture-order', { sessionId, orderID: json.orderID })).status, 409);
  });

  await t.test('a pending payment is settled by a webhook that arrives after a restart', async () => {
    const sessionId = 'persist_pending';
    await http.post('/api/cart/add', { sessionId, id: 'p3', quantity: 1 });
    const { json } = await http.post('/api/paypal/create-order', { sessionId });
    fake.state.captureBehavior.set(json.orderID, 'pending');
    assert.equal((await http.post('/api/paypal/capture-order', { sessionId, orderID: json.orderID })).status, 202);

    restart();

    const event = {
      id: 'WH-PERSIST-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAP-1', supplementary_data: { related_ids: { order_id: json.orderID } } }
    };
    const hook = await http.post('/api/paypal/webhook', event, webhookHeaders());
    assert.equal(hook.json.outcome, 'settled');

    restart();
    // Duplicate detection survives restarts too
    const again = await http.post('/api/paypal/webhook', event, webhookHeaders());
    assert.equal(again.json.outcome, 'duplicate');
    const order = await http.get(`/api/paypal/orders/${json.orderID}?sessionId=${sessionId}`);
    assert.equal(order.json.status, 'COMPLETED');
    assert.equal(order.json.webhookConfirmed, true);
  });

  await t.test('a cart survives a restart, including decrements and removals', async () => {
    const sessionId = 'persist_cart';
    await http.post('/api/cart/add', { sessionId, id: 'p1', quantity: 3 });
    await http.post('/api/cart/add', { sessionId, id: 'p1', quantity: -1 });
    await http.post('/api/cart/add', { sessionId, id: 'p2', quantity: 1 });
    await http.post('/api/cart/add', { sessionId, id: 'p3', quantity: 1 });
    await http.post('/api/cart/remove', { sessionId, id: 'p3' });

    restart();

    const res = await http.get(`/api/cart?sessionId=${sessionId}`);
    assert.deepEqual(res.json.cart.items.map(i => [i.id, i.quantity]), [['p1', 2], ['p2', 1]]);
    assert.equal(res.json.cart.totalCents, 3999 * 2 + 1650);
  });

  await t.test('paying after a restart removes the paid items from the saved cart', async () => {
    const sessionId = 'persist_paid_cart';
    await http.post('/api/cart/add', { sessionId, id: 'p4', quantity: 1 });
    const { json } = await http.post('/api/paypal/create-order', { sessionId });
    await http.post('/api/cart/add', { sessionId, id: 'p6', quantity: 1 }); // added after ordering

    restart();
    assert.equal((await http.post('/api/paypal/capture-order', { sessionId, orderID: json.orderID })).status, 200);

    restart();
    const res = await http.get(`/api/cart?sessionId=${sessionId}`);
    assert.deepEqual(res.json.cart.items.map(i => i.id), ['p6']);
  });

  await t.test('the chat transcript survives a restart', async () => {
    setAiClientForTesting(null); // rule-based assistant
    const sessionId = 'persist_chat';
    await http.post('/api/chat', { sessionId, message: 'add the grinder' });
    await http.post('/api/chat', { sessionId, message: 'view my cart' });

    restart();

    const res = await http.get(`/api/chat/history?sessionId=${sessionId}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(res.json.messages[0].text, 'add the grinder');
    assert.equal(res.json.messages[1].products[0].id, 'p1', 'product cards are restored with the reply');
  });

  await t.test("Gemini's memory of the conversation is restored after a restart", async () => {
    const sessionId = 'persist_ai_memory';
    setAiClientForTesting(createFakeGemini([[[{ text: 'Hi! What are you shopping for?' }]]]));
    await http.post('/api/chat', { sessionId, message: 'hello, I am shopping for my dad' });

    restart();

    const fake = createFakeGemini([[[{ text: 'For your dad, how about a grinder?' }]]]);
    setAiClientForTesting(fake);
    const res = await http.post('/api/chat', { sessionId, message: 'any ideas?' });
    assert.equal(res.json.reply, 'For your dad, how about a grinder?');

    const restored = fake.calls.chatsCreated[0].history;
    assert.equal(restored.length, 2, 'previous user + model turns are passed back to Gemini');
    assert.equal(restored[0].parts[0].text, 'hello, I am shopping for my dad');
    setAiClientForTesting(null);
  });

  await t.test('the database file is created on disk', () => {
    assert.ok(fs.existsSync(path.join(dir, 'orders.db')));
  });
});

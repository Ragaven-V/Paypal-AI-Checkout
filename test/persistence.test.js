import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTestEnv, listen, api, createFakePayPal, webhookHeaders } from './helpers.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-checkout-db-'));
setTestEnv({ DATABASE_PATH: path.join(dir, 'orders.db') });

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { sessions } = await import('../src/sessions.js');

// Simulates a server restart: in-memory sessions are gone and the DB connection is reopened
function restart() {
  sessions.clear();
  closeDb();
}

test('Orders persist in SQLite across restarts', async (t) => {
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

  await t.test('the database file is created on disk', () => {
    assert.ok(fs.existsSync(path.join(dir, 'orders.db')));
  });
});

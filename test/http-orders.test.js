import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { setTestEnv, listen, api, createFakePayPal, createFakeGemini } from './helpers.js';

setTestEnv({ ADMIN_TOKEN: 'test-admin-secret' });
const { createApp } = await import('../src/app.js');
const { catalogMap } = await import('../src/catalog.js');
const { getDb, closeDb } = await import('../src/db.js');
const { setAiClientForTesting } = await import('../src/ai/gemini.js');

const SHOPPER_A = 'shop_aaaaaaaa-1111-2222-3333-444444444444';
const SHOPPER_B = 'shop_bbbbbbbb-1111-2222-3333-444444444444';
const ADMIN = { Authorization: 'Bearer test-admin-secret' };

test('Order history and admin', async (t) => {
  const fake = createFakePayPal();
  const paypal = await listen(fake.app);
  process.env.PAYPAL_BASE_URL = paypal.url;
  const app = createApp();
  const server = await listen(app);
  const http = api(server.url);
  t.after(async () => {
    await server.close();
    await paypal.close();
  });

  // Fill a cart, create the PayPal order and (optionally) capture it
  async function checkout(sessionId, shopperId, items, { pay = true } = {}) {
    for (const [id, quantity] of items) {
      await http.post('/api/cart/add', { sessionId, id, quantity });
    }
    const { json } = await http.post('/api/paypal/create-order', { sessionId, shopperId });
    if (pay) {
      const capture = await http.post('/api/paypal/capture-order', { sessionId, orderID: json.orderID });
      assert.equal(capture.status, 200);
    }
    return json.orderID;
  }

  await t.test('history requires a valid shopperId', async () => {
    assert.equal((await http.get('/api/orders')).status, 400);
    assert.equal((await http.get('/api/orders?shopperId=nope')).status, 400);
    assert.equal((await http.post('/api/paypal/create-order', { sessionId: 's', shopperId: 'bad id' })).status, 400);
  });

  await t.test('a shopper sees their paid orders with line items, newest first', async () => {
    const first = await checkout('hist_s1', SHOPPER_A, [['p1', 2]]);
    const second = await checkout('hist_s2', SHOPPER_A, [['p2', 1], ['p3', 1]]);

    const res = await http.get(`/api/orders?shopperId=${SHOPPER_A}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.orders.map(o => o.orderID), [second, first]);

    const order = res.json.orders[1];
    assert.equal(order.status, 'COMPLETED');
    assert.equal(order.statusLabel, 'Paid');
    assert.equal(order.amount, '$79.98');
    assert.equal(order.itemCount, 2);
    assert.deepEqual(order.lines.map(l => [l.id, l.quantity, l.price, l.subtotal]), [['p1', 2, '$39.99', '$79.98']]);
  });

  await t.test('history survives a new shopping session (same shopper, new session ID)', async () => {
    const res = await http.get(`/api/orders?shopperId=${SHOPPER_A}&sessionId=brand_new_session`);
    assert.equal(res.json.orders.length, 2);
  });

  await t.test('another shopper cannot see these orders', async () => {
    const res = await http.get(`/api/orders?shopperId=${SHOPPER_B}`);
    assert.deepEqual(res.json.orders, []);
  });

  await t.test('unfinished checkouts are hidden unless asked for', async () => {
    const unpaid = await checkout('hist_s3', SHOPPER_B, [['p4', 1]], { pay: false });
    assert.equal((await http.get(`/api/orders?shopperId=${SHOPPER_B}`)).json.orders.length, 0);
    const all = await http.get(`/api/orders?shopperId=${SHOPPER_B}&includeUnpaid=1`);
    assert.equal(all.json.orders[0].orderID, unpaid);
    assert.equal(all.json.orders[0].statusLabel, 'Not paid');
  });

  await t.test('history keeps the price that was charged even if the catalog price changes', async () => {
    const product = catalogMap.get('p5');
    const original = product.price;
    await checkout('hist_price', 'shop_cccccccc-1111-2222-3333-444444444444', [['p5', 1]]);
    product.price = 99.99;
    try {
      const res = await http.get('/api/orders?shopperId=shop_cccccccc-1111-2222-3333-444444444444');
      assert.equal(res.json.orders[0].lines[0].price, `$${original.toFixed(2)}`);
    } finally {
      product.price = original;
    }
  });

  await t.test("AI: get_order_history returns only this shopper's paid orders", async () => {
    const fake = createFakeGemini([
      [[{ functionCall: { name: 'get_order_history', args: {}, id: 'h1' } }]],
      [[{ text: 'You bought a grinder and a mug.' }]]
    ]);
    setAiClientForTesting(fake);
    const res = await http.post('/api/chat', { sessionId: 'ai_hist', shopperId: SHOPPER_A, message: 'what did I buy before?' });
    assert.equal(res.json.reply, 'You bought a grinder and a mug.');

    const output = fake.calls.messages[1][0].functionResponse.response.output;
    assert.equal(output.orders.length, 2);
    assert.ok(output.orders.every(o => o.status === 'Paid'));
    assert.deepEqual(output.orders[1].items.map(i => i.product_id), ['p1']);
    setAiClientForTesting(null);
  });

  await t.test('AI: reorder puts a past order back in the cart', async () => {
    const history = await http.get(`/api/orders?shopperId=${SHOPPER_A}`);
    const firstOrder = history.json.orders.at(-1).orderID; // the 2x grinder order
    setAiClientForTesting(createFakeGemini([
      [[{ functionCall: { name: 'reorder', args: { order_id: firstOrder }, id: 'r1' } }]],
      [[{ text: 'Done, the grinders are back in your cart.' }]]
    ]));
    const res = await http.post('/api/chat', { sessionId: 'ai_reorder', shopperId: SHOPPER_A, message: 'order the same again' });
    assert.deepEqual(res.json.cart.items.map(i => [i.id, i.quantity]), [['p1', 2]]);
    setAiClientForTesting(null);
  });

  await t.test("AI: reorder refuses another shopper's order", async () => {
    const history = await http.get(`/api/orders?shopperId=${SHOPPER_A}`);
    const fake = createFakeGemini([
      [[{ functionCall: { name: 'reorder', args: { order_id: history.json.orders[0].orderID }, id: 'r2' } }]],
      [[{ text: 'I could not find that order.' }]]
    ]);
    setAiClientForTesting(fake);
    const res = await http.post('/api/chat', { sessionId: 'ai_thief', shopperId: SHOPPER_B, message: 'reorder that' });
    assert.equal(res.json.cart.items.length, 0);
    assert.equal(fake.calls.messages[1][0].functionResponse.response.output.success, false);
    setAiClientForTesting(null);
  });

  await t.test('fallback assistant: order history and "order the same again"', async () => {
    setAiClientForTesting(null);
    const hist = await http.post('/api/chat', { sessionId: 'mock_hist', shopperId: SHOPPER_A, message: 'what did I buy last time?' });
    assert.match(hist.json.reply, /recent orders/);
    assert.match(hist.json.reply, /Precision Burr Coffee Grinder/);

    const again = await http.post('/api/chat', { sessionId: 'mock_again', shopperId: SHOPPER_A, message: 'order the same again' });
    assert.ok(again.json.cart.items.length > 0, 'latest order is back in the cart');

    const none = await http.post('/api/chat', { sessionId: 'mock_none', shopperId: 'shop_dddddddd-1111-2222-3333-444444444444', message: 'reorder' });
    assert.match(none.json.reply, /don't have any past orders/);
  });

  await t.test('admin: wrong or missing password is rejected', async () => {
    assert.equal((await http.get('/api/admin/orders')).status, 401);
    assert.equal((await http.get('/api/admin/orders', { Authorization: 'Bearer wrong' })).status, 401);
  });

  await t.test('admin: lists all orders with a status summary and filter', async () => {
    const all = await http.get('/api/admin/orders', ADMIN);
    assert.equal(all.status, 200);
    // Earlier steps created 3 paid orders and 1 unfinished checkout
    assert.equal(all.json.total, 4);
    const paid = all.json.summary.find(s => s.status === 'COMPLETED');
    assert.equal(paid.count, 3);
    assert.equal(all.json.summary.find(s => s.status === 'CREATED').count, 1);
    assert.ok(all.json.orders.every(o => 'shopperId' in o && 'sessionId' in o));

    const unpaid = await http.get('/api/admin/orders?status=created', ADMIN);
    assert.ok(unpaid.json.orders.length >= 1);
    assert.ok(unpaid.json.orders.every(o => o.status === 'CREATED'));

    assert.equal((await http.get('/api/admin/orders?status=bogus', ADMIN)).status, 400);
  });

  await t.test('admin: pagination', async () => {
    const page = await http.get('/api/admin/orders?limit=2&offset=1', ADMIN);
    assert.equal(page.json.orders.length, 2);
  });

  await t.test('admin: disabled (503) when ADMIN_TOKEN is not set', async () => {
    const saved = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = '';
    try {
      assert.equal((await http.get('/api/admin/orders', ADMIN)).status, 503);
    } finally {
      process.env.ADMIN_TOKEN = saved;
    }
  });

  await t.test('admin: password guessing is rate limited', async () => {
    app.locals.rateLimiters.adminLimiter.reset();
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await http.get('/api/admin/orders', { Authorization: `Bearer guess${i}` })).status);
    }
    assert.equal(statuses.at(-1), 429);
    app.locals.rateLimiters.adminLimiter.reset();
  });

  await t.test('GET /admin serves the admin page', async () => {
    const res = await http.get('/admin');
    assert.equal(res.status, 200);
    assert.match(res.text, /Orders admin/);
  });
});

test('database migration adds history columns to an existing database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-checkout-migrate-'));
  const file = path.join(dir, 'old.db');
  // Schema as shipped before order history existed, with one old order
  const old = new Database(file);
  old.exec(`CREATE TABLE orders (order_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, items_json TEXT NOT NULL,
    total_cents INTEGER NOT NULL, total_formatted TEXT NOT NULL, status TEXT NOT NULL, capture_id TEXT,
    settled INTEGER NOT NULL DEFAULT 0, webhook_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  old.prepare(`INSERT INTO orders VALUES ('OLD-1','sess_old','[["p1",1]]',3999,'$39.99','COMPLETED',null,1,0,1,1)`).run();
  old.close();

  const savedPath = process.env.DATABASE_PATH;
  closeDb();
  process.env.DATABASE_PATH = file;
  try {
    const columns = getDb().prepare('PRAGMA table_info(orders)').all().map(c => c.name);
    assert.ok(columns.includes('shopper_id'));
    assert.ok(columns.includes('lines_json'));
    const row = getDb().prepare('SELECT order_id, shopper_id FROM orders').get();
    assert.equal(row.order_id, 'OLD-1');
    assert.equal(row.shopper_id, null);
  } finally {
    closeDb();
    process.env.DATABASE_PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

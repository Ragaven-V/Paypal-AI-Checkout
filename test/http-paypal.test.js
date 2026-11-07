import test from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, listen, api, createFakePayPal, webhookHeaders } from './helpers.js';

setTestEnv();
const { createApp } = await import('../src/app.js');
const { resetPayPalStateForTesting } = await import('../src/paypal.js');

const captureEvent = (orderId, id = `WH-EVT-${Math.random()}`) => ({
  id,
  event_type: 'PAYMENT.CAPTURE.COMPLETED',
  resource: { id: `CAP-${orderId}`, status: 'COMPLETED', supplementary_data: { related_ids: { order_id: orderId } } }
});

test('HTTP: PayPal checkout and webhooks', async (t) => {
  const fake = createFakePayPal();
  const paypal = await listen(fake.app);
  process.env.PAYPAL_BASE_URL = paypal.url;

  const server = await listen(createApp());
  const http = api(server.url);
  t.after(async () => {
    await server.close();
    await paypal.close();
  });

  const fillCart = async (sessionId, items) => {
    for (const [id, quantity] of items) {
      await http.post('/api/cart/add', { sessionId, id, quantity });
    }
  };

  await t.test('create-order refuses an empty cart', async () => {
    const res = await http.post('/api/paypal/create-order', { sessionId: 'pp_empty' });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /empty/i);
  });

  await t.test('create-order sends server-computed totals to PayPal', async () => {
    await fillCart('pp_totals', [['p1', 2], ['p2', 1]]);
    const res = await http.post('/api/paypal/create-order', { sessionId: 'pp_totals' });
    assert.equal(res.status, 200);
    const sent = fake.state.orders.get(res.json.orderID);
    assert.equal(sent.purchase_units[0].amount.value, '96.48'); // 2 x 39.99 + 16.50
    assert.equal(sent.purchase_units[0].items.length, 2);
  });

  await t.test('capture before buyer approval returns 422 and keeps the cart', async () => {
    await fillCart('pp_unapproved', [['p1', 1]]);
    const { json } = await http.post('/api/paypal/create-order', { sessionId: 'pp_unapproved' });
    fake.state.captureBehavior.set(json.orderID, 'not-approved');

    const res = await http.post('/api/paypal/capture-order', { sessionId: 'pp_unapproved', orderID: json.orderID });
    assert.equal(res.status, 422);
    const cart = await http.get('/api/cart?sessionId=pp_unapproved');
    assert.equal(cart.json.cart.itemCount, 1);
  });

  await t.test('capture rejects an order ID from another session', async () => {
    await fillCart('pp_owner', [['p1', 1]]);
    const { json } = await http.post('/api/paypal/create-order', { sessionId: 'pp_owner' });
    const res = await http.post('/api/paypal/capture-order', { sessionId: 'pp_attacker', orderID: json.orderID });
    assert.equal(res.status, 400);
  });

  await t.test('successful capture removes only the paid items', async () => {
    const sessionId = 'pp_paid';
    await fillCart(sessionId, [['p1', 1]]);
    const { json } = await http.post('/api/paypal/create-order', { sessionId });
    // Shopper adds a kettle after the order was created
    await fillCart(sessionId, [['p5', 1]]);

    const res = await http.post('/api/paypal/capture-order', { sessionId, orderID: json.orderID });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'COMPLETED');
    assert.equal(res.json.amount, '$39.99', 'amount is what PayPal charged, not the new cart total');

    const cart = await http.get(`/api/cart?sessionId=${sessionId}`);
    assert.deepEqual(cart.json.cart.items.map(i => i.id), ['p5']);
  });

  await t.test('pending capture returns 202, then a verified webhook settles it', async () => {
    const sessionId = 'pp_pending';
    await fillCart(sessionId, [['p2', 2]]);
    const { json } = await http.post('/api/paypal/create-order', { sessionId });
    fake.state.captureBehavior.set(json.orderID, 'pending');

    const capture = await http.post('/api/paypal/capture-order', { sessionId, orderID: json.orderID });
    assert.equal(capture.status, 202);
    assert.equal((await http.get(`/api/cart?sessionId=${sessionId}`)).json.cart.itemCount, 2, 'not paid yet');

    const hook = await http.post('/api/paypal/webhook', captureEvent(json.orderID), webhookHeaders());
    assert.equal(hook.status, 200);
    assert.equal(hook.json.outcome, 'settled');

    // PayPal received the exact headers + configured webhook id for verification
    const verify = fake.state.verifyCalls.at(-1);
    assert.equal(verify.webhook_id, 'WH-TEST');
    assert.equal(verify.transmission_sig, 'valid-sig');

    assert.equal((await http.get(`/api/cart?sessionId=${sessionId}`)).json.cart.itemCount, 0);
    const order = await http.get(`/api/paypal/orders/${json.orderID}?sessionId=${sessionId}`);
    assert.equal(order.json.status, 'COMPLETED');
    assert.equal(order.json.webhookConfirmed, true);
  });

  await t.test('webhook with an invalid signature is rejected and changes nothing', async () => {
    const sessionId = 'pp_forged';
    await fillCart(sessionId, [['p3', 1]]);
    const { json } = await http.post('/api/paypal/create-order', { sessionId });

    const res = await http.post('/api/paypal/webhook', captureEvent(json.orderID), webhookHeaders('forged'));
    assert.equal(res.status, 400);
    const order = await http.get(`/api/paypal/orders/${json.orderID}?sessionId=${sessionId}`);
    assert.notEqual(order.json.status, 'COMPLETED');
    assert.equal((await http.get(`/api/cart?sessionId=${sessionId}`)).json.cart.itemCount, 1);
  });

  await t.test('webhook without PayPal signature headers is rejected', async () => {
    const res = await http.post('/api/paypal/webhook', captureEvent('ORDER-X'));
    assert.equal(res.status, 400);
  });

  await t.test('duplicate webhook deliveries are processed once', async () => {
    const sessionId = 'pp_dupe';
    await fillCart(sessionId, [['p4', 1]]);
    const { json } = await http.post('/api/paypal/create-order', { sessionId });
    const event = captureEvent(json.orderID, 'WH-DUPE-1');

    assert.equal((await http.post('/api/paypal/webhook', event, webhookHeaders())).json.outcome, 'settled');
    await fillCart(sessionId, [['p4', 1]]); // re-added after payment
    assert.equal((await http.post('/api/paypal/webhook', event, webhookHeaders())).json.outcome, 'duplicate');
    assert.equal((await http.get(`/api/cart?sessionId=${sessionId}`)).json.cart.itemCount, 1);
  });

  await t.test('refund webhook updates the order status', async () => {
    const sessionId = 'pp_refund';
    await fillCart(sessionId, [['p1', 1]]);
    const { json } = await http.post('/api/paypal/create-order', { sessionId });
    await http.post('/api/paypal/capture-order', { sessionId, orderID: json.orderID });

    const refund = {
      id: 'WH-REFUND-1',
      event_type: 'PAYMENT.CAPTURE.REFUNDED',
      resource: { id: 'REF-1', supplementary_data: { related_ids: { order_id: json.orderID } } }
    };
    assert.equal((await http.post('/api/paypal/webhook', refund, webhookHeaders())).json.outcome, 'refunded');
    const order = await http.get(`/api/paypal/orders/${json.orderID}?sessionId=${sessionId}`);
    assert.equal(order.json.status, 'REFUNDED');
  });

  await t.test('orders are only visible to their own session', async () => {
    await fillCart('pp_private', [['p1', 1]]);
    const { json } = await http.post('/api/paypal/create-order', { sessionId: 'pp_private' });
    const res = await http.get(`/api/paypal/orders/${json.orderID}?sessionId=someone_else`);
    assert.equal(res.status, 404);
  });

  await t.test('webhook returns 503 when PAYPAL_WEBHOOK_ID is not configured', async () => {
    const saved = process.env.PAYPAL_WEBHOOK_ID;
    process.env.PAYPAL_WEBHOOK_ID = '';
    try {
      const res = await http.post('/api/paypal/webhook', captureEvent('ORDER-1'), webhookHeaders());
      assert.equal(res.status, 503);
    } finally {
      process.env.PAYPAL_WEBHOOK_ID = saved;
    }
  });

  await t.test('missing PayPal credentials give a clear 503', async () => {
    const saved = process.env.PAYPAL_CLIENT_ID;
    process.env.PAYPAL_CLIENT_ID = '';
    resetPayPalStateForTesting();
    try {
      await fillCart('pp_nocreds', [['p1', 1]]);
      const res = await http.post('/api/paypal/create-order', { sessionId: 'pp_nocreds' });
      assert.equal(res.status, 503);
      assert.match(res.json.error, /credentials missing/);
    } finally {
      process.env.PAYPAL_CLIENT_ID = saved;
    }
  });
});

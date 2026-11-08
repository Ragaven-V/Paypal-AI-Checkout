import test from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, listen, api, createFakePayPal } from './helpers.js';

setTestEnv({ SHIPPING_FLAT_CENTS: '599', FREE_SHIPPING_THRESHOLD_CENTS: '5000', TAX_RATE_PERCENT: '8.25' });
const { createApp } = await import('../src/app.js');
const { priceCart } = await import('../src/cart.js');

test('priceCart: shipping threshold and tax rounding in integer cents', () => {
  assert.deepEqual(priceCart(0), { subtotalCents: 0, shippingCents: 0, taxCents: 0, totalCents: 0, freeShippingRemainingCents: 0 });
  // $16.50: flat shipping, 8.25% tax = 136.125 -> 136
  assert.deepEqual(priceCart(1650), { subtotalCents: 1650, shippingCents: 599, taxCents: 136, totalCents: 2385, freeShippingRemainingCents: 3350 });
  // Exactly at the threshold ships free
  assert.equal(priceCart(5000).shippingCents, 0);
  assert.equal(priceCart(4999).shippingCents, 599);
  // Half-cent rounds up: 1000 * 8.25% = 82.5 -> 83
  assert.equal(priceCart(1000).taxCents, 83);
});

test('HTTP: cart, PayPal breakdown and order history carry shipping and tax', async (t) => {
  const fake = createFakePayPal();
  const paypal = await listen(fake.app);
  process.env.PAYPAL_BASE_URL = paypal.url;
  const server = await listen(createApp());
  const http = api(server.url);
  t.after(async () => {
    await server.close();
    await paypal.close();
  });

  const sessionId = 'pricing_s1';
  const shopperId = 'shop_pricing0-1111-2222-3333-444444444444';
  const add = await http.post('/api/cart/add', { sessionId, id: 'p2', quantity: 1 });
  const cart = add.json.cart;
  assert.equal(cart.subtotalFormatted, '$16.50');
  assert.equal(cart.shippingFormatted, '$5.99');
  assert.equal(cart.taxFormatted, '$1.36');
  assert.equal(cart.totalFormatted, '$23.85');
  assert.equal(cart.freeShippingRemainingCents, 3350);

  const { json } = await http.post('/api/paypal/create-order', { sessionId, shopperId });
  const unit = fake.state.orders.get(json.orderID).purchase_units[0];
  assert.equal(unit.amount.value, '23.85');
  assert.deepEqual(
    Object.fromEntries(Object.entries(unit.amount.breakdown).map(([k, v]) => [k, v.value])),
    { item_total: '16.50', shipping: '5.99', tax_total: '1.36' }
  );
  const sum = Object.values(unit.amount.breakdown).reduce((n, v) => n + Math.round(Number(v.value) * 100), 0);
  assert.equal(sum, 2385, 'PayPal requires the breakdown to add up to the amount');

  const capture = await http.post('/api/paypal/capture-order', { sessionId, orderID: json.orderID });
  assert.equal(capture.json.amount, '$23.85');

  const history = await http.get(`/api/orders?shopperId=${shopperId}`);
  const order = history.json.orders[0];
  assert.deepEqual([order.subtotal, order.shipping, order.tax, order.amount], ['$16.50', '$5.99', '$1.36', '$23.85']);

  const config = await http.get('/api/config');
  assert.deepEqual(config.json.pricing, { shippingFlatCents: 599, freeShippingThresholdCents: 5000, taxRatePercent: 8.25 });
});

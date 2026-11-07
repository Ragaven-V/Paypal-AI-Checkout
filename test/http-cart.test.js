import test from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, listen, api } from './helpers.js';

setTestEnv();
const { createApp } = await import('../src/app.js');

test('HTTP: cart and routing', async (t) => {
  const server = await listen(createApp());
  const http = api(server.url);
  t.after(() => server.close());

  await t.test('GET /api/catalog returns products', async () => {
    const res = await http.get('/api/catalog');
    assert.equal(res.status, 200);
    assert.ok(res.json.products.length >= 5);
  });

  await t.test('add, decrement (− button) and remove keep server totals correct', async () => {
    const sessionId = 'cart_flow';
    let res = await http.post('/api/cart/add', { sessionId, id: 'p1', quantity: 3 });
    assert.equal(res.status, 200);
    assert.equal(res.json.item.quantity, 3);

    res = await http.post('/api/cart/add', { sessionId, id: 'p1', quantity: -1 });
    assert.equal(res.json.item.quantity, 2, 'negative quantity must decrement, not add');
    assert.equal(res.json.cart.totalCents, 3999 * 2);

    res = await http.post('/api/cart/add', { sessionId, id: 'p1', quantity: -5 });
    assert.equal(res.json.cart.items.length, 0, 'decrementing past zero removes the item');

    await http.post('/api/cart/add', { sessionId, id: 'p2', quantity: 1 });
    res = await http.post('/api/cart/remove', { sessionId, id: 'p2' });
    assert.equal(res.json.removed, true);

    res = await http.get(`/api/cart?sessionId=${sessionId}`);
    assert.equal(res.json.cart.totalFormatted, '$0.00');
  });

  await t.test('quantity is capped at 10', async () => {
    const res = await http.post('/api/cart/add', { sessionId: 'cart_cap', id: 'p2', quantity: 50 });
    assert.equal(res.json.item.quantity, 10);
  });

  await t.test('rejects bad input with 400', async () => {
    assert.equal((await http.post('/api/cart/add', { id: 'p1' })).status, 400);
    assert.equal((await http.post('/api/cart/add', { sessionId: 'x', id: 'nope' })).status, 400);
    assert.equal((await http.post('/api/cart/add', { sessionId: 'x'.repeat(200), id: 'p1' })).status, 400);
    assert.equal((await http.get('/api/cart')).status, 400);
    assert.equal((await http.post('/api/cart/remove', { sessionId: 'x' })).status, 400);
  });

  await t.test('malformed JSON body returns a JSON 400', async () => {
    const res = await http.post('/api/cart/add', '{not json');
    assert.equal(res.status, 400);
    assert.ok(res.json?.error);
  });

  await t.test('unknown API routes and wrong methods return JSON 404, not the SPA', async () => {
    let res = await http.get('/api/paypal/create-order');
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /json/);
    res = await http.get('/api/does-not-exist');
    assert.equal(res.status, 404);
  });

  await t.test('non-API paths still serve the app', async () => {
    const res = await http.get('/some/page');
    assert.equal(res.status, 200);
    assert.match(res.text, /<html/i);
  });

  await t.test('/api/config never exposes secrets', async () => {
    const res = await http.get('/api/config');
    assert.equal(res.status, 200);
    assert.equal(res.json.paypalClientId, 'test-client-id');
    assert.ok(!res.text.includes('test-client-secret'));
  });
});

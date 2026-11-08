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

  await t.test('POST to a page path returns 404, not the SPA (catches a wrong webhook URL)', async () => {
    const res = await http.post('/', { event_type: 'PAYMENT.CAPTURE.COMPLETED' });
    assert.equal(res.status, 404);
  });

  await t.test('non-API paths still serve the app', async () => {
    const res = await http.get('/some/page');
    assert.equal(res.status, 200);
    assert.match(res.text, /<html/i);
  });

  await t.test('security headers are set on pages and API responses', async () => {
    const page = await http.get('/');
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' https:\/\/\*\.paypal\.com/);
    assert.doesNotMatch(csp.match(/script-src[^;]*/)[0], /unsafe-inline/, 'no inline scripts allowed');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
    assert.equal(page.headers.get('x-powered-by'), null);

    const apiRes = await http.get('/api/catalog');
    assert.equal(apiRes.headers.get('cache-control'), 'no-store');
  });

  await t.test('pages contain no inline scripts (required by the CSP)', async () => {
    for (const path of ['/', '/admin']) {
      const res = await http.get(path);
      const inline = res.text.match(/<script(?![^>]*\ssrc=)[^>]*>/g) || [];
      assert.deepEqual(inline, [], `${path} has inline <script>`);
      assert.doesNotMatch(res.text, /\son[a-z]+="/, `${path} has inline event handlers`);
    }
  });

  await t.test('health check responds', async () => {
    const res = await http.get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  await t.test('static assets: stylesheet, scripts and product images are served', async () => {
    for (const path of ['/css/app.css', '/js/main.js', '/images/products/p1.svg']) {
      assert.equal((await http.get(path)).status, 200, path);
    }
    const catalog = await http.get('/api/catalog');
    assert.ok(catalog.json.products.every(p => p.image && p.image.startsWith('/images/products/')));
  });

  await t.test('/api/config never exposes secrets', async () => {
    const res = await http.get('/api/config');
    assert.equal(res.status, 200);
    assert.equal(res.json.paypalClientId, 'test-client-id');
    assert.ok(!res.text.includes('test-client-secret'));
  });
});

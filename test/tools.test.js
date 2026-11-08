import test from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv } from './helpers.js';

// Use the in-memory test database, never the real one
setTestEnv();
const {
  executeSearchProducts,
  executeAddToCart,
  executeRemoveFromCart,
  executeViewCart,
  getOrCreateSession
} = await import('../server.js');

test('AI Tools Execution', async (t) => {
  await t.test('search_products matches keywords across names, descriptions and tags', () => {
    const coffeeResults = executeSearchProducts('coffee');
    assert.ok(coffeeResults.length > 0);
    assert.ok(coffeeResults.some(p => p.name.includes('Coffee') || p.tags.includes('coffee')));

    const grinderResults = executeSearchProducts('grinder');
    assert.ok(grinderResults.length > 0);
    assert.equal(grinderResults[0].id, 'p1');
  });

  await t.test('search_products respects max_price budget filter', () => {
    const under30 = executeSearchProducts('coffee', 30.00);
    assert.ok(under30.length > 0);
    for (const p of under30) {
      assert.ok(p.price <= 30.00, `Expected ${p.name} ($${p.price}) to be <= $30`);
    }
  });

  await t.test('search_products returns at most 5 products', () => {
    const all = executeSearchProducts('');
    assert.ok(all.length <= 5);
  });

  await t.test('add_to_cart and remove_from_cart update session cart accurately', () => {
    const session = getOrCreateSession('test_tool_session');
    session.cart.clear();

    const addRes = executeAddToCart(session, 'p2', 2);
    assert.equal(addRes.success, true);
    assert.equal(session.cart.get('p2'), 2);

    const viewRes = executeViewCart(session);
    assert.equal(viewRes.success, true);
    assert.equal(viewRes.item_count, 2);
    assert.equal(viewRes.total_cents, 1650 * 2);

    const removeRes = executeRemoveFromCart(session, 'p2');
    assert.equal(removeRes.success, true);
    assert.equal(session.cart.has('p2'), false);
  });

  await t.test('add_to_cart fails gracefully for unknown product ID', () => {
    const session = getOrCreateSession('test_unknown_prod_session');
    const res = executeAddToCart(session, 'unknown_id_999', 1);
    assert.equal(res.success, false);
    assert.ok(res.error.includes('not found'));
  });
});


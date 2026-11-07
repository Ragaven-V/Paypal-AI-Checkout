import test from 'node:test';
import assert from 'node:assert/strict';
import { getOrCreateSession, executeAddToCart, executeRemoveFromCart, getCartSummary, catalog } from '../server.js';

test('Cart Math in Integer Cents', async (t) => {
  await t.test('computes item price and subtotal strictly in integer cents', () => {
    const session = getOrCreateSession('test_math_session_1');
    session.cart.clear();

    // p1: Precision Burr Coffee Grinder ($39.99 -> 3999 cents)
    executeAddToCart(session, 'p1', 2);
    const summary = getCartSummary(session);

    assert.equal(summary.itemCount, 2);
    assert.equal(summary.totalCents, 3999 * 2); // 7998 cents
    assert.equal(summary.totalFormatted, '$79.98');
    assert.equal(summary.items[0].priceInCents, 3999);
    assert.equal(summary.items[0].subtotalInCents, 7998);
  });

  await t.test('handles multi-item carts with fractional cents without float errors', () => {
    const session = getOrCreateSession('test_math_session_2');
    session.cart.clear();

    // p1 ($39.99), p2 ($16.50), p3 ($27.99)
    executeAddToCart(session, 'p1', 1);
    executeAddToCart(session, 'p2', 1);
    executeAddToCart(session, 'p3', 1);

    const summary = getCartSummary(session);
    const expectedCents = 3999 + 1650 + 2799; // 8448 cents

    assert.equal(summary.itemCount, 3);
    assert.equal(summary.totalCents, expectedCents);
    assert.equal(summary.totalFormatted, '$84.48');
  });

  await t.test('clamps quantity strictly between 1 and 10', () => {
    const session = getOrCreateSession('test_clamp_session');
    session.cart.clear();

    // Add with 0 or negative quantity defaults to 1
    executeAddToCart(session, 'p1', -5);
    let summary = getCartSummary(session);
    assert.equal(summary.items[0].quantity, 1);

    // Add with more than 10 clamps total to 10
    executeAddToCart(session, 'p1', 50);
    summary = getCartSummary(session);
    assert.equal(summary.items[0].quantity, 10);
  });

  await t.test('properly removes items and recalculates total to $0.00', () => {
    const session = getOrCreateSession('test_remove_session');
    session.cart.clear();

    executeAddToCart(session, 'p1', 2);
    executeRemoveFromCart(session, 'p1');

    const summary = getCartSummary(session);
    assert.equal(summary.itemCount, 0);
    assert.equal(summary.totalCents, 0);
    assert.equal(summary.totalFormatted, '$0.00');
    assert.equal(summary.items.length, 0);
  });
});


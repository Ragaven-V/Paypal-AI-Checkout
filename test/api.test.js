import test from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv } from './helpers.js';

// Use the in-memory test database, never the real one
setTestEnv();
const {
  app,
  getOrCreateSession,
  runMockAi,
  createPayPalOrder,
  capturePayPalOrder,
  executeAddToCart
} = await import('../server.js');

test('API & Checkout Routes', async (t) => {
  await t.test('createPayPalOrder refuses an empty cart with status 400', async () => {
    const emptySession = getOrCreateSession('test_empty_cart_session');
    emptySession.cart.clear();

    await assert.rejects(
      async () => {
        await createPayPalOrder(emptySession);
      },
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /empty/i);
        return true;
      }
    );
  });

  await t.test('capturePayPalOrder refuses an untrusted or mismatched order ID', async () => {
    const session = getOrCreateSession('test_capture_fraud_session');
    session.currentOrderId = 'EXPECTED_ORDER_123';

    await assert.rejects(
      async () => {
        await capturePayPalOrder(session, 'ATTACKER_SUPPLIED_ORDER_999');
      },
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /Untrusted or invalid order ID/i);
        return true;
      }
    );
  });

  await t.test('runMockAi responds with a friendly greeting without products for "hi"', () => {
    const session = getOrCreateSession('test_greeting_session');
    session.cart.clear();

    const result = runMockAi(session, 'hi');
    assert.match(result.reply, /hello|welcome/i);
    assert.equal(result.products.length, 0);
  });

  await t.test('runMockAi correctly handles recommendation requests', () => {
    const session = getOrCreateSession('test_mock_ai_session');
    session.cart.clear();

    const result = runMockAi(session, 'I need a gift for my dad under $50, he likes coffee');
    assert.ok(result.reply);
    assert.ok(result.products.length > 0);
    // Should have products priced <= 50
    for (const p of result.products) {
      assert.ok(p.price <= 50);
    }
  });

  await t.test('runMockAi correctly handles add to cart intent', () => {
    const session = getOrCreateSession('test_mock_add_session');
    session.cart.clear();

    const result = runMockAi(session, 'add the grinder');
    assert.ok(result.reply.includes('Added'));
    assert.equal(session.cart.has('p1'), true);
    assert.ok(result.cart.itemCount >= 1);
  });

  await t.test('runMockAi correctly handles view cart and remove intent', () => {
    const session = getOrCreateSession('test_mock_cart_session');
    session.cart.clear();
    executeAddToCart(session, 'p2', 1);

    const viewRes = runMockAi(session, 'view my cart');
    assert.ok(viewRes.reply.includes('Ceramic Coffee Mug'));

    const removeRes = runMockAi(session, 'remove the mug');
    assert.ok(removeRes.reply.includes('Removed'));
    assert.equal(session.cart.has('p2'), false);
  });
});


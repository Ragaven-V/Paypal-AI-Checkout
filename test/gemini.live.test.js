// Live end-to-end check against the real Gemini API with the production config.
// Skipped unless GEMINI_LIVE_TEST=1 (needs GEMINI_API_KEY in .env; makes real, billed calls).
//   npm run test:live        (any shell)
//   GEMINI_LIVE_TEST=1 node --test test/gemini.live.test.js                  (bash)
//   $env:GEMINI_LIVE_TEST = "1"; node --test test/gemini.live.test.js         (PowerShell)
import test from 'node:test';
import assert from 'node:assert/strict';
import { listen, api, parseSse } from './helpers.js';

const live = process.env.GEMINI_LIVE_TEST === '1' || process.env.npm_lifecycle_event === 'test:live';

test('LIVE Gemini: chat works without falling back to the mock', { skip: !live && 'set GEMINI_LIVE_TEST=1' }, async (t) => {
  process.env.MOCK_AI = 'false';
  const { createApp } = await import('../src/app.js');
  const { runAiSelfCheck, isAiEnabled } = await import('../src/ai/gemini.js');
  assert.ok(isAiEnabled(), 'GEMINI_API_KEY must be set');

  const check = await runAiSelfCheck();
  assert.equal(check.ok, true, `self-check failed: ${check.error}`);

  const server = await listen(createApp());
  const http = api(server.url);
  t.after(() => server.close());

  const sessionId = `live_${Date.now()}`;
  const res = await http.post('/api/chat', { sessionId, message: 'Please add the coffee grinder to my cart', stream: true });
  const events = parseSse(res.text);
  assert.ok(!events.some(e => e.type === 'notice'), 'fell back to the mock assistant');
  assert.equal(events.filter(e => e.type === 'cart').at(-1).cart.items.find(i => i.id === 'p1')?.quantity, 1);

  // Second turn reuses history containing the earlier functionCall (Gemini 3 requires its thought signature)
  const second = await http.post('/api/chat', { sessionId, message: 'Also add one ceramic mug, then tell me my total.', stream: true });
  const secondEvents = parseSse(second.text);
  assert.ok(!secondEvents.some(e => e.type === 'notice'), 'second turn fell back to the mock assistant');
  const finalCart = secondEvents.filter(e => e.type === 'cart').at(-1).cart;
  assert.equal(finalCart.items.find(i => i.id === 'p1')?.quantity, 1, 'grinder not duplicated');
  assert.equal(finalCart.items.find(i => i.id === 'p2')?.quantity, 1);

  const config = await http.get('/api/config');
  assert.equal(config.json.aiDegraded, false);
});

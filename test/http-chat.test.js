import test from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, listen, api, parseSse, createFakeGemini } from './helpers.js';

setTestEnv({ GEMINI_MODEL: 'gemini-3.5-flash-lite' });
const { createApp } = await import('../src/app.js');
const { setAiClientForTesting, buildThinkingConfig, runAiSelfCheck } = await import('../src/ai/gemini.js');

// Each scripted turn is a list of streamed chunks; each chunk is a list of parts
const text = (t) => [{ text: t }];
const call = (name, args, id) => [{ functionCall: { name, args, id } }];

test('HTTP: chat', async (t) => {
  const server = await listen(createApp());
  const http = api(server.url);
  t.after(async () => {
    setAiClientForTesting(null);
    await server.close();
  });

  await t.test('validates input', async () => {
    assert.equal((await http.post('/api/chat', { message: 'hi' })).status, 400);
    assert.equal((await http.post('/api/chat', { sessionId: 's', message: '   ' })).status, 400);
    assert.equal((await http.post('/api/chat', { sessionId: 's', message: 'x'.repeat(1001) })).status, 400);
  });

  await t.test('mock mode: JSON reply adds to cart', async () => {
    setAiClientForTesting(null);
    const res = await http.post('/api/chat', { sessionId: 'mock_json', message: 'add the grinder' });
    assert.equal(res.status, 200);
    assert.match(res.json.reply, /Added/);
    assert.equal(res.json.cart.items[0].id, 'p1');
  });

  await t.test('mock mode: SSE stream has chunks, cart and done', async () => {
    setAiClientForTesting(null);
    const res = await http.post('/api/chat', { sessionId: 'mock_sse', message: 'coffee gifts under $30', stream: true });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const types = parseSse(res.text).map(e => e.type);
    assert.ok(types.includes('chunk'));
    assert.ok(types.includes('products'));
    assert.equal(types.at(-1), 'done');
  });

  await t.test('mock mode: browsing words like "budget"/"gadget" do not add to cart', async () => {
    setAiClientForTesting(null);
    const res = await http.post('/api/chat', { sessionId: 'mock_get', message: 'show me gadgets on a budget' });
    assert.equal(res.json.cart.items.length, 0);
  });

  await t.test('Gemini: tool call adds exactly once and streams the reply', async () => {
    const fake = createFakeGemini([
      [call('add_to_cart', { product_id: 'p1', quantity: 1 }, 'c1')],
      [text('Added the grinder '), text('to your cart!')]
    ]);
    setAiClientForTesting(fake);

    const res = await http.post('/api/chat', { sessionId: 'gem_tool', message: 'add the grinder', stream: true });
    const events = parseSse(res.text);
    const reply = events.filter(e => e.type === 'chunk').map(e => e.text).join('');
    assert.equal(reply, 'Added the grinder to your cart!');
    assert.equal(events.filter(e => e.type === 'cart').at(-1).cart.items[0].quantity, 1);

    // The function response goes back with the matching id
    const toolReply = fake.calls.messages[1];
    assert.equal(toolReply[0].functionResponse.name, 'add_to_cart');
    assert.equal(toolReply[0].functionResponse.id, 'c1');

    const config = await http.get('/api/config');
    assert.equal(config.json.mockAi, false);
    assert.equal(config.json.aiDegraded, false);
  });

  await t.test('Gemini: parallel tool calls are answered together, in order', async () => {
    const fake = createFakeGemini([
      [[{ functionCall: { name: 'add_to_cart', args: { product_id: 'p2' }, id: 'a' } },
        { functionCall: { name: 'view_cart', args: {}, id: 'b' } }]],
      [text('Done.')]
    ]);
    setAiClientForTesting(fake);
    const res = await http.post('/api/chat', { sessionId: 'gem_parallel', message: 'add a mug and show cart' });
    assert.equal(res.json.reply, 'Done.');
    assert.deepEqual(fake.calls.messages[1].map(p => p.functionResponse.id), ['a', 'b']);
  });

  await t.test('Gemini fails after a tool ran: no duplicate add via the mock fallback', async () => {
    setAiClientForTesting(createFakeGemini([
      [call('add_to_cart', { product_id: 'p1', quantity: 1 }, 'c1')],
      new Error('503 UNAVAILABLE')
    ]));
    const res = await http.post('/api/chat', { sessionId: 'gem_dup', message: 'add the grinder' });
    assert.equal(res.status, 200);
    assert.equal(res.json.cart.items[0].quantity, 1, 'grinder must be added once, not twice');
  });

  await t.test('Gemini fails up front: mock answers AND the failure is visible in /api/config', async () => {
    setAiClientForTesting(createFakeGemini([
      new Error('{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}')
    ]));
    const res = await http.post('/api/chat', { sessionId: 'gem_fail', message: 'hi', stream: true });
    const events = parseSse(res.text);
    assert.ok(events.some(e => e.type === 'notice'), 'stream should carry a fallback notice');

    const config = await http.get('/api/config');
    assert.equal(config.json.aiDegraded, true, 'silent fallback must be reported');
    assert.match(config.json.aiLastError, /INVALID_ARGUMENT/);
  });

  await t.test('quota error (429): instant fallback, then Gemini is skipped during the cooldown', async () => {
    const quota = new Error('{"error":{"code":429,"message":"You exceeded your current quota","status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"45s"}]}}');
    const fake = createFakeGemini([quota, [[{ text: 'should not be used' }]]]);
    setAiClientForTesting(fake);

    const first = await http.post('/api/chat', { sessionId: 'quota_s', message: 'hi', stream: true });
    const notice = parseSse(first.text).find(e => e.type === 'notice');
    assert.match(notice.message, /usage limit/);

    const config = await http.get('/api/config');
    assert.ok(config.json.aiCooldownSeconds >= 40 && config.json.aiCooldownSeconds <= 45, `cooldown ${config.json.aiCooldownSeconds}s`);

    const second = await http.post('/api/chat', { sessionId: 'quota_s2', message: 'add the grinder' });
    assert.match(second.json.notice, /busy right now/);
    assert.equal(second.json.cart.items[0].id, 'p1', 'fallback assistant still serves the shopper');
    assert.equal(fake.calls.messages.length, 1, 'Gemini was not called again during the cooldown');
    setAiClientForTesting(null);
  });

  await t.test('a failed turn resets the chat so the next turn starts clean', async () => {
    const fake = createFakeGemini([new Error('boom'), [text('Hello again!')]]);
    setAiClientForTesting(fake);
    await http.post('/api/chat', { sessionId: 'gem_reset', message: 'hi' });
    const res = await http.post('/api/chat', { sessionId: 'gem_reset', message: 'hi' });
    assert.equal(res.json.reply, 'Hello again!');
    assert.equal(fake.calls.chatsCreated.length, 2, 'a new chat is created after the failure');
  });

  await t.test('chat config never sends thinkingBudget to a Gemini 3 model (root cause of the 400)', async () => {
    const fake = createFakeGemini([[text('ok')]]);
    setAiClientForTesting(fake);
    await http.post('/api/chat', { sessionId: 'gem_cfg', message: 'hi' });
    const cfg = fake.calls.chatsCreated[0].config;
    assert.equal(cfg.thinkingConfig?.thinkingBudget, undefined);
    assert.ok(cfg.systemInstruction && cfg.tools, 'systemInstruction/tools are sent when no cache is used');
    assert.equal(cfg.cachedContent, undefined);
  });

  await t.test('buildThinkingConfig: thinkingLevel for Gemini 3, thinkingBudget only for 2.5', () => {
    assert.equal(buildThinkingConfig('gemini-3.5-flash-lite', ''), undefined);
    assert.equal(buildThinkingConfig('gemini-3.5-flash-lite', 'bogus'), undefined);
    assert.deepEqual(buildThinkingConfig('gemini-3.5-flash-lite', 'low'), { thinkingLevel: 'LOW' });
    assert.deepEqual(buildThinkingConfig('gemini-3-flash-preview', 'minimal'), { thinkingLevel: 'MINIMAL' });
    assert.deepEqual(buildThinkingConfig('gemini-2.5-flash', 'minimal'), { thinkingBudget: 0 });
  });

  await t.test('startup self-check uses the production config', async () => {
    const fake = createFakeGemini([]);
    setAiClientForTesting(fake);
    const result = await runAiSelfCheck();
    assert.equal(result.ok, true);
    const cfg = fake.calls.generateContent[0].config;
    assert.ok(cfg.tools && cfg.systemInstruction);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTestEnv, listen, api } from './helpers.js';

setTestEnv({ RATE_LIMIT_CHAT_PER_MIN: '3', RATE_LIMIT_API_PER_MIN: '8', TRUST_PROXY: '1' });
const { createApp } = await import('../src/app.js');

test('HTTP: per-IP rate limiting', async (t) => {
  const app = createApp();
  const server = await listen(app);
  const http = api(server.url);
  t.after(() => server.close());
  t.beforeEach(() => {
    app.locals.rateLimiters.apiLimiter.reset();
    app.locals.rateLimiters.chatLimiter.reset();
  });

  const chat = (ip, sessionId) =>
    http.post('/api/chat', { sessionId, message: 'hi' }, { 'X-Forwarded-For': ip });

  await t.test('chat is limited per IP even when the session ID changes every request', async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await chat('203.0.113.5', `rotating_${i}`)).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  });

  await t.test('429 carries Retry-After and RateLimit headers', async () => {
    for (let i = 0; i < 3; i++) await chat('203.0.113.6', 's');
    const res = await chat('203.0.113.6', 's');
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    assert.equal(res.headers.get('ratelimit-limit'), '3');
    assert.equal(res.headers.get('ratelimit-remaining'), '0');
  });

  await t.test('different IPs have independent budgets', async () => {
    for (let i = 0; i < 3; i++) await chat('198.51.100.1', 's');
    assert.equal((await chat('198.51.100.1', 's')).status, 429);
    assert.equal((await chat('198.51.100.2', 's')).status, 200);
  });

  await t.test('general API limit covers cart endpoints too', async () => {
    const statuses = [];
    for (let i = 0; i < 9; i++) {
      const res = await http.post('/api/cart/add', { sessionId: `c${i}`, id: 'p1' }, { 'X-Forwarded-For': '192.0.2.9' });
      statuses.push(res.status);
    }
    assert.equal(statuses.filter(s => s === 200).length, 8);
    assert.equal(statuses.at(-1), 429);
  });

  await t.test('PayPal webhooks are not subject to the client rate limit', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await http.post('/api/paypal/webhook', { event_type: 'X' }, { 'X-Forwarded-For': '192.0.2.10' });
      assert.notEqual(res.status, 429);
    }
  });
});

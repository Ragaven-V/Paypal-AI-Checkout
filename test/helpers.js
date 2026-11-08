import express from 'express';

// Must run before the app modules are imported: dotenv never overrides variables that are already set,
// so these keep tests away from the real Gemini and PayPal accounts in .env.
export function setTestEnv(overrides = {}) {
  Object.assign(process.env, {
    MOCK_AI: 'true',
    GEMINI_API_KEY: '',
    PAYPAL_CLIENT_ID: 'test-client-id',
    PAYPAL_CLIENT_SECRET: 'test-client-secret',
    PAYPAL_BASE_URL: 'http://127.0.0.1:1', // replaced once the fake PayPal server is listening
    PAYPAL_WEBHOOK_ID: 'WH-TEST',
    RATE_LIMIT_CHAT_PER_MIN: '1000',
    RATE_LIMIT_API_PER_MIN: '1000',
    DATABASE_PATH: ':memory:',
    // Pricing defaults that keep totals equal to the items sum; pricing tests override these
    SHIPPING_FLAT_CENTS: '0',
    TAX_RATE_PERCENT: '0',
    ...overrides
  });
}

export async function listen(app) {
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

export function api(baseUrl) {
  const request = async (method, path, body, headers = {}) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, json, text };
  };
  return {
    get: (path, headers) => request('GET', path, undefined, headers),
    post: (path, body, headers) => request('POST', path, body, headers)
  };
}

// Parse an SSE body into its JSON events
export function parseSse(text) {
  return text.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => JSON.parse(line.slice(5).trim()));
}

/**
 * Minimal fake of the PayPal REST endpoints this app uses.
 * state.captureBehavior per order id: 'completed' (default) | 'not-approved' | 'pending'
 */
export function createFakePayPal() {
  const state = { orders: new Map(), captureBehavior: new Map(), verifyCalls: [], tokenCalls: 0, nextId: 1 };
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.post('/v1/oauth2/token', (req, res) => {
    state.tokenCalls++;
    if (req.headers.authorization !== 'Basic ' + Buffer.from('test-client-id:test-client-secret').toString('base64')) {
      return res.status(401).json({ error: 'invalid_client' });
    }
    res.json({ access_token: 'fake-token', expires_in: 3600 });
  });

  app.post('/v2/checkout/orders', (req, res) => {
    if (req.headers.authorization !== 'Bearer fake-token') return res.status(401).end();
    const id = `ORDER-${state.nextId++}`;
    state.orders.set(id, req.body);
    res.status(201).json({ id, status: 'CREATED' });
  });

  app.post('/v2/checkout/orders/:id/capture', (req, res) => {
    const { id } = req.params;
    if (!state.orders.has(id)) return res.status(404).json({ name: 'RESOURCE_NOT_FOUND' });
    const behavior = state.captureBehavior.get(id) || 'completed';
    if (behavior === 'not-approved') {
      return res.status(422).json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
    }
    const captureStatus = behavior === 'pending' ? 'PENDING' : 'COMPLETED';
    res.status(201).json({
      id,
      status: 'COMPLETED',
      purchase_units: [{ payments: { captures: [{ id: `CAP-${id}`, status: captureStatus }] } }]
    });
  });

  app.post('/v1/notifications/verify-webhook-signature', (req, res) => {
    state.verifyCalls.push(req.body);
    const ok = req.body.transmission_sig === 'valid-sig' && req.body.webhook_id === 'WH-TEST';
    res.json({ verification_status: ok ? 'SUCCESS' : 'FAILURE' });
  });

  return { app, state };
}

export const webhookHeaders = (sig = 'valid-sig') => ({
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST',
  'paypal-transmission-id': 'tx-1',
  'paypal-transmission-sig': sig,
  'paypal-transmission-time': new Date().toISOString()
});

/**
 * Fake @google/genai client. `script` is a list of turns; each turn is an array of streamed
 * chunks, or an Error to throw. Each sendMessageStream call consumes the next turn.
 */
export function createFakeGemini(script) {
  const calls = { chatsCreated: [], messages: [], generateContent: [] };
  const turns = [...script];

  const chunk = (parts) => ({ candidates: [{ content: { role: 'model', parts } }] });

  const client = {
    calls,
    chats: {
      create(options) {
        calls.chatsCreated.push(options);
        // Like the real SDK: history = initial history + every completed exchange
        const history = structuredClone(options.history || []);
        return {
          getHistory: () => structuredClone(history),
          async sendMessageStream({ message }) {
            calls.messages.push(message);
            const turn = turns.shift();
            if (!turn) throw new Error('Fake Gemini: no scripted turn left');
            if (turn instanceof Error) throw turn;
            const userParts = typeof message === 'string' ? [{ text: message }] : message;
            return (async function* () {
              for (const parts of turn) yield chunk(parts);
              history.push({ role: 'user', parts: userParts }, { role: 'model', parts: turn.flat() });
            })();
          }
        };
      }
    },
    models: {
      async generateContent(options) {
        calls.generateContent.push(options);
        return { text: 'OK' };
      }
    },
    caches: {
      async create() { throw new Error('below minimum token count'); }
    }
  };
  return client;
}

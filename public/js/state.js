// Shared client state: session/shopper IDs, server config, cart and catalog.

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function readStorage(storage, key) {
  try { return storage.getItem(key); } catch { return null; }
}

function writeStorage(storage, key, value) {
  try { storage.setItem(key, value); } catch { /* storage blocked: keep in memory */ }
}

const SESSION_KEY = 'ai_checkout_session';
const SHOPPER_KEY = 'ai_checkout_shopper';
const SHOPPER_RE = /^shop_[A-Za-z0-9-]{16,64}$/;

// Session: one shopping session (cart + chat), kept for this tab
let sessionId = readStorage(sessionStorage, SESSION_KEY);
if (!sessionId) {
  sessionId = 'sess_' + randomId();
  writeStorage(sessionStorage, SESSION_KEY, sessionId);
}

// Shopper: long-lived browser ID for order history; survives new sessions and reloads
let shopperId = readStorage(localStorage, SHOPPER_KEY);
if (!shopperId || !SHOPPER_RE.test(shopperId)) {
  shopperId = 'shop_' + randomId();
  writeStorage(localStorage, SHOPPER_KEY, shopperId);
}

export const state = {
  sessionId,
  shopperId,
  config: { paypalClientId: '', mockAi: true, aiDegraded: false, modelName: '' },
  cart: { items: [], itemCount: 0, totalCents: 0, totalFormatted: '$0.00' },
  catalog: [],
  user: null, // { id, email } when signed in
  catalogById: new Map()
};

export function startNewSession() {
  state.sessionId = 'sess_' + randomId();
  writeStorage(sessionStorage, SESSION_KEY, state.sessionId);
}

export function setCatalog(products) {
  state.catalog = products;
  state.catalogById = new Map(products.map(p => [p.id, p]));
}

export const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;

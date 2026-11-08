import crypto from 'crypto';
import { sessionStore, cartStore, chatStore, authSessionStore } from './db.js';
import { log } from './logger.js';

/**
 * Sessions are cached in memory and backed by SQLite, so carts and chats survive restarts.
 * The in-memory cache only saves reads; every cart change is written through immediately.
 */
export const sessions = new Map();

const CACHE_IDLE_MS = 2 * 60 * 60 * 1000;      // drop from memory after 2h idle (still in the DB)
const DB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // delete abandoned sessions after 30 days
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Map-like cart (productId -> quantity) that persists every change to the database.
 * Callers keep using set/delete/clear/get/entries exactly like a Map.
 */
export class PersistentCart {
  constructor(sessionId, entries = []) {
    this.sessionId = sessionId;
    this.items = new Map(entries);
  }

  get size() { return this.items.size; }
  get(productId) { return this.items.get(productId); }
  has(productId) { return this.items.has(productId); }
  entries() { return this.items.entries(); }
  keys() { return this.items.keys(); }
  values() { return this.items.values(); }
  [Symbol.iterator]() { return this.items[Symbol.iterator](); }

  set(productId, quantity) {
    this.items.set(productId, quantity);
    cartStore.set(this.sessionId, productId, quantity);
    return this;
  }

  delete(productId) {
    const existed = this.items.delete(productId);
    if (existed) cartStore.delete(this.sessionId, productId);
    return existed;
  }

  clear() {
    this.items.clear();
    cartStore.clear(this.sessionId);
  }
}

// userId: the signed-in account for this request, or null for a guest. Leave it out (cart,
// checkout and webhook calls) to keep the value set by the last chat request: overwriting it
// with null mid-turn would make the assistant's order tools lose the account.
export function getOrCreateSession(sessionId, { shopperId = null, userId } = {}) {
  if (!sessionId || typeof sessionId !== 'string') {
    sessionId = 'session_' + crypto.randomUUID();
  }

  let session = sessions.get(sessionId);
  if (!session) {
    // Restore from the database (or start fresh)
    const row = sessionStore.get(sessionId);
    session = {
      id: sessionId,
      shopperId: shopperId || row?.shopper_id || null,
      // Signed-in account (set fresh by each chat request, so sign-out takes effect at once)
      userId: userId ?? null,
      cart: new PersistentCart(sessionId, row ? cartStore.load(sessionId) : []),
      chat: null,
      // Saved Gemini history; turned back into a live chat on the next message
      savedHistory: row ? chatStore.loadHistory(sessionId) : null,
      currentOrderId: null,
      lastActive: Date.now()
    };
    sessions.set(sessionId, session);
    sessionStore.touch(sessionId, session.shopperId);
  } else {
    session.lastActive = Date.now();
    if (userId !== undefined) session.userId = userId;
    if (shopperId && session.shopperId !== shopperId) {
      session.shopperId = shopperId;
    }
    sessionStore.touch(sessionId, shopperId);
  }
  return session;
}

/**
 * Run chat turns for one session one at a time. A turn is several Gemini sends (message,
 * tool responses...); two interleaved turns would put one turn's tool responses after the
 * other's message, which Gemini rejects.
 */
export async function withSessionTurn(session, fn) {
  const previous = session.turnQueue || Promise.resolve();
  let release;
  const mine = new Promise(resolve => { release = resolve; });
  session.turnQueue = previous.then(() => mine);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

// Periodic cleanup: evict idle sessions from memory and prune long-abandoned ones from the DB
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActive > CACHE_IDLE_MS) {
      sessions.delete(id);
    }
  }
  try {
    sessionStore.pruneOlderThan(DB_RETENTION_MS);
    authSessionStore.deleteExpired();
  } catch (err) {
    log.error('Session prune failed:', err.message);
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

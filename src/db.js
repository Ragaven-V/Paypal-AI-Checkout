import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from './config.js';

/**
 * Durable store (orders, webhook events, sessions, carts, chats, users) on SQLite via the
 * stable better-sqlite3 driver. DATABASE_PATH: file path (default ./data/ai-checkout.db)
 * or ':memory:' (used by tests). One server process owns the file (WAL mode).
 */
let db = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS orders (
    order_id          TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    items_json        TEXT NOT NULL,
    total_cents       INTEGER NOT NULL,
    total_formatted   TEXT NOT NULL,
    status            TEXT NOT NULL,
    capture_id        TEXT,
    settled           INTEGER NOT NULL DEFAULT 0,
    webhook_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_session_idx ON orders (session_id);

  -- Shopping sessions (one per browser tab session), with their carts and chats
  CREATE TABLE IF NOT EXISTS sessions (
    session_id  TEXT PRIMARY KEY,
    shopper_id  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cart_items (
    session_id  TEXT NOT NULL,
    product_id  TEXT NOT NULL,
    quantity    INTEGER NOT NULL,
    PRIMARY KEY (session_id, product_id)
  );

  -- Visible chat transcript, so the conversation is still on screen after a reload or restart
  CREATE TABLE IF NOT EXISTS chat_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    role          TEXT NOT NULL,
    text          TEXT NOT NULL,
    products_json TEXT,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chat_messages_session_idx ON chat_messages (session_id, id);

  -- Gemini conversation state (Content[] incl. thought signatures) to resume the model's context
  CREATE TABLE IF NOT EXISTS chat_history (
    session_id    TEXT PRIMARY KEY,
    history_json  TEXT NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  -- Customer accounts (email + scrypt password hash) and their login sessions
  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    last_login_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id);

  CREATE TABLE IF NOT EXISTS webhook_events (
    event_id    TEXT PRIMARY KEY,
    event_type  TEXT NOT NULL,
    order_id    TEXT,
    outcome     TEXT,
    received_at INTEGER NOT NULL
  );
`;

export function getDb() {
  if (db) return db;
  const file = config.databasePath;
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Add columns introduced after the first release to existing databases
function migrate(database) {
  const columns = new Set(database.prepare('PRAGMA table_info(orders)').all().map(c => c.name));
  if (!columns.has('shopper_id')) {
    // Long-lived browser ID that survives "Start New Shopping Session", used for order history
    database.exec('ALTER TABLE orders ADD COLUMN shopper_id TEXT');
  }
  if (!columns.has('lines_json')) {
    // Line items as charged: [{ id, name, quantity, priceInCents, subtotalInCents }]
    database.exec('ALTER TABLE orders ADD COLUMN lines_json TEXT');
  }
  if (!columns.has('subtotal_cents')) {
    // Checkout breakdown (items, shipping, tax); total_cents is the grand total charged
    database.exec('ALTER TABLE orders ADD COLUMN subtotal_cents INTEGER');
    database.exec('ALTER TABLE orders ADD COLUMN shipping_cents INTEGER NOT NULL DEFAULT 0');
    database.exec('ALTER TABLE orders ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.has('user_id')) {
    database.exec('ALTER TABLE orders ADD COLUMN user_id INTEGER');
  }
  database.exec('CREATE INDEX IF NOT EXISTS orders_shopper_idx ON orders (shopper_id)');
  database.exec('CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id)');
}

// Run fn inside one SQLite transaction (all or nothing). fn must be synchronous.
export function inTransaction(fn) {
  return getDb().transaction(fn)();
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Readiness probe: true when the database answers a trivial query
export function isDbHealthy() {
  try {
    return getDb().prepare('SELECT 1 AS ok').get().ok === 1;
  } catch {
    return false;
  }
}

/**
 * Online backup to <dir>/ai-checkout-<timestamp>.db, keeping the newest `keep` files.
 * Safe while the app is serving requests (SQLite backup API).
 */
export async function backupDatabase(dir, keep = 7) {
  if (config.databasePath === ':memory:') return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ai-checkout-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  await getDb().backup(file);
  const backups = fs.readdirSync(dir).filter(f => /^ai-checkout-.*\.db$/.test(f)).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    fs.rmSync(path.join(dir, old), { force: true });
  }
  return file;
}

const toRecord = (row) => row && {
  orderId: row.order_id,
  sessionId: row.session_id,
  shopperId: row.shopper_id ?? null,
  items: new Map(JSON.parse(row.items_json)),
  lines: row.lines_json ? JSON.parse(row.lines_json) : null,
  userId: row.user_id ?? null,
  // Older orders have no breakdown: their total was the items subtotal
  subtotalCents: row.subtotal_cents ?? row.total_cents,
  shippingCents: row.shipping_cents ?? 0,
  taxCents: row.tax_cents ?? 0,
  totalCents: row.total_cents,
  totalFormatted: row.total_formatted,
  status: row.status,
  captureId: row.capture_id,
  settled: Boolean(row.settled),
  webhookConfirmed: Boolean(row.webhook_confirmed),
  createdAt: row.created_at,
  updatedAt: row.updated_at
};

export const orderStore = {
  insert(record) {
    const now = Date.now();
    getDb().prepare(`
      INSERT INTO orders (order_id, session_id, shopper_id, user_id, items_json, lines_json, total_cents,
                          total_formatted, subtotal_cents, shipping_cents, tax_cents,
                          status, capture_id, settled, webhook_confirmed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).run(record.orderId, record.sessionId, record.shopperId ?? null, record.userId ?? null,
      JSON.stringify([...record.items]), record.lines ? JSON.stringify(record.lines) : null,
      record.totalCents, record.totalFormatted, record.subtotalCents ?? record.totalCents,
      record.shippingCents ?? 0, record.taxCents ?? 0, record.status, record.captureId ?? null, now, now);
    return this.get(record.orderId);
  },

  get(orderId) {
    return toRecord(getDb().prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId));
  },

  // Persist the mutable fields of a record. settled and webhook_confirmed only ever go from
  // 0 to 1, so saving a copy loaded before a concurrent webhook can't undo what it recorded.
  save(record) {
    record.updatedAt = Date.now();
    getDb().prepare(`
      UPDATE orders SET status = ?, capture_id = COALESCE(?, capture_id), settled = MAX(settled, ?),
                        webhook_confirmed = MAX(webhook_confirmed, ?), updated_at = ?
      WHERE order_id = ?
    `).run(record.status, record.captureId ?? null, record.settled ? 1 : 0,
      record.webhookConfirmed ? 1 : 0, record.updatedAt, record.orderId);
    return record;
  },

  // Atomically mark an order paid. True only for the one caller that actually flipped it,
  // so the capture route and the webhook can't both settle (and empty the cart) twice.
  claimSettlement(orderId) {
    return getDb().prepare(`
      UPDATE orders SET settled = 1, status = 'COMPLETED', updated_at = ? WHERE order_id = ? AND settled = 0
    `).run(Date.now(), orderId).changes === 1;
  },

  listBySession(sessionId) {
    return getDb().prepare('SELECT * FROM orders WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId).map(toRecord);
  },

  listForUser(userId, limit = 50) {
    return getDb().prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit).map(toRecord);
  },

  // Attach guest orders (same browser shopper ID or session) to an account; returns how many
  linkToUser(userId, shopperId, sessionId) {
    return getDb().prepare(`
      UPDATE orders SET user_id = ?
      WHERE user_id IS NULL AND ((? IS NOT NULL AND shopper_id = ?) OR (? IS NOT NULL AND session_id = ?))
    `).run(userId, shopperId ?? null, shopperId ?? null, sessionId ?? null, sessionId ?? null).changes;
  },

  // A shopper's orders (plus any from their current session that predate shopper IDs)
  listForShopper(shopperId, sessionId, limit = 50) {
    return getDb().prepare(`
      SELECT * FROM orders
      WHERE user_id IS NULL AND (shopper_id = ? OR (session_id = ? AND shopper_id IS NULL))
      ORDER BY created_at DESC LIMIT ?
    `).all(shopperId, sessionId ?? '', limit).map(toRecord);
  },

  // All orders for the admin view, optionally filtered by status
  listAll({ status = null, limit = 100, offset = 0 } = {}) {
    const where = status ? 'WHERE status = ?' : '';
    const params = status ? [status] : [];
    const rows = getDb().prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset).map(toRecord);
    const { total } = getDb().prepare(`SELECT COUNT(*) AS total FROM orders ${where}`).get(...params);
    return { orders: rows, total };
  },

  summary() {
    return getDb().prepare(`
      SELECT status, COUNT(*) AS count, SUM(total_cents) AS cents FROM orders GROUP BY status
    `).all();
  }
};

export const webhookEventStore = {
  // Returns false if this event id was already recorded (duplicate delivery)
  tryInsert(eventId, eventType, orderId) {
    const result = getDb().prepare(`
      INSERT OR IGNORE INTO webhook_events (event_id, event_type, order_id, received_at) VALUES (?, ?, ?, ?)
    `).run(eventId, eventType, orderId ?? null, Date.now());
    return result.changes === 1;
  },

  setOutcome(eventId, outcome) {
    getDb().prepare('UPDATE webhook_events SET outcome = ? WHERE event_id = ?').run(outcome, eventId);
  }
};

export const sessionStore = {
  // Upsert a session row; shopperId is kept once known
  touch(sessionId, shopperId = null) {
    const now = Date.now();
    getDb().prepare(`
      INSERT INTO sessions (session_id, shopper_id, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET
        shopper_id = COALESCE(excluded.shopper_id, sessions.shopper_id),
        updated_at = excluded.updated_at
    `).run(sessionId, shopperId, now, now);
  },

  get(sessionId) {
    return getDb().prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) || null;
  },

  // Remove sessions (and their carts/chats) idle for longer than maxAgeMs
  pruneOlderThan(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    const db = getDb();
    const stale = `SELECT session_id FROM sessions WHERE updated_at < ${Number(cutoff)}`;
    db.exec(`
      DELETE FROM cart_items WHERE session_id IN (${stale});
      DELETE FROM chat_messages WHERE session_id IN (${stale});
      DELETE FROM chat_history WHERE session_id IN (${stale});
      DELETE FROM sessions WHERE updated_at < ${Number(cutoff)};
    `);
  }
};

export const cartStore = {
  load(sessionId) {
    return getDb().prepare('SELECT product_id, quantity FROM cart_items WHERE session_id = ?')
      .all(sessionId).map(r => [r.product_id, r.quantity]);
  },

  set(sessionId, productId, quantity) {
    getDb().prepare(`
      INSERT INTO cart_items (session_id, product_id, quantity) VALUES (?, ?, ?)
      ON CONFLICT (session_id, product_id) DO UPDATE SET quantity = excluded.quantity
    `).run(sessionId, productId, quantity);
  },

  delete(sessionId, productId) {
    getDb().prepare('DELETE FROM cart_items WHERE session_id = ? AND product_id = ?').run(sessionId, productId);
  },

  clear(sessionId) {
    getDb().prepare('DELETE FROM cart_items WHERE session_id = ?').run(sessionId);
  }
};

const MAX_TRANSCRIPT = 200;

export const chatStore = {
  addMessage(sessionId, role, text, products = []) {
    const db = getDb();
    db.prepare(`INSERT INTO chat_messages (session_id, role, text, products_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(sessionId, role, text, products.length ? JSON.stringify(products.map(p => p.id)) : null, Date.now());
    // Keep the transcript bounded per session
    db.prepare(`
      DELETE FROM chat_messages WHERE session_id = ? AND id NOT IN (
        SELECT id FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(sessionId, sessionId, MAX_TRANSCRIPT);
  },

  // Most recent messages, oldest first. productIds are resolved by the caller.
  listMessages(sessionId, limit = 50) {
    return getDb().prepare(`
      SELECT role, text, products_json, created_at FROM (
        SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(sessionId, limit).map(r => ({
      role: r.role,
      text: r.text,
      productIds: r.products_json ? JSON.parse(r.products_json) : [],
      createdAt: r.created_at
    }));
  },

  saveHistory(sessionId, history) {
    getDb().prepare(`
      INSERT INTO chat_history (session_id, history_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (session_id) DO UPDATE SET history_json = excluded.history_json, updated_at = excluded.updated_at
    `).run(sessionId, JSON.stringify(history), Date.now());
  },

  loadHistory(sessionId) {
    const row = getDb().prepare('SELECT history_json FROM chat_history WHERE session_id = ?').get(sessionId);
    return row ? JSON.parse(row.history_json) : null;
  },

  clearHistory(sessionId) {
    getDb().prepare('DELETE FROM chat_history WHERE session_id = ?').run(sessionId);
  }
};

export const userStore = {
  create(email, passwordHash) {
    const result = getDb().prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
      .run(email, passwordHash, Date.now());
    return this.getById(Number(result.lastInsertRowid));
  },
  getByEmail(email) {
    return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) || null;
  },
  getById(id) {
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  },
  touchLogin(id) {
    getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), id);
  }
};

export const authSessionStore = {
  create(tokenHash, userId, expiresAt) {
    getDb().prepare('INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, Date.now(), expiresAt);
  },
  // The user for a valid, unexpired session token hash
  getUser(tokenHash) {
    return getDb().prepare(`
      SELECT u.id, u.email FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(tokenHash, Date.now()) || null;
  },
  delete(tokenHash) {
    getDb().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
  },
  deleteExpired() {
    getDb().prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
  }
};

export function clearAllForTesting() {
  getDb().exec(`DELETE FROM orders; DELETE FROM webhook_events; DELETE FROM sessions;
    DELETE FROM cart_items; DELETE FROM chat_messages; DELETE FROM chat_history;
    DELETE FROM auth_sessions; DELETE FROM users;`);
}

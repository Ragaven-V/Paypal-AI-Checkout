import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

/**
 * Durable order + webhook-event store on Node's built-in SQLite (node:sqlite, Node >= 22.13).
 * DATABASE_PATH: file path (default ./data/ai-checkout.db) or ':memory:' (used by tests).
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
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
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
  database.exec('CREATE INDEX IF NOT EXISTS orders_shopper_idx ON orders (shopper_id)');
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

const toRecord = (row) => row && {
  orderId: row.order_id,
  sessionId: row.session_id,
  shopperId: row.shopper_id ?? null,
  items: new Map(JSON.parse(row.items_json)),
  lines: row.lines_json ? JSON.parse(row.lines_json) : null,
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
      INSERT INTO orders (order_id, session_id, shopper_id, items_json, lines_json, total_cents, total_formatted,
                          status, capture_id, settled, webhook_confirmed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).run(record.orderId, record.sessionId, record.shopperId ?? null, JSON.stringify([...record.items]),
      record.lines ? JSON.stringify(record.lines) : null, record.totalCents, record.totalFormatted,
      record.status, record.captureId ?? null, now, now);
    return this.get(record.orderId);
  },

  get(orderId) {
    return toRecord(getDb().prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId));
  },

  // Persist the mutable fields of a record
  save(record) {
    record.updatedAt = Date.now();
    getDb().prepare(`
      UPDATE orders SET status = ?, capture_id = ?, settled = ?, webhook_confirmed = ?, updated_at = ?
      WHERE order_id = ?
    `).run(record.status, record.captureId ?? null, record.settled ? 1 : 0,
      record.webhookConfirmed ? 1 : 0, record.updatedAt, record.orderId);
    return record;
  },

  listBySession(sessionId) {
    return getDb().prepare('SELECT * FROM orders WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId).map(toRecord);
  },

  // A shopper's orders (plus any from their current session that predate shopper IDs)
  listForShopper(shopperId, sessionId, limit = 50) {
    return getDb().prepare(`
      SELECT * FROM orders WHERE shopper_id = ? OR (session_id = ? AND shopper_id IS NULL)
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

export function clearAllForTesting() {
  getDb().exec('DELETE FROM orders; DELETE FROM webhook_events;');
}

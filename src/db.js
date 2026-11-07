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
  return db;
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
  items: new Map(JSON.parse(row.items_json)),
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
      INSERT INTO orders (order_id, session_id, items_json, total_cents, total_formatted, status,
                          capture_id, settled, webhook_confirmed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).run(record.orderId, record.sessionId, JSON.stringify([...record.items]), record.totalCents,
      record.totalFormatted, record.status, record.captureId ?? null, now, now);
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

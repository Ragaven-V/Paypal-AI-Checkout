import crypto from 'crypto';
import { catalogMap } from './catalog.js';
import { orderStore } from './db.js';
import { config } from './config.js';

const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;

// Shopper IDs are random, browser-generated bearer IDs ("shop_" + UUID)
export const isValidShopperId = (id) => typeof id === 'string' && /^shop_[A-Za-z0-9-]{16,64}$/.test(id);

// Friendly status shown to shoppers
const STATUS_LABELS = {
  CREATED: 'Not paid',
  APPROVED: 'Approved, awaiting capture',
  PENDING: 'Payment pending',
  COMPLETED: 'Paid',
  DENIED: 'Payment denied',
  REFUNDED: 'Refunded',
  REVERSED: 'Reversed'
};

// Orders created before line items were stored: rebuild lines from the catalog (current prices)
function linesFor(record) {
  if (record.lines) return record.lines;
  return [...record.items].map(([id, quantity]) => {
    const product = catalogMap.get(id);
    const priceInCents = product ? Math.round(product.price * 100) : 0;
    return { id, name: product?.name || id, quantity, priceInCents, subtotalInCents: priceInCents * quantity };
  });
}

export function toPublicOrder(record) {
  const lines = linesFor(record).map(l => ({
    ...l,
    price: formatCents(l.priceInCents),
    subtotal: formatCents(l.subtotalInCents)
  }));
  return {
    orderID: record.orderId,
    status: record.status,
    statusLabel: STATUS_LABELS[record.status] || record.status,
    paid: record.settled,
    amount: record.totalFormatted,
    totalCents: record.totalCents,
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    lines,
    captureId: record.captureId,
    webhookConfirmed: record.webhookConfirmed,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString()
  };
}

/**
 * A shopper's order history. Unpaid checkouts (CREATED) are hidden unless includeUnpaid,
 * since every click on the PayPal button creates one.
 */
export function getShopperOrders(shopperId, sessionId, { includeUnpaid = false } = {}) {
  return orderStore.listForShopper(shopperId, sessionId)
    .filter(r => includeUnpaid || r.status !== 'CREATED')
    .map(toPublicOrder);
}

export function getAdminOrders({ status, limit, offset }) {
  const { orders, total } = orderStore.listAll({ status, limit, offset });
  const summary = orderStore.summary().map(s => ({
    status: s.status,
    statusLabel: STATUS_LABELS[s.status] || s.status,
    count: s.count,
    total: formatCents(s.cents || 0)
  }));
  return {
    total,
    summary,
    orders: orders.map(r => ({ ...toPublicOrder(r), sessionId: r.sessionId, shopperId: r.shopperId }))
  };
}

// Constant-time check of the admin token (ADMIN_TOKEN in .env). Admin is disabled when unset.
export function isAdminRequest(req) {
  const expected = config.adminToken;
  if (!expected) return false;
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b) && given.length > 0;
}

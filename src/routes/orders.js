import { Router } from 'express';
import { config } from '../config.js';
import { getShopperOrders, getUserOrders, getAdminOrders, isAdminRequest, isValidShopperId } from '../orders.js';
import { isValidSessionId } from './api.js';

const ADMIN_STATUSES = new Set(['CREATED', 'APPROVED', 'PENDING', 'COMPLETED', 'DENIED', 'REFUNDED', 'REVERSED']);

export function createOrdersRouter({ adminLimiter }) {
  const router = Router();

  // Shopper order history: GET /api/orders?shopperId=...&sessionId=...&includeUnpaid=1
  router.get('/orders', (req, res) => {
    const { shopperId, sessionId, includeUnpaid } = req.query;
    if (req.user) {
      return res.json({ orders: getUserOrders(req.user.id, { includeUnpaid: includeUnpaid === '1' }), account: true });
    }
    if (!isValidShopperId(shopperId)) {
      return res.status(400).json({ error: 'Valid shopperId is required' });
    }
    if (sessionId !== undefined && !isValidSessionId(sessionId)) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }
    res.json({ orders: getShopperOrders(shopperId, sessionId, { includeUnpaid: includeUnpaid === '1' }) });
  });

  // Admin: all orders. Authorization: Bearer <ADMIN_TOKEN>
  router.get('/admin/orders', adminLimiter, (req, res) => {
    if (!config.adminToken) {
      return res.status(503).json({ error: 'Admin is disabled. Set ADMIN_TOKEN in .env and restart.' });
    }
    if (!isAdminRequest(req)) {
      return res.status(401).json({ error: 'Invalid admin password' });
    }

    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : null;
    if (status && !ADMIN_STATUSES.has(status)) {
      return res.status(400).json({ error: 'Unknown status filter' });
    }
    // Whole numbers only: SQLite rejects a fractional LIMIT/OFFSET ("datatype mismatch")
    const limit = Math.min(200, Math.max(1, Math.floor(Number(req.query.limit)) || 50));
    const offset = Math.max(0, Math.floor(Number(req.query.offset)) || 0);
    res.json(getAdminOrders({ status, limit, offset }));
  });

  return router;
}

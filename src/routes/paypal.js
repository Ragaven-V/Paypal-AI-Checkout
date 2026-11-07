import { Router } from 'express';
import { getOrCreateSession } from '../sessions.js';
import {
  createPayPalOrder,
  capturePayPalOrder,
  getOrderForSession,
  verifyWebhookSignature,
  handleWebhookEvent
} from '../paypal.js';
import { isValidSessionId } from './api.js';

export function createPayPalRouter() {
  const router = Router();

  router.post('/create-order', async (req, res) => {
    const { sessionId } = req.body || {};
    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({ error: 'Valid sessionId is required' });
    }
    try {
      const order = await createPayPalOrder(getOrCreateSession(sessionId));
      res.json({ orderID: order.id });
    } catch (err) {
      console.error('Failed to create PayPal order:', err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/capture-order', async (req, res) => {
    const { sessionId, orderID } = req.body || {};
    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({ error: 'Valid sessionId is required' });
    }
    if (typeof orderID !== 'string' || !orderID) {
      return res.status(400).json({ error: 'Valid orderID is required' });
    }

    try {
      const { captureData, record } = await capturePayPalOrder(getOrCreateSession(sessionId), orderID);
      if (record.status !== 'COMPLETED') {
        // 202: accepted but not yet paid (e.g. PENDING review); the webhook settles it later
        return res.status(record.status === 'PENDING' ? 202 : 402).json({
          success: false,
          status: record.status,
          orderID,
          error: record.status === 'PENDING'
            ? 'Payment is pending review by PayPal. Your cart will update once it completes.'
            : `Payment not completed (status: ${record.status}).`
        });
      }
      res.json({
        success: true,
        status: record.status,
        orderID: captureData.id,
        amount: record.totalFormatted,
        captureId: record.captureId
      });
    } catch (err) {
      console.error('Failed to capture PayPal order:', err.message);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.get('/orders/:orderID', (req, res) => {
    const { sessionId } = req.query;
    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({ error: 'Valid sessionId is required' });
    }
    const order = getOrderForSession(getOrCreateSession(sessionId), req.params.orderID);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    res.json(order);
  });

  return router;
}

// PayPal webhook: verified with PayPal before anything is trusted
export async function paypalWebhookHandler(req, res) {
  const event = req.body;
  if (!event || typeof event !== 'object' || !event.event_type) {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  try {
    const verified = await verifyWebhookSignature(req.headers, event);
    if (!verified) {
      console.warn('Rejected PayPal webhook with invalid signature:', event.id);
      return res.status(400).json({ error: 'Webhook signature verification failed' });
    }
    const outcome = handleWebhookEvent(event);
    console.log(`PayPal webhook ${event.event_type} (${event.id}): ${outcome}`);
    res.json({ received: true, outcome });
  } catch (err) {
    console.error('PayPal webhook error:', err.message);
    // Non-2xx makes PayPal retry later
    res.status(err.status || 500).json({ error: err.message });
  }
}

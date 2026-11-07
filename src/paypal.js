import { config } from './config.js';
import { getCartSummary, removePaidItems } from './cart.js';
import { sessions } from './sessions.js';

let cachedToken = null;

/**
 * Orders created through this server, keyed by PayPal order ID.
 * { orderId, sessionId, items: Map(productId -> qty), totalFormatted, status, captureId,
 *   settled, webhookConfirmed, createdAt, updatedAt }
 * In-memory: lost on restart (swap for a database in production).
 */
export const orders = new Map();
const processedWebhookEvents = new Set();

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function resetPayPalStateForTesting() {
  cachedToken = null;
  orders.clear();
  processedWebhookEvents.clear();
}

export async function getPayPalAccessToken() {
  if (!config.paypalClientId || !config.paypalClientSecret) {
    throw httpError('PayPal credentials missing: please set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env', 503);
  }

  if (cachedToken && cachedToken.baseUrl === config.paypalBaseUrl && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.token;
  }

  const auth = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString('base64');
  const res = await fetch(`${config.paypalBaseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) {
    console.error(`PayPal OAuth failed (${res.status}):`, await res.text());
    throw httpError('Could not authenticate with PayPal.', 502);
  }

  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    baseUrl: config.paypalBaseUrl,
    expiresAt: Date.now() + ((data.expires_in || 3600) * 1000)
  };
  return cachedToken.token;
}

async function paypalFetch(path, options = {}) {
  const token = await getPayPalAccessToken();
  return fetch(`${config.paypalBaseUrl}${path}`, {
    ...options,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
}

export async function createPayPalOrder(session) {
  const summary = getCartSummary(session);
  if (summary.items.length === 0) {
    throw httpError('Your cart is empty. Please add items before checking out.', 400);
  }

  const total = (summary.totalCents / 100).toFixed(2);
  const purchaseUnit = {
    reference_id: session.id,
    description: 'Ask & Buy Order Checkout',
    amount: {
      currency_code: 'USD',
      value: total,
      breakdown: { item_total: { currency_code: 'USD', value: total } }
    },
    items: summary.items.map(item => ({
      name: item.name.slice(0, 127),
      unit_amount: { currency_code: 'USD', value: (item.priceInCents / 100).toFixed(2) },
      quantity: String(item.quantity)
    }))
  };

  const res = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify({ intent: 'CAPTURE', purchase_units: [purchaseUnit] })
  });

  if (!res.ok) {
    console.error(`PayPal order creation failed (${res.status}):`, await res.text());
    throw httpError('PayPal could not create the order. Please try again.', 502);
  }

  const order = await res.json();
  session.currentOrderId = order.id;
  orders.set(order.id, {
    orderId: order.id,
    sessionId: session.id,
    // Snapshot exactly what this order charges for, so settlement only removes paid items
    items: new Map(summary.items.map(i => [i.id, i.quantity])),
    totalFormatted: summary.totalFormatted,
    status: order.status || 'CREATED',
    captureId: null,
    settled: false,
    webhookConfirmed: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  return order;
}

// Mark an order paid and remove its items from the session cart (idempotent)
function settleOrder(record) {
  if (record.settled) return;
  record.settled = true;
  record.status = 'COMPLETED';
  record.updatedAt = Date.now();
  const session = sessions.get(record.sessionId);
  if (session) {
    removePaidItems(session, record.items);
    if (session.currentOrderId === record.orderId) {
      session.currentOrderId = null;
    }
  }
}

export async function capturePayPalOrder(session, orderID) {
  const record = orders.get(orderID);
  if (!session.currentOrderId || session.currentOrderId !== orderID || !record || record.sessionId !== session.id) {
    throw httpError('Untrusted or invalid order ID for this session.', 400);
  }

  const res = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.text();
    console.error(`PayPal capture failed (${res.status}):`, body);
    const notApproved = res.status === 422 && body.includes('ORDER_NOT_APPROVED');
    throw httpError(notApproved ? 'The order has not been approved by the buyer yet.' : 'PayPal could not capture the payment.', notApproved ? 422 : 502);
  }

  const captureData = await res.json();
  const capture = captureData.purchase_units?.[0]?.payments?.captures?.[0];
  record.captureId = capture?.id || record.captureId;
  record.updatedAt = Date.now();

  // The order can be COMPLETED while the capture itself is still PENDING (e.g. under review);
  // only treat it as paid when the capture is COMPLETED. A later webhook settles pending ones.
  const captureStatus = capture?.status || captureData.status;
  if (captureData.status === 'COMPLETED' && captureStatus === 'COMPLETED') {
    settleOrder(record);
  } else {
    record.status = captureStatus === 'PENDING' ? 'PENDING' : (captureData.status || 'UNKNOWN');
  }

  return { captureData, record };
}

export function getOrderForSession(session, orderID) {
  const record = orders.get(orderID);
  if (!record || record.sessionId !== session.id) return null;
  return {
    orderID: record.orderId,
    status: record.status,
    amount: record.totalFormatted,
    captureId: record.captureId,
    webhookConfirmed: record.webhookConfirmed
  };
}

/**
 * Verify a webhook with PayPal's verify-webhook-signature API.
 * https://developer.paypal.com/docs/api/webhooks/v1/#verify-webhook-signature_post
 */
export async function verifyWebhookSignature(headers, event) {
  if (!config.paypalWebhookId) {
    throw httpError('PAYPAL_WEBHOOK_ID is not configured.', 503);
  }

  const required = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
  if (required.some(h => !headers[h])) {
    return false;
  }

  const res = await paypalFetch('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: config.paypalWebhookId,
      webhook_event: event
    })
  });

  if (!res.ok) {
    console.error(`PayPal webhook verification call failed (${res.status}):`, await res.text());
    throw httpError('Could not verify webhook with PayPal.', 502);
  }
  const data = await res.json();
  return data.verification_status === 'SUCCESS';
}

function orderIdFromEvent(event) {
  const resource = event.resource || {};
  if (event.event_type?.startsWith('CHECKOUT.ORDER.')) return resource.id;
  return resource.supplementary_data?.related_ids?.order_id || null;
}

/**
 * Apply a verified webhook event to our order records. Idempotent per event id.
 * Returns a short description of what happened (for logs/tests).
 */
export function handleWebhookEvent(event) {
  if (event.id && processedWebhookEvents.has(event.id)) {
    return 'duplicate';
  }
  if (event.id) processedWebhookEvents.add(event.id);

  const orderId = orderIdFromEvent(event);
  const record = orderId ? orders.get(orderId) : null;
  if (!record) {
    return 'unknown-order';
  }

  record.webhookConfirmed = true;
  record.updatedAt = Date.now();

  switch (event.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED':
      record.captureId = event.resource?.id || record.captureId;
      settleOrder(record);
      return 'settled';
    case 'PAYMENT.CAPTURE.PENDING':
      if (!record.settled) record.status = 'PENDING';
      return 'pending';
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED':
      record.status = 'DENIED';
      return 'denied';
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED':
      record.status = event.event_type.endsWith('REFUNDED') ? 'REFUNDED' : 'REVERSED';
      return 'refunded';
    case 'CHECKOUT.ORDER.APPROVED':
      if (!record.settled) record.status = 'APPROVED';
      return 'approved';
    default:
      return 'ignored';
  }
}

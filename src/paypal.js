import { config } from './config.js';
import { getCartSummary, removePaidItems } from './cart.js';
import { getOrCreateSession } from './sessions.js';
import { orderStore, webhookEventStore, clearAllForTesting } from './db.js';

let cachedToken = null;

// Orders and processed webhook events are persisted in SQLite (see db.js), so a restart
// never loses a payment record.

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function resetPayPalStateForTesting() {
  cachedToken = null;
  clearAllForTesting();
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

export async function createPayPalOrder(session, { shopperId = null } = {}) {
  const summary = getCartSummary(session);
  if (summary.items.length === 0) {
    throw httpError('Your cart is empty. Please add items before checking out.', 400);
  }

  const usd = (cents) => ({ currency_code: 'USD', value: (cents / 100).toFixed(2) });
  const purchaseUnit = {
    reference_id: session.id,
    description: 'Ask & Buy Order Checkout',
    amount: {
      ...usd(summary.totalCents),
      // PayPal checks that item_total + shipping + tax_total equals the amount
      breakdown: {
        item_total: usd(summary.subtotalCents),
        shipping: usd(summary.shippingCents),
        tax_total: usd(summary.taxCents)
      }
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
  orderStore.insert({
    orderId: order.id,
    sessionId: session.id,
    shopperId,
    // Line items exactly as charged, for order history (catalog prices may change later)
    lines: summary.items.map(i => ({
      id: i.id, name: i.name, quantity: i.quantity, priceInCents: i.priceInCents, subtotalInCents: i.subtotalInCents
    })),
    // Snapshot exactly what this order charges for, so settlement only removes paid items
    items: new Map(summary.items.map(i => [i.id, i.quantity])),
    totalCents: summary.totalCents,
    totalFormatted: summary.totalFormatted,
    subtotalCents: summary.subtotalCents,
    shippingCents: summary.shippingCents,
    taxCents: summary.taxCents,
    status: order.status || 'CREATED'
  });
  return order;
}

// Mark an order paid and remove its items from the session cart (idempotent).
// The caller persists the record with orderStore.save().
function settleOrder(record) {
  if (record.settled) return;
  record.settled = true;
  record.status = 'COMPLETED';
  // Load from the DB if needed, so the saved cart is updated even after a restart
  const session = getOrCreateSession(record.sessionId);
  if (session) {
    removePaidItems(session, record.items);
    if (session.currentOrderId === record.orderId) {
      session.currentOrderId = null;
    }
  }
}

export async function capturePayPalOrder(session, orderID) {
  // Ownership comes from the stored order, so capture still works after a server restart
  const record = orderStore.get(orderID);
  if (!record || record.sessionId !== session.id) {
    throw httpError('Untrusted or invalid order ID for this session.', 400);
  }
  if (record.settled) {
    throw httpError('This order has already been paid.', 409);
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

  // The order can be COMPLETED while the capture itself is still PENDING (e.g. under review);
  // only treat it as paid when the capture is COMPLETED. A later webhook settles pending ones.
  const captureStatus = capture?.status || captureData.status;
  if (captureData.status === 'COMPLETED' && captureStatus === 'COMPLETED') {
    settleOrder(record);
  } else {
    record.status = captureStatus === 'PENDING' ? 'PENDING' : (captureData.status || 'UNKNOWN');
  }
  orderStore.save(record);

  return { captureData, record };
}

export function getOrderForSession(session, orderID) {
  const record = orderStore.get(orderID);
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
  const orderId = orderIdFromEvent(event);
  if (event.id && !webhookEventStore.tryInsert(event.id, event.event_type, orderId)) {
    return 'duplicate';
  }

  const outcome = applyWebhookEvent(event, orderId);
  if (event.id) webhookEventStore.setOutcome(event.id, outcome);
  return outcome;
}

function applyWebhookEvent(event, orderId) {
  const record = orderId ? orderStore.get(orderId) : null;
  if (!record) {
    return 'unknown-order';
  }

  record.webhookConfirmed = true;
  let outcome;

  switch (event.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED':
      record.captureId = event.resource?.id || record.captureId;
      settleOrder(record);
      outcome = 'settled';
      break;
    case 'PAYMENT.CAPTURE.PENDING':
      if (!record.settled) record.status = 'PENDING';
      outcome = 'pending';
      break;
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED':
      record.status = 'DENIED';
      outcome = 'denied';
      break;
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED':
      record.status = event.event_type.endsWith('REFUNDED') ? 'REFUNDED' : 'REVERSED';
      outcome = 'refunded';
      break;
    case 'CHECKOUT.ORDER.APPROVED':
      if (!record.settled) record.status = 'APPROVED';
      outcome = 'approved';
      break;
    default:
      outcome = 'ignored';
  }

  orderStore.save(record);
  return outcome;
}

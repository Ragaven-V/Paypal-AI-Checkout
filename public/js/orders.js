// "My orders" dialog: the shopper's past orders.
import { state } from './state.js';
import { $, el, showModal } from './dom.js';
import { getJSON } from './api.js';

export function statusClass(status) {
  if (status === 'COMPLETED') return 'paid';
  if (status === 'PENDING' || status === 'APPROVED') return 'pending';
  if (status === 'DENIED' || status === 'REFUNDED' || status === 'REVERSED') return 'bad';
  return '';
}

function showMessage(text) {
  $('orders-list').replaceChildren(el('div', 'orders-empty', text));
}

function renderOrder(order, dateFmt) {
  const card = el('article', 'order-item');

  const top = el('div', 'order-item-top');
  const info = el('div');
  info.append(
    el('div', 'order-date', dateFmt.format(new Date(order.createdAt))),
    el('div', 'order-id', `PayPal order ${order.orderID}`)
  );
  top.append(info, el('span', `status-pill ${statusClass(order.status)}`, order.statusLabel));

  const lines = el('ul', 'order-lines');
  for (const line of order.lines) {
    const li = el('li');
    li.append(el('span', '', `${line.quantity} × ${line.name}`), el('span', '', line.subtotal));
    lines.appendChild(li);
  }

  const total = el('div', 'order-total');
  total.append(el('span', '', 'Total'), el('span', '', `${order.amount} USD`));

  card.append(top, lines, total);
  return card;
}

async function loadOrders() {
  showMessage('Loading your orders…');
  const params = new URLSearchParams({ shopperId: state.shopperId, sessionId: state.sessionId });
  if ($('orders-include-unpaid').checked) params.set('includeUnpaid', '1');
  try {
    const { ok, data } = await getJSON(`/api/orders?${params}`);
    if (!ok) throw new Error(data.error || 'Could not load orders');
    if (!data.orders.length) {
      showMessage('No orders yet. Orders you pay for with PayPal will appear here. You can also ask the assistant "what did I buy last time?"');
      return;
    }
    const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    $('orders-list').replaceChildren(...data.orders.map(o => renderOrder(o, dateFmt)));
  } catch (err) {
    showMessage(`Sorry, your orders could not be loaded. ${err.message}`);
  }
}

export function initOrders() {
  const modal = $('orders-modal');
  let close = null;
  $('btn-orders').addEventListener('click', () => {
    close = showModal(modal);
    loadOrders();
  });
  $('btn-orders-close').addEventListener('click', () => close?.());
  $('orders-include-unpaid').addEventListener('change', loadOrders);
}

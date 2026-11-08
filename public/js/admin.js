// Admin orders dashboard (/admin). Password = ADMIN_TOKEN, sent as a Bearer token.
const PAGE_SIZE = 25;
let token = '';
let offset = 0;
let total = 0;

try { token = sessionStorage.getItem('ai_checkout_admin') || ''; } catch (e) { /* storage blocked */ }

const $ = (id) => document.getElementById(id);
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function statusClass(status) {
  if (status === 'COMPLETED') return 'paid';
  if (status === 'PENDING' || status === 'APPROVED') return 'pending';
  if (status === 'DENIED' || status === 'REFUNDED' || status === 'REVERSED') return 'bad';
  return '';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showLogin(message = '') {
  $('dashboard-view').hidden = true;
  $('login-view').hidden = false;
  $('login-error').textContent = message;
  $('token-input').focus();
}

function renderTiles(summary) {
  const byStatus = Object.fromEntries(summary.map(s => [s.status, s]));
  const totalOrders = summary.reduce((n, s) => n + s.count, 0);
  const tiles = [
    ['Paid orders', byStatus.COMPLETED?.count ?? 0, `${byStatus.COMPLETED?.total ?? '$0.00'} revenue`],
    ['Pending', (byStatus.PENDING?.count ?? 0) + (byStatus.APPROVED?.count ?? 0), 'awaiting PayPal'],
    ['Unfinished checkouts', byStatus.CREATED?.count ?? 0, 'PayPal opened, not paid'],
    ['Refunded / reversed', (byStatus.REFUNDED?.count ?? 0) + (byStatus.REVERSED?.count ?? 0), `${totalOrders} orders in total`]
  ];
  $('tiles').replaceChildren(...tiles.map(([label, value, sub]) => {
    const tile = el('div', 'card tile');
    tile.append(el('div', 'tile-label', label), el('div', 'tile-value', String(value)), el('div', 'tile-sub', sub));
    return tile;
  }));
}

function renderOrders(orders) {
  $('orders-empty').hidden = orders.length > 0;
  $('orders-body').replaceChildren(...orders.map(order => {
    const tr = document.createElement('tr');

    const dateTd = el('td');
    dateTd.append(el('div', '', dateFmt.format(new Date(order.createdAt))));

    const orderTd = el('td');
    orderTd.append(el('div', 'mono', order.orderID));
    if (order.captureId) orderTd.append(el('div', 'muted', `Capture ${order.captureId}`));
    orderTd.append(el('div', 'muted', order.webhookConfirmed ? 'Confirmed by webhook' : 'No webhook yet'));

    const itemsTd = el('td');
    const list = el('ul', 'lines');
    order.lines.forEach(l => list.append(el('li', '', `${l.quantity} × ${l.name}`)));
    itemsTd.append(list);

    const statusTd = el('td');
    statusTd.append(el('span', `pill ${statusClass(order.status)}`, order.statusLabel));

    tr.append(dateTd, orderTd, itemsTd, statusTd, el('td', 'num', order.amount));
    return tr;
  }));

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  $('pager-info').textContent = `${from}–${to} of ${total}`;
  $('btn-prev').disabled = offset === 0;
  $('btn-next').disabled = offset + PAGE_SIZE >= total;
}

async function load() {
  if (!token) return showLogin();
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset });
  const status = $('status-filter').value;
  if (status) params.set('status', status);

  try {
    const res = await fetch(`/api/admin/orders?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      token = '';
      try { sessionStorage.removeItem('ai_checkout_admin'); } catch (e) { /* ignore */ }
      return showLogin('Wrong password. Please try again.');
    }
    if (!res.ok) return showLogin(data.error || `Could not load orders (HTTP ${res.status}).`);

    total = data.total;
    $('login-view').hidden = true;
    $('dashboard-view').hidden = false;
    renderTiles(data.summary);
    renderOrders(data.orders);
  } catch (err) {
    showLogin('Could not reach the server.');
  }
}

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  token = $('token-input').value;
  $('token-input').value = '';
  try { sessionStorage.setItem('ai_checkout_admin', token); } catch (e) { /* keep in memory */ }
  offset = 0;
  load();
});

$('status-filter').addEventListener('change', () => { offset = 0; load(); });
$('btn-refresh').addEventListener('click', load);
$('btn-prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); load(); });
$('btn-next').addEventListener('click', () => { offset += PAGE_SIZE; load(); });
$('btn-signout').addEventListener('click', () => {
  token = '';
  try { sessionStorage.removeItem('ai_checkout_admin'); } catch (e) { /* ignore */ }
  showLogin();
});

load();

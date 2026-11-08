// Cart panel: rendering plus optimistic add/decrement/remove synced with the server.
import { state, formatCents } from './state.js';
import { $, el, showToast } from './dom.js';
import { getJSON, postJSON } from './api.js';

function recalc(cart) {
  cart.totalCents = cart.items.reduce((n, it) => n + it.subtotalInCents, 0);
  cart.itemCount = cart.items.reduce((n, it) => n + it.quantity, 0);
  cart.totalFormatted = formatCents(cart.totalCents);
}

function renderEmpty() {
  const empty = el('div', 'empty-cart-state');
  const icon = el('div', 'empty-cart-icon', '🛍️');
  icon.setAttribute('aria-hidden', 'true');
  const title = el('p');
  title.appendChild(el('strong', '', 'Your cart is empty'));
  empty.append(icon, title, el('p', '', 'Ask the assistant for recommendations or click "+ Add to Cart" on any product.'));
  return empty;
}

function renderItem(item) {
  const row = el('div', 'cart-item');

  const product = state.catalogById.get(item.id);
  if (product?.image) {
    const img = el('img', 'cart-item-thumb');
    img.src = product.image;
    img.alt = '';
    img.width = 44;
    img.height = 44;
    row.appendChild(img);
  }

  const details = el('div', 'cart-item-details');
  details.append(
    el('div', 'cart-item-name', item.name),
    el('div', 'cart-item-price', `$${Number(item.price).toFixed(2)} each`)
  );

  const controls = el('div', 'cart-item-controls');
  const minus = el('button', 'btn-qty', '−');
  minus.type = 'button';
  minus.setAttribute('aria-label', `Decrease quantity of ${item.name}`);
  minus.addEventListener('click', () => (item.quantity <= 1 ? removeItemFromCart(item.id) : addItemToCart(item.id, -1)));

  const qty = el('span', 'qty-display', String(item.quantity));
  qty.setAttribute('aria-label', `Quantity ${item.quantity}`);

  const plus = el('button', 'btn-qty', '+');
  plus.type = 'button';
  plus.setAttribute('aria-label', `Increase quantity of ${item.name}`);
  plus.addEventListener('click', () => addItemToCart(item.id, 1));

  const remove = el('button', 'btn-remove-item', '🗑️');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove ${item.name} from cart`);
  remove.addEventListener('click', () => removeItemFromCart(item.id));

  controls.append(minus, qty, plus, remove);
  row.append(details, controls);
  return row;
}

export function renderCart(cart) {
  state.cart = cart;
  $('cart-count').textContent = `${cart.itemCount} ${cart.itemCount === 1 ? 'item' : 'items'}`;
  $('summary-subtotal').textContent = cart.totalFormatted;
  $('summary-total').textContent = cart.totalFormatted;
  const list = $('cart-items');
  list.replaceChildren(...(cart.items?.length ? cart.items.map(renderItem) : [renderEmpty()]));
}

export async function fetchCart() {
  try {
    const { ok, data } = await getJSON(`/api/cart?sessionId=${encodeURIComponent(state.sessionId)}`);
    if (ok) renderCart(data.cart);
  } catch (err) {
    console.error('Failed to load cart:', err);
  }
}

// Update the UI immediately, then sync with the server (which has the final say on totals)
export async function addItemToCart(id, quantityDelta = 1) {
  const previous = structuredClone(state.cart);
  const cart = state.cart;
  const product = state.catalogById.get(id) || cart.items.find(i => i.id === id);

  if (product) {
    const existing = cart.items.find(i => i.id === id);
    if (existing) {
      existing.quantity = Math.max(1, Math.min(10, existing.quantity + quantityDelta));
      existing.subtotalInCents = existing.priceInCents * existing.quantity;
    } else if (quantityDelta > 0) {
      const priceInCents = Math.round(Number(product.price) * 100);
      cart.items.push({ id: product.id, name: product.name, price: product.price, priceInCents, quantity: 1, subtotalInCents: priceInCents });
    }
    recalc(cart);
    renderCart(cart);
    showToast(quantityDelta > 0 ? `Added "${product.name}"` : 'Updated quantity', 'success');
  }

  try {
    const { ok, data } = await postJSON('/api/cart/add', { sessionId: state.sessionId, id, quantity: quantityDelta });
    if (ok && data.success) {
      renderCart(data.cart);
    } else {
      renderCart(previous);
      showToast(data.error || 'Failed to update cart', 'error');
    }
  } catch {
    renderCart(previous);
    showToast('Network error updating cart', 'error');
  }
}

export async function removeItemFromCart(id) {
  const previous = structuredClone(state.cart);
  const removed = state.cart.items.find(i => i.id === id);
  state.cart.items = state.cart.items.filter(i => i.id !== id);
  recalc(state.cart);
  renderCart(state.cart);
  if (removed) showToast(`Removed "${removed.name}"`, 'info');

  try {
    const { ok, data } = await postJSON('/api/cart/remove', { sessionId: state.sessionId, id });
    if (ok && data.success) {
      renderCart(data.cart);
    } else {
      renderCart(previous);
      showToast(data.error || 'Failed to remove item', 'error');
    }
  } catch {
    renderCart(previous);
    showToast('Network error removing item', 'error');
  }
}

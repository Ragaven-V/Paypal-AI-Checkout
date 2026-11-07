import { catalogMap } from './catalog.js';

const clampQty = (q) => Math.max(1, Math.min(10, Math.floor(Number(q) || 1)));
const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;

/**
 * Cart calculations (strictly in integer cents)
 */
export function getCartSummary(session) {
  const items = [];
  let totalCents = 0;
  let itemCount = 0;

  for (const [productId, qty] of session.cart.entries()) {
    const product = catalogMap.get(productId);
    if (!product) continue;

    const quantity = clampQty(qty);
    const priceInCents = Math.round(product.price * 100);
    const subtotalInCents = priceInCents * quantity;

    totalCents += subtotalInCents;
    itemCount += quantity;

    items.push({
      id: product.id,
      name: product.name,
      price: product.price,
      priceInCents,
      quantity,
      subtotalInCents,
      formattedSubtotal: formatCents(subtotalInCents)
    });
  }

  return { items, itemCount, totalCents, totalFormatted: formatCents(totalCents) };
}

export function executeAddToCart(session, productId, quantity = 1) {
  const product = catalogMap.get(productId);
  if (!product) {
    return { success: false, error: `Product "${productId}" not found in catalog.` };
  }

  const validQty = clampQty(quantity);
  const newQty = Math.min(10, (session.cart.get(productId) || 0) + validQty);
  session.cart.set(productId, newQty);

  return {
    success: true,
    message: `Added ${validQty}x "${product.name}" to cart.`,
    item: { id: product.id, name: product.name, quantity: newQty },
    cart: getCartSummary(session)
  };
}

export function executeDecrementCart(session, productId, amount = 1) {
  const product = catalogMap.get(productId);
  if (!product) {
    return { success: false, error: `Product "${productId}" not found in catalog.` };
  }

  const newQty = (session.cart.get(productId) || 0) - clampQty(amount);
  if (newQty > 0) {
    session.cart.set(productId, newQty);
  } else {
    session.cart.delete(productId);
  }

  return {
    success: true,
    message: `Updated "${product.name}" quantity to ${Math.max(0, newQty)}.`,
    item: { id: product.id, name: product.name, quantity: Math.max(0, newQty) },
    cart: getCartSummary(session)
  };
}

export function executeRemoveFromCart(session, productId) {
  const product = catalogMap.get(productId);
  if (!product) {
    return { success: false, error: `Product "${productId}" not found in catalog.` };
  }

  const existed = session.cart.delete(productId);
  return {
    success: true,
    removed: existed,
    message: existed ? `Removed "${product.name}" from cart.` : `"${product.name}" was not in cart.`,
    cart: getCartSummary(session)
  };
}

export function executeViewCart(session) {
  const summary = getCartSummary(session);
  return {
    success: true,
    items: summary.items,
    item_count: summary.itemCount,
    total: summary.totalFormatted,
    total_cents: summary.totalCents
  };
}

// Remove the quantities of a paid order from the cart; items added afterwards stay.
export function removePaidItems(session, paidItems) {
  for (const [productId, paidQty] of paidItems) {
    const remaining = (session.cart.get(productId) || 0) - paidQty;
    if (remaining > 0) {
      session.cart.set(productId, remaining);
    } else {
      session.cart.delete(productId);
    }
  }
}

import { catalogMap } from './catalog.js';
import { config } from './config.js';

const clampQty = (q) => Math.max(1, Math.min(10, Math.floor(Number(q) || 1)));
const formatCents = (cents) => `$${(cents / 100).toFixed(2)}`;

/**
 * Cart calculations (strictly in integer cents)
 */
export function getCartSummary(session) {
  const items = [];
  let itemsCents = 0;
  let itemCount = 0;

  for (const [productId, qty] of session.cart.entries()) {
    const product = catalogMap.get(productId);
    if (!product) continue;

    const quantity = clampQty(qty);
    const priceInCents = Math.round(product.price * 100);
    const subtotalInCents = priceInCents * quantity;

    itemsCents += subtotalInCents;
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

  const pricing = priceCart(itemsCents);
  return {
    items,
    itemCount,
    subtotalCents: pricing.subtotalCents,
    shippingCents: pricing.shippingCents,
    taxCents: pricing.taxCents,
    // Grand total actually charged (items + shipping + tax)
    totalCents: pricing.totalCents,
    subtotalFormatted: formatCents(pricing.subtotalCents),
    shippingFormatted: pricing.shippingCents === 0 ? 'FREE' : formatCents(pricing.shippingCents),
    taxFormatted: formatCents(pricing.taxCents),
    totalFormatted: formatCents(pricing.totalCents),
    freeShippingRemainingCents: pricing.freeShippingRemainingCents
  };
}

/**
 * Shipping and tax for an items subtotal (integer cents). Shipping is a flat fee below the
 * free-shipping threshold; tax is a percentage of the items subtotal, rounded half up.
 */
export function priceCart(subtotalCents) {
  const empty = subtotalCents === 0;
  const freeShipping = subtotalCents >= config.freeShippingThresholdCents;
  const shippingCents = empty || freeShipping ? 0 : config.shippingFlatCents;
  // Rate as basis points (8.25% -> 825) to keep the math in integers
  const rateBp = Math.round(config.taxRatePercent * 100);
  const taxCents = Math.round((subtotalCents * rateBp) / 10000);
  return {
    subtotalCents,
    shippingCents,
    taxCents,
    totalCents: subtotalCents + shippingCents + taxCents,
    freeShippingRemainingCents: empty || freeShipping ? 0 : config.freeShippingThresholdCents - subtotalCents
  };
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
    subtotal: summary.subtotalFormatted,
    shipping: summary.shippingFormatted,
    tax: summary.taxFormatted,
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

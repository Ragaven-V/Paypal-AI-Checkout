// PayPal JS SDK buttons: create the order on our server, capture it on approval.
import { state } from './state.js';
import { $, el, showToast, showModal } from './dom.js';
import { postJSON } from './api.js';
import { fetchCart } from './cart.js';

function showNotice(text) {
  $('paypal-button-container').replaceChildren(el('div', 'paypal-notice-banner', text));
}

let closeConfirmation = null;

function showConfirmation({ orderID, status, amount }) {
  $('confirm-order-id').textContent = orderID;
  $('confirm-order-status').textContent = status || 'COMPLETED';
  $('confirm-order-amount').textContent = `${amount} USD`;
  closeConfirmation = showModal($('confirmation-modal'), { closeOnBackdrop: false });
}

export function closeConfirmationModal() {
  closeConfirmation?.();
  closeConfirmation = null;
}

function renderButtons() {
  window.paypal.Buttons({
    style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', height: 44 },

    createOrder: async () => {
      if (!state.cart || state.cart.itemCount === 0) {
        showToast('Your cart is empty. Please add items before checking out.', 'warning');
        throw new Error('Cart is empty');
      }
      const { ok, data } = await postJSON('/api/paypal/create-order', { sessionId: state.sessionId, shopperId: state.shopperId });
      if (!ok) {
        showToast(data.error || 'Failed to create PayPal order', 'error');
        throw new Error(data.error || 'Failed to create PayPal order');
      }
      return data.orderID;
    },

    onApprove: async (approval) => {
      showToast('Capturing payment with PayPal...', 'info');
      try {
        const { ok, status, data } = await postJSON('/api/paypal/capture-order', { sessionId: state.sessionId, orderID: approval.orderID });
        if (status === 202) {
          showToast(data.error || 'Payment is pending review by PayPal.', 'warning');
          return;
        }
        if (!ok) {
          showToast(data.error || 'Payment capture failed', 'error');
          return;
        }
        showConfirmation({
          orderID: data.orderID || approval.orderID,
          status: data.status,
          amount: data.amount || state.cart.totalFormatted
        });
        await fetchCart(); // paid items were removed on the server
      } catch (err) {
        console.error('Capture error:', err);
        showToast('Error finalizing PayPal order capture', 'error');
      }
    },

    onCancel: () => showToast('Payment was cancelled. Your items remain in your cart.', 'warning'),

    onError: (err) => {
      console.error('PayPal Checkout error:', err);
      showToast('There was an issue processing with PayPal. Please verify sandbox account credentials.', 'error');
    }
  }).render('#paypal-button-container');
}

export function initPayPal() {
  if (!state.config.paypalClientId) {
    showNotice('⚠️ PayPal Sandbox Client ID is not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env to render interactive PayPal buttons.');
    return;
  }

  const script = document.createElement('script');
  script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(state.config.paypalClientId)}&currency=USD&enable-funding=venmo`;
  script.async = true;
  script.onload = () => {
    if (!window.paypal?.Buttons) {
      console.error('PayPal SDK loaded but Buttons not available');
      return;
    }
    renderButtons();
  };
  script.onerror = () => showNotice('Failed to load PayPal SDK. Please check your internet connection and verify PAYPAL_CLIENT_ID.');
  document.head.appendChild(script);
}

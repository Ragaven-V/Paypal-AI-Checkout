// Small DOM helpers: element builder, toasts and accessible modals.

export const $ = (id) => document.getElementById(id);

// Create an element with a class and text (text is always set safely via textContent)
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

export function showToast(message, type = 'info') {
  const toast = el('div', `toast ${type}`, message);
  $('toast-container').appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let openModal = null;

/**
 * Open a modal dialog: show it, move focus inside, keep Tab inside it (focus trap),
 * close on Escape (if allowed) and restore focus to the opener when it closes.
 */
export function showModal(modalEl, { onClose, closeOnEscape = true, closeOnBackdrop = true } = {}) {
  const opener = document.activeElement;

  const close = () => {
    modalEl.style.display = 'none';
    document.removeEventListener('keydown', onKeydown, true);
    modalEl.removeEventListener('click', onBackdrop);
    openModal = null;
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    onClose?.();
  };

  function onKeydown(e) {
    if (e.key === 'Escape' && closeOnEscape) {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...modalEl.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onBackdrop(e) {
    if (closeOnBackdrop && e.target === modalEl) close();
  }

  openModal?.();
  modalEl.style.display = 'flex';
  document.addEventListener('keydown', onKeydown, true);
  modalEl.addEventListener('click', onBackdrop);
  const firstFocusable = modalEl.querySelector(FOCUSABLE);
  firstFocusable?.focus();
  openModal = close;
  return close;
}

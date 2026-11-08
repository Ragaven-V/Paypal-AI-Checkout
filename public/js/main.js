// App entry point: load config/catalog/cart/chat, wire up events, start PayPal.
import { state, setCatalog, startNewSession } from './state.js';
import { $ } from './dom.js';
import { getJSON } from './api.js';
import { fetchCart } from './cart.js';
import { sendMessage, restoreChat, resetChat, appendMessage } from './chat.js';
import { initOrders } from './orders.js';
import { initAccount } from './account.js';
import { initPayPal, closeConfirmationModal } from './paypal.js';

function renderAiBadge() {
  const badge = $('badge-ai-mode');
  const { config } = state;
  if (config.aiDegraded) {
    badge.textContent = '⚠️ AI degraded: using fallback';
    badge.className = 'badge badge-mock';
    badge.title = `Gemini requests are failing: ${config.aiLastError || 'unknown error'}`;
  } else if (config.mockAi) {
    badge.textContent = '🤖 Mock AI Mode';
    badge.className = 'badge badge-mock';
    badge.title = 'Running on rule-based shopping assistant (MOCK_AI=true or no GEMINI_API_KEY)';
  } else {
    badge.textContent = `🤖 Gemini Live AI (${config.modelName})`;
    badge.className = 'badge badge-ai';
    badge.title = `Running with Google Gemini (${config.modelName})`;
  }
}

function wireEvents() {
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage($('chat-input').value);
  });

  document.querySelectorAll('.prompt-chip').forEach(chip => {
    chip.addEventListener('click', () => sendMessage(chip.dataset.prompt));
  });

  $('btn-new-order').addEventListener('click', () => {
    closeConfirmationModal();
    startNewSession();
    resetChat();
    fetchCart();
    appendMessage('assistant', 'Welcome to a new shopping session! What can I help you find today?');
    $('chat-input').focus();
  });

  initOrders();
}

async function init() {
  wireEvents();

  const [configRes, catalogRes] = await Promise.allSettled([getJSON('/api/config'), getJSON('/api/catalog')]);
  if (configRes.status === 'fulfilled' && configRes.value.ok) state.config = configRes.value.data;
  if (catalogRes.status === 'fulfilled' && catalogRes.value.ok) setCatalog(catalogRes.value.data.products || []);
  renderAiBadge();

  await Promise.all([fetchCart(), restoreChat(), initAccount()]);
  initPayPal();
}

init();

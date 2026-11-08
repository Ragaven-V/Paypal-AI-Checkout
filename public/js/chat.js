// Chat: message rendering, SSE streaming from /api/chat, and restoring the saved transcript.
import { state } from './state.js';
import { $, el, showToast } from './dom.js';
import { getJSON } from './api.js';
import { renderProductCards } from './products.js';
import { renderCart, addItemToCart } from './cart.js';

const WELCOME = "Hello! I am your AI shopping assistant. What are you looking for today? Tell me who you are shopping for, your budget, or your favorite style, and I'll find the best options for you!";

const messagesEl = () => $('chat-messages');
const scrollToEnd = () => { messagesEl().scrollTop = messagesEl().scrollHeight; };

function avatar(role) {
  const a = el('div', `avatar avatar-${role}`, role === 'user' ? 'You' : 'AI');
  a.setAttribute('aria-hidden', 'true');
  return a;
}

// Build a message row; returns its parts so streaming can update them in place
function createMessage(role, text = '') {
  const row = el('div', `message-row ${role}`);
  const wrapper = el('div', 'bubble-wrapper');
  const bubble = el('div', 'message-bubble', text);
  const label = el('span', 'visually-hidden', role === 'user' ? 'You said: ' : 'Assistant: ');
  bubble.prepend(label);
  const grid = el('div', 'product-grid');
  wrapper.append(bubble, grid);
  row.append(avatar(role), wrapper);
  return { row, bubble, label, grid };
}

export function appendMessage(role, text, products = []) {
  const msg = createMessage(role, text);
  if (products.length) renderProductCards(msg.grid, products, addItemToCart);
  messagesEl().appendChild(msg.row);
  scrollToEnd();
  return msg;
}

function showSkeleton() {
  const row = el('div', 'skeleton-message');
  row.setAttribute('aria-hidden', 'true');
  const bubble = el('div', 'skeleton-bubble');
  bubble.append(
    el('div', 'skeleton skeleton-line w80'),
    el('div', 'skeleton skeleton-line w95'),
    el('div', 'skeleton skeleton-line w60')
  );
  const grid = el('div', 'skeleton-grid');
  grid.append(el('div', 'skeleton skeleton-card'), el('div', 'skeleton skeleton-card'));
  bubble.appendChild(grid);
  row.append(avatar('assistant'), bubble);
  messagesEl().appendChild(row);
  scrollToEnd();
  return row;
}

// Show only the welcome message (used on load and for a new session)
export function resetChat() {
  messagesEl().replaceChildren(createMessage('assistant', WELCOME).row);
}

// Restore the saved transcript for this session (after a reload or server restart)
export async function restoreChat() {
  resetChat();
  try {
    const { ok, data } = await getJSON(`/api/chat/history?sessionId=${encodeURIComponent(state.sessionId)}`);
    if (!ok || !data.messages?.length) return;
    messagesEl().appendChild(el('div', 'history-divider', 'Earlier in this conversation'));
    for (const m of data.messages) {
      appendMessage(m.role === 'user' ? 'user' : 'assistant', m.text, m.products || []);
    }
  } catch (err) {
    console.warn('Could not restore chat history:', err);
  }
}

export async function sendMessage(rawText) {
  const text = rawText.trim();
  if (!text) return;

  const input = $('chat-input');
  const sendBtn = $('btn-send');
  appendMessage('user', text);
  input.value = '';
  sendBtn.disabled = true;
  const skeleton = showSkeleton();

  let msg = null;
  let cursor = null;
  let reply = '';
  const ensureMessage = () => {
    if (msg) return;
    skeleton.remove();
    msg = createMessage('assistant');
    cursor = el('span', 'streaming-cursor');
    cursor.setAttribute('aria-hidden', 'true');
    msg.bubble.appendChild(cursor);
    messagesEl().appendChild(msg.row);
  };

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ sessionId: state.sessionId, shopperId: state.shopperId, message: text, stream: true })
    });

    if (!response.ok) {
      skeleton.remove();
      const err = await response.json().catch(() => ({}));
      appendMessage('assistant', err.error || 'Sorry, I encountered an error processing your request.');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        let event;
        try {
          event = JSON.parse(trimmed.slice(5).trim());
        } catch {
          continue; // ignore a malformed chunk
        }
        ensureMessage();

        if (event.type === 'chunk' && event.text) {
          reply += event.text;
          msg.bubble.replaceChildren(msg.label, document.createTextNode(reply), cursor);
          scrollToEnd();
        } else if (event.type === 'products' && Array.isArray(event.products)) {
          renderProductCards(msg.grid, event.products, addItemToCart);
          scrollToEnd();
        } else if (event.type === 'notice' && event.message) {
          showToast(event.message, 'warning');
        } else if (event.type === 'cart' && event.cart) {
          renderCart(event.cart);
        }
      }
    }
  } catch {
    appendMessage('assistant', 'Sorry, I lost connection to the assistant. Please try again.');
    showToast('Network connection error', 'error');
  } finally {
    if (skeleton.isConnected) skeleton.remove();
    cursor?.remove();
    sendBtn.disabled = false;
    input.focus();
  }
}

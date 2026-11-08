import { Router } from 'express';
import { config } from '../config.js';
import { catalog, catalogMap } from '../catalog.js';
import { getOrCreateSession } from '../sessions.js';
import { getCartSummary, executeAddToCart, executeDecrementCart, executeRemoveFromCart } from '../cart.js';
import { runMockAi } from '../ai/mockAi.js';
import { runGeminiTurn, isAiEnabled, aiHealth, aiCooldownRemainingMs, isQuotaError } from '../ai/gemini.js';
import { chatStore } from '../db.js';
import { isValidShopperId } from '../orders.js';

export const isValidSessionId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 128;

const TOOL_FAILURE_REPLY = 'Sorry, I had trouble finishing that reply. Your cart is up to date.';

export function createApiRouter({ chatLimiter }) {
  const router = Router();

  // Public configuration (never expose secrets)
  router.get('/config', (req, res) => {
    res.json({
      paypalClientId: config.paypalClientId,
      mockAi: !isAiEnabled(),
      // true when the live AI path is failing and chat is answered by the fallback assistant
      aiDegraded: isAiEnabled() && aiHealth.ok === false,
      aiLastError: isAiEnabled() && aiHealth.ok === false ? aiHealth.lastError : null,
      // Seconds until the AI is retried after hitting the Gemini usage limit (0 = available)
      aiCooldownSeconds: Math.ceil(aiCooldownRemainingMs() / 1000),
      modelName: config.geminiModel,
      // Lets the cart show shipping/tax instantly; the server still computes the real totals
      pricing: {
        shippingFlatCents: config.shippingFlatCents,
        freeShippingThresholdCents: config.freeShippingThresholdCents,
        taxRatePercent: config.taxRatePercent
      }
    });
  });

  router.get('/catalog', (req, res) => {
    res.json({ products: catalog });
  });

  // Saved chat transcript for a session, so the conversation reappears after a reload or restart
  router.get('/chat/history', (req, res) => {
    const { sessionId } = req.query;
    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({ error: 'Valid sessionId is required' });
    }
    const messages = chatStore.listMessages(sessionId).map(m => ({
      role: m.role,
      text: m.text,
      products: m.productIds.map(id => catalogMap.get(id)).filter(Boolean),
      createdAt: new Date(m.createdAt).toISOString()
    }));
    res.json({ messages });
  });

  router.get('/cart', (req, res) => {
    const { sessionId } = req.query;
    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({ error: 'Missing sessionId query parameter' });
    }
    res.json({ cart: getCartSummary(getOrCreateSession(sessionId)) });
  });

  // quantity > 0 adds; quantity < 0 decrements (used by the cart's − button)
  router.post('/cart/add', (req, res) => {
    const { sessionId, id, quantity } = req.body || {};
    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({ error: 'Invalid or missing sessionId' });
    }
    if (typeof id !== 'string' || !catalogMap.has(id)) {
      return res.status(400).json({ error: 'Invalid product id' });
    }

    const session = getOrCreateSession(sessionId);
    const qty = Number(quantity);
    res.json(qty < 0 ? executeDecrementCart(session, id, -qty) : executeAddToCart(session, id, quantity || 1));
  });

  router.post('/cart/remove', (req, res) => {
    const { sessionId, id } = req.body || {};
    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({ error: 'Invalid or missing sessionId' });
    }
    if (typeof id !== 'string' || !id) {
      return res.status(400).json({ error: 'Invalid product id' });
    }
    res.json(executeRemoveFromCart(getOrCreateSession(sessionId), id));
  });

  // Chat: SSE streaming (stream: true or Accept: text/event-stream) or a single JSON response
  router.post('/chat', chatLimiter, async (req, res) => {
    const { sessionId, message, stream, shopperId } = req.body || {};

    if (!isValidSessionId(sessionId)) {
      return res.status(400).json({ error: 'Valid sessionId is required' });
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ error: 'Valid non-empty message is required' });
    }
    if (message.length > 1000) {
      return res.status(400).json({ error: 'Message exceeds maximum length of 1000 characters' });
    }

    if (shopperId !== undefined && !isValidShopperId(shopperId)) {
      return res.status(400).json({ error: 'Invalid shopperId' });
    }

    const session = getOrCreateSession(sessionId, { shopperId: shopperId ?? null, userId: req.user?.id ?? null });
    const isStream = stream === true || req.headers.accept?.includes('text/event-stream') || req.query.stream === 'true';

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
    }
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // Save the exchange to the transcript (never let a storage error break the reply)
    const record = (reply, products = []) => {
      try {
        chatStore.addMessage(session.id, 'user', message);
        if (reply) chatStore.addMessage(session.id, 'assistant', reply, products);
      } catch (err) {
        console.error('Could not save chat transcript:', err.message);
      }
    };

    const respondWithMock = async (notice) => {
      const result = runMockAi(session, message);
      record(result.reply, result.products);
      if (!isStream) {
        return res.json(notice ? { ...result, notice } : result);
      }
      if (result.products.length > 0) send({ type: 'products', products: result.products });
      const words = result.reply.split(' ');
      for (let i = 0; i < words.length; i += 3) {
        send({ type: 'chunk', text: words.slice(i, i + 3).join(' ') + (i + 3 < words.length ? ' ' : '') });
        await new Promise(r => setTimeout(r, 15));
      }
      if (notice) send({ type: 'notice', message: notice });
      send({ type: 'cart', cart: result.cart });
      send({ type: 'done' });
      res.end();
    };

    if (!isAiEnabled()) {
      return respondWithMock();
    }
    const cooldownMs = aiCooldownRemainingMs();
    if (cooldownMs > 0) {
      return respondWithMock(`The AI assistant is busy right now, so a basic assistant answered. Full AI is back in about ${Math.ceil(cooldownMs / 1000)}s.`);
    }

    if (isStream) send({ type: 'start' });

    try {
      const result = await runGeminiTurn(session, message, {
        onText: (text) => isStream && send({ type: 'chunk', text }),
        onEvent: (event) => isStream && send(event)
      });

      const reply = result.text || "I've updated your shopping request. Let me know if you need anything else!";
      record(reply, result.products);
      if (!isStream) {
        return res.json({ reply, products: result.products, cart: getCartSummary(session) });
      }
      send({ type: 'cart', cart: getCartSummary(session) });
      send({ type: 'done' });
      return res.end();
    } catch (err) {
      console.error('Gemini chat error:', String(err.message).slice(0, 300));

      // Tools already changed the cart (or text was streamed): replaying via the mock would repeat actions
      if (err.toolsRan || err.partialText) {
        record(err.partialText || TOOL_FAILURE_REPLY);
        if (!isStream) {
          return res.json({ reply: err.partialText || TOOL_FAILURE_REPLY, products: [], cart: getCartSummary(session) });
        }
        if (!err.partialText) send({ type: 'chunk', text: TOOL_FAILURE_REPLY });
        send({ type: 'cart', cart: getCartSummary(session) });
        send({ type: 'done' });
        return res.end();
      }
      return respondWithMock(isQuotaError(err)
        ? 'The AI assistant reached its usage limit, so a basic assistant answered. Please try again shortly.'
        : 'Note: Responded using rule-based shopping assistant.');
    }
  });

  return router;
}

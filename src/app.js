import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { createIpRateLimiter } from './rateLimit.js';
import { securityHeaders } from './security.js';
import { createApiRouter } from './routes/api.js';
import { createPayPalRouter, paypalWebhookHandler } from './routes/paypal.js';
import { createOrdersRouter } from './routes/orders.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  if (config.trustProxy) {
    // e.g. "1" (one proxy hop), "loopback", or a subnet list; see Express "trust proxy"
    const value = /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy;
    app.set('trust proxy', value);
  }

  const apiLimiter = createIpRateLimiter({ name: 'api', max: () => config.rateLimitApiPerMin });
  const chatLimiter = createIpRateLimiter({ name: 'chat', max: () => config.rateLimitChatPerMin });
  // Admin password attempts: tight limit against guessing
  const adminLimiter = createIpRateLimiter({ name: 'admin', max: 10, message: 'Too many admin attempts. Please wait a minute.' });
  app.locals.rateLimiters = { apiLimiter, chatLimiter, adminLimiter };

  app.use(securityHeaders);

  // Health check for the hosting platform (no DB or external calls)
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(publicDir));
  app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));

  // Webhooks come from PayPal's servers; keep them out of the per-IP client limit
  app.post('/api/paypal/webhook', paypalWebhookHandler);

  app.use('/api', apiLimiter);
  app.use('/api/paypal', createPayPalRouter());
  app.use('/api', createOrdersRouter({ adminLimiter }));
  app.use('/api', createApiRouter({ chatLimiter }));

  // Unknown API routes / wrong methods get a JSON 404 instead of the SPA HTML
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
  });

  // Malformed JSON bodies etc.
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(err.status || 400).json({ error: 'Invalid request body' });
    }
    next(err);
  });

  // SPA fallback for page loads only. Other methods get a 404 so a misconfigured
  // webhook URL (e.g. PayPal posting to "/") fails visibly instead of returning 200.
  app.use((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}

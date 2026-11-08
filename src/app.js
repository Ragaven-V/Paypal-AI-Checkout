import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { createIpRateLimiter } from './rateLimit.js';
import { securityHeaders } from './security.js';
import { requestLogger, errorHandler } from './logger.js';
import { authenticate, sameOriginOnly } from './auth.js';
import { isDbHealthy } from './db.js';
import { createApiRouter } from './routes/api.js';
import { createPayPalRouter, paypalWebhookHandler } from './routes/paypal.js';
import { createOrdersRouter } from './routes/orders.js';
import { createAuthRouter } from './routes/auth.js';

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
  // Password attempts: tight limits against guessing
  const adminLimiter = createIpRateLimiter({ name: 'admin', max: 10, message: 'Too many admin attempts. Please wait a minute.' });
  const authLimiter = createIpRateLimiter({ name: 'auth', max: () => config.rateLimitAuthPerMin, message: 'Too many sign-in attempts. Please wait a minute.' });
  app.locals.rateLimiters = { apiLimiter, chatLimiter, adminLimiter, authLimiter };

  app.use(requestLogger);
  app.use(securityHeaders);

  // Liveness (process is up) and readiness (database answers) for the hosting platform
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/readyz', (req, res) => {
    const db = isDbHealthy();
    res.status(db ? 200 : 503).json({ ok: db, db });
  });

  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(publicDir));
  app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));

  // Webhooks come from PayPal's servers: no client rate limit, no cookies, no Origin check
  app.post('/api/paypal/webhook', paypalWebhookHandler);

  app.use('/api', apiLimiter);
  app.use('/api', sameOriginOnly);
  app.use('/api', authenticate);
  app.use('/api/auth', createAuthRouter({ authLimiter }));
  app.use('/api/paypal', createPayPalRouter());
  app.use('/api', createOrdersRouter({ adminLimiter }));
  app.use('/api', createApiRouter({ chatLimiter }));

  // Unknown API routes / wrong methods get a JSON 404 instead of the SPA HTML
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
  });

  // SPA fallback for page loads only. Other methods get a 404 so a misconfigured
  // webhook URL (e.g. PayPal posting to "/") fails visibly instead of returning 200.
  app.use((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
    }
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Malformed JSON bodies, and anything unexpected: logged with the request ID
  app.use(errorHandler);

  return app;
}

import dotenv from 'dotenv';

dotenv.config({ quiet: true });

// Read lazily so tests (and runtime changes) can override process.env before each call.
export const config = {
  get port() { return Number(process.env.PORT) || 3000; },
  get databasePath() { return process.env.DATABASE_PATH || './data/ai-checkout.db'; },
  // Password for the /admin orders page; admin is disabled when empty
  get adminToken() { return process.env.ADMIN_TOKEN || ''; },

  get geminiApiKey() { return (process.env.GEMINI_API_KEY || '').trim(); },
  get geminiModel() { return process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'; },
  get mockAiForced() { return process.env.MOCK_AI === 'true'; },
  // Gemini 3 models take thinkingLevel; Gemini 2.5 models take thinkingBudget. Empty = model default.
  get geminiThinkingLevel() { return (process.env.GEMINI_THINKING_LEVEL ?? 'low').trim().toLowerCase(); },
  get geminiExplicitCache() { return process.env.GEMINI_EXPLICIT_CACHE === 'true'; },
  // Fail fast instead of the SDK default (5 attempts, backoff up to 60s): shoppers get the fallback quickly
  get geminiTimeoutMs() { return numberOr(process.env.GEMINI_TIMEOUT_MS, 20000); },
  get geminiRetryAttempts() { return numberOr(process.env.GEMINI_RETRY_ATTEMPTS, 2); },

  get paypalClientId() { return process.env.PAYPAL_CLIENT_ID || ''; },
  get paypalClientSecret() { return process.env.PAYPAL_CLIENT_SECRET || ''; },
  get paypalBaseUrl() { return process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com'; },
  get paypalWebhookId() { return process.env.PAYPAL_WEBHOOK_ID || ''; },

  // Express "trust proxy" setting, needed behind a reverse proxy so req.ip is the real client IP.
  get trustProxy() { return process.env.TRUST_PROXY || ''; },
  get rateLimitChatPerMin() { return Number(process.env.RATE_LIMIT_CHAT_PER_MIN) || 20; },
  get rateLimitApiPerMin() { return Number(process.env.RATE_LIMIT_API_PER_MIN) || 120; },
  get rateLimitAuthPerMin() { return Number(process.env.RATE_LIMIT_AUTH_PER_MIN) || 10; },

  // Database backups (file databases only). Empty BACKUP_DIR = "<database folder>/backups".
  get backupDir() { return process.env.BACKUP_DIR || ''; },
  get backupIntervalHours() { return numberOr(process.env.BACKUP_INTERVAL_HOURS, 6); },
  get backupKeep() { return numberOr(process.env.BACKUP_KEEP, 7); },

  // Checkout pricing, all in integer cents. Shipping is free at or above the threshold.
  get shippingFlatCents() { return numberOr(process.env.SHIPPING_FLAT_CENTS, 599); },
  get freeShippingThresholdCents() { return numberOr(process.env.FREE_SHIPPING_THRESHOLD_CENTS, 5000); },
  // Sales tax percentage applied to the items subtotal (e.g. 8.25). 0 = no tax.
  get taxRatePercent() { return numberOr(process.env.TAX_RATE_PERCENT, 0); },

  // Accounts: login session lifetime and whether cookies need HTTPS (auto: secure when served over HTTPS)
  get sessionDays() { return numberOr(process.env.AUTH_SESSION_DAYS, 30); },

  // Logging: "json" (one JSON object per line, for hosting platforms) or "pretty"
  get logFormat() { return process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'pretty'); },
  get logLevel() { return process.env.LOG_LEVEL || 'info'; }
};

// Numeric env var with a default; allows an explicit 0
function numberOr(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

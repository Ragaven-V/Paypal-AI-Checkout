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

  get paypalClientId() { return process.env.PAYPAL_CLIENT_ID || ''; },
  get paypalClientSecret() { return process.env.PAYPAL_CLIENT_SECRET || ''; },
  get paypalBaseUrl() { return process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com'; },
  get paypalWebhookId() { return process.env.PAYPAL_WEBHOOK_ID || ''; },

  // Express "trust proxy" setting, needed behind a reverse proxy so req.ip is the real client IP.
  get trustProxy() { return process.env.TRUST_PROXY || ''; },
  get rateLimitChatPerMin() { return Number(process.env.RATE_LIMIT_CHAT_PER_MIN) || 20; },
  get rateLimitApiPerMin() { return Number(process.env.RATE_LIMIT_API_PER_MIN) || 120; }
};

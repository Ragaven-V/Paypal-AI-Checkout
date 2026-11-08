import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { SYSTEM_INSTRUCTIONS } from './instructions.js';
import { GEMINI_TOOLS, runToolCall } from './tools.js';
import { catalog } from '../catalog.js';
import { chatStore } from '../db.js';

let aiClient = null;

// Explicit context cache (optional; Gemini falls back to implicit prefix caching when it can't be created)
const CACHE_TTL_SECONDS = 1800;
let explicitCache = null;
let cacheExpiresAt = 0;
let cacheRefreshInFlight = false;

// Health of the live AI path, so a silent fallback is visible in /api/config and the UI
export const aiHealth = { ok: null, lastError: null, lastErrorAt: null, lastOkAt: null };

const MAX_TOOL_ROUNDS = 5;

if (!config.mockAiForced && config.geminiApiKey) {
  try {
    aiClient = new GoogleGenAI({
      apiKey: config.geminiApiKey,
      httpOptions: {
        timeout: config.geminiTimeoutMs,
        retryOptions: { attempts: config.geminiRetryAttempts, initialDelay: 0.5, maxDelay: 2 }
      }
    });
  } catch (err) {
    console.warn('Warning: Failed to initialize GoogleGenAI client, will use Mock AI mode:', err.message);
  }
}

export function isAiEnabled() {
  return Boolean(aiClient);
}

// ---- Quota cooldown (circuit breaker) ------------------------------------------------------
// After a 429 / RESOURCE_EXHAUSTED, stop calling Gemini for the delay Google suggests, so
// shoppers get the fallback assistant instantly instead of waiting on doomed requests.
let cooldownUntil = 0;
const MIN_COOLDOWN_S = 10;
const MAX_COOLDOWN_S = 120;

export const isQuotaError = (err) => /\b429\b|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(String(err?.message || err));

function retryDelaySeconds(err) {
  const text = String(err?.message || err);
  // "retryDelay": "23s" (quotes may be escaped inside a nested error string) or "retry in 23s"
  const match = text.match(/retryDelay[^0-9]{0,8}(\d+(?:\.\d+)?)s/i) || text.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  const seconds = match ? Number(match[1]) : 30;
  return Math.min(MAX_COOLDOWN_S, Math.max(MIN_COOLDOWN_S, Math.ceil(seconds)));
}

export function aiCooldownRemainingMs() {
  return Math.max(0, cooldownUntil - Date.now());
}

export function resetAiCooldownForTesting() {
  cooldownUntil = 0;
}

// Test hook: inject a fake client (or null to force mock mode)
export function setAiClientForTesting(client) {
  aiClient = client;
  cooldownUntil = 0;
  explicitCache = null;
  cacheExpiresAt = 0;
  resetAiHealth();
}

export function resetAiHealth() {
  aiHealth.ok = null;
  aiHealth.lastError = null;
  aiHealth.lastErrorAt = null;
  aiHealth.lastOkAt = null;
}

function recordAiSuccess() {
  aiHealth.ok = true;
  aiHealth.lastOkAt = Date.now();
}

function recordAiFailure(err) {
  if (isQuotaError(err)) {
    cooldownUntil = Date.now() + retryDelaySeconds(err) * 1000;
  }
  aiHealth.ok = false;
  aiHealth.lastError = String(err?.message || err).slice(0, 300);
  aiHealth.lastErrorAt = Date.now();
}

/**
 * Thinking configuration.
 * Gemini 3 models take `thinkingLevel`; `thinkingBudget: 0` (the Gemini 2.5 way to disable
 * thinking) is rejected by Gemini 3 models with 400 INVALID_ARGUMENT, which is what broke chat.
 * Leave GEMINI_THINKING_LEVEL empty to use the model default.
 */
const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);

export function buildThinkingConfig(model = config.geminiModel, level = config.geminiThinkingLevel) {
  if (!level || !THINKING_LEVELS.has(level)) return undefined;
  if (/^gemini-2\./.test(model)) {
    // Gemini 2.5 (deprecated): budget tokens. 0 disables thinking on 2.5 Flash/Flash-Lite only.
    const budgets = { minimal: 0, low: 1024, medium: 8192, high: -1 };
    return { thinkingBudget: budgets[level] };
  }
  // Gemini 3+: ThinkingLevel enum values are uppercase strings ("MINIMAL" | "LOW" | "MEDIUM" | "HIGH").
  // Thinking cannot be fully disabled on Gemini 3; MINIMAL is the floor on models that offer it.
  return { thinkingLevel: level.toUpperCase() };
}

function baseGenerationConfig() {
  const thinkingConfig = buildThinkingConfig();
  return thinkingConfig ? { thinkingConfig } : {};
}

async function setupExplicitCache() {
  if (!aiClient) return;
  try {
    explicitCache = await aiClient.caches.create({
      model: config.geminiModel,
      config: {
        displayName: 'ask_and_buy_store_cache',
        ttl: `${CACHE_TTL_SECONDS}s`,
        systemInstruction: SYSTEM_INSTRUCTIONS,
        tools: GEMINI_TOOLS,
        contents: [{ role: 'user', parts: [{ text: `Store Catalog Reference:\n${JSON.stringify(catalog)}` }] }]
      }
    });
    // Refresh slightly before the server-side TTL elapses
    cacheExpiresAt = Date.now() + (CACHE_TTL_SECONDS - 60) * 1000;
    console.log('⚡ Explicit context caching initialized:', explicitCache.name);
  } catch (err) {
    // Usually: content below the model's minimum cacheable token count. Implicit caching still applies.
    explicitCache = null;
    console.log('⚡ Context caching using implicit prefix caching mode:', String(err.message).slice(0, 160));
  }
}

function refreshExplicitCache() {
  if (cacheRefreshInFlight) return;
  cacheRefreshInFlight = true;
  setupExplicitCache().finally(() => {
    cacheRefreshInFlight = false;
  });
}

// Cache name only while still valid; schedules a refresh once it expires
function getValidCacheName() {
  if (explicitCache?.name && Date.now() < cacheExpiresAt) {
    return explicitCache.name;
  }
  if (explicitCache) {
    explicitCache = null;
    refreshExplicitCache();
  }
  return null;
}

function createGeminiChat(history = []) {
  const cacheName = getValidCacheName();
  // A cachedContent request must not also set systemInstruction/tools (they live in the cache)
  const chatConfig = cacheName
    ? { ...baseGenerationConfig(), cachedContent: cacheName }
    : { ...baseGenerationConfig(), systemInstruction: SYSTEM_INSTRUCTIONS, tools: GEMINI_TOOLS };

  const chat = aiClient.chats.create({ model: config.geminiModel, history, config: chatConfig });
  chat.cacheName = cacheName;
  return chat;
}

// A user turn that starts a real exchange (text), not a functionResponse turn
function isUserTextTurn(content) {
  return content.role === 'user' &&
    Array.isArray(content.parts) &&
    content.parts.some(p => typeof p.text === 'string') &&
    !content.parts.some(p => p.functionResponse);
}

const MAX_HISTORY = 12;
const KEEP_HISTORY = 8;

// Keep the most recent turns, starting at a user text turn so no functionCall/functionResponse
// pair is cut in half (Gemini rejects orphaned function turns)
export function trimHistory(history, maxLength = MAX_HISTORY, keep = KEEP_HISTORY) {
  if (!Array.isArray(history)) return [];
  let start = history.length > maxLength ? history.length - keep : 0;
  while (start < history.length && !isUserTextTurn(history[start])) {
    start++;
  }
  return history.slice(start);
}

// Get the session's chat, recreating it when the cache expired or history grew too long.
// After a restart the chat is rebuilt from the history saved in the database.
function getSessionChat(session) {
  if (!session.chat) {
    session.chat = createGeminiChat(trimHistory(session.savedHistory || []));
    session.savedHistory = null;
    return session.chat;
  }
  const history = session.chat.getHistory();
  const cacheStale = session.chat.cacheName && session.chat.cacheName !== getValidCacheName();
  if (history.length > MAX_HISTORY || cacheStale) {
    session.chat = createGeminiChat(trimHistory(history));
  }
  return session.chat;
}

// Read text and function calls straight from the parts (avoids the SDK's non-text-parts warning
// from chunk.text, and skips thought summaries)
function readChunk(chunk) {
  const parts = chunk?.candidates?.[0]?.content?.parts || [];
  let text = '';
  const calls = [];
  for (const part of parts) {
    if (part.functionCall) calls.push(part.functionCall);
    else if (typeof part.text === 'string' && !part.thought) text += part.text;
  }
  return { text, calls };
}

async function consumeStream(stream, onText, calls) {
  let text = '';
  for await (const chunk of stream) {
    const read = readChunk(chunk);
    if (read.text) {
      text += read.text;
      onText(read.text);
    }
    calls.push(...read.calls);
  }
  return text;
}

/**
 * Run one user turn through Gemini, including tool rounds.
 * Callbacks: onText(textDelta), onEvent({type:'products'|'cart'|'status', ...}).
 * Resolves { text, products, toolsRan }. On failure throws an error carrying
 * { toolsRan, partialText } so the caller never replays tools via the mock assistant.
 */
export async function runGeminiTurn(session, message, { onText = () => {}, onEvent = () => {} } = {}) {
  let text = '';
  let toolsRan = false;
  let products = [];

  const trackEvent = (event) => {
    if (event.type === 'products') products = event.products;
    onEvent(event);
  };

  try {
    const chat = getSessionChat(session);
    let calls = [];
    text += await consumeStream(await chat.sendMessageStream({ message }), onText, calls);

    let rounds = 0;
    while (calls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      toolsRan = true;
      onEvent({ type: 'status', message: 'Checking catalog...' });

      // All responses for a round go back together, in call order
      const responseParts = calls.map(call => runToolCall(session, call, trackEvent));
      calls = [];
      text += await consumeStream(await chat.sendMessageStream({ message: responseParts }), onText, calls);
    }

    recordAiSuccess();
    try {
      chatStore.saveHistory(session.id, chat.getHistory());
    } catch (saveErr) {
      console.error('Could not save chat history:', saveErr.message);
    }
    return { text, products, toolsRan };
  } catch (err) {
    recordAiFailure(err);
    // History may now end in an unanswered functionCall; start a fresh chat next turn,
    // and drop the saved copy too in case it is what the model rejected
    session.chat = null;
    session.savedHistory = null;
    try { chatStore.clearHistory(session.id); } catch { /* ignore */ }
    err.toolsRan = toolsRan;
    err.partialText = text;
    throw err;
  }
}

/**
 * Startup self-check: send one tiny request with the exact production config, so a
 * misconfiguration (bad model id, unsupported thinking option, ...) is logged loudly at boot
 * instead of silently degrading every chat to the mock assistant.
 */
export async function runAiSelfCheck() {
  if (!aiClient) return { ok: false, skipped: true };
  try {
    await aiClient.models.generateContent({
      model: config.geminiModel,
      contents: 'Reply with OK.',
      config: { ...baseGenerationConfig(), systemInstruction: SYSTEM_INSTRUCTIONS, tools: GEMINI_TOOLS }
    });
    recordAiSuccess();
    console.log(`✅ Gemini self-check passed (${config.geminiModel})`);
    return { ok: true };
  } catch (err) {
    recordAiFailure(err);
    console.error(`❌ Gemini self-check FAILED for ${config.geminiModel}: ${aiHealth.lastError}`);
    console.error('   Chat will fall back to the rule-based assistant until this is fixed.');
    return { ok: false, error: aiHealth.lastError };
  }
}

export function startAiBackground() {
  if (!aiClient) return;
  // Explicit caching needs >= ~4,096 tokens on Gemini 3; the catalog prompt is far below that,
  // so it is opt-in. Implicit prefix caching applies automatically either way.
  if (config.geminiExplicitCache) refreshExplicitCache();
  runAiSelfCheck();
}

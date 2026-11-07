import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load Catalog
const catalogPath = path.join(__dirname, 'catalog.json');
export const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
export const catalogMap = new Map(catalog.map(p => [p.id, p]));

// Sessions in-memory store
export const sessions = new Map();

// PayPal Token Cache
let cachedPayPalToken = null;

// Explicit Context Cache Resource
let explicitCacheResource = null;
let cacheExpiresAt = 0;
let cacheRefreshInFlight = false;
const CACHE_TTL_SECONDS = 1800;

// Initialize Gemini Client
const geminiApiKey = process.env.GEMINI_API_KEY;
const isMockAiConfigured = process.env.MOCK_AI === 'true' || !geminiApiKey || geminiApiKey.trim() === '';
let aiClient = null;

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

if (!isMockAiConfigured) {
  try {
    aiClient = new GoogleGenAI({ apiKey: geminiApiKey });
    // Explicit context caching is started after the tool declarations below
  } catch (err) {
    console.warn('Warning: Failed to initialize GoogleGenAI client, will use Mock AI mode:', err.message);
  }
}

/**
 * System Instructions for Store Assistant
 */
const SYSTEM_INSTRUCTIONS = `You are Ask & Buy, an AI shopping assistant for a boutique online store.
Your main role is to help shoppers discover products, answer questions, manage their cart, and prepare for PayPal checkout.

CONVERSATION GUIDELINES:
1. GREETINGS & CASUAL CHAT: When the shopper greets you (e.g. "hi", "hello", "hey") or chats casually (e.g. "how are you?", "tell me a joke"), respond naturally and pleasantly. Do NOT forcefully push product sales or call search_products for casual chat unless they ask about products, gifts, or shopping.
2. OFF-TOPIC QUESTIONS: If asked an off-topic or general question, answer briefly and politely, then gently mention that you are also here to assist with store shopping if they need anything.
3. SEARCH TOOLS: Only call search_products when the user expresses intent to find, view, or buy products, mentions a budget, or asks for recommendations.
4. STRICT PRICING RULES: You NEVER compute, invent, or set prices or order totals yourself. Prices and totals are computed strictly by the server and returned by the cart tools.
5. STRICT CHECKOUT RULES: Only the PayPal button on the page can approve or capture payment. You must NEVER claim you charged a payment. When the shopper is ready to pay, tell them to review their cart and click the PayPal button.
6. When recommending items, state their name and price clearly.`;

/**
 * Explicit Context Caching Setup
 */
async function setupExplicitCache() {
  if (!aiClient || isMockAiConfigured) return;
  try {
    explicitCacheResource = await aiClient.caches.create({
      model: DEFAULT_MODEL,
      config: {
        displayName: 'ask_and_buy_store_cache',
        ttl: `${CACHE_TTL_SECONDS}s`,
        systemInstruction: SYSTEM_INSTRUCTIONS,
        tools: GEMINI_TOOLS,
        contents: [
          {
            role: 'user',
            parts: [{ text: `Store Catalog Reference:\n${JSON.stringify(catalog)}` }]
          }
        ]
      }
    });
    // Refresh slightly before the server-side TTL elapses
    cacheExpiresAt = Date.now() + (CACHE_TTL_SECONDS - 60) * 1000;
    console.log('⚡ Explicit context caching initialized:', explicitCacheResource.name);
  } catch (err) {
    // If below token minimum, Gemini automatically uses implicit prompt caching
    explicitCacheResource = null;
  }
}

/**
 * Session Management & Cleanup
 */
export function getOrCreateSession(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    sessionId = 'session_' + Math.random().toString(36).substring(2, 12);
  }
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      id: sessionId,
      cart: new Map(), // productId -> quantity (integer 1..10)
      chat: null,
      currentOrderId: null, // Track generated PayPal order ID
      lastActive: Date.now(),
      messageCount: 0,
      windowStart: Date.now()
    };
    sessions.set(sessionId, session);
  } else {
    session.lastActive = Date.now();
  }
  return session;
}

// Periodic cleanup of sessions inactive for > 2 hours (runs every 15 minutes)
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActive > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

/**
 * Cart Calculations (Strictly in Integer Cents)
 */
export function getCartSummary(session) {
  const items = [];
  let totalCents = 0;
  let itemCount = 0;

  for (const [productId, qty] of session.cart.entries()) {
    const product = catalogMap.get(productId);
    if (!product) continue;

    const quantity = Math.max(1, Math.min(10, Math.floor(Number(qty) || 1)));
    const priceInCents = Math.round(product.price * 100);
    const subtotalInCents = priceInCents * quantity;

    totalCents += subtotalInCents;
    itemCount += quantity;

    items.push({
      id: product.id,
      name: product.name,
      price: product.price,
      priceInCents,
      quantity,
      subtotalInCents,
      formattedSubtotal: `$${(subtotalInCents / 100).toFixed(2)}`
    });
  }

  return {
    items,
    itemCount,
    totalCents,
    totalFormatted: `$${(totalCents / 100).toFixed(2)}`
  };
}

/**
 * Tool Execution Functions
 */
export function executeSearchProducts(query, maxPrice) {
  const rawQ = String(query || '').toLowerCase().trim();
  const max = typeof maxPrice === 'number' && maxPrice > 0 ? maxPrice : null;

  // Clean and tokenize query
  const cleanQ = rawQ.replace(/[^a-z0-9\s]/g, ' ').trim();
  if (!cleanQ && max === null) {
    return [];
  }

  // Common conversational stop words to ignore during search
  const stopWords = new Set(['hi', 'hello', 'hey', 'the', 'a', 'an', 'and', 'or', 'for', 'in', 'of', 'to', 'with', 'at', 'is', 'me', 'my', 'i', 'need', 'want', 'show', 'find', 'get', 'some', 'please']);
  const tokens = cleanQ.split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w));

  // If query was only greetings or stop words with no budget filter, return empty
  if (tokens.length === 0 && max === null) {
    return [];
  }

  const matches = catalog.filter(p => {
    if (max !== null && p.price > max) return false;
    if (tokens.length === 0) return true; // Budget-only filter matches within budget

    const nameLower = p.name.toLowerCase();
    const catLower = p.category.toLowerCase();
    const descLower = p.description.toLowerCase();
    const tagsLower = p.tags.map(t => t.toLowerCase());

    return tokens.some(token => {
      // Use whole-word boundary for short tokens (<= 3 chars) so 'hi' doesn't match 'whisper'
      if (token.length <= 3) {
        const regex = new RegExp(`\\b${token}\\b`, 'i');
        return regex.test(nameLower) || regex.test(catLower) || regex.test(descLower) || tagsLower.includes(token);
      }
      return nameLower.includes(token) || catLower.includes(token) || descLower.includes(token) || tagsLower.some(t => t.includes(token));
    });
  });

  return matches.slice(0, 5);
}

export function executeAddToCart(session, productId, quantity = 1) {
  const product = catalogMap.get(productId);
  if (!product) {
    return { success: false, error: `Product "${productId}" not found in catalog.` };
  }

  const validQty = Math.max(1, Math.min(10, Math.floor(Number(quantity) || 1)));
  const currentQty = session.cart.get(productId) || 0;
  const newQty = Math.min(10, currentQty + validQty);

  session.cart.set(productId, newQty);
  const cartSummary = getCartSummary(session);

  return {
    success: true,
    message: `Added ${validQty}x "${product.name}" to cart.`,
    item: { id: product.id, name: product.name, quantity: newQty },
    cart: cartSummary
  };
}

export function executeDecrementCart(session, productId, amount = 1) {
  const product = catalogMap.get(productId);
  if (!product) {
    return { success: false, error: `Product "${productId}" not found in catalog.` };
  }

  const dec = Math.max(1, Math.min(10, Math.floor(Number(amount) || 1)));
  const currentQty = session.cart.get(productId) || 0;
  const newQty = currentQty - dec;
  if (newQty > 0) {
    session.cart.set(productId, newQty);
  } else {
    session.cart.delete(productId);
  }

  return {
    success: true,
    message: `Updated "${product.name}" quantity to ${Math.max(0, newQty)}.`,
    item: { id: product.id, name: product.name, quantity: Math.max(0, newQty) },
    cart: getCartSummary(session)
  };
}

export function executeRemoveFromCart(session, productId) {
  const product = catalogMap.get(productId);
  if (!product) {
    return { success: false, error: `Product "${productId}" not found in catalog.` };
  }

  const existed = session.cart.delete(productId);
  const cartSummary = getCartSummary(session);

  return {
    success: true,
    removed: existed,
    message: existed ? `Removed "${product.name}" from cart.` : `"${product.name}" was not in cart.`,
    cart: cartSummary
  };
}

export function executeViewCart(session) {
  const cartSummary = getCartSummary(session);
  return {
    success: true,
    items: cartSummary.items,
    item_count: cartSummary.itemCount,
    total: cartSummary.totalFormatted,
    total_cents: cartSummary.totalCents
  };
}

/**
 * Gemini Tool Declarations
 */
const searchProductsDeclaration = {
  name: 'search_products',
  description: 'Search the product catalog by keywords and an optional maximum price in USD. Returns up to 5 matching products.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'Keywords, gift recipient, or product category (e.g. "coffee grinder", "dad", "kettle").'
      },
      max_price: {
        type: Type.NUMBER,
        description: 'Maximum budget in dollars (e.g. 50).'
      }
    },
    required: ['query']
  }
};

const addToCartDeclaration = {
  name: 'add_to_cart',
  description: 'Add an item to the shopping cart by product ID with a quantity between 1 and 10.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      product_id: {
        type: Type.STRING,
        description: 'The product ID from the catalog (e.g. "p1", "p2").'
      },
      quantity: {
        type: Type.INTEGER,
        description: 'Number of units to add (1 to 10). Defaults to 1.'
      }
    },
    required: ['product_id']
  }
};

const removeFromCartDeclaration = {
  name: 'remove_from_cart',
  description: 'Remove an item completely from the shopping cart by product ID.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      product_id: {
        type: Type.STRING,
        description: 'The product ID to remove (e.g. "p1").'
      }
    },
    required: ['product_id']
  }
};

const viewCartDeclaration = {
  name: 'view_cart',
  description: 'View current items in the shopping cart and the server-calculated total price.',
  parameters: {
    type: Type.OBJECT,
    properties: {}
  }
};

const GEMINI_TOOLS = [
  {
    functionDeclarations: [
      searchProductsDeclaration,
      addToCartDeclaration,
      removeFromCartDeclaration,
      viewCartDeclaration
    ]
  }
];

// Attempt explicit context caching (needs SYSTEM_INSTRUCTIONS and GEMINI_TOOLS defined above)
function refreshExplicitCache() {
  if (cacheRefreshInFlight) return;
  cacheRefreshInFlight = true;
  setupExplicitCache()
    .catch(err => {
      console.log('⚡ Context caching using implicit prefix caching mode:', err.message);
    })
    .finally(() => {
      cacheRefreshInFlight = false;
    });
}

// Returns the cache name only while it is still valid; schedules a refresh once it expires
function getValidCacheName() {
  if (explicitCacheResource && explicitCacheResource.name && Date.now() < cacheExpiresAt) {
    return explicitCacheResource.name;
  }
  if (explicitCacheResource) {
    explicitCacheResource = null;
    refreshExplicitCache();
  }
  return null;
}

if (aiClient && !isMockAiConfigured) {
  refreshExplicitCache();
}

/**
 * Rule-Based Mock AI Mode
 */
export function runMockAi(session, userMessage) {
  const text = (userMessage || '').toLowerCase().trim();
  const cleanText = text.replace(/[^a-z0-9\s]/g, ' ').trim();
  let reply = '';
  let products = [];

  // Check for greetings (e.g. "hi", "hello", "hey")
  const greetingWords = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'howdy', 'yo', 'sup', 'greetings'];
  const isGreeting = greetingWords.some(g => cleanText === g || cleanText.startsWith(g + ' '));
  const hasShoppingKeywords = ['coffee', 'grinder', 'mug', 'kettle', 'gift', 'dad', 'cart', 'buy', 'add', 'under', 'price', 'dollar', 'earbuds', 'wallet', 'charger'].some(k => cleanText.includes(k));

  if (isGreeting && !hasShoppingKeywords) {
    return {
      reply: "Hello! Welcome to Ask & Buy. How can I help you today? Are you looking for a gift, coffee gear, tech gadgets, or something else?",
      products: [],
      cart: getCartSummary(session)
    };
  }

  // Check for common off-topic / conversational intents in mock mode
  if (text.includes('joke')) {
    return {
      reply: "Why did the coffee file a police report? It got mugged! 😄 Speaking of coffee, let me know if you need any gift ideas or store recommendations!",
      products: [],
      cart: getCartSummary(session)
    };
  }
  if (text.includes('who are you') || text.includes('what can you do') || text.includes('how do you work')) {
    return {
      reply: "I'm Ask & Buy, your AI shopping assistant! I can recommend products based on your budget and tastes, manage your cart (add or remove items), and help you check out with PayPal.",
      products: [],
      cart: getCartSummary(session)
    };
  }

  // Check for cart / view cart intent
  if (text.includes('cart') && (text.includes('view') || text.includes('show') || text.includes('what') || text === 'cart' || text.includes('check'))) {
    const summary = getCartSummary(session);
    if (summary.items.length === 0) {
      reply = "Your shopping cart is currently empty. What kind of items are you looking for today? We have great coffee gear, tech gadgets, and home gifts!";
    } else {
      const itemsList = summary.items.map(i => `${i.quantity}x ${i.name} ($${(i.subtotalInCents / 100).toFixed(2)})`).join(', ');
      reply = `You have ${summary.itemCount} item(s) in your cart: ${itemsList}.\nTotal: ${summary.totalFormatted}.\n\nWhen you're ready to purchase, please click the PayPal button on the right to complete checkout securely!`;
    }
    return { reply, products: [], cart: summary };
  }

  // Check for remove intent
  if (text.includes('remove') || text.includes('delete') || text.includes('drop')) {
    const summary = getCartSummary(session);
    const itemToRemove = summary.items.find(item => {
      const nameLower = item.name.toLowerCase();
      if (text.includes(nameLower)) return true;
      const words = nameLower.split(' ').filter(w => w.length >= 3);
      return words.some(w => text.includes(w));
    });

    if (itemToRemove) {
      executeRemoveFromCart(session, itemToRemove.id);
      const updatedSummary = getCartSummary(session);
      reply = `Removed "${itemToRemove.name}" from your cart. Your updated total is ${updatedSummary.totalFormatted}.`;
      return { reply, products: [], cart: updatedSummary };
    } else {
      reply = "I couldn't find that item in your cart. You can say 'view cart' to review your items, or click the trash icon next to any item in the cart.";
      return { reply, products: [], cart: summary };
    }
  }

  // Check for add intent
  // Whole words only, so 'budget'/'gadget'/'together' or 'address' don't trigger an add
  if (/\b(add|buy|get)\b/.test(cleanText)) {
    const nameStopWords = new Set(['for', 'the', 'and', 'with', 'set', 'pro']);
    const foundProduct = catalog.find(p => {
      const nameLower = p.name.toLowerCase();
      if (text.includes(nameLower)) return true;
      const keyWords = ['grinder', 'mug', 'kettle', 'cold brew', 'tumbler', 'earbuds', 'wallet', 'diffuser', 'espresso', 'knife'];
      for (const kw of keyWords) {
        if (text.includes(kw) && nameLower.includes(kw)) return true;
      }
      const words = nameLower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !nameStopWords.has(w));
      return words.some(w => new RegExp(`\\b${w}\\b`).test(cleanText));
    });

    if (foundProduct) {
      let qty = 1;
      const qtyMatch = text.match(/\b([1-9]|10)\b/);
      if (qtyMatch) {
        qty = parseInt(qtyMatch[1], 10);
      }
      executeAddToCart(session, foundProduct.id, qty);
      const updatedSummary = getCartSummary(session);
      reply = `Added ${qty}x "${foundProduct.name}" ($${foundProduct.price.toFixed(2)}) to your cart! Your current total is ${updatedSummary.totalFormatted}. You can continue shopping or click the PayPal button to check out.`;
      return { reply, products: [foundProduct], cart: updatedSummary };
    }
  }

  // Search & Recommendations
  let maxBudget = null;
  const budgetMatch = text.match(/under\s*\$?(\d+(\.\d+)?)/i) || text.match(/less than\s*\$?(\d+(\.\d+)?)/i) || text.match(/budget\s*\$?(\d+(\.\d+)?)/i);
  if (budgetMatch) {
    maxBudget = parseFloat(budgetMatch[1]);
  }

  const results = executeSearchProducts(text, maxBudget);
  products = results;

  if (results.length > 0) {
    const list = results.map(p => `• **${p.name}** ($${p.price.toFixed(2)}) — ${p.description}`).join('\n');
    reply = `Here are recommendations that match your request:\n\n${list}\n\nWould you like me to add any of these to your cart? You can say "add the grinder" or use the "+ Add to Cart" buttons on the product cards below!`;
  } else {
    // If user asked about shopping/gifts/budget but nothing matched
    const isShoppingQuery = ['gift', 'looking', 'recommend', 'buy', 'shop', 'product', 'items', 'find', 'under', 'budget'].some(k => text.includes(k));
    if (isShoppingQuery) {
      products = catalog.slice(0, 3);
      reply = "I couldn't find an exact match for that, but here are three popular gift selections from our store. Tell me if any catch your eye, or feel free to ask by budget or category!";
    } else {
      products = [];
      reply = "I'm primarily focused on helping you shop, find gifts, manage your cart, and check out securely via PayPal. Feel free to ask about our coffee gear, tech gadgets, or lifestyle gifts!";
    }
  }

  return { reply, products, cart: getCartSummary(session) };
}

/**
 * PayPal API Helpers
 */
export async function getPayPalAccessToken() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const baseUrl = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';

  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials missing: please set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env');
  }

  if (cachedPayPalToken && cachedPayPalToken.expiresAt > Date.now() + 60000) {
    return cachedPayPalToken.token;
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`PayPal OAuth authentication failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  cachedPayPalToken = {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in || 3600) * 1000)
  };
  return cachedPayPalToken.token;
}

export async function createPayPalOrder(session) {
  const cartSummary = getCartSummary(session);
  if (cartSummary.items.length === 0) {
    const err = new Error('Your cart is empty. Please add items before checking out.');
    err.status = 400;
    throw err;
  }

  const token = await getPayPalAccessToken();
  const baseUrl = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
  const totalDollars = (cartSummary.totalCents / 100).toFixed(2);

  const purchaseUnit = {
    reference_id: session.id,
    description: 'Ask & Buy Order Checkout',
    amount: {
      currency_code: 'USD',
      value: totalDollars,
      breakdown: {
        item_total: {
          currency_code: 'USD',
          value: totalDollars
        }
      }
    },
    items: cartSummary.items.map(item => ({
      name: item.name.slice(0, 127),
      unit_amount: {
        currency_code: 'USD',
        value: (item.priceInCents / 100).toFixed(2)
      },
      quantity: String(item.quantity)
    }))
  };

  const res = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [purchaseUnit]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`PayPal order creation failed (${res.status}): ${errText}`);
  }

  const order = await res.json();
  session.currentOrderId = order.id;
  // Snapshot exactly what this order charges for, so capture only removes paid items
  session.currentOrderItems = new Map(cartSummary.items.map(i => [i.id, i.quantity]));
  session.currentOrderTotal = cartSummary.totalFormatted;
  return order;
}

export async function capturePayPalOrder(session, orderID) {
  if (!session.currentOrderId || session.currentOrderId !== orderID) {
    const err = new Error('Untrusted or invalid order ID for this session.');
    err.status = 400;
    throw err;
  }

  const token = await getPayPalAccessToken();
  const baseUrl = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';

  const res = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`PayPal capture failed (${res.status}): ${errText}`);
  }

  const captureData = await res.json();
  if (captureData.status === 'COMPLETED') {
    // Remove only the quantities that were in the paid order; items added afterwards stay
    for (const [productId, paidQty] of (session.currentOrderItems || new Map())) {
      const remaining = (session.cart.get(productId) || 0) - paidQty;
      if (remaining > 0) {
        session.cart.set(productId, remaining);
      } else {
        session.cart.delete(productId);
      }
    }
    captureData.paidTotal = session.currentOrderTotal;
    session.currentOrderId = null;
    session.currentOrderItems = null;
    session.currentOrderTotal = null;
  }
  return captureData;
}

/**
 * Express Application Setup
 */
export const app = express();
app.use(express.json());

// Serve static assets with path based on import.meta.url
app.use(express.static(path.join(__dirname, 'public')));

// Public Configuration endpoint (Never expose secrets!)
app.get('/api/config', (req, res) => {
  res.json({
    paypalClientId: process.env.PAYPAL_CLIENT_ID || '',
    mockAi: isMockAiConfigured || !aiClient,
    modelName: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
  });
});

// Catalog endpoint
app.get('/api/catalog', (req, res) => {
  res.json({ products: catalog });
});

// Cart Status endpoint
app.get('/api/cart', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing sessionId query parameter' });
  }
  const session = getOrCreateSession(sessionId);
  res.json({ cart: getCartSummary(session) });
});

// Cart Add Item endpoint
app.post('/api/cart/add', (req, res) => {
  const { sessionId, id, quantity } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Invalid or missing sessionId' });
  }
  if (!id || typeof id !== 'string' || !catalogMap.has(id)) {
    return res.status(400).json({ error: 'Invalid product id' });
  }

  const session = getOrCreateSession(sessionId);
  const qty = Number(quantity);
  const result = qty < 0
    ? executeDecrementCart(session, id, -qty)
    : executeAddToCart(session, id, quantity || 1);
  res.json(result);
});

// Cart Remove Item endpoint
app.post('/api/cart/remove', (req, res) => {
  const { sessionId, id } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Invalid or missing sessionId' });
  }
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Invalid product id' });
  }

  const session = getOrCreateSession(sessionId);
  const result = executeRemoveFromCart(session, id);
  res.json(result);
});

function createGeminiChat(history = []) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const cacheName = getValidCacheName();
  // A cachedContent request must not also set systemInstruction/tools (they live in the cache)
  const config = cacheName
    ? { cachedContent: cacheName }
    : { systemInstruction: SYSTEM_INSTRUCTIONS, tools: GEMINI_TOOLS };

  const chat = aiClient.chats.create({
    model,
    history,
    config
  });
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

// Get the session's chat, recreating it when the cache expired or history grew too long
function getSessionChat(session) {
  if (!session.chat) {
    session.chat = createGeminiChat();
    return session.chat;
  }
  const history = session.chat.getHistory();
  const cacheStale = session.chat.cacheName && session.chat.cacheName !== getValidCacheName();
  if (history.length > 12 || cacheStale) {
    let sliceStart = history.length > 12 ? history.length - 8 : 0;
    while (sliceStart < history.length && !isUserTextTurn(history[sliceStart])) {
      sliceStart++;
    }
    session.chat = createGeminiChat(history.slice(sliceStart));
  }
  return session.chat;
}

// Chat endpoint with Gemini & Fallback Mock AI (Supports both streaming and standard JSON)
app.post('/api/chat', async (req, res) => {
  const { sessionId, message, stream } = req.body || {};

  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
    return res.status(400).json({ error: 'Valid sessionId is required' });
  }
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Valid non-empty message is required' });
  }
  if (message.length > 1000) {
    return res.status(400).json({ error: 'Message exceeds maximum length of 1000 characters' });
  }

  const session = getOrCreateSession(sessionId);

  // Rate Limiting: Max 25 messages per 60s per session
  const now = Date.now();
  if (now - session.windowStart > 60000) {
    session.windowStart = now;
    session.messageCount = 0;
  }
  session.messageCount++;
  if (session.messageCount > 25) {
    return res.status(429).json({ error: 'Rate limit exceeded: too many requests. Please wait a moment.' });
  }

  const isStreamRequest = stream === true || req.headers.accept?.includes('text/event-stream') || req.query.stream === 'true';

  // --- STREAMING MODE (Server-Sent Events) ---
  if (isStreamRequest) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (res.flushHeaders) res.flushHeaders();

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // If Mock AI mode
    if (isMockAiConfigured || !aiClient) {
      const mockResult = runMockAi(session, message);
      if (mockResult.products && mockResult.products.length > 0) {
        sendEvent({ type: 'products', products: mockResult.products });
      }
      const words = mockResult.reply.split(' ');
      for (let i = 0; i < words.length; i += 3) {
        const slice = words.slice(i, i + 3).join(' ') + (i + 3 < words.length ? ' ' : '');
        sendEvent({ type: 'chunk', text: slice });
        await new Promise(r => setTimeout(r, 15));
      }
      sendEvent({ type: 'cart', cart: mockResult.cart });
      sendEvent({ type: 'done' });
      return res.end();
    }

    let fullText = '';
    let toolsRan = false;
    try {
      getSessionChat(session);

      sendEvent({ type: 'start' });

      let responseStream = await session.chat.sendMessageStream({ message });
      let functionCalls = [];
      let loopCount = 0;
      let recommendedProducts = [];

      for await (const chunk of responseStream) {
        if (chunk.text) {
          fullText += chunk.text;
          sendEvent({ type: 'chunk', text: chunk.text });
        }
        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          functionCalls.push(...chunk.functionCalls);
        }
      }

      // Streamlined Parallel Tool Execution Loop
      while (functionCalls.length > 0 && loopCount < 5) {
        loopCount++;
        const currentCalls = functionCalls;
        functionCalls = [];

        sendEvent({ type: 'status', message: 'Checking catalog...' });
        toolsRan = true;

        // Streamlined parallel tool execution
        const functionResponseParts = await Promise.all(currentCalls.map(async (call) => {
          const { name, args, id } = call;
          let toolResult;

          if (name === 'search_products') {
            const rawResults = executeSearchProducts(args?.query, args?.max_price);
            if (Array.isArray(rawResults) && rawResults.length > 0) {
              recommendedProducts = rawResults;
              sendEvent({ type: 'products', products: rawResults });
            }
            toolResult = rawResults.map(p => ({
              id: p.id,
              name: p.name,
              price: p.price,
              description: p.description
            }));
          } else if (name === 'add_to_cart') {
            toolResult = executeAddToCart(session, args?.product_id, args?.quantity);
            sendEvent({ type: 'cart', cart: getCartSummary(session) });
          } else if (name === 'remove_from_cart') {
            toolResult = executeRemoveFromCart(session, args?.product_id);
            sendEvent({ type: 'cart', cart: getCartSummary(session) });
          } else if (name === 'view_cart') {
            toolResult = executeViewCart(session);
            sendEvent({ type: 'cart', cart: getCartSummary(session) });
          } else {
            toolResult = { error: `Unknown tool "${name}"` };
          }

          const part = {
            functionResponse: {
              name,
              response: { output: toolResult }
            }
          };
          if (id) {
            part.functionResponse.id = id;
          }
          return part;
        }));

        responseStream = await session.chat.sendMessageStream({ message: functionResponseParts });
        for await (const chunk of responseStream) {
          if (chunk.text) {
            fullText += chunk.text;
            sendEvent({ type: 'chunk', text: chunk.text });
          }
          if (chunk.functionCalls && chunk.functionCalls.length > 0) {
            functionCalls.push(...chunk.functionCalls);
          }
        }
      }

      sendEvent({ type: 'cart', cart: getCartSummary(session) });
      sendEvent({ type: 'done' });
      return res.end();
    } catch (err) {
      console.error('Gemini stream error, falling back to mock mode:', err.message);
      // History may now end in an unanswered functionCall; start a fresh chat next turn
      session.chat = null;
      if (toolsRan || fullText) {
        // Tools already acted (or text was streamed); replaying via mock would repeat cart actions
        if (!fullText) {
          sendEvent({ type: 'chunk', text: 'Sorry, I had trouble finishing that reply. Your cart below is up to date.' });
        }
        sendEvent({ type: 'cart', cart: getCartSummary(session) });
        sendEvent({ type: 'done' });
        return res.end();
      }
      const fallbackResult = runMockAi(session, message);
      if (fallbackResult.products && fallbackResult.products.length > 0) {
        sendEvent({ type: 'products', products: fallbackResult.products });
      }
      sendEvent({ type: 'chunk', text: fallbackResult.reply });
      sendEvent({ type: 'cart', cart: fallbackResult.cart });
      sendEvent({ type: 'done' });
      return res.end();
    }
  }

  // --- STANDARD JSON MODE (Synchronous non-stream fallback) ---
  if (isMockAiConfigured || !aiClient) {
    const mockResult = runMockAi(session, message);
    return res.json(mockResult);
  }

  let toolsRan = false;
  try {
    getSessionChat(session);

    let recommendedProducts = [];
    let loopCount = 0;
    let response = await session.chat.sendMessage({ message });

    while (response.functionCalls && response.functionCalls.length > 0 && loopCount < 5) {
      loopCount++;
      toolsRan = true;
      const currentCalls = response.functionCalls;

      // Parallelize tool execution
      const functionResponseParts = await Promise.all(currentCalls.map(async (call) => {
        const { name, args, id } = call;
        let toolResult;

        if (name === 'search_products') {
          const rawResults = executeSearchProducts(args?.query, args?.max_price);
          if (Array.isArray(rawResults) && rawResults.length > 0) {
            recommendedProducts = rawResults;
          }
          toolResult = rawResults.map(p => ({
            id: p.id,
            name: p.name,
            price: p.price,
            description: p.description
          }));
        } else if (name === 'add_to_cart') {
          toolResult = executeAddToCart(session, args?.product_id, args?.quantity);
        } else if (name === 'remove_from_cart') {
          toolResult = executeRemoveFromCart(session, args?.product_id);
        } else if (name === 'view_cart') {
          toolResult = executeViewCart(session);
        } else {
          toolResult = { error: `Unknown tool "${name}"` };
        }

        const part = {
          functionResponse: {
            name,
            response: { output: toolResult }
          }
        };
        if (id) {
          part.functionResponse.id = id;
        }
        return part;
      }));

      response = await session.chat.sendMessage({ message: functionResponseParts });
    }

    const reply = response.text || "I've updated your shopping request. Let me know if you need anything else!";
    return res.json({
      reply,
      products: recommendedProducts,
      cart: getCartSummary(session)
    });
  } catch (err) {
    console.error('Gemini chat error, falling back to mock mode:', err.message);
    // History may now end in an unanswered functionCall; start a fresh chat next turn
    session.chat = null;
    if (toolsRan) {
      // Tools already acted; replaying via mock would repeat cart actions
      return res.json({
        reply: 'Sorry, I had trouble finishing that reply. Your cart is up to date.',
        products: [],
        cart: getCartSummary(session)
      });
    }
    const fallbackResult = runMockAi(session, message);
    return res.json({
      ...fallbackResult,
      notice: 'Note: Responded using rule-based shopping assistant.'
    });
  }
});

// PayPal: Create Order endpoint
app.post('/api/paypal/create-order', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Valid sessionId is required' });
  }

  const session = getOrCreateSession(sessionId);
  try {
    const order = await createPayPalOrder(session);
    res.json({ orderID: order.id });
  } catch (err) {
    console.error('Failed to create PayPal order:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PayPal: Capture Order endpoint
app.post('/api/paypal/capture-order', async (req, res) => {
  const { sessionId, orderID } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Valid sessionId is required' });
  }
  if (!orderID || typeof orderID !== 'string') {
    return res.status(400).json({ error: 'Valid orderID is required' });
  }

  const session = getOrCreateSession(sessionId);
  try {
    const captureData = await capturePayPalOrder(session, orderID);
    if (captureData.status !== 'COMPLETED') {
      return res.status(402).json({
        success: false,
        error: `Payment not completed (status: ${captureData.status || 'unknown'}).`,
        status: captureData.status
      });
    }
    res.json({
      success: true,
      status: captureData.status,
      orderID: captureData.id,
      amount: captureData.paidTotal,
      details: captureData
    });
  } catch (err) {
    console.error('Failed to capture PayPal order:', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Unknown API routes / wrong methods get a JSON 404 instead of the SPA HTML
app.use('/api', (req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Fallback route for SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server if invoked directly
const PORT = process.env.PORT || 3000;
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🛒 Ask & Buy AI Checkout Server running on port ${PORT}`);
    console.log(`👉 Local: http://localhost:${PORT}`);
    console.log(`🤖 Mode:  ${isMockAiConfigured || !aiClient ? 'Mock AI (Rule-based)' : 'Gemini AI'}`);
    console.log(`====================================================`);
  });
}

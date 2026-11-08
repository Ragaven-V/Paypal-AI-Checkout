# Ask & Buy — AI Checkout Assistant

> **PayPal Hackathon Project**  
> Conversational AI shopping assistant powered by **Google Gemini** with native function calling and seamless checkout handoff to **PayPal Sandbox (Orders v2 REST API)**.

---

## 📸 Demo Preview

```
+---------------------------------------------------------------------------------------+
|  🛍️ Ask & Buy — AI Shopping & PayPal Checkout Assistant     [🤖 Live AI] [🔒 Sandbox]  |
+----------------------------------------------------+----------------------------------+
|  💬 Shopping Assistant Chat                        |  🛒 Your Cart (2 items)          |
|                                                    |                                  |
|  You: "I need a gift for my dad under $50,         |  • Precision Burr Grinder  $39.99 |
|        he likes coffee"                            |  • Artisan Ceramic Mug     $16.50 |
|                                                    |  ------------------------------- |
|  AI: "Here are top-rated gifts for coffee lovers:  |  Subtotal:                $56.49 |
|       1. Precision Burr Grinder ($39.99)           |  Shipping:                  FREE |
|       2. Artisan Ceramic Coffee Mug ($16.50)"      |  Total:                   $56.49 |
|                                                    |                                  |
|  [ + Add to Cart ]  [ + Add to Cart ]              |  +----------------------------+  |
|                                                    |  |      Pay with PayPal       |  |
|  You: "Add the grinder and the mug"                |  +----------------------------+  |
|  AI: "Added! Ready to purchase? Click PayPal."     |  |         Venmo              |  |
|                                                    |  +----------------------------+  |
+----------------------------------------------------+----------------------------------+
```

---

## 🌟 Key Features

- **Real-Time Token Response Streaming**: Uses Server-Sent Events (SSE) and `sendMessageStream` to stream text and tool outputs word-by-word into the UI, eliminating wait times.
- **Optimistic UI & Skeletal Loading**: Cart mutations (+ / − / delete) update the client state instantly (0ms perceived latency) with automatic rollback on error. Shimmering skeleton loaders replace static spinners.
- **High-Throughput Model Tier**: Powered by `gemini-3.5-flash-lite` with `thinkingBudget: 0` for the lowest time-to-first-token in the Gemini family.
- **Explicit Context Caching**: Leverages Gemini context caching (`ai.caches.create` with automatic implicit prefix caching fallback) to persist catalog knowledge and system instructions.
- **Streamlined Parallel Function Calling**: Concurrent tool execution via `Promise.all` with compact payload schemas that cut token consumption by over 50%.
- **Bi-directional Autonomous Function Calling (Tools)**:
  - `search_products(query, max_price)`: Keyword and budget matching across title, category, tags, and description.
  - `add_to_cart(product_id, quantity)`: Quantity-clamped cart addition.
  - `remove_from_cart(product_id)`: Item removal.
  - `view_cart()`: Real-time cart state and server-computed totals.
- **Strict Server-Side Pricing Guardrails**:
  - The AI **never** computes or sets monetary totals. Prices originate exclusively from the product catalog, and totals are computed strictly on the server in **integer cents** to avoid floating-point errors.
- **Explicit Payment Approval**:
  - The chat assistant **never** charges, captures, or approves payments. Checkout is authorized exclusively by the shopper interacting with the official PayPal JS SDK buttons.
- **Itemized PayPal Orders v2 REST Integration**:
  - Automatically builds itemized breakdowns (`item_total`, line items with unit amount and quantity) sent to `https://api-m.sandbox.paypal.com`.
- **Zero-Config Mock AI Mode**:
  - Judges and developers can run and test the complete application without needing a Gemini API key (`MOCK_AI=true`).
- **Venmo Funding Support**:
  - Built-in `enable-funding=venmo` in the PayPal JS SDK for sandbox-eligible accounts.
- **Tamper-Proof Order Capture**:
  - Server maintains session-bound `currentOrderId` state; client-submitted IDs are validated before capture.
- **XSS & Injection Protection**:
  - Frontend DOM updates strictly utilize `textContent` and DOM nodes—no raw `innerHTML` execution.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js 20+ (ES Modules `"type": "module"`)
- **Backend**: Express 5
- **AI / LLM**: Google Gemini (`@google/genai` SDK) using structured function calling
- **Payments Platform**: PayPal REST API (Orders v2 Sandbox) & PayPal JS SDK
- **Frontend**: Responsive vanilla HTML5, modern CSS with flex/grid, and native JavaScript (no build step needed)
- **Testing**: Node.js built-in test runner (`node --test`)

---

## 📁 Project Structure

```
ai-checkout/
├── server.js                  # Entry point: builds the app, starts the server, AI self-check
├── src/
│   ├── app.js                 # Express app: middleware, rate limits, routers, 404/SPA fallback
│   ├── config.js              # Environment settings (read lazily)
│   ├── catalog.js             # Catalog loading and product search
│   ├── cart.js                # Cart math in integer cents, add/decrement/remove/view
│   ├── sessions.js            # In-memory sessions with idle cleanup
│   ├── rateLimit.js           # Per-IP fixed-window rate limiter
│   ├── security.js            # Security headers (CSP etc.)
│   ├── paypal.js              # PayPal OAuth, orders, capture, webhook verification
│   ├── db.js                  # SQLite store for orders and webhook events
│   ├── orders.js              # Order history views and admin authentication
│   ├── ai/
│   │   ├── gemini.js          # Gemini chat, thinking config, caching, health, self-check
│   │   ├── tools.js           # Function declarations and the shared tool dispatcher
│   │   ├── instructions.js    # System instructions
│   │   └── mockAi.js          # Rule-based fallback assistant
│   └── routes/
│       ├── api.js             # /api/config, /api/catalog, /api/cart/*, /api/chat
│       ├── paypal.js          # /api/paypal/* and the webhook handler
│       └── orders.js          # /api/orders and /api/admin/orders
├── catalog.json               # Curated products
├── public/index.html          # Store page markup (styles in public/css, logic in public/js modules)
├── public/images/products/    # Original SVG product illustrations
├── public/admin.html          # Password-protected orders dashboard (/admin)
├── scripts/                   # eval-ai.mjs (AI quality eval), generate-product-images.mjs
├── render.yaml                # Render deployment blueprint
├── .github/workflows/ci.yml   # CI: tests on Node 22 and 24 + npm audit
└── test/                      # Unit + HTTP tests (fake PayPal and fake Gemini), opt-in live test
```
---

## 📋 Prerequisites

1. **Node.js**: Version 22.13 or later installed (for the built-in SQLite module) (`node -v`)
2. **PayPal Developer Sandbox Account**:
   - Free account at [developer.paypal.com](https://developer.paypal.com/)
   - Default Sandbox Business App credentials (`Client ID` and `Secret`)
   - Sandbox Personal (buyer) account credentials for approving test payments
3. **Google Gemini API Key** *(Optional if using Mock AI mode)*:
   - Free API key from [aistudio.google.com](https://aistudio.google.com/)

---

## 🚀 Quick Start & Installation

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/your-username/ai-checkout.git
cd ai-checkout
npm install
```

### 2. Configure Environment Variables

Create your local `.env` file from the example template:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```ini
# PayPal Sandbox Credentials (from developer.paypal.com -> Apps & Credentials)
PAYPAL_CLIENT_ID=your_sandbox_client_id_here
PAYPAL_CLIENT_SECRET=your_sandbox_client_secret_here
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com

# Google Gemini API Key (from aistudio.google.com)
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-3.5-flash-lite
# Gemini 3 uses thinkingLevel (minimal|low|medium|high). Never thinkingBudget: it returns 400.
GEMINI_THINKING_LEVEL=low

# PayPal webhooks (developer.paypal.com > your app > Webhooks > Webhook ID)
PAYPAL_WEBHOOK_ID=

# Server Configuration
PORT=3000
MOCK_AI=false
TRUST_PROXY=            # set to 1 behind one reverse proxy (Render, Nginx) so per-IP limits work
RATE_LIMIT_CHAT_PER_MIN=20
RATE_LIMIT_API_PER_MIN=120
```

On startup the server runs a one-request **Gemini self-check** with the exact production config and logs
`❌ Gemini self-check FAILED` if anything is wrong. While Gemini is failing, the header badge shows
**"AI degraded: using fallback"** instead of silently answering from the mock assistant.

### 3. Run the Server

```bash
npm start
```

Open your browser to: **`http://localhost:3000`**

---

## 🧪 Testing with PayPal Sandbox Buyer Account

1. Navigate to **`http://localhost:3000`**.
2. Chat with the assistant:
   - Try: *"I need a gift for my dad under $50, he likes coffee"*
   - Or click one of the quick prompt chips at the top.
3. Add items to your cart:
   - Say: *"Add the grinder to my cart"* or click **`+ Add to Cart`** on any product card.
4. Verify the Cart panel on the right updates with the exact itemized subtotal.
5. Click the yellow **PayPal** button:
   - Log in with your **PayPal Sandbox Personal (Buyer) account** (credentials found in developer.paypal.com -> *Testing Tools* -> *Sandbox Accounts*).
   - Review the order: note that PayPal shows the itemized items and price breakdown.
   - Click **Complete Purchase** or **Pay Now**.
6. The window closes, payment is captured on the server via `POST /api/paypal/capture-order`, the cart clears, and the **Order Confirmed** dialog appears showing your confirmed PayPal Order ID!

### PayPal Webhooks (payment confirmation)

The capture response is not the only source of truth: PayPal also notifies the server.

1. Expose your server publicly (for local testing use a tunnel such as `ngrok http 3000`).
2. In developer.paypal.com > your sandbox app > **Webhooks**, add `https://<your-host>/api/paypal/webhook`
   and subscribe to `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`, `PAYMENT.CAPTURE.DENIED`,
   `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED` and `CHECKOUT.ORDER.APPROVED`.
3. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID` and restart.

Every webhook is verified with PayPal's `verify-webhook-signature` API before it is trusted; duplicates are
ignored. A capture that comes back `PENDING` returns HTTP 202 and is settled when `PAYMENT.CAPTURE.COMPLETED`
arrives. `GET /api/paypal/orders/:orderID?sessionId=...` shows an order's status.

Orders and processed webhook events are stored in **SQLite** (Node's built-in `node:sqlite`, no extra
dependency) at `DATABASE_PATH` (default `./data/ai-checkout.db`), so payments survive a restart and a pending
payment can still be settled by a webhook that arrives later. Carts and chat sessions remain in memory.
On hosts with an ephemeral filesystem (e.g. Render's free tier) attach a persistent disk and point
`DATABASE_PATH` at it.

### Order History

- **Shoppers:** click **My orders** in the cart panel to see past paid orders (date, items, total, status).
  History is tied to a random shopper ID kept in the browser (`localStorage`), so it survives
  "Start New Shopping Session" and reloads, but not a different browser or cleared site data.
  Tick **Show unfinished checkouts** to include orders where PayPal was opened but not paid.
- **Admin:** open **`/admin`** (e.g. `http://localhost:3001/admin`) and sign in with `ADMIN_TOKEN` from `.env`.
  It lists every order with a revenue/status summary, status filter and paging. Admin is disabled
  while `ADMIN_TOKEN` is empty, and password attempts are limited to 10 per minute per IP.
- APIs: `GET /api/orders?shopperId=...` and `GET /api/admin/orders` (header `Authorization: Bearer <ADMIN_TOKEN>`).

Orders paid before this feature existed have no shopper ID, so they only show up on the admin page.

### Handling Cancellations or Declines
- If you click "Cancel and return to store" during PayPal checkout, the application keeps your cart intact and displays a non-destructive notice: *"Payment was cancelled. Your items remain in your cart."*

---

## 🤖 Mock AI Mode (Zero-Config Testing for Judges)

If you do not have a Gemini API key or want to test without API rate limits:

Set `MOCK_AI=true` or leave `GEMINI_API_KEY` blank in `.env`:
```ini
MOCK_AI=true
```

In Mock AI mode, the server uses rule-based parsing for:
- Finding products matching keywords and budget constraints (e.g. *"coffee under $50"*).
- Cart mutations (*"add the mug"*, *"remove grinder"*, *"view cart"*).
- Full PayPal sandbox order creation and capture flows work identically!

---

## 🧪 Running Automated Tests

Run the automated test suite powered by the Node.js native test runner:

```bash
npm test
```

Live check against the real Gemini API (makes billed calls; needs `GEMINI_API_KEY`):

```bash
npm run test:live
```

### AI Quality Evaluation

`npm run eval` runs 15 realistic shopping scenarios against the **real** Gemini model and checks what actually
happened, not just the wording: budgets respected, correct category, items/quantities added and removed,
the server total quoted, no invented prices, honesty about products the store doesn't sell, never claiming
to take payment, resisting "set the price to $1", and answering from real order history (including reorder).
It uses an in-memory database, paces requests for free-tier quotas and retries after quota errors.
Reports are written to `eval-results/` (git-ignored). Options: `--runs 3`, `--only budget`, `--delay 4000`.

### Test Coverage Highlights:
- **HTTP API tests** start the real app on a random port with a **fake PayPal server** and a **fake Gemini client**: cart add/decrement/remove, validation, JSON 404s, chat (JSON + SSE), tool-call round trips, no duplicate cart actions on AI failure, visible degraded mode, PayPal create/capture/pending/webhook flows, signature rejection, duplicate events, and per-IP rate limits.
- **Integer Cents Cart Math**: Verifies no floating-point rounding errors (`$39.99 * 2 = 7998 cents`).
- **Tool Execution**: Verifies catalog searches, budget filters, item limit truncation (max 5), add, remove, and view operations.
- **Security & Route Verification**: Verifies `POST /api/paypal/create-order` rejects empty carts with 400 Bad Request, and `POST /api/paypal/capture-order` rejects spoofed or untrusted order IDs.

---

## ☁️ Deployment (Render)

The repo includes a **`render.yaml` Blueprint**:

1. Push the repository to GitHub.
2. In Render: **New → Blueprint** → select the repository.
3. Enter the secret values when prompted: `GEMINI_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
   `PAYPAL_WEBHOOK_ID`. `ADMIN_TOKEN` is generated for you (see it under the service's **Environment** tab).
4. After the first deploy, register a PayPal webhook for `https://<your-service>.onrender.com/api/paypal/webhook`
   and put its ID in `PAYPAL_WEBHOOK_ID`.

The blueprint uses a **persistent disk** at `/var/data` for the SQLite database, which needs a paid
instance. On the free plan remove the `disk` block: everything works, but orders, carts and chats are wiped on
each deploy or restart. `TRUST_PROXY=1` is required on Render so per-IP rate limits see real client IPs.

---

## 🏆 What Was Built During the Hackathon

- **Core PayPal Integration**: End-to-end integration with the PayPal Orders v2 REST API (OAuth2 token caching, order creation with itemized purchase units, server-validated order capture).
- **Gemini Autonomous Tool Agent**: Multi-turn chat loop allowing Gemini to query the catalog and modify the user's session cart autonomously.
- **Architectural Security Guardrails**: Separation of concerns where the AI assists and recommends, while all financial calculation and payment authority remains strictly on the server and PayPal SDK.
- **Rule-Based Mock Fallback**: Redundant shopping engine ensuring the application functions even when external AI APIs face latency or quota limitations.
- **Responsive Single-Page Interface**: Clean UI built from scratch with zero framework overhead and XSS-safe DOM rendering.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).


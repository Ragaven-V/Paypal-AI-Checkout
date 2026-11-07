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
├── server.js              # Express app, catalog, cart logic, Gemini tools, PayPal routes
├── catalog.json           # 12 curated products (id, name, price, category, tags, description)
├── public/
│   └── index.html         # Responsive chat UI, product recommendation cards, cart, PayPal buttons
├── test/
│   ├── cart-math.test.js  # Unit tests for integer cents math, clamping, and subtotals
│   ├── tools.test.js      # Unit tests for Gemini search, add, remove, and view tools
│   └── api.test.js        # API tests: empty cart rejection, fraud protection, mock AI
├── .env.example           # Clean environment template
├── .gitignore             # Git ignore file protecting .env and node_modules
├── package.json           # Dependencies and test runner script
├── LICENSE                # Open-source MIT License
└── README.md              # Project documentation and setup guide
```

---

## 📋 Prerequisites

1. **Node.js**: Version 20.x or later installed (`node -v`)
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
GEMINI_MODEL=gemini-3.8-flash

# Server Configuration
PORT=3000
MOCK_AI=false
```

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

### Test Coverage Highlights:
- **Integer Cents Cart Math**: Verifies no floating-point rounding errors (`$39.99 * 2 = 7998 cents`).
- **Tool Execution**: Verifies catalog searches, budget filters, item limit truncation (max 5), add, remove, and view operations.
- **Security & Route Verification**: Verifies `POST /api/paypal/create-order` rejects empty carts with 400 Bad Request, and `POST /api/paypal/capture-order` rejects spoofed or untrusted order IDs.

---

## ☁️ Deployment Instructions (Render)

This project can be deployed to [Render](https://render.com/) in under 3 minutes:

1. Push your repository to GitHub or GitLab.
2. Log into the Render Dashboard and click **New +** -> **Web Service**.
3. Connect your repository.
4. Configure service settings:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. In the **Environment Variables** section, add:
   - `PAYPAL_CLIENT_ID`: Your sandbox Client ID
   - `PAYPAL_CLIENT_SECRET`: Your sandbox Secret
   - `PAYPAL_BASE_URL`: `https://api-m.sandbox.paypal.com`
   - `GEMINI_API_KEY`: Your Gemini API key (or set `MOCK_AI=true`)
   - `GEMINI_MODEL`: `gemini-3.8-flash`
6. Click **Deploy Web Service**.

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


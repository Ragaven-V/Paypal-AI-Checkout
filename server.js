import { createApp } from './src/app.js';
import { config } from './src/config.js';
import { isAiEnabled, startAiBackground } from './src/ai/gemini.js';

// Re-exports kept for existing imports/tests
export { catalog, catalogMap, executeSearchProducts } from './src/catalog.js';
export { sessions, getOrCreateSession } from './src/sessions.js';
export {
  getCartSummary,
  executeAddToCart,
  executeDecrementCart,
  executeRemoveFromCart,
  executeViewCart
} from './src/cart.js';
export { runMockAi } from './src/ai/mockAi.js';
export { getPayPalAccessToken, createPayPalOrder, capturePayPalOrder } from './src/paypal.js';
export { createApp };

export const app = createApp();

// Start server if invoked directly (node server.js / npm start)
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  // Express 5 passes listen errors (e.g. port already in use) to this callback instead of throwing
  app.listen(config.port, (err) => {
    if (err) {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${config.port} is already in use, probably by another copy of this server.`);
        console.error('   Stop the other one (Ctrl+C in its terminal) or set a different PORT in .env.');
      } else {
        console.error(`❌ Could not start the server: ${err.message}`);
      }
      process.exit(1);
    }
    startAiBackground();
    console.log(`====================================================`);
    console.log(`🛒 Ask & Buy AI Checkout Server running on port ${config.port}`);
    console.log(`👉 Local: http://localhost:${config.port}`);
    console.log(`🤖 Mode:  ${isAiEnabled() ? `Gemini AI (${config.geminiModel})` : 'Mock AI (Rule-based)'}`);
    console.log(`💳 PayPal webhooks: ${config.paypalWebhookId ? 'enabled' : 'disabled (set PAYPAL_WEBHOOK_ID)'}`);
    console.log(`====================================================`);
  });
}

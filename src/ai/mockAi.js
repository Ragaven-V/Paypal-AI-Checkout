import { catalog, executeSearchProducts } from '../catalog.js';
import { getCartSummary, executeAddToCart, executeRemoveFromCart } from '../cart.js';

/**
 * Rule-based mock assistant, used when Gemini is not configured or a request fails.
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

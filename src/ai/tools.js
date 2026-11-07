import { Type } from '@google/genai';
import { executeSearchProducts } from '../catalog.js';
import { executeAddToCart, executeRemoveFromCart, executeViewCart, getCartSummary } from '../cart.js';

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
      product_id: { type: Type.STRING, description: 'The product ID from the catalog (e.g. "p1", "p2").' },
      quantity: { type: Type.INTEGER, description: 'Number of units to add (1 to 10). Defaults to 1.' }
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
      product_id: { type: Type.STRING, description: 'The product ID to remove (e.g. "p1").' }
    },
    required: ['product_id']
  }
};

const viewCartDeclaration = {
  name: 'view_cart',
  description: 'View current items in the shopping cart and the server-calculated total price.',
  parameters: { type: Type.OBJECT, properties: {} }
};

export const GEMINI_TOOLS = [
  {
    functionDeclarations: [
      searchProductsDeclaration,
      addToCartDeclaration,
      removeFromCartDeclaration,
      viewCartDeclaration
    ]
  }
];

/**
 * Run one model function call against the session and build its functionResponse part.
 * `onEvent` (optional) receives UI events: { type: 'products' | 'cart', ... }.
 */
export function runToolCall(session, call, onEvent = () => {}) {
  const { name, args, id } = call;
  let output;

  if (name === 'search_products') {
    const results = executeSearchProducts(args?.query, args?.max_price);
    if (results.length > 0) {
      onEvent({ type: 'products', products: results });
    }
    output = results.map(p => ({ id: p.id, name: p.name, price: p.price, description: p.description }));
  } else if (name === 'add_to_cart') {
    output = executeAddToCart(session, args?.product_id, args?.quantity);
    onEvent({ type: 'cart', cart: getCartSummary(session) });
  } else if (name === 'remove_from_cart') {
    output = executeRemoveFromCart(session, args?.product_id);
    onEvent({ type: 'cart', cart: getCartSummary(session) });
  } else if (name === 'view_cart') {
    output = executeViewCart(session);
    onEvent({ type: 'cart', cart: getCartSummary(session) });
  } else {
    output = { error: `Unknown tool "${name}"` };
  }

  const part = { functionResponse: { name, response: { output } } };
  if (id) {
    part.functionResponse.id = id;
  }
  return part;
}

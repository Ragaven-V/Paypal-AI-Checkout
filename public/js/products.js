// Product cards (used in chat replies). Built with textContent only, so catalog text can't inject HTML.
import { el } from './dom.js';

export function renderProductCards(grid, products, onAdd) {
  grid.replaceChildren(...products.map(p => {
    const card = el('article', 'product-card');

    if (p.image) {
      const img = el('img', 'product-image');
      img.src = p.image;
      img.alt = p.name;
      img.loading = 'lazy';
      img.width = 320;
      img.height = 240;
      card.appendChild(img);
    }

    const bottom = el('div', 'product-bottom');
    const addBtn = el('button', 'btn-add-cart', '+ Add to Cart');
    addBtn.type = 'button';
    addBtn.setAttribute('aria-label', `Add ${p.name} to cart`);
    addBtn.addEventListener('click', () => onAdd(p.id));
    bottom.append(el('div', 'product-price', `$${Number(p.price).toFixed(2)}`), addBtn);

    card.append(
      el('div', 'product-tag', p.category || 'Product'),
      el('h3', 'product-name', p.name),
      el('p', 'product-desc', p.description),
      bottom
    );
    return card;
  }));
}

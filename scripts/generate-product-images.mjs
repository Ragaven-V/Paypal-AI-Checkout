// Generates the original flat product illustrations in public/images/products/*.svg.
// Run: node scripts/generate-product-images.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'images', 'products');

const C = {
  navy: '#1b2a4a',
  steel: '#9aa8bb',
  steelDark: '#6b7a90',
  white: '#ffffff',
  cream: '#f4ead8',
  wood: '#b07a4a',
  woodDark: '#7d5230',
  glass: '#d9ecf7',
  glassEdge: '#9cc6e0',
  coffee: '#5b3a22',
  blue: '#0070e0',
  sky: '#59b7e6',
  black: '#26292e',
  leather: '#8a4b2a',
  sage: '#9cc5a1',
  gold: '#e7b54a'
};

// Soft background per category
const BACKGROUNDS = {
  'Coffee & Tea': ['#fbf2e6', '#f1dfc6'],
  'Kitchen & Appliances': ['#eef3f8', '#dbe5ef'],
  'Kitchen & Home': ['#eef3f8', '#dbe5ef'],
  Drinkware: ['#e8f4fb', '#cfe7f5'],
  Electronics: ['#eceffd', '#d6dcf7'],
  Accessories: ['#f8eee9', '#efd9cd'],
  'Home & Wellness': ['#ecf6ee', '#d5ebd9']
};

const frame = (category, body) => {
  const [a, b] = BACKGROUNDS[category] || ['#f3f5f8', '#e2e7ee'];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" role="img">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${a}"/>
      <stop offset="1" stop-color="${b}"/>
    </linearGradient>
  </defs>
  <rect width="320" height="240" fill="url(#bg)"/>
  <circle cx="262" cy="46" r="58" fill="#ffffff" opacity="0.35"/>
  <ellipse cx="160" cy="206" rx="92" ry="11" fill="#000000" opacity="0.08"/>
${body}
</svg>
`;
};

const DRAWINGS = {
  // Precision Burr Coffee Grinder
  p1: `
  <rect x="128" y="96" width="64" height="104" rx="10" fill="${C.steel}"/>
  <rect x="128" y="140" width="64" height="16" fill="${C.steelDark}"/>
  <rect x="132" y="66" width="56" height="34" rx="6" fill="${C.wood}"/>
  <rect x="152" y="54" width="16" height="16" rx="3" fill="${C.navy}"/>
  <path d="M160 58 L214 40" stroke="${C.navy}" stroke-width="7" stroke-linecap="round"/>
  <circle cx="218" cy="38" r="10" fill="${C.woodDark}"/>
  <rect x="122" y="196" width="76" height="8" rx="4" fill="${C.navy}"/>`,

  // Artisan Ceramic Coffee Mug
  p2: `
  <path d="M146 64 q-8 -14 0 -26 M164 64 q-8 -14 0 -26 M182 64 q-8 -14 0 -26" stroke="${C.steelDark}" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.6"/>
  <path d="M206 108 h12 a26 26 0 0 1 0 52 h-12" fill="none" stroke="#3f6f8f" stroke-width="12"/>
  <rect x="112" y="80" width="100" height="120" rx="16" fill="#4f86a8"/>
  <rect x="112" y="80" width="100" height="18" rx="9" fill="#3f6f8f"/>
  <ellipse cx="162" cy="86" rx="44" ry="6" fill="${C.coffee}"/>`,

  // Cold Brew Coffee Maker (1L)
  p3: `
  <rect x="114" y="62" width="92" height="140" rx="14" fill="${C.glass}" stroke="${C.glassEdge}" stroke-width="3"/>
  <rect x="117" y="110" width="86" height="89" rx="10" fill="${C.coffee}" opacity="0.85"/>
  <rect x="150" y="70" width="20" height="120" rx="8" fill="${C.steel}" opacity="0.9"/>
  <rect x="108" y="48" width="104" height="18" rx="8" fill="${C.black}"/>
  <path d="M206 92 h14 a10 10 0 0 1 10 10 v40 a10 10 0 0 1 -10 10 h-14" fill="none" stroke="${C.black}" stroke-width="8"/>
  <rect x="126" y="122" width="16" height="16" rx="3" fill="#ffffff" opacity="0.55"/>
  <rect x="178" y="140" width="14" height="14" rx="3" fill="#ffffff" opacity="0.45"/>`,

  // Pour-Over Glass Carafe & Dripper
  p4: `
  <path d="M122 50 h76 l-26 44 h-24 z" fill="${C.steel}"/>
  <path d="M130 50 h60" stroke="${C.steelDark}" stroke-width="5" stroke-linecap="round"/>
  <path d="M146 94 h28 v12 c34 10 40 40 34 66 c-4 18 -18 28 -48 28 c-30 0 -44 -10 -48 -28 c-6 -26 0 -56 34 -66 z" fill="${C.glass}" stroke="${C.glassEdge}" stroke-width="3"/>
  <path d="M120 160 c4 22 16 34 40 34 c24 0 36 -12 40 -34 z" fill="${C.coffee}" opacity="0.85"/>
  <rect x="144" y="104" width="32" height="10" rx="3" fill="${C.wood}"/>`,

  // Electric Gooseneck Kettle
  p5: `
  <rect x="104" y="186" width="112" height="16" rx="6" fill="${C.black}"/>
  <path d="M112 186 c-4 -60 12 -98 48 -98 c36 0 52 38 48 98 z" fill="${C.black}"/>
  <path d="M120 140 c-30 -4 -44 -30 -50 -60 c-2 -8 -10 -10 -16 -8" fill="none" stroke="${C.black}" stroke-width="9" stroke-linecap="round"/>
  <path d="M204 110 c26 0 30 54 6 64" fill="none" stroke="${C.steelDark}" stroke-width="10" stroke-linecap="round"/>
  <ellipse cx="160" cy="88" rx="22" ry="6" fill="${C.steelDark}"/>
  <circle cx="160" cy="80" r="6" fill="${C.steel}"/>
  <path d="M134 120 c-4 22 -4 40 0 54" stroke="#ffffff" stroke-width="5" opacity="0.25" stroke-linecap="round" fill="none"/>`,

  // Insulated Stainless Travel Tumbler (20oz)
  p6: `
  <path d="M128 64 h64 l-8 136 h-48 z" fill="${C.sky}"/>
  <path d="M128 64 h64 l-1.5 24 h-61 z" fill="#3a9bd0"/>
  <rect x="122" y="46" width="76" height="20" rx="8" fill="${C.navy}"/>
  <rect x="166" y="40" width="20" height="8" rx="3" fill="${C.navy}"/>
  <path d="M146 100 l-4 90" stroke="#ffffff" stroke-width="6" opacity="0.35" stroke-linecap="round"/>`,

  // Smart Desk Wireless Charging Pad
  p7: `
  <ellipse cx="160" cy="176" rx="86" ry="22" fill="${C.black}"/>
  <ellipse cx="160" cy="170" rx="86" ry="22" fill="#3b3f46"/>
  <rect x="128" y="62" width="64" height="112" rx="12" fill="${C.navy}" transform="rotate(-8 160 118)"/>
  <rect x="134" y="72" width="52" height="92" rx="8" fill="${C.blue}" transform="rotate(-8 160 118)"/>
  <path d="M164 92 l-16 30 h14 l-6 26 l20 -34 h-14 z" fill="${C.gold}"/>
  <ellipse cx="160" cy="184" rx="30" ry="4" fill="${C.sky}" opacity="0.7"/>`,

  // Compact Noise-Isolating Earbuds
  p8: `
  <rect x="106" y="120" width="108" height="76" rx="34" fill="${C.white}" stroke="#d3d9e2" stroke-width="3"/>
  <path d="M106 150 h108" stroke="#d3d9e2" stroke-width="3"/>
  <circle cx="160" cy="174" r="4" fill="${C.sky}"/>
  <g transform="rotate(-18 128 82)">
    <circle cx="128" cy="82" r="20" fill="${C.black}"/>
    <rect x="122" y="92" width="12" height="34" rx="6" fill="${C.black}"/>
    <circle cx="124" cy="78" r="7" fill="#4a4f58"/>
  </g>
  <g transform="rotate(18 194 82)">
    <circle cx="194" cy="82" r="20" fill="${C.black}"/>
    <rect x="188" y="92" width="12" height="34" rx="6" fill="${C.black}"/>
    <circle cx="198" cy="78" r="7" fill="#4a4f58"/>
  </g>`,

  // Minimalist Leather Cardholder Wallet
  p9: `
  <rect x="124" y="60" width="78" height="50" rx="5" fill="${C.blue}" transform="rotate(-12 163 85)"/>
  <rect x="140" y="56" width="78" height="50" rx="5" fill="${C.gold}" transform="rotate(6 179 81)"/>
  <rect x="98" y="88" width="124" height="104" rx="12" fill="${C.leather}"/>
  <path d="M98 120 h124" stroke="#6e3a1f" stroke-width="3"/>
  <path d="M98 146 h124" stroke="#6e3a1f" stroke-width="3"/>
  <rect x="104" y="94" width="112" height="92" rx="9" fill="none" stroke="#c98a5e" stroke-width="2" stroke-dasharray="5 5"/>`,

  // Aromatherapy Ultrasonic Diffuser
  p10: `
  <path d="M150 64 q-12 -16 0 -30 q12 -14 0 -26" stroke="#c7cfdb" stroke-width="9" fill="none" stroke-linecap="round" opacity="0.8"/>
  <path d="M172 60 q-10 -12 0 -24" stroke="#c7cfdb" stroke-width="7" fill="none" stroke-linecap="round" opacity="0.6"/>
  <path d="M160 70 c40 0 62 50 62 92 c0 24 -18 38 -62 38 c-44 0 -62 -14 -62 -38 c0 -42 22 -92 62 -92 z" fill="${C.cream}"/>
  <path d="M100 168 c10 26 110 26 120 0 c2 14 -6 32 -60 32 c-54 0 -62 -18 -60 -32 z" fill="${C.wood}"/>
  <circle cx="160" cy="76" r="9" fill="${C.steel}"/>
  <circle cx="200" cy="178" r="4" fill="${C.sage}"/>`,

  // Organic Fair-Trade Espresso Beans (12oz)
  p11: `
  <path d="M118 66 h84 l10 134 h-104 z" fill="${C.black}"/>
  <path d="M118 66 h84 l-4 -14 h-76 z" fill="#3b3f46"/>
  <rect x="128" y="104" width="64" height="60" rx="6" fill="${C.cream}"/>
  <ellipse cx="160" cy="128" rx="13" ry="17" fill="${C.coffee}"/>
  <path d="M160 112 c-6 10 6 22 0 32" stroke="${C.cream}" stroke-width="3" fill="none"/>
  <rect x="138" y="150" width="44" height="5" rx="2" fill="${C.sage}"/>
  ${[[84, 196, -20], [96, 186, 25], [228, 194, 15], [242, 184, -30], [214, 200, 40]].map(([x, y, r]) =>
    `<g transform="rotate(${r} ${x} ${y})"><ellipse cx="${x}" cy="${y}" rx="8" ry="11" fill="${C.coffee}"/><path d="M${x} ${y - 9} c-3 6 3 12 0 18" stroke="#3a2414" stroke-width="2" fill="none"/></g>`
  ).join('\n  ')}`,

  // Magnetic Knife & Tool Bar (16-inch)
  p12: `
  <rect x="52" y="52" width="216" height="22" rx="6" fill="${C.woodDark}"/>
  <rect x="52" y="52" width="216" height="8" rx="4" fill="${C.wood}"/>
  ${[[86, 118], [126, 138], [166, 110], [206, 130], [242, 100]].map(([x, len]) =>
    `<rect x="${x - 7}" y="66" width="14" height="34" rx="4" fill="${C.black}"/><path d="M${x - 9} 98 h18 v${len - 40} q-9 ${len > 120 ? 22 : 16} -18 0 z" fill="${C.steel}"/><path d="M${x + 5} 100 v${len - 44}" stroke="#ffffff" stroke-width="2" opacity="0.5"/>`
  ).join('\n  ')}`
};

const catalogPath = path.join(root, 'catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

let written = 0;
for (const product of catalog) {
  const drawing = DRAWINGS[product.id];
  if (!drawing) {
    console.warn(`No drawing for ${product.id} (${product.name}); skipped`);
    continue;
  }
  fs.writeFileSync(path.join(outDir, `${product.id}.svg`), frame(product.category, drawing));
  product.image = `/images/products/${product.id}.svg`;
  written++;
}
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Wrote ${written} product images and updated catalog.json image paths`);

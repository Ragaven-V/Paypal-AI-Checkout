import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const catalog = JSON.parse(fs.readFileSync(path.join(rootDir, 'catalog.json'), 'utf8'));
export const catalogMap = new Map(catalog.map(p => [p.id, p]));

// Common conversational stop words to ignore during search
const STOP_WORDS = new Set(['hi', 'hello', 'hey', 'the', 'a', 'an', 'and', 'or', 'for', 'in', 'of', 'to', 'with', 'at', 'is', 'me', 'my', 'i', 'need', 'want', 'show', 'find', 'get', 'some', 'please']);

export function executeSearchProducts(query, maxPrice) {
  const rawQ = String(query || '').toLowerCase().trim();
  const max = typeof maxPrice === 'number' && maxPrice > 0 ? maxPrice : null;

  const cleanQ = rawQ.replace(/[^a-z0-9\s]/g, ' ').trim();
  if (!cleanQ && max === null) {
    return [];
  }

  const tokens = cleanQ.split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w));
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
      // Whole-word match for short tokens so 'hi' doesn't match 'whisper' (tokens are [a-z0-9] only)
      if (token.length <= 3) {
        const regex = new RegExp(`\\b${token}\\b`, 'i');
        return regex.test(nameLower) || regex.test(catLower) || regex.test(descLower) || tagsLower.includes(token);
      }
      return nameLower.includes(token) || catLower.includes(token) || descLower.includes(token) || tagsLower.some(t => t.includes(token));
    });
  });

  return matches.slice(0, 5);
}

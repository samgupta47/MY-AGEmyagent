// Keyword search over the synced catalogue, tuned for how Indian jewellery
// shoppers type (Hinglish names, common misspellings).
import { load } from './store.js';

const SYNONYMS = [
  ['necklace', 'neckless', 'necklac', 'haar', 'har', 'neklace', 'set'],
  ['earring', 'earrings', 'tops', 'jhumka', 'jhumki', 'bali', 'baali', 'studs', 'kaan'],
  ['ring', 'rings', 'anguthi', 'angoothi', 'mundri', 'band', 'challa', 'chhalla'],
  ['mangalsutra', 'mangalsutre', 'mangal', 'sutar', 'mangalsutar'],
  ['pendant', 'pendent', 'pendal', 'locket'],
  ['chain', 'chains', 'zanjeer'],
  ['bracelet', 'braclet', 'kada', 'kadaa'],
  ['bangle', 'bangles', 'kangan', 'chudi', 'choodi'],
  ['murti', 'idol', 'statue', 'god', 'bhagwan'],
  ['anklet', 'payal', 'pajeb', 'payel'],
  ['tikka', 'maang', 'mang', 'maangtikka'],
  ['nose', 'nath', 'nosepin', 'laung'],
  ['gents', 'men', 'mens', 'male', 'boys', 'gent'],
  ['ladies', 'women', 'womens', 'female', 'girls', 'lady'],
  ['baby', 'kids', 'child', 'children'],
  ['gold', 'sona', 'sone'],
  ['silver', 'chandi', 'chaandi'],
];
const SYN = new Map();
for (const group of SYNONYMS) for (const w of group) SYN.set(w, group);

const STOP = new Set(['a', 'an', 'the', 'for', 'of', 'in', 'and', 'or', 'with', 'me', 'show', 'want', 'need', 'any', 'some', 'do', 'you', 'have', 'under', 'below', 'above', 'ka', 'ki', 'ke', 'hai', 'chahiye', 'dikhao']);

export { SYN, STOP };

const NON_TYPE_GROUPS = new Set(['gents', 'ladies', 'baby', 'gold', 'silver']);
export function typeTerms(terms) {
  return terms.filter((t) => SYN.has(t) && !NON_TYPE_GROUPS.has(SYN.get(t)[0]));
}

export function cardOf(p) {
  return {
    code: p.code,
    title: p.title,
    purity: p.purity,
    weightG: p.weightG,
    price: p.price,
    compareAtPrice: p.compareAtPrice && p.compareAtPrice > p.price ? p.compareAtPrice : null,
    image: p.thumb || p.image,
    url: p.url,
  };
}

export function words(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function expand(term) {
  return SYN.get(term) || [term];
}

function haystack(p) {
  return words(`${p.title} ${p.catalogues.join(' ')} ${p.metal} ${p.purity}`).join(' ');
}

// Matches at the start of a word, so "ring" finds "rings" but not "earring".
function matches(hay, term) {
  return expand(term).some((w) => (w.length <= 3 ? ` ${hay} `.includes(` ${w} `) : ` ${hay}`.includes(` ${w}`)));
}

// True when product p is of the given type word ("ring", "murti", ...).
export function productMatches(p, term) {
  return matches(haystack(p), term);
}

export function publicProduct(p) {
  return {
    code: p.code,
    title: p.title,
    metal: p.metal,
    purity: p.purity,
    weight_g: p.weightG,
    price_inr: p.price ?? 'not listed - ask the store team',
    mrp_inr: p.compareAtPrice && p.compareAtPrice > p.price ? p.compareAtPrice : undefined,
    collections: p.catalogues,
    pieces_in_stock: p.inStock,
    other_piece_weights_g: p.weightsG?.length > 1 ? p.weightsG : undefined,
  };
}

export function findByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return load('catalog').products.find((p) => p.code.toUpperCase() === c) || null;
}

export function searchProducts({ query = '', metal, purity, min_price, max_price, min_weight, max_weight, limit = 8, offset = 0 }) {
  const products = load('catalog').products;
  const terms = words(query).filter((t) => !STOP.has(t));
  const purityQ = purity ? String(purity).toUpperCase().replace(/\s+/g, '') : null;

  const scored = [];
  for (const p of products) {
    if (metal && p.metal !== metal) continue;
    if (purityQ && !p.purity.toUpperCase().replace(/\s+/g, '').includes(purityQ)) continue;
    if (min_price != null && (p.price == null || p.price < min_price)) continue;
    if (max_price != null && (p.price == null || p.price > max_price)) continue;
    if (min_weight != null && (p.weightG == null || p.weightG < min_weight)) continue;
    if (max_weight != null && (p.weightG == null || p.weightG > max_weight)) continue;

    let score = 0;
    if (terms.length) {
      const hay = haystack(p);
      const title = words(p.title).join(' ');
      // Product-type words ("murti", "ring", "jhumka") must all match; other
      // words ("silver", "ladies") only improve the ranking.
      if (!typeTerms(terms).every((t) => matches(hay, t))) continue;
      for (const t of terms) {
        if (p.code.toLowerCase() === t) score += 20;
        else if (matches(title, t)) score += 3;
        else if (matches(hay, t)) score += 2;
      }
      if (score === 0) continue;
    }
    scored.push({ p, score });
  }

  // Best match first; among equals, priced designs first, cheapest first.
  scored.sort((a, b) => b.score - a.score || (a.p.price ?? Infinity) - (b.p.price ?? Infinity));
  const n = Math.min(Math.max(1, Number(limit) || 8), 15);
  const from = Math.max(0, Number(offset) || 0);
  return { total_matches: scored.length, products: scored.slice(from, from + n).map((s) => publicProduct(s.p)) };
}

export function catalogSummary() {
  const { products, syncedAt } = load('catalog');
  const byMetal = {};
  const collections = {};
  for (const p of products) {
    byMetal[p.metal] = (byMetal[p.metal] || 0) + 1;
    for (const c of p.catalogues) collections[c] = (collections[c] || 0) + 1;
  }
  return { total: products.length, syncedAt, byMetal, collections };
}

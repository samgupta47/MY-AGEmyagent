// Product search by meaning: a lightweight vector database (Orama, no
// dependencies) holding one vector per in-stock design. Searches are hybrid -
// meaning (vectors) + keywords (BM25) - with exact filters for budget, weight,
// metal and jewellery type. Stored as a file in <data>/vectors/products.json,
// updated after every CRM sync (only new or changed designs are re-embedded).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { create, insertMultiple, removeMultiple, search, save, load as loadDb, count } from '@orama/orama';
import config from './config.js';
import { DATA_DIR, load } from './store.js';
import { SYN, words, STOP, publicProduct, findByCode, searchProducts } from './search.js';
import { embed, translate } from './meaning.js';

const DIR = path.join(DATA_DIR, 'vectors');
const FILE = path.join(DIR, 'products-v2.json'); // bump when SCHEMA changes
const DIM = 384; // all-MiniLM-L6-v2
const SIMILARITY = 0.4; // minimum meaning match for a design to count as a result
const RELAXED_SIMILARITY = 0.25; // retry for vague requests that found nothing
const STRICT_SIMILARITY = 0.5; // deciding whether an unmatched question is about products

const SCHEMA = {
  code: 'string',
  text: 'string', // searchable words (title, type, category, metal, purity, gender)
  hash: 'string', // detects changed designs
  type: 'enum', // ring | earring | necklace | ...
  metal: 'enum',
  purity: 'enum', // K22, K18, S925 ...

  price: 'number', // -1 = not listed
  weight: 'number', // -1 = unknown
  embedding: `vector[${DIM}]`,
};

// Jewellery type of a design, checked in this order (a "Gold pendent set" is a
// pendant, a "Kitty set" a necklace). Keys are the first word of SYN groups.
const TYPE_ORDER = ['mangalsutra', 'tikka', 'murti', 'pendant', 'earring', 'ring', 'bangle', 'bracelet', 'chain', 'anklet', 'nose', 'necklace'];
const TYPE_WORDS = {
  earring: 'earrings tops bali jhumka', ring: 'ring finger ring', necklace: 'necklace set haar', chain: 'chain', bracelet: 'bracelet kada',
  bangle: 'bangle kangan', mangalsutra: 'mangalsutra black beads', pendant: 'pendant locket', tikka: 'maang tikka forehead head jewellery',
  murti: 'idol murti god statue ganesh ganpati lakshmi krishna shiva hanuman durga',
  anklet: 'anklet payal', nose: 'nose pin nath', other: '',
};

function typeOf(p) {
  const hay = ` ${words(`${p.title} ${p.catalogues.join(' ')}`).join(' ')} `;
  for (const key of TYPE_ORDER) {
    const group = SYN.get(key) || [key];
    if (group.some((w) => (w.length <= 3 ? hay.includes(` ${w} `) : hay.includes(` ${w}`)))) return key;
  }
  return 'other';
}

function docText(p, type) {
  const metal = p.metal === 'gold' ? 'gold' : p.metal === 'silver' ? 'silver' : p.metal;
  const purity = /^K(\d+)/.test(p.purity) ? `${p.purity.slice(1)} karat` : p.purity;
  return `${p.title}. ${TYPE_WORDS[type] || ''}. ${p.catalogues.join(', ')}. ${metal} ${purity}`.replace(/\s+/g, ' ').trim();
}

let db = null;
let ready = false;
let updating = null;

async function emptyDb() {
  return create({ schema: SCHEMA, components: { tokenizer: { stemming: false } } });
}

async function openDb() {
  if (db) return db;
  db = await emptyDb();
  try {
    await loadDb(db, JSON.parse(fs.readFileSync(FILE, 'utf8')));
    ready = (await count(db)) > 0;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[vectors] could not load, rebuilding:', err.message);
    db = await emptyDb();
  }
  return db;
}

function persist() {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(save(db)));
  fs.renameSync(tmp, FILE);
}

/** Adds new/changed in-stock designs and removes sold/deleted ones. */
export function updateProductVectors() {
  if (!config.VECTOR_SEARCH) return Promise.resolve();
  updating ??= doUpdate()
    .catch((err) => console.error('[vectors] update failed:', err.message))
    .finally(() => (updating = null));
  return updating;
}

async function doUpdate() {
  await openDb();
  const products = load('catalog').products;
  const existing = await search(db, { term: '', limit: 100000, includeVectors: false });
  const have = new Map(existing.hits.map((h) => [h.id, h.document.hash]));

  const wanted = new Map();
  for (const p of products) {
    const type = typeOf(p);
    const text = docText(p, type);
    const hash = crypto.createHash('sha1').update(`${text}|${p.price}|${p.weightG}|${p.metal}`).digest('hex').slice(0, 16);
    wanted.set(p.code, { p, type, text, hash });
  }

  const remove = [...have.keys()].filter((code) => !wanted.has(code) || wanted.get(code).hash !== have.get(code));
  const add = [...wanted.values()].filter((w) => !have.has(w.p.code) || have.get(w.p.code) !== w.hash);
  if (!remove.length && !add.length) {
    ready = true;
    return;
  }
  if (remove.length) await removeMultiple(db, remove);

  console.log(`[vectors] embedding ${add.length} design(s)…`);
  const docs = [];
  for (const [i, w] of add.entries()) {
    docs.push({
      id: w.p.code,
      code: w.p.code,
      text: w.text,
      hash: w.hash,
      type: w.type,
      metal: w.p.metal || 'other',
      purity: (w.p.purity || '').toUpperCase(),
      price: w.p.price ?? -1,
      weight: w.p.weightG ?? -1,
      embedding: Array.from(await embed(w.text)),
    });
    if (i % 50 === 49) await new Promise((r) => setTimeout(r, 50)); // stay gentle on shared CPU
  }
  if (docs.length) await insertMultiple(db, docs);
  persist();
  ready = true;
  console.log(`[vectors] product vector database ready: ${await count(db)} designs`);
}

export async function vectorStats() {
  if (!db) await openDb();
  return { designs: await count(db), ready, updating: Boolean(updating) };
}

const NOISE = new Set([...STOP, 'k', 'lakh', 'lac', 'rs', 'inr', 'gram', 'grams', 'gm', 'g', 'price', 'rate', 'kam', 'tak', 'upto', 'budget', 'between', 'se', 'than', 'less', 'more', 'over', 'within', 'around', 'ji', 'sir', 'please', 'pls', 'jewellery', 'jewelry']);
// Phrases that name a type in more than one word.
// Who it's for → the audience words used in the catalogue.
const AUDIENCE = {
  wife: 'ladies', mother: 'ladies', mom: 'ladies', mummy: 'ladies', maa: 'ladies', sister: 'ladies', daughter: 'ladies', girlfriend: 'ladies', bride: 'bridal', behen: 'ladies', beti: 'ladies', biwi: 'ladies',
  husband: 'gents', father: 'gents', dad: 'gents', papa: 'gents', brother: 'gents', son: 'gents', boyfriend: 'gents', groom: 'gents', bhai: 'gents', beta: 'gents', pati: 'gents',
  newborn: 'baby', infant: 'baby', toddler: 'baby', bachcha: 'baby', bacche: 'baby',
  gift: '', gifts: '', present: '', occasion: '', something: '', anything: '', nice: '', good: '', beautiful: '', my: '', on: '', her: '', him: '', his: '',
};
const PHRASE_TYPES = [[/black\s*beads?/, 'mangalsutra'], [/fore\s*head|maang/, 'tikka'], [/\b(ganesh|ganpati|lakshmi|laxmi|krishna|shiv|shiva|hanuman|durga|god|bhagwan)\b/, 'murti']];

/**
 * Hybrid product search. Same result shape as the keyword searchProducts(),
 * or null when the vector database is not available (caller falls back).
 */
export async function vectorSearchProducts({ query = '', metal, purity, min_price, max_price, min_weight, max_weight, limit = 8, offset = 0 }, { strict = false } = {}) {
  if (!config.VECTOR_SEARCH) return null;
  try {
    await openDb();
    if (!ready) return null;

    const qWords = words(translate(query))
      .map((w) => AUDIENCE[w] ?? w)
      // keyword half matches word starts, so tiny words ("to", "pe") would match "tops"/"pendant"
      .filter((w) => w && w.length > 2 && !NOISE.has(w) && !/^\d/.test(w));
    const where = {};
    if (metal) where.metal = { eq: metal };
    if (purity) where.purity = { eq: String(purity).toUpperCase().replace(/\s+/g, '') };
    if (min_price != null || max_price != null) where.price = { between: [min_price ?? 0, max_price ?? 1e12] };
    if (min_weight != null || max_weight != null) where.weight = { between: [min_weight ?? 0, max_weight ?? 1e6] };
    // A named jewellery type ("rings", "jhumka") is a hard filter.
    const lower = String(query).toLowerCase();
    const named = PHRASE_TYPES.find(([re]) => re.test(lower))?.[1] || qWords.map((w) => SYN.get(w)?.[0]).find((k) => TYPE_ORDER.includes(k));
    if (named) where.type = { eq: named };

    const n = Math.min(Math.max(1, Number(limit) || 8), 15);
    const from = Math.max(0, Number(offset) || 0);
    const term = qWords.join(' ');
    let res;
    if (term) {
      const vector = { value: Array.from(await embed(term)), property: 'embedding' };
      const run = (similarity) =>
        search(db, {
          mode: 'hybrid',
          term,
          properties: ['text'],
          vector,
          similarity,
          hybridWeights: { text: 0.4, vector: 0.6 },
          where,
          limit: from + n,
          offset: 0,
          includeVectors: false,
        });
      // strict: guessing whether an unmatched question is about products -
      // meaning only, so stray keywords ("book", "delhi") can't pull in designs.
      res = strict
        ? await search(db, { mode: 'vector', vector, similarity: STRICT_SIMILARITY, where, limit: from + n, includeVectors: false })
        : await run(SIMILARITY);
      // Vague requests ("gift for my wife under 50k"): show the closest designs anyway.
      if (!res.count && !strict) res = await run(RELAXED_SIMILARITY);
    } else {
      // Filters only ("under 30k"): everything that fits, cheapest first.
      res = await search(db, { term: '', where, limit: from + n, includeVectors: false, sortBy: { property: 'price', order: 'ASC' } });
    }
    const products = res.hits.slice(from, from + n).map((h) => findByCode(h.id)).filter(Boolean).map(publicProduct);
    return { total_matches: res.count, products };
  } catch (err) {
    console.error('[vectors] search failed, using keyword search:', err.message);
    return null;
  }
}

/** Product search used everywhere: vector database first, keyword search as fallback. */
export async function findProducts(params) {
  return (await vectorSearchProducts(params)) || searchProducts(params);
}

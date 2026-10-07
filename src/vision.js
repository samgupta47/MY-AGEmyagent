// Photo search: a customer uploads a photo and we find the most similar designs.
// Uses the free CLIP model running locally (no API cost). Every product photo
// is turned into an "embedding" once and stored in data/image-index.json; a
// customer photo is compared against all of them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';
import { DATA_DIR, load } from './store.js';
import { productMatches } from './search.js';

const MODEL = 'Xenova/clip-vit-base-patch32';
const INDEX_FILE = path.join(DATA_DIR, 'image-index.json');
const DIM = 512;

// Jewellery types the model can recognise: several descriptions each (averaged,
// which recognises much better than one), and the catalogue word for each.
// "none" catches photos that are not jewellery (pets, people, food...).
// Tested on 22 real photos: 16 correct vs 11 with one description per type.
const TYPES = [
  { key: 'ring', term: 'ring', prompts: ['a finger ring', 'a gold ring', 'a diamond ring', 'a ring worn on a finger'] },
  { key: 'earrings', term: 'earrings', prompts: ['a pair of earrings', 'jhumka earrings', 'gold drop earrings', 'stud earrings', 'hoop earrings'] },
  { key: 'necklace', term: 'necklace', prompts: ['a necklace', 'a gold necklace set', 'a heavy indian bridal necklace', 'layered necklaces worn on the neck'] },
  { key: 'chain', term: 'chain', prompts: ['a plain gold chain', 'a thin chain necklace', 'a link chain'] },
  { key: 'bracelet', term: 'bracelet', prompts: ['a bracelet', 'a gold cuff bracelet', 'a link bracelet on a wrist'] },
  { key: 'bangle', term: 'bangle', prompts: ['bangles', 'a gold bangle', 'glass bangles on wrists', 'a kada'] },
  { key: 'mangalsutra', term: 'mangalsutra', prompts: ['a mangalsutra with black beads', 'a black bead necklace with a gold pendant', 'an indian wedding mangalsutra'] },
  { key: 'pendant', term: 'pendant', prompts: ['a pendant locket', 'a small gold pendant', 'a pendant on a chain'] },
  { key: 'tikka', term: 'tikka', prompts: ['a maang tikka forehead jewellery', 'an indian head ornament with a hanging pendant'] },
  { key: 'murti', term: 'murti', prompts: ['a silver idol statue of a hindu god', 'a ganesha idol', 'a religious statue', 'a lakshmi ganesh murti'] },
  { key: 'anklet', term: 'anklet', prompts: ['an anklet', 'silver payal anklets', 'an ankle chain'] },
  { key: 'none', term: null, prompts: ['a photo of an animal', 'a photo of a cat or dog', 'a photo of a person without jewellery', 'a photo of food', 'a landscape', 'a screenshot of text', 'a car', 'a building'] },
];

// Keep CPU use low on shared hosting: one thread, and a pause between product
// photos while indexing (a customer search is a single ~0.1 s step).
const SESSION = { session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } };
const INDEX_PAUSE_MS = 400;
// Below this the type guess is unreliable (from the 22-photo test), so results
// are ranked by looks only and no type is claimed.
const TYPE_CONFIDENCE = 0.4;
const INDEX_START_DELAY_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let modelsPromise = null;

async function models() {
  modelsPromise ??= (async () => {
    const T = await import('@huggingface/transformers');
    T.env.cacheDir = path.join(DATA_DIR, 'models'); // kept with the data so redeploys don't re-download it
    const [processor, vision, tokenizer, text] = await Promise.all([
      T.AutoProcessor.from_pretrained(MODEL),
      T.CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'q8', ...SESSION }),
      T.AutoTokenizer.from_pretrained(MODEL),
      T.CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: 'q8', ...SESSION }),
    ]);
    const typeEmbeds = [];
    for (const t of TYPES) {
      const prompts = t.prompts.map((p) => `a photo of ${p}`);
      const { text_embeds } = await text(tokenizer(prompts, { padding: true, truncation: true }));
      const mean = new Float32Array(DIM);
      for (let i = 0; i < prompts.length; i++) {
        const e = normalize(text_embeds.data.slice(i * DIM, (i + 1) * DIM));
        for (let j = 0; j < DIM; j++) mean[j] += e[j];
      }
      typeEmbeds.push(normalize(mean));
    }
    return { T, processor, vision, typeEmbeds };
  })().catch((err) => {
    modelsPromise = null;
    throw err;
  });
  return modelsPromise;
}

function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  return Float32Array.from(v, (x) => x / s);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
}

async function embed(buffer) {
  const { T, processor, vision } = await models();
  const img = await T.RawImage.fromBlob(new Blob([buffer]));
  const { image_embeds } = await vision(await processor(img));
  return normalize(image_embeds.data);
}

// --- product photo index --------------------------------------------------------

let index = null; // { model, items: { code: { img, e: Float32Array } } }

function loadIndex() {
  if (index) return index;
  index = { model: MODEL, items: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (raw.model === MODEL) {
      for (const [code, it] of Object.entries(raw.items)) {
        if (!it.e) { index.items[code] = { img: it.img, e: null }; continue; } // photo missing in CRM
        const b = Buffer.from(it.e, 'base64'); // may sit inside a shared pool: copy its exact bytes
        index.items[code] = { img: it.img, e: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) };
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[vision] index unreadable, rebuilding:', err.message);
  }
  return index;
}

function saveIndex() {
  const items = {};
  for (const [code, it] of Object.entries(index.items)) {
    items[code] = { img: it.img, e: it.e ? Buffer.from(it.e.buffer, it.e.byteOffset, it.e.byteLength).toString('base64') : null };
  }
  const tmp = INDEX_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ model: MODEL, items }));
  fs.renameSync(tmp, INDEX_FILE);
}

let indexing = null;

/** Embeds product photos that are new or changed since the last run. */
export function updateIndex() {
  if (!config.PHOTO_SEARCH) return Promise.resolve();
  indexing ??= doUpdateIndex()
    .catch((err) => console.error('[vision] indexing failed:', err.message))
    .finally(() => (indexing = null));
  return indexing;
}

async function doUpdateIndex() {
  const idx = loadIndex();
  const products = load('catalog').products;
  const live = new Set(products.map((p) => p.code));
  for (const code of Object.keys(idx.items)) if (!live.has(code)) delete idx.items[code];

  const todo = products.filter((p) => (p.thumb || p.image) && idx.items[p.code]?.img !== (p.thumb || p.image));
  if (!todo.length) return;
  // A big batch (first run) waits a minute so the site is responsive right after start-up.
  if (todo.length > 20) await sleep(INDEX_START_DELAY_MS);
  console.log(`[vision] indexing ${todo.length} product photo(s)…`);
  await models();
  let done = 0;
  for (const p of todo) {
    await sleep(INDEX_PAUSE_MS); // gentle on shared-hosting CPU
    const url = p.thumb || p.image;
    try {
      let res = await fetch(url);
      if (!res.ok && p.image && url !== p.image) res = await fetch(p.image);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      idx.items[p.code] = { img: url, e: await embed(Buffer.from(await res.arrayBuffer())) };
    } catch (err) {
      // Remember the failure so we only retry when the CRM photo changes.
      idx.items[p.code] = { img: url, e: null };
      console.error(`[vision] ${p.code}: no usable photo (${err.message})`);
    }
    if (++done % 50 === 0) {
      saveIndex();
      console.log(`[vision] ${done}/${todo.length}`);
    }
  }
  saveIndex();
  console.log(`[vision] photo index ready: ${indexStats().indexed} designs`);
}

export function indexStats() {
  const items = Object.values(loadIndex().items);
  return { indexed: items.filter((it) => it.e).length, noPhoto: items.filter((it) => !it.e).length, indexing: Boolean(indexing) };
}

// --- searching ----------------------------------------------------------------

const results = new Map(); // id -> { codes, at }
setInterval(() => {
  const cutoff = Date.now() - 2 * 3600_000;
  for (const [k, v] of results) if (v.at < cutoff) results.delete(k);
}, 600_000).unref();

/**
 * Ranks in-stock designs by visual similarity to the photo.
 * `typeTerm` (e.g. "ring" typed by the customer) overrides the guessed type.
 * Returns { id, type: {key, confidence} | null, notJewellery, codes: [...] }.
 */
export async function similarToPhoto(buffer, { filter, typeTerm } = {}) {
  if (!config.PHOTO_SEARCH) throw new Error('photo search is turned off in src/config.js');
  const e = await embed(buffer);
  const { typeEmbeds } = await models();

  // Zero-shot guess of the jewellery type (CLIP logit scale is 100).
  const logits = typeEmbeds.map((t) => dot(e, t) * 100);
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  let best = 0;
  for (let i = 1; i < exps.length; i++) if (exps[i] > exps[best]) best = i;
  const type = { key: TYPES[best].key, term: TYPES[best].term, confidence: exps[best] / sum };
  const notJewellery = type.key === 'none' && !typeTerm;
  const sure = !notJewellery && type.key !== 'none' && type.confidence >= TYPE_CONFIDENCE;

  const idx = loadIndex();
  let candidates = load('catalog').products.filter((p) => idx.items[p.code]?.e && (!filter || filter(p)));
  // Only show one type when the customer named it, or the model is fairly sure.
  const term = typeTerm || (sure ? type.term : null);
  if (term) {
    const sameType = candidates.filter((p) => productMatches(p, term));
    if (sameType.length >= 3 || typeTerm) candidates = sameType;
  }
  const codes = candidates
    .map((p) => ({ code: p.code, s: dot(e, idx.items[p.code].e) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 100)
    .map((x) => x.code);

  const id = crypto.randomBytes(8).toString('hex');
  results.set(id, { codes, at: Date.now() });
  return { id, type: sure && !typeTerm ? type : null, notJewellery, codes };
}

export function similarPage(id, offset, n) {
  const r = results.get(id);
  if (!r) return null;
  return { codes: r.codes.slice(offset, offset + n), total: r.codes.length };
}

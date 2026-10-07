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

// Jewellery types the model can recognise, and the catalogue word for each.
const TYPES = [
  { key: 'ring', label: 'a finger ring', term: 'ring' },
  { key: 'earrings', label: 'a pair of earrings', term: 'earrings' },
  { key: 'jhumka', label: 'jhumka earrings', term: 'earrings' },
  { key: 'necklace', label: 'a necklace', term: 'necklace' },
  { key: 'chain', label: 'a plain gold chain', term: 'chain' },
  { key: 'bracelet', label: 'a bracelet', term: 'bracelet' },
  { key: 'bangle', label: 'bangles', term: 'bangle' },
  { key: 'mangalsutra', label: 'a mangalsutra with black beads', term: 'mangalsutra' },
  { key: 'pendant', label: 'a pendant locket', term: 'pendant' },
  { key: 'pendant set', label: 'a pendant with matching earrings', term: 'pendant' },
  { key: 'tikka', label: 'a maang tikka forehead jewellery', term: 'tikka' },
  { key: 'murti', label: 'a silver idol statue of a hindu god', term: 'murti' },
  { key: 'anklet', label: 'an anklet', term: 'anklet' },
];

let modelsPromise = null;

async function models() {
  modelsPromise ??= (async () => {
    const T = await import('@huggingface/transformers');
    T.env.cacheDir = path.join(DATA_DIR, 'models'); // kept with the data so redeploys don't re-download it
    const [processor, vision, tokenizer, text] = await Promise.all([
      T.AutoProcessor.from_pretrained(MODEL),
      T.CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'q8' }),
      T.AutoTokenizer.from_pretrained(MODEL),
      T.CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: 'q8' }),
    ]);
    const prompts = TYPES.map((t) => `a photo of ${t.label}`);
    const { text_embeds } = await text(tokenizer(prompts, { padding: true, truncation: true }));
    const typeEmbeds = TYPES.map((_, i) => normalize(text_embeds.data.slice(i * DIM, (i + 1) * DIM)));
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
  console.log(`[vision] indexing ${todo.length} product photo(s)…`);
  await models();
  let done = 0;
  for (const p of todo) {
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
 * Returns { id, type: {key, confidence} | null, codes: [...] }.
 */
export async function similarToPhoto(buffer, { filter } = {}) {
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

  const idx = loadIndex();
  let candidates = load('catalog').products.filter((p) => idx.items[p.code]?.e && (!filter || filter(p)));
  // If the model is fairly sure of the type, only show that type.
  if (type.confidence >= 0.45) {
    const sameType = candidates.filter((p) => productMatches(p, type.term));
    if (sameType.length >= 3) candidates = sameType;
  }
  const codes = candidates
    .map((p) => ({ code: p.code, s: dot(e, idx.items[p.code].e) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 100)
    .map((x) => x.code);

  const id = crypto.randomBytes(8).toString('hex');
  results.set(id, { codes, at: Date.now() });
  return { id, type: type.confidence >= 0.45 ? type : null, codes };
}

export function similarPage(id, offset, n) {
  const r = results.get(id);
  if (!r) return null;
  return { codes: r.codes.slice(offset, offset + n), total: r.codes.length };
}

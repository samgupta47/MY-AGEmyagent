// "Meaning" matching for free mode: finds the Q&A or store-info line that means
// the same as the customer's question even when the words differ
// ("where is the game being held" ≈ "Where do I play?"). Uses a small free
// sentence model (~25 MB, ~2 ms per question, one CPU thread).
import path from 'node:path';
import config from './config.js';
import { DATA_DIR } from './store.js';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

// Common Hinglish words → English, so the English model understands them.
// Tested: 22/24 paraphrased/Hinglish questions matched correctly (17/24 without this).
const HINGLISH = {
  purana: 'old', purani: 'old', sona: 'gold', sone: 'gold', chandi: 'silver', lete: 'buy', lena: 'buy', bechna: 'sell', bechni: 'sell', bech: 'sell',
  dukaan: 'shop', dukan: 'shop', kahan: 'where', kaha: 'where', kab: 'when', khulta: 'open', khulti: 'open', khulega: 'open', baje: 'time',
  kitne: 'how much', kitna: 'how much', kitni: 'how much', milti: 'available', milta: 'available', milegi: 'available', milega: 'available',
  bana: 'make', banate: 'make', banwana: 'make', banwani: 'make', sakte: 'can', sakta: 'can', sakti: 'can',
  kist: 'emi installments', installments: 'emi', installment: 'emi', huid: 'hallmark', bhejte: 'deliver', bhejoge: 'deliver', courier: 'deliver',
  aap: 'you', aapka: 'your', apka: 'your', mera: 'my', meri: 'my', naam: 'name', paisa: 'money', paise: 'money', wapas: 'return', badalna: 'exchange',
  kya: '', hai: '', hain: '', ho: '', karte: '', karti: '', kar: '', ki: '', ka: '', ke: '', se: '', mein: 'in', me: 'me',
};

export function translate(text) {
  return String(text || '')
    .toLowerCase()
    .split(/\s+/)
    .map((w) => {
      const c = w.replace(/[^a-z]/g, '');
      return c in HINGLISH ? HINGLISH[c] : w;
    })
    .filter(Boolean)
    .join(' ');
}

let pipe = null;

function extractor() {
  pipe ??= (async () => {
    const T = await import('@huggingface/transformers');
    T.env.cacheDir = path.join(DATA_DIR, 'models');
    return T.pipeline('feature-extraction', MODEL, { dtype: 'q8', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } });
  })().catch((err) => {
    pipe = null;
    throw err;
  });
  return pipe;
}

const cache = new Map(); // translated text -> embedding

async function embed(text) {
  const key = translate(text);
  if (cache.has(key)) return cache.get(key);
  const ex = await extractor();
  const v = (await ex(key, { pooling: 'mean', normalize: true })).data;
  if (cache.size > 3000) cache.clear();
  cache.set(key, v);
  return v;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Best candidate by meaning: { index, score } (score ~0..1), or null if unavailable. */
export async function bestByMeaning(query, candidates) {
  const scores = await scoresByMeaning(query, candidates);
  if (!scores) return null;
  let best = { index: -1, score: -1 };
  scores.forEach((s, i) => s > best.score && (best = { index: i, score: s }));
  return best;
}

/** Meaning score of the query against each candidate text, or null if unavailable. */
export async function scoresByMeaning(query, candidates) {
  if (!config.SMART_ANSWERS || !candidates.length) return null;
  try {
    const q = await embed(query);
    const out = [];
    for (const c of candidates) out.push(dot(q, await embed(c)));
    return out;
  } catch (err) {
    console.error('[meaning] unavailable, using word matching only:', err.message);
    return null;
  }
}

/** Loads the model in the background so the first customer question is fast. */
export function warmUp() {
  if (config.SMART_ANSWERS) extractor().catch(() => {});
}

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
  ghar: 'home', bhej: 'send deliver', bhejna: 'send deliver', bhejo: 'send deliver', gaadi: 'car vehicle', gadi: 'car vehicle', khadi: 'park', khada: 'park',
  anguthi: 'ring', angoothi: 'ring', chhoti: 'small tight', choti: 'small tight', badi: 'bigger', bada: 'bigger', dikha: 'show', dikhao: 'show', dikhana: 'show',
  purane: 'old', gehne: 'jewellery', gehna: 'jewellery', zevar: 'jewellery', chamka: 'shine polish', chamkana: 'shine polish', saaf: 'clean',
  chalega: 'accepted', paytm: 'upi payment', gpay: 'upi payment', phonepe: 'upi payment', pakki: 'proper', pakka: 'proper', theek: 'fix repair', kharab: 'broken repair',
  invoice: 'invoice bill', receipt: 'receipt bill', packing: 'packing wrapping', karoge: '', doge: '', dete: '', kuch: 'something',
  kya: '', hai: '', hain: '', ho: '', karte: '', karti: '', kar: '', ki: '', ka: '', ke: '', se: '', mein: 'in', me: 'me',
};

// Common Punjabi words (typed in English letters) → English.
const PUNJABI = {
  tusi: 'you', tussi: 'you', tuhada: 'your', tuhadi: 'your', tuhade: 'your', tuhanu: 'you', tainu: 'you', mainu: 'me', menu: 'me', sanu: 'us', saanu: 'us',
  kithe: 'where', kidhar: 'where', kado: 'when', kadon: 'when', kinna: 'how much', kinne: 'how much', kinni: 'how much', kive: 'how', kiddan: 'how',
  ha: '', haiga: '', hega: '', hoyega: '', ne: '', da: '', di: '', de: '', nu: '', vich: 'in', te: '', ji: '',
  vaje: 'time', waje: 'time', khulda: 'open', khuldi: 'open', khulde: 'open', kharidna: 'buy', khareedna: 'buy', kharid: 'buy', kharido: 'buy',
  lainde: 'buy', lende: 'buy', laina: 'buy', lavo: 'buy', vechna: 'sell', vecho: 'sell', vechde: 'sell', dinde: 'give', dende: 'give', karde: '', kardo: '',
  bhejde: 'send deliver', bhejoge: 'send deliver', milda: 'available', mildi: 'available', milde: 'available', milju: 'available',
  chahida: 'want', chahidi: 'want', chahide: 'want', dasso: 'tell', daso: 'tell', dass: 'tell', vekhao: 'show', vikhao: 'show', vekh: 'see', dekh: 'see',
  hatti: 'shop', hatt: 'shop', sunyara: 'jeweller', suniara: 'jeweller', gaddi: 'car vehicle', vadda: 'bigger', vaddi: 'bigger', vadi: 'bigger',
  navaan: 'new', navi: 'new', changa: 'good', vadhia: 'good', badhiya: 'good',
  tohfa: 'gift', tohfe: 'gift', tohafe: 'gift', grahak: 'customer', faida: 'benefit reward', fayda: 'benefit reward', chalda: 'accepted', chaldi: 'accepted',
  naal: 'with', sakde: 'can', sakdi: 'can', dio: '', diyoge: '', dioge: '', karaan: '', kariye: '', pasand: 'like', taan: '', jauga: '', je: 'if',
  gahine: 'jewellery', gahina: 'jewellery', kharhi: 'park', kharri: 'park', lai: 'for', layi: 'for',
  // English loan words as they come out of Gurmukhi/Devanagari letters
  veedeeo: 'video', vidio: 'video', vidiyo: 'video', gaahak: 'customer', gahak: 'customer', peteeaim: 'upi payment', petiem: 'upi payment', bil: 'bill', koee: 'any', koi: 'any',
  valiyan: 'earrings', waliyan: 'earrings', baliyan: 'earrings', kante: 'earrings', mundri: 'ring', chhaap: 'ring', chhap: 'ring',
  kaintha: 'necklace', kantha: 'necklace', jhanjar: 'anklet', jhanjran: 'anklet', pazeb: 'anklet',
};

// Spelling is very loose in romanized Hindi/Punjabi ("kithe/kitthe/kithhe",
// "dukaan/dukan", "wapas/vapas"), so words are also looked up by a rough
// skeleton of their spelling.
function skeleton(w) {
  const s = w
    .replace(/w/g, 'v').replace(/q/g, 'k').replace(/z/g, 'j').replace(/ph/g, 'f')
    .replace(/ee/g, 'i').replace(/oo/g, 'u')
    .replace(/(.)\1+/g, '$1') // collapse doubled letters
    .replace(/([kgtdcbplrnm])h/g, '$1') // kh/th/dh/lh... spelled with or without h
    .replace(/^(.{3,}[aeiou])n$/, '$1'); // nasal ending on longer words: "tuseen" ~ "tusi"
  // inner short "a" is often written or left out: "bhejade" ~ "bhejde", "mundari" ~ "mundri"
  return s.length > 3 ? s[0] + s.slice(1, -1).replace(/a/g, '') + s.at(-1) : s;
}
const LOCAL_WORDS = { ...HINGLISH, ...PUNJABI };
const BY_SKELETON = new Map();
for (const [k, v] of Object.entries(LOCAL_WORDS)) if (!BY_SKELETON.has(skeleton(k))) BY_SKELETON.set(skeleton(k), v);

// Gurmukhi (Punjabi) and Devanagari (Hindi) letters → English letters, so
// "ਦੁਕਾਨ ਕਿੱਥੇ ਹੈ" / "दुकान कहाँ है" go through the same word lists.
const SCRIPT = {
  // Gurmukhi
  'ਅ': 'a', 'ਆ': 'aa', 'ਇ': 'i', 'ਈ': 'ee', 'ਉ': 'u', 'ਊ': 'oo', 'ਏ': 'e', 'ਐ': 'ai', 'ਓ': 'o', 'ਔ': 'au',
  'ਕ': 'k', 'ਖ': 'kh', 'ਗ': 'g', 'ਘ': 'gh', 'ਙ': 'n', 'ਚ': 'ch', 'ਛ': 'chh', 'ਜ': 'j', 'ਝ': 'jh', 'ਞ': 'n', 'ਟ': 't', 'ਠ': 'th', 'ਡ': 'd', 'ਢ': 'dh', 'ਣ': 'n',
  'ਤ': 't', 'ਥ': 'th', 'ਦ': 'd', 'ਧ': 'dh', 'ਨ': 'n', 'ਪ': 'p', 'ਫ': 'ph', 'ਬ': 'b', 'ਭ': 'bh', 'ਮ': 'm', 'ਯ': 'y', 'ਰ': 'r', 'ਲ': 'l', 'ਵ': 'v', 'ੜ': 'r',
  'ਸ': 's', 'ਹ': 'h', 'ਸ਼': 'sh', 'ਖ਼': 'kh', 'ਗ਼': 'g', 'ਜ਼': 'z', 'ਫ਼': 'f', 'ਲ਼': 'l',
  // Devanagari
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n', 'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n', 'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h', 'ड़': 'r', 'ढ़': 'rh', 'क़': 'k', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'फ़': 'f',
};
const MATRA = {
  'ਾ': 'aa', 'ਿ': 'i', 'ੀ': 'ee', 'ੁ': 'u', 'ੂ': 'oo', 'ੇ': 'e', 'ੈ': 'ai', 'ੋ': 'o', 'ੌ': 'au',
  'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o',
};
const NASAL = new Set(['ੰ', 'ਂ', 'ं', 'ँ']);
const VIRAMA = new Set(['੍', '्']);
const VOWELS = new Set(['ਅ', 'ਆ', 'ਇ', 'ਈ', 'ਉ', 'ਊ', 'ਏ', 'ਐ', 'ਓ', 'ਔ', 'अ', 'आ', 'इ', 'ई', 'उ', 'ऊ', 'ऋ', 'ए', 'ऐ', 'ओ', 'औ']);

export function romanize(text) {
  if (!/[ऀ-ॿ਀-੿]/.test(text)) return text;
  const chars = [...text.normalize('NFC')];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    if (c in SCRIPT) {
      out += SCRIPT[c];
      // consonant: inherent "a" unless a vowel sign / virama follows or the word ends
      const endOfWord = !next || /\s|[.,!?]/.test(next);
      if (!VOWELS.has(c) && !(next in MATRA) && !VIRAMA.has(next) && next !== '़' && next !== '਼' && !endOfWord) out += 'a';
    } else if (c in MATRA) out += MATRA[c];
    else if (NASAL.has(c)) out += 'n';
    else if (VIRAMA.has(c) || c === 'ੱ' || c === '़' || c === '਼') continue; // virama, addak, nukta
    else if (c === 'ः' || c === 'ਃ') out += 'h';
    else if (c === '।' || c === '॥') out += '.';
    else out += c;
  }
  return out;
}

export function translate(text) {
  return romanize(String(text || ''))
    .toLowerCase()
    .split(/\s+/)
    .map((w) => {
      const c = w.replace(/[^a-z]/g, '');
      if (c in LOCAL_WORDS) return LOCAL_WORDS[c];
      const s = skeleton(c);
      return s.length >= 2 && BY_SKELETON.has(s) ? BY_SKELETON.get(s) : w;
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

export async function embed(text) {
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

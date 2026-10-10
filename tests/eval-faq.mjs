// Which small sentence model best matches customer questions to Q&As by meaning?
import { pathToFileURL } from 'node:url';
const T = await import(pathToFileURL('C:/Users/Sameer Gupta/Desktop/ecommerce-website/ittan-ai-agent/node_modules/@huggingface/transformers/dist/transformers.node.mjs').href);
T.env.cacheDir = 'C:/Users/Sameer Gupta/Desktop/ecommerce-website/ittan-ai-agent/data/models';

const faqs = ['Where do I play?', 'Do you buy old gold?', 'Is EMI available?', 'Do you make custom jewellery?', 'Is your gold hallmarked?', 'What are your store timings?', 'Where is your store located?', 'Do you deliver outside Punjab?'];
// [question, expected FAQ index or -1 for "should match nothing"]
const tests = [
  ['where is the game being held', 0], ['where i play', 0], ['where can I play', 0],
  ['old gold exchange karte ho?', 1], ['can I sell my old jewellery', 1], ['purana sona lete ho', 1],
  ['can I pay in installments', 2], ['emi milti hai kya', 2],
  ['can you make a ring with my own design', 3], ['customised mangalsutra bana sakte ho', 3],
  ['is the gold BIS certified', 4], ['huid hai kya', 4],
  ['when do you open', 5], ['store timing kya hai', 5], ['what time do you close on sunday', 5],
  ['what is your address', 6], ['how do I reach your shop', 6], ['dukaan kahan hai', 6],
  ['do you ship to Delhi', 7], ['courier karte ho mumbai', 7],
  ['what is my name', -1], ['tell me a joke', -1], ['who won the cricket match', -1], ['show me gold rings', -1],
];

const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s); return Float32Array.from(v, (x) => x / s); };
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

const HINGLISH = {
  purana: 'old', purani: 'old', sona: 'gold', sone: 'gold', chandi: 'silver', lete: 'buy', lena: 'buy', lo: 'buy', bechna: 'sell', bechni: 'sell', bech: 'sell',
  dukaan: 'shop', dukan: 'shop', kahan: 'where', kaha: 'where', kab: 'when', khulta: 'open', khulti: 'open', khulega: 'open', baje: 'time',
  kitne: 'how much', kitna: 'how much', milti: 'available', milta: 'available', milegi: 'available', bana: 'make', banate: 'make', banwana: 'make', banwani: 'make',
  sakte: 'can', sakta: 'can', kist: 'emi installments', installments: 'emi', installment: 'emi', huid: 'hallmark', hallmark: 'hallmark',
  bhejte: 'deliver', bhejoge: 'deliver', courier: 'deliver', kya: '', hai: '', ho: '', karte: '', kar: '', aap: 'you', mera: 'my', naam: 'name',
};
const translate = (s) => s.toLowerCase().split(/\s+/).map((w) => { const c = w.replace(/[^a-z]/g, ''); return c in HINGLISH ? HINGLISH[c] : w; }).filter(Boolean).join(' ');

for (const MODEL of ['Xenova/all-MiniLM-L6-v2']) {
  const t0 = Date.now();
  const extract = await T.pipeline('feature-extraction', MODEL, { dtype: 'q8', session_options: { intraOpNumThreads: 1 } });
  const emb = async (s) => norm((await extract(translate(s), { pooling: 'mean', normalize: true })).data);
  const F = []; for (const f of faqs) F.push(await emb(f));
  const load = Date.now() - t0;
  const rows = []; let ms = 0;
  for (const [q, want] of tests) {
    const t = Date.now(); const e = await emb(q); ms += Date.now() - t;
    const scores = F.map((f) => dot(e, f)); const best = scores.indexOf(Math.max(...scores));
    rows.push({ q, want, best, score: scores[best] });
  }
  // pick the threshold that gets the most right
  let bestT = 0, bestOk = -1;
  for (let th = 0.3; th <= 0.8; th += 0.025) {
    const ok = rows.filter((r) => (r.score >= th ? r.best : -1) === r.want).length;
    if (ok > bestOk) { bestOk = ok; bestT = th; }
  }
  console.log(`\n### ${MODEL}: ${bestOk}/${rows.length} correct at threshold ${bestT.toFixed(3)}  (load ${Math.round(load / 1000)}s, ${Math.round(ms / rows.length)} ms/question)`);
  for (const r of rows) {
    const got = r.score >= bestT ? r.best : -1;
    console.log(`${got === r.want ? '✔' : '✘'} ${r.q.padEnd(42)} -> ${got >= 0 ? faqs[got] : '(no match)'}  [${r.score.toFixed(2)}]`);
  }
}

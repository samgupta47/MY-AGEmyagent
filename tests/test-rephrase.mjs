// Train new Q&As, then ask rephrasings that share no content words with the
// original question, and measure how often the right answer comes back.
// Usage: node test-rephrase.mjs <url> [adminPassword]   (no password = ask only)
const B = process.argv[2] || 'http://localhost:3000';
const PW = process.argv[3];

export const QA = [
  { q: 'Do you offer free gift wrapping?', a: '[T1] Yes, every purchase gets free gift wrapping.',
    ask: ['can you pack it nicely as a present', 'will the box look special for a surprise', 'birthday surprise ke liye packing karoge'] },
  { q: 'Do you provide home delivery?', a: '[T2] Yes, we deliver to your home.',
    ask: ['can you send my order to my house', 'will someone bring it to my address', 'ghar pe bhej sakte ho'] },
  { q: 'What is your return policy?', a: '[T3] Returns accepted within 7 days with the bill.',
    ask: ['can I give back something I bought if I dont like it', 'i want my money back after buying, possible?', 'wapas kar sakte hain kya'] },
  { q: 'Is parking available at the showroom?', a: '[T4] Yes, free parking right outside the shop.',
    ask: ['where can I leave my car when I visit', 'space for my scooter near your place?', 'gaadi kahan khadi karu'] },
  { q: 'Do you resize rings?', a: '[T5] Yes, resizing is free within 30 days.',
    ask: ['my band is too tight, can you make it bigger', 'can you adjust the size so it fits my finger', 'anguthi chhoti ho gayi badi kar doge'] },
  { q: 'Can I book a video call to see designs?', a: '[T6] Yes, book a WhatsApp video call with our team.',
    ask: ['can you show me pieces live on camera', 'I live far away, can I view items online over a call', 'whatsapp pe live dikha sakte ho'] },
  { q: 'Do you have a loyalty points program?', a: '[T7] Yes, earn 1 point per Rs 1000 spent.',
    ask: ['do regular customers get rewards', 'any membership benefits for frequent buyers', 'purane customer ko kuch milta hai'] },
  { q: 'Do you clean and polish old jewellery?', a: '[T8] Yes, free cleaning and polishing for our customers.',
    ask: ['can you make my old necklace shine again', 'my bangles look dull, can you fix that', 'purane gehne chamka dete ho'] },
  { q: 'What payment methods do you accept?', a: '[T9] We accept UPI, cards, net banking and cash.',
    ask: ['can I pay using GPay or a card', 'is cash fine or only online', 'paytm chalega'] },
  { q: 'Do you give a GST bill?', a: '[T10] Yes, a proper GST invoice with every purchase.',
    ask: ['will I get an invoice for my purchase', 'need tax receipt for office claim', 'pakki receipt milegi'] },
];
// Punjabi rephrasings (English letters, then Gurmukhi) - no words from the original question.
const PUNJABI_ASK = [
  ['tohfe layi vadhia packing karde ho?', 'ਤੋਹਫ਼ੇ ਲਈ ਪੈਕਿੰਗ ਕਰਦੇ ਹੋ?'],
  ['tussi ghar bhejde ho?', 'ਕੀ ਤੁਸੀਂ ਘਰ ਭੇਜਦੇ ਹੋ?'],
  ['je pasand na aaye taan paise vapas milde ne?', 'ਪੈਸੇ ਵਾਪਸ ਮਿਲਦੇ ਨੇ?'],
  ['gaddi kithe khadi karaan?', 'ਗੱਡੀ ਕਿੱਥੇ ਖੜ੍ਹੀ ਕਰੀਏ?'],
  ['mundri tight hai, vaddi kar doge?', 'ਮੁੰਦਰੀ ਵੱਡੀ ਕਰ ਦਿਓਗੇ?'],
  ['video call te dikha sakde ho?', 'ਵੀਡੀਓ ਕਾਲ ਤੇ ਦਿਖਾ ਸਕਦੇ ਹੋ?'],
  ['purane grahak nu koi faida milda?', 'ਪੁਰਾਣੇ ਗਾਹਕ ਨੂੰ ਕੋਈ ਫਾਇਦਾ ਮਿਲਦਾ?'],
  ['purane gahine chamka dinde ho?', 'ਪੁਰਾਣੇ ਗਹਿਣੇ ਚਮਕਾ ਦਿੰਦੇ ਹੋ?'],
  ['gpay chalda hai?', 'ਪੇਟੀਐਮ ਚੱਲਦਾ?'],
  ['pakka bill milega?', 'ਪੱਕਾ ਬਿੱਲ ਮਿਲੇਗਾ?'],
];
QA.forEach((x, i) => x.ask.push(...PUNJABI_ASK[i]));
const UNRELATED = ['who is the prime minister of india', 'recommend a good movie', 'what is 2 plus 2', 'book me a flight to delhi', 'tell me a joke', 'how is the weather today'];

let cookie = '';
async function admin(path, opts = {}) {
  const res = await fetch(`${B}/admin/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return res.json().catch(() => null);
}
let n = 1;
async function ask(message) {
  const res = await fetch(`${B}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.8.8.${n++}` }, body: JSON.stringify({ message, pageUrl: 'rephrase-test' }) });
  let text = '', cards = 0;
  for (const c of (await res.text()).split('\n\n')) {
    const ev = (c.match(/^event: (.*)$/m) || [])[1]; const d = (c.match(/^data: (.*)$/m) || [])[1];
    if (ev === 'text') text += JSON.parse(d).delta; if (ev === 'products') cards += JSON.parse(d).items.length;
  }
  return { text, cards };
}

const added = [];
if (PW) {
  await admin('/login', { method: 'POST', body: { password: PW } });
  for (const x of QA) added.push((await admin('/faqs', { method: 'POST', body: { question: x.q, answer: x.a } })).id);
  console.log(`Trained ${added.length} new Q&As\n`);
}

// Live mode (no password): learn each Q&A's live answer by asking the exact
// original question, then recognise answers by that text.
const baseline = [];
if (!PW) {
  console.log('Live answers to the original questions:');
  for (const [i, x] of QA.entries()) {
    const r = await ask(x.q);
    const known = r.text && !/check with our team|couldn't find|Here are some designs|I found \d+/i.test(r.text) && !r.cards;
    baseline[i] = known ? r.text.trim() : null;
    console.log(`   [T${i + 1}] "${x.q}" -> ${known ? r.text.trim().slice(0, 80) : 'NOT TRAINED ON LIVE (' + r.text.slice(0, 50) + ')'}`);
  }
  console.log('');
}
const tagOf = (text) => {
  const t = (text.match(/\[T(\d+)\]/) || [])[1];
  if (t || PW) return t;
  const i = baseline.findIndex((b) => b && b === text.trim());
  return i >= 0 ? String(i + 1) : undefined;
};

let right = 0, wrong = 0, none = 0, skipped = 0;
for (const [i, x] of QA.entries()) {
  console.log(`Q&A [T${i + 1}] "${x.q}"`);
  if (!PW && !baseline[i]) { console.log('   (skipped - this Q&A is not on the live site)'); skipped += x.ask.length; continue; }
  for (const q of x.ask) {
    const r = await ask(q);
    const tag = tagOf(r.text);
    const verdict = tag == i + 1 ? 'RIGHT' : tag ? `WRONG (gave T${tag})` : r.cards ? `NO ANSWER (showed ${r.cards} products)` : 'NO ANSWER (sent to Needs answers)';
    if (verdict === 'RIGHT') right++; else if (tag) wrong++; else none++;
    console.log(`   ${verdict === 'RIGHT' ? '✔' : '✘'} "${q}" -> ${verdict}`);
  }
}
console.log('\nUnrelated questions (should NOT get a trained answer):');
let leaked = 0;
for (const q of UNRELATED) {
  const r = await ask(q);
  const tag = (r.text.match(/\[T(\d+)\]/) || [])[1];
  if (tag) leaked++;
  console.log(`   ${tag ? '✘' : '✔'} "${q}" -> ${tag ? `WRONG: gave T${tag}` : r.cards ? `${r.cards} products` : 'no trained answer'}`);
}
const total = QA.reduce((s, x) => s + x.ask.length, 0) - skipped;
console.log(`\nRESULT: ${right}/${total} rephrasings answered correctly (${Math.round((right / total) * 100)}%), ${wrong} wrong answers, ${none} not answered; unrelated: ${UNRELATED.length - leaked}/${UNRELATED.length} correctly not answered`);

if (PW) {
  for (const id of added) await admin(`/faqs/${id}`, { method: 'DELETE' });
  for (const u of (await admin('/unanswered')) || []) await admin(`/unanswered/${u.id}`, { method: 'DELETE' });
}

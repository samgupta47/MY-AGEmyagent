// Recreates the user's conversation + paraphrase/Hinglish cases on the agent.
const B = process.argv[2] || 'http://localhost:3000';
const PW = process.argv[3];
let cookie = '';
async function admin(path, opts = {}) {
  const res = await fetch(`${B}/admin/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', cookie }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return res.json().catch(() => null);
}
let n = 1;
async function ask(message) {
  const res = await fetch(`${B}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.3.3.${n++}` }, body: JSON.stringify({ message }) });
  let text = '', cards = 0;
  for (const c of (await res.text()).split('\n\n')) {
    const ev = (c.match(/^event: (.*)$/m) || [])[1]; const d = (c.match(/^data: (.*)$/m) || [])[1];
    if (ev === 'text') text += JSON.parse(d).delta; if (ev === 'products') cards += JSON.parse(d).items.length;
  }
  return { text, cards };
}
await admin('/login', { method: 'POST', body: { password: PW } });
const before = (await admin('/settings')).settings;
const added = [];
for (const [question, answer] of [
  ['where do i play', 'i play in playground'],
  ['Do you buy old gold?', 'TEST: Yes, we buy and exchange old gold at today\'s rate.'],
  ['Is EMI available?', 'TEST: Yes, EMI is available on major credit cards.'],
  ['Do you make custom jewellery?', 'TEST: Yes, we make jewellery to your design.'],
  ['Is your gold hallmarked?', 'TEST: All our gold is BIS hallmarked with HUID.'],
  ['Do you deliver outside Punjab?', 'TEST: Yes, we courier across India.'],
]) added.push((await admin('/faqs', { method: 'POST', body: { question, answer } })).id);
await admin('/settings', { method: 'PUT', body: { storeInfo: 'Address: 12 Test Market, Test City\nTimings: 11am to 9pm, Tuesday closed' } });

const cases = [
  ['where do i play', /playground/], ['where is the game being held', /playground/], ['where is tha game being held', /playground/], ['where i play', /playground/],
  ['purana sona lete ho', /old gold/], ['can I pay in installments', /EMI/], ['emi milti hai kya', /EMI/], ['huid hai kya', /hallmark/],
  ['can you make a ring with my own design', /your design/], ['do you ship to Delhi', /courier/], ['courier karte ho mumbai', /courier/],
  ['dukaan kahan hai', /Test Market/], ['how do I reach your shop', /Test Market/], ['when do you open', /11am/], ['store timing kya hai', /11am/],
  ['show me gold rings', null], ['what is my name', /check with our team/], ['who won the cricket match', /check with our team/],
];
let ok = 0;
for (const [q, want] of cases) {
  const r = await ask(q);
  const pass = want ? want.test(r.text) : r.cards > 0;
  ok += pass;
  console.log(`${pass ? '✔' : '✘'} ${q.padEnd(40)} -> ${r.cards ? r.cards + ' product cards' : r.text.slice(0, 70)}`);
}
console.log(`\n${ok}/${cases.length} correct`);
for (const id of added) await admin(`/faqs/${id}`, { method: 'DELETE' });
await admin('/settings', { method: 'PUT', body: { storeInfo: before.storeInfo } });
// remove the test questions this run sent to "Needs answers"
for (const u of (await admin('/unanswered')) || []) if (/my name|cricket/.test(u.question)) await admin(`/unanswered/${u.id}`, { method: 'DELETE' });

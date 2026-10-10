// Tests every non-photo feature: chat answers, training, leads, admin panel.
const B = process.argv[2] || 'http://localhost:3000';
const PW = process.argv[3];
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? '✔' : '✘'} ${name}${info ? '  — ' + info : ''}`); };
let ip = 1;
async function chat(message, conversationId) {
  const res = await fetch(`${B}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.1.1.${ip++}` }, body: JSON.stringify({ message, conversationId, pageUrl: 'feature-test' }) });
  if (!res.ok) return { status: res.status, error: (await res.json()).error, text: '', items: [] };
  const out = { status: 200, text: '', items: [], more: null };
  for (const c of (await res.text()).split('\n\n')) {
    const ev = (c.match(/^event: (.*)$/m) || [])[1]; const d = (c.match(/^data: (.*)$/m) || [])[1];
    if (!ev) continue; const j = JSON.parse(d);
    if (ev === 'meta') out.conversationId = j.conversationId;
    if (ev === 'text') out.text += j.delta;
    if (ev === 'products') { out.items.push(...j.items); out.more = j.more; }
  }
  return out;
}
let cookie = '';
async function admin(path, opts = {}) {
  const res = await fetch(`${B}/admin/api${path}`, { ...opts, headers: { 'Content-Type': 'application/json', cookie, ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}
const prices = (items) => items.map((p) => p.price);

console.log('--- Chat: product questions ---');
let r = await chat('hi'); check('greeting', /Namaste/.test(r.text), r.text.slice(0, 60));
r = await chat('gold rings under 30k'); check('"gold rings under 30k"', r.items.length && prices(r.items).every((p) => p <= 30000) && r.items.every((p) => !/S9/.test(p.purity)), `${r.more?.total ?? r.items.length} found, max ₹${Math.max(...prices(r.items))}`);
r = await chat('jhumka between 40k and 80k'); check('"jhumka between 40k and 80k"', r.items.length && prices(r.items).every((p) => p >= 40000 && p <= 80000), `${r.items.length} shown`);
r = await chat('22k chain'); check('"22k chain"', r.items.length && r.items.every((p) => p.purity === 'K22' && /chain/i.test(p.title)), r.items.slice(0, 3).map((p) => p.title).join(', '));
r = await chat('silver murti'); check('"silver murti"', r.items.length && r.items.every((p) => /murti/i.test(p.title)), `${r.more?.total ?? r.items.length} found`);
r = await chat('5 gram ring'); check('"5 gram ring" (weight)', r.items.length && r.items.every((p) => p.weightG >= 4.25 && p.weightG <= 5.75), r.items.map((p) => p.weightG).join(','));
r = await chat('mangalsutra dikhao'); check('Hinglish "mangalsutra dikhao"', r.items.length && r.items.every((p) => /mangal/i.test(p.title + p.code)), `${r.more?.total ?? r.items.length} found`);
r = await chat('ladies earrings 50,000 se kam'); check('"50,000 se kam" budget', r.items.length && prices(r.items).every((p) => p <= 50000));
r = await chat('BE07'); check('design code BE07', r.items[0]?.code === 'BE07', r.text.slice(0, 70));
r = await chat('ZZ999'); check('unknown code ZZ999', !r.items.length && /couldn't find design/i.test(r.text));
r = await chat('earrings');
let seen = r.items.map((p) => p.code), more = r.more, pages = 1;
while (more && pages < 3) { const j = await (await fetch(`${B}/api/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(more) })).json(); seen.push(...j.items.map((p) => p.code)); more = j.more; pages++; }
check('Load more on text search', seen.length === 30 && new Set(seen).size === 30, `${pages} pages, ${seen.length} designs, ${seen.length - new Set(seen).size} duplicates`);
r = await chat('thank you'); check('thanks', /welcome/i.test(r.text));

console.log('--- Chat: validation ---');
r = await chat(''); check('empty message refused', r.status === 400, r.error);
r = await chat('x'.repeat(1001)); check('message over 1000 chars refused', r.status === 400, r.error);

console.log('--- Admin login ---');
check('admin data blocked without login', (await admin('/overview')).status === 401);
check('wrong password refused', (await admin('/login', { method: 'POST', body: { password: 'wrong' } })).status === 401);
check('correct password accepted', (await admin('/login', { method: 'POST', body: { password: PW } })).status === 200);
const ov = await admin('/overview'); check('overview after login', ov.status === 200, `products ${ov.json?.catalog?.total}, photo ${JSON.stringify(ov.json?.photoSearch)}`);

console.log('--- Training: store info + Q&A ---');
const before = (await admin('/settings')).json.settings;
await admin('/settings', { method: 'PUT', body: { storeInfo: 'Address: 12 Test Market, Test City\nTimings: 11am to 9pm, Tuesday closed\nWe accept UPI, cards and cash' } });
r = await chat('what is your address?'); check('store info: address', /Test Market/.test(r.text), r.text);
r = await chat('store timing kya hai'); check('store info: timings (Hinglish)', /11am/.test(r.text), r.text);
r = await chat('do you accept upi'); check('store info: payment', /UPI/.test(r.text), r.text);
const faq = (await admin('/faqs', { method: 'POST', body: { question: 'Do you buy old gold?', answer: 'TEST: Yes, we exchange old gold at today\'s rate.' } })).json;
r = await chat('old gold exchange karte ho?'); check('Q&A answered', /exchange old gold/.test(r.text), r.text);
await admin(`/faqs/${faq.id}`, { method: 'PUT', body: { answer: 'TEST EDITED: old gold exchange answer' } });
r = await chat('do you buy old gold'); check('edited Q&A used', /EDITED/.test(r.text));
await admin(`/faqs/${faq.id}`, { method: 'DELETE' });
check('Q&A deleted', !(await admin('/faqs')).json.some((f) => f.id === faq.id));

console.log('--- Unanswered questions → teach ---');
r = await chat('do you give EMI on credit card?'); check('unknown question gets polite holding reply', /check with our team/i.test(r.text));
let un = (await admin('/unanswered')).json; const u = un.find((x) => /EMI/i.test(x.question));
check('it appears in "Needs answers"', Boolean(u));
await admin('/faqs', { method: 'POST', body: { question: u.question, answer: 'TEST: Yes, EMI is available on major credit cards.', unansweredId: u.id } });
check('teaching removes it from "Needs answers"', !(await admin('/unanswered')).json.some((x) => x.id === u.id));
r = await chat('is EMI available on credit card?'); check('agent now answers the taught question', /EMI is available/.test(r.text), r.text);
const taught = (await admin('/faqs')).json.find((f) => /EMI/.test(f.answer)); if (taught) await admin(`/faqs/${taught.id}`, { method: 'DELETE' });
r = await chat('gold rate today'); check('"gold rate today" is not treated as a product search', !r.items.length);

console.log('--- Leads ---');
const conv = await chat('I want a gold mangalsutra');
r = await chat('my name is Ravi 9876543210', conv.conversationId); check('phone number captured as lead', /9876543210/.test(r.text));
const lead = (await admin('/leads')).json.find((l) => l.phone === '9876543210');
check('lead in admin with name + interest', lead && lead.name === 'Ravi' && /mangalsutra/i.test(lead.interest), lead ? `${lead.name} / ${lead.interest}` : 'missing');
check('lead status can be changed', (await admin(`/leads/${lead.id}`, { method: 'PUT', body: { status: 'contacted' } })).json?.status === 'contacted');

console.log('--- Conversations & uploads ---');
const convs = (await admin('/conversations')).json; check('conversations list', convs.length > 0, `${convs.length} chats`);
const detail = (await admin(`/conversations/${conv.conversationId}`)).json; check('conversation detail shows both messages', detail?.messages?.length >= 4);
const withPhoto = []; for (const c of convs.slice(0, 80)) { const d = (await admin(`/conversations/${c.id}`)).json; const m = d.messages.find((x) => x.image); if (m) { withPhoto.push(m.image); break; } }
if (withPhoto.length) {
  const img = await fetch(`${B}/admin/api/uploads/${withPhoto[0]}`, { headers: { cookie } });
  check('customer photo viewable in admin', img.ok && /image/.test(img.headers.get('content-type')));
  check('customer photo NOT viewable without login', (await fetch(`${B}/admin/api/uploads/${withPhoto[0]}`)).status === 401);
}
check('path tricks blocked on uploads', (await fetch(`${B}/admin/api/uploads/..%2F..%2Fsrc%2Fconfig.js`, { headers: { cookie } })).status === 404);

console.log('--- Settings & catalogue ---');
await admin('/settings', { method: 'PUT', body: { welcomeMessage: 'TEST welcome', accentColor: '#123456' } });
const cfg = await (await fetch(`${B}/api/config`)).json(); check('settings change reaches the chat widget', cfg.welcomeMessage === 'TEST welcome' && cfg.accentColor === '#123456');
check('admin product search', (await admin('/catalog?q=ring')).json.matches > 0);
const sync = await admin('/sync', { method: 'POST' }); check('"Sync now" with CRM', sync.status === 200, `${sync.json?.total} products`);
await admin('/settings', { method: 'PUT', body: { allowedOrigins: 'https://ittanjeweller.com' } });
const okO = await fetch(`${B}/api/config`, { headers: { Origin: 'https://ittanjeweller.com' } });
const badO = await fetch(`${B}/api/config`, { headers: { Origin: 'https://evil.example' } });
check('allowed website gets access (CORS)', okO.headers.get('access-control-allow-origin') === 'https://ittanjeweller.com');
check('other websites blocked (CORS)', !badO.headers.get('access-control-allow-origin'));
await admin('/settings', { method: 'PUT', body: { storeInfo: before.storeInfo, welcomeMessage: before.welcomeMessage, accentColor: before.accentColor, allowedOrigins: before.allowedOrigins } });
await admin('/logout', { method: 'POST' }); check('logout ends admin access', (await admin('/overview')).status === 401);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);

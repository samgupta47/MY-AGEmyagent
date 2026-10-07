import config from './config.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { load, save, id, flushAll, DATA_DIR } from './store.js';
import { syncCatalog, scheduleSync, catalogueToken, CRM_BASE } from './crm.js';
import { directConfigured } from './crm-direct.js';
import { similarPage, indexStats } from './vision.js';
import { warmUp } from './meaning.js';
import fs from 'node:fs';
import { searchProducts, catalogSummary, findByCode, cardOf } from './search.js';
import { PAGE_SIZE } from './basic.js';
import { chat, getConversation, MODELS } from './agent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const PORT = Number(process.env.PORT) || config.PORT || 3000; // hosting panels set PORT themselves
const ADMIN_PASSWORD = config.ADMIN_PASSWORD || '';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' })); // customer photos arrive as base64

const UPLOADS = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

// Validates a customer photo (data URL from the widget) and saves it for the admin.
function readPhoto(dataUrl, convId) {
  if (dataUrl == null) return null;
  const m = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw new Error('Please upload a JPG, PNG or WEBP photo.');
  const buffer = Buffer.from(m[3], 'base64');
  if (buffer.length > 3 * 1024 * 1024) throw new Error('That photo is too large - please use one under 3 MB.');
  const file = `${convId}-${Date.now()}.${m[2] === 'jpeg' ? 'jpg' : m[2]}`;
  fs.writeFileSync(path.join(UPLOADS, file), buffer);
  return { buffer, mediaType: m[1], base64: m[3], file };
}

// --- simple in-memory rate limiter -------------------------------------------
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}
setInterval(() => hits.clear(), 3600_000).unref();

// --- public: widget + chat ----------------------------------------------------
function cors(req, res, next) {
  const origin = req.headers.origin;
  const allowed = load('settings').allowedOrigins.split(/[\s,]+/).filter(Boolean);
  if (origin && (!allowed.length || allowed.includes(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

app.use('/api', cors);

// wa.me links need the country code; the CRM stores 10-digit Indian numbers.
function waNumber(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length === 10 ? `91${d}` : d;
}

app.get('/api/config', (req, res) => {
  const s = load('settings');
  res.json({
    assistantName: s.assistantName,
    businessName: s.businessName,
    welcomeMessage: s.welcomeMessage,
    accentColor: s.accentColor,
    whatsappPhone: waNumber(s.whatsappPhone),
  });
});

app.post('/api/chat', async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const hasImage = req.body?.image != null;
  if (!message && !hasImage) return res.status(400).json({ error: 'message is required' });
  if (message.length > 1000) return res.status(400).json({ error: 'Message is too long.' });
  if (limited(`chat:${req.ip}`, 40, 10 * 60_000)) return res.status(429).json({ error: 'Too many messages - please wait a few minutes.' });
  if (hasImage && limited(`photo:${req.ip}`, 10, 10 * 60_000)) return res.status(429).json({ error: 'Too many photos - please wait a few minutes.' });

  const conv = getConversation(req.body.conversationId, req.body.pageUrl);
  if (conv.busy) return res.status(409).json({ error: 'Please wait for the previous reply.' });
  let image = null;
  try {
    image = readPhoto(req.body.image, conv.id);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  conv.busy = true;

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  emit('meta', { conversationId: conv.id });
  try {
    await chat(conv, message, emit, image);
  } finally {
    conv.busy = false;
    res.end();
  }
});

// "Load more" in the chat: next page of a product search the agent already ran.
app.post('/api/products', (req, res) => {
  if (limited(`more:${req.ip}`, 120, 10 * 60_000)) return res.status(429).json({ error: 'Too many requests - please wait a minute.' });
  const offset0 = Math.max(0, Math.min(5000, Number(req.body?.offset) || 0));
  if (typeof req.body?.similar === 'string') {
    const page = similarPage(req.body.similar, offset0, PAGE_SIZE);
    if (!page) return res.json({ items: [], more: null, error: 'These results expired - please send the photo again.' });
    const items = page.codes.map(findByCode).filter(Boolean).map(cardOf);
    const next = offset0 + page.codes.length;
    return res.json({ items, more: next < page.total ? { similar: req.body.similar, offset: next, total: page.total } : null });
  }
  const s = req.body?.search || {};
  const search = { query: typeof s.query === 'string' ? s.query.slice(0, 200) : '' };
  if (['gold', 'silver', 'platinum'].includes(s.metal)) search.metal = s.metal;
  if (typeof s.purity === 'string') search.purity = s.purity.slice(0, 10);
  for (const k of ['min_price', 'max_price', 'min_weight', 'max_weight']) if (Number.isFinite(s[k])) search[k] = s[k];
  const offset = Math.max(0, Math.min(5000, Number(req.body?.offset) || 0));
  const r = searchProducts({ ...search, limit: PAGE_SIZE, offset });
  const items = r.products.map((p) => cardOf(findByCode(p.code)));
  const next = offset + items.length;
  res.json({ items, more: next < r.total_matches ? { search, offset: next, total: r.total_matches } : null });
});

app.get('/widget.js', (req, res) => {
  res.set('Cache-Control', 'no-cache'); // revalidate each load so updates show immediately
  res.sendFile(path.join(PUBLIC, 'widget.js'));
});
app.get('/demo', (req, res) => res.sendFile(path.join(PUBLIC, 'demo.html')));
app.get('/', (req, res) => res.redirect('/demo'));

// --- admin auth ---------------------------------------------------------------
const sessions = new Map(); // token -> expiry
const COOKIE = 'ittan_admin';

function tokenFrom(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`));
  return m ? m[1] : null;
}

// With no ADMIN_PASSWORD set, the admin panel is open (single local admin).
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const t = tokenFrom(req);
  const exp = t && sessions.get(t);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: 'Please log in.' });
  next();
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));

app.post('/admin/api/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.json({ ok: true });
  if (limited(`login:${req.ip}`, 10, 15 * 60_000)) return res.status(429).json({ error: 'Too many attempts - try again later.' });
  if (!safeEqual(String(req.body?.password || ''), ADMIN_PASSWORD)) return res.status(401).json({ error: 'Wrong password.' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + 7 * 24 * 3600_000);
  const secure = req.secure ? '; Secure' : '';
  res.set('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${7 * 24 * 3600}${secure}`);
  res.json({ ok: true });
});

app.post('/admin/api/logout', (req, res) => {
  sessions.delete(tokenFrom(req));
  res.set('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
  res.json({ ok: true });
});

const admin = express.Router();
admin.use(requireAdmin);
app.use('/admin/api', admin);

admin.get('/overview', (req, res) => {
  const convs = load('conversations');
  const dayAgo = Date.now() - 24 * 3600_000;
  res.json({
    catalog: catalogSummary(),
    conversations: convs.length,
    conversationsToday: convs.filter((c) => Date.parse(c.startedAt) > dayAgo).length,
    leadsNew: load('leads').filter((l) => l.status === 'new').length,
    unansweredOpen: load('unanswered').filter((u) => u.status === 'open').length,
    faqs: load('faqs').length,
    apiKeySet: Boolean(config.ANTHROPIC_API_KEY),
    authEnabled: Boolean(ADMIN_PASSWORD),
    photoSearch: indexStats(),
    dataDir: DATA_DIR,
  });
});

// Settings
const EDITABLE = ['businessName', 'assistantName', 'whatsappPhone', 'welcomeMessage', 'accentColor', 'model', 'effort', 'syncIntervalHours', 'allowedOrigins', 'storeInfo', 'instructions'];

admin.get('/settings', (req, res) => res.json({ settings: load('settings'), models: MODELS, crmBase: CRM_BASE }));

admin.put('/settings', (req, res) => {
  const s = load('settings');
  for (const k of EDITABLE) {
    if (req.body[k] === undefined) continue;
    s[k] = k === 'syncIntervalHours' ? Math.max(0.25, Number(req.body[k]) || 1) : String(req.body[k]).slice(0, 20000);
  }
  if (!MODELS[s.model]) s.model = 'claude-opus-5-5';
  if (!/^#[0-9a-f]{6}$/i.test(s.accentColor)) s.accentColor = '#b8860b';
  if (Array.isArray(req.body.catalogueLinks)) {
    const bad = req.body.catalogueLinks.filter((l) => String(l).trim() && !catalogueToken(l));
    if (bad.length) return res.status(400).json({ error: `Not a public catalogue link: ${bad[0]}` });
    s.catalogueLinks = [...new Set(req.body.catalogueLinks.map(catalogueToken).filter(Boolean))].map((t) => `${CRM_BASE}/c/${t}`);
  }
  save('settings', s);
  scheduleSync();
  res.json({ settings: s });
});

// FAQs (the agent's trained answers)
admin.get('/faqs', (req, res) => res.json(load('faqs')));

admin.post('/faqs', (req, res) => {
  const question = String(req.body?.question || '').trim().slice(0, 1000);
  const answer = String(req.body?.answer || '').trim().slice(0, 4000);
  if (!question || !answer) return res.status(400).json({ error: 'Question and answer are both required.' });
  const faqs = load('faqs');
  const faq = { id: id(), question, answer, createdAt: new Date().toISOString() };
  faqs.push(faq);
  save('faqs', faqs);
  if (req.body.unansweredId) {
    const u = load('unanswered').find((x) => x.id === req.body.unansweredId);
    if (u) { u.status = 'answered'; save('unanswered'); }
  }
  res.json(faq);
});

admin.put('/faqs/:id', (req, res) => {
  const faq = load('faqs').find((f) => f.id === req.params.id);
  if (!faq) return res.status(404).json({ error: 'Not found' });
  if (req.body.question) faq.question = String(req.body.question).trim().slice(0, 1000);
  if (req.body.answer) faq.answer = String(req.body.answer).trim().slice(0, 4000);
  save('faqs');
  res.json(faq);
});

admin.delete('/faqs/:id', (req, res) => {
  save('faqs', load('faqs').filter((f) => f.id !== req.params.id));
  res.json({ ok: true });
});

// Catalogue
admin.post('/sync', async (req, res) => {
  try {
    const cat = await syncCatalog();
    if (cat.error) return res.status(502).json({ error: cat.error });
    res.json({ syncedAt: cat.syncedAt, catalogues: cat.catalogues, total: cat.products.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

admin.get('/catalog', (req, res) => {
  const { syncedAt, catalogues, source, stats, error } = load('catalog');
  const q = String(req.query.q || '');
  const result = searchProducts({ query: q, limit: 15 });
  const products = load('catalog').products;
  const items = result.products.map((r) => products.find((p) => p.code === r.code));
  res.json({ syncedAt, catalogues, source, stats, error, direct: directConfigured(), total: products.length, matches: result.total_matches, items });
});

// Conversations, leads, unanswered
admin.get('/conversations', (req, res) => {
  res.json(load('conversations').slice(0, 300).map((c) => ({
    id: c.id, startedAt: c.startedAt, updatedAt: c.updatedAt, pageUrl: c.pageUrl,
    turns: c.messages.filter((m) => m.role === 'user').length,
    preview: (c.messages.find((m) => m.role === 'user') || {}).text?.slice(0, 120) || '',
  })));
});

admin.get('/conversations/:id', (req, res) => {
  const c = load('conversations').find((x) => x.id === req.params.id);
  c ? res.json(c) : res.status(404).json({ error: 'Not found' });
});

admin.get('/uploads/:name', (req, res) => {
  if (!/^[a-f0-9]+-\d+\.(jpg|png|webp)$/.test(req.params.name)) return res.sendStatus(404);
  res.sendFile(path.join(UPLOADS, req.params.name), (err) => err && !res.headersSent && res.sendStatus(404));
});

admin.get('/leads', (req, res) => res.json(load('leads')));

admin.put('/leads/:id', (req, res) => {
  const lead = load('leads').find((l) => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  if (['new', 'contacted', 'converted', 'closed'].includes(req.body.status)) lead.status = req.body.status;
  save('leads');
  res.json(lead);
});

admin.get('/unanswered', (req, res) => res.json(load('unanswered').filter((u) => u.status === 'open')));

admin.delete('/unanswered/:id', (req, res) => {
  const u = load('unanswered').find((x) => x.id === req.params.id);
  if (u) { u.status = 'dismissed'; save('unanswered'); }
  res.json({ ok: true });
});

// --- start --------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That photo is too large - please use one under 3 MB.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`ITTAN AI agent running: admin http://localhost:${PORT}/admin  demo http://localhost:${PORT}/demo`);
  if (!config.ANTHROPIC_API_KEY) console.log('No ANTHROPIC_API_KEY - running in free basic mode (keyword answers, no AI)');
  if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set - the admin panel is open without login (fine on your own computer, set one before hosting publicly)');
  syncCatalog().catch((e) => console.error('[crm]', e));
  scheduleSync();
  setTimeout(warmUp, 20_000).unref(); // load the meaning model once the site is up
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    flushAll();
    process.exit(0);
  });
}

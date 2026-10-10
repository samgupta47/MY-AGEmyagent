// Photo-upload tests against the agent: real photos + edge cases.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire('C:/Users/Sameer Gupta/Desktop/ecommerce-website/ittan-ai-agent/package.json');
const sharp = require('sharp');

const B = process.argv[2] || 'http://localhost:3000';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'imgs');
let ipN = 1;
const freshIp = () => `10.0.0.${ipN++}`; // separate rate-limit bucket per test

async function chat({ image, message = '', ip = freshIp(), conversationId }) {
  const t = Date.now();
  const res = await fetch(`${B}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ message, image, conversationId, pageUrl: 'photo-test' }),
  });
  const ms = Date.now() - t;
  if (!res.ok) return { status: res.status, ms, error: (await res.json().catch(() => ({}))).error };
  const out = { status: res.status, ms, text: '', items: [], more: null };
  for (const chunk of (await res.text()).split('\n\n')) {
    const ev = (chunk.match(/^event: (.*)$/m) || [])[1];
    const data = (chunk.match(/^data: (.*)$/m) || [])[1];
    if (!ev) continue;
    const d = JSON.parse(data);
    if (ev === 'meta') out.conversationId = d.conversationId;
    if (ev === 'text') out.text += d.delta;
    if (ev === 'products') { out.items.push(...d.items); out.more = d.more; }
    if (ev === 'error') out.error = d.message;
  }
  return out;
}
const dataUrl = (buf, type = 'jpeg') => `data:image/${type};base64,${buf.toString('base64')}`;
const looks = (t) => (t.match(/This looks like ([^.]+)\./) || [])[1] || '(no type)';
const top = (items, n = 5) => items.slice(0, n).map((p) => p.title).join(' | ');

console.log('=== 1. Real jewellery photos ===');
for (const f of fs.readdirSync(dir).filter((f) => /\.jpe?g$/.test(f)).sort()) {
  const r = await chat({ image: dataUrl(fs.readFileSync(path.join(dir, f))) });
  console.log(`${f.padEnd(20)} ${r.status} ${String(r.ms).padStart(5)}ms  looks: ${looks(r.text).padEnd(16)} total:${String(r.more?.total ?? r.items.length).padStart(4)}  top: ${top(r.items)}`);
  if (r.error) console.log('   ERROR', r.error);
}

console.log('\n=== 2. Photo + text filters ===');
const neck = dataUrl(fs.readFileSync(path.join(dir, 'necklace-sample.jpg')));
for (const message of ['like this under 50k', 'like this between 1 lakh and 2 lakh', 'same in silver', 'similar ring under 20000']) {
  const r = await chat({ image: neck, message });
  const prices = r.items.map((p) => p.price);
  console.log(`"${message}" -> ${r.status} looks: ${looks(r.text)} | total ${r.more?.total ?? r.items.length} | price range ₹${Math.min(...prices)}–₹${Math.max(...prices)} | metals/purity: ${[...new Set(r.items.map((p) => p.purity))].join(',')}\n   reply: ${r.text.slice(0, 110)}`);
}

console.log('\n=== 3. Load more for photo results ===');
const first = await chat({ image: neck });
let more = first.more, seen = first.items.map((p) => p.code), pages = 1;
while (more && pages < 20) {
  const r = await (await fetch(`${B}/api/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(more) })).json();
  seen.push(...r.items.map((p) => p.code)); more = r.more; pages++;
}
console.log(`pages loaded: ${pages}, designs: ${seen.length}, duplicates: ${seen.length - new Set(seen).size}, expected total: ${first.more?.total}`);
const expired = await (await fetch(`${B}/api/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ similar: 'deadbeefdeadbeef', offset: 10 }) })).json();
console.log('expired/unknown result id ->', JSON.stringify(expired));

console.log('\n=== 4. Formats & edge cases ===');
const src = fs.readFileSync(path.join(dir, 'earrings-1.jpg'));
const cases = {
  'PNG upload': dataUrl(await sharp(src).png().toBuffer(), 'png'),
  'WEBP upload': dataUrl(await sharp(src).webp().toBuffer(), 'webp'),
  'tiny 40px photo': dataUrl(await sharp(src).resize(40).jpeg().toBuffer()),
  'huge 4000px photo (under 3MB)': dataUrl(await sharp(src).resize(4000).jpeg({ quality: 70 }).toBuffer()),
  'too large (>3MB)': dataUrl(await sharp({ create: { width: 3000, height: 3000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } } }).jpeg({ quality: 100 }).toBuffer()),
  'corrupt image bytes': dataUrl(Buffer.from('this is not really a jpeg file at all')),
  'GIF (unsupported type)': 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
  'not a data URL': 'https://example.com/photo.jpg',
  'PDF pretending': 'data:application/pdf;base64,JVBERi0xLjQ=',
};
for (const [name, image] of Object.entries(cases)) {
  const r = await chat({ image });
  console.log(`${name.padEnd(30)} -> ${r.status} ${r.error ? 'ERROR: ' + r.error : 'reply: ' + r.text.slice(0, 90) + ` [${r.items.length} cards]`}`);
}

console.log('\n=== 5. Photo inside an ongoing chat, then text follow-up ===');
const a = await chat({ message: 'hi', ip: '10.9.9.9' });
const b = await chat({ image: dataUrl(fs.readFileSync(path.join(dir, 'ring-1.jpg'))), conversationId: a.conversationId, ip: '10.9.9.9' });
const c = await chat({ message: 'show gold chains under 60k', conversationId: a.conversationId, ip: '10.9.9.9' });
console.log(`same conversation: ${a.conversationId === b.conversationId && b.conversationId === c.conversationId} | photo -> ${looks(b.text)}, ${b.items.length} cards | follow-up -> ${c.items.length} cards: ${top(c.items, 3)}`);

if (!process.env.SKIP_RATE) {
console.log('\n=== 6. Photo rate limit (10 photos / 10 min per visitor) ===');
let codes = [];
for (let i = 0; i < 11; i++) codes.push((await chat({ image: cases['tiny 40px photo'], ip: '10.7.7.7' })).status);
console.log('statuses:', codes.join(','));
}

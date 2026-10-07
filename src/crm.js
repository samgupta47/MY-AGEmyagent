// Pulls products out of the CRM's public catalogue pages (crm.../c/<token>).
// The CRM has no public API, but every public catalogue page embeds its items
// as JSON in the Next.js flight payload, with live prices already applied.
import config from './config.js';
import { load, save } from './store.js';
import { directConfigured, fetchDirect } from './crm-direct.js';

export const CRM_BASE = (config.CRM_BASE_URL || 'https://crm.ittanjeweller.com').replace(/\/$/, '');

export function catalogueToken(link) {
  const s = String(link || '').trim();
  if (/^[a-z0-9]{16,40}$/i.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.origin !== CRM_BASE) return null;
    const m = u.pathname.match(/^\/c\/([a-z0-9]{16,40})\/?$/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function flightPayload(html) {
  let out = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    out += JSON.parse(`"${m[1]}"`);
  }
  return out;
}

// Returns the JSON array that starts at `"key":[` in s.
function extractArray(s, key) {
  const start = s.indexOf(`"${key}":[`);
  if (start < 0) return null;
  let i = start + key.length + 3;
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      for (i++; s[i] !== '"'; i++) if (s[i] === '\\') i++;
    } else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  return JSON.parse(s.slice(start + key.length + 3, i + 1));
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

export function metalOf(purity, title = '') {
  // Some CRM entries have a gold purity on a silver piece ("Italian silver ring"
  // marked K22); "gold plated silver" is silver too. Trust the title first.
  if (/silver|chandi/i.test(title)) return 'silver';
  const p = String(purity || '').toUpperCase();
  if (/^S\d|SILVER/.test(p)) return 'silver';
  if (/^PT|PLATINUM/.test(p)) return 'platinum';
  if (/\d{2}\s*K|^K\s*\d{2}|GOLD/.test(p)) return 'gold';
  return 'other';
}

export async function fetchCatalogue(token) {
  const url = `${CRM_BASE}/c/${token}`;
  const res = await fetch(url, { headers: { 'user-agent': 'ittan-ai-agent/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} (is the catalogue still public?)`);
  const html = await res.text();
  const flight = flightPayload(html);
  const items = extractArray(flight, 'items');
  if (!items) throw new Error('no items found on the page');
  const rawTitle = decodeEntities((html.match(/<title>([^<]*)<\/title>/) || [])[1] || token);
  const title = rawTitle.replace(/\s*·\s*ITTAN Jewellers\s*$/i, '').trim();
  const whatsappPhone = (flight.match(/"whatsappPhone":"(\+?\d{8,15})"/) || [])[1] || '';
  return { token, url, title, whatsappPhone, items };
}

let syncing = null;

export function syncCatalog() {
  syncing ??= doSync()
    .then((catalog) => {
      // Update the product vector database, then index photos of new/changed
      // designs for photo search (both run in the background).
      import('./vectordb.js')
        .then((v) => v.updateProductVectors())
        .catch((e) => console.error('[vectors]', e.message))
        .then(() => import('./vision.js'))
        .then((v) => v.updateIndex())
        .catch((e) => console.error('[vision]', e.message));
      return catalog;
    })
    .finally(() => (syncing = null));
  return syncing;
}

async function doSync() {
  if (directConfigured()) return doDirectSync();
  const settings = load('settings');
  const tokens = [...new Set(settings.catalogueLinks.map(catalogueToken).filter(Boolean))];
  const byCode = new Map();
  const catalogues = [];
  let phone = '';

  for (const token of tokens) {
    const entry = { token, url: `${CRM_BASE}/c/${token}`, title: token, count: 0, error: null };
    try {
      const cat = await fetchCatalogue(token);
      entry.title = cat.title;
      entry.count = cat.items.length;
      phone ||= cat.whatsappPhone;
      for (const it of cat.items) {
        const key = it.code || it.id;
        const existing = byCode.get(key);
        if (existing) {
          if (!existing.catalogues.includes(cat.title)) existing.catalogues.push(cat.title);
          // Some catalogues hide prices; fill gaps from any catalogue that shows them.
          if (existing.price == null && it.price != null) {
            existing.price = Math.round(it.price);
            existing.compareAtPrice = it.compareAtPrice != null ? Math.round(it.compareAtPrice) : null;
          }
          existing.weightG ??= it.weightG ?? null;
          continue;
        }
        byCode.set(key, {
          code: it.code || '',
          title: String(it.title || '').replace(/\s+/g, ' ').trim(),
          purity: it.purity || '',
          metal: metalOf(it.purity, it.title),
          weightG: it.weightG ?? null,
          price: it.price != null ? Math.round(it.price) : null,
          compareAtPrice: it.compareAtPrice != null ? Math.round(it.compareAtPrice) : null,
          image: it.imageUrl ? CRM_BASE + it.imageUrl : null,
          thumb: it.thumbUrl ? CRM_BASE + it.thumbUrl : it.imageUrl ? CRM_BASE + it.imageUrl : null,
          catalogues: [cat.title],
          url: cat.url,
        });
      }
    } catch (err) {
      entry.error = err.message;
      console.error(`[crm] catalogue ${token} failed:`, err.message);
    }
    catalogues.push(entry);
  }

  const previous = load('catalog');
  const allFailed = tokens.length > 0 && catalogues.every((c) => c.error);
  // Keep the last good product list if the CRM is unreachable right now.
  const products = allFailed ? previous.products : [...byCode.values()];
  const catalog = { syncedAt: new Date().toISOString(), source: 'catalogues', catalogues, products };
  save('catalog', catalog);

  if (phone && !settings.whatsappPhone) {
    settings.whatsappPhone = phone;
    save('settings', settings);
  }
  console.log(`[crm] synced ${products.length} products from ${tokens.length} catalogue(s)`);
  return catalog;
}

async function doDirectSync() {
  const previous = load('catalog');
  try {
    const { products, stats } = await fetchDirect(load('settings'));
    const catalog = { syncedAt: new Date().toISOString(), source: 'crm', stats, error: null, catalogues: [], products };
    save('catalog', catalog);
    console.log(`[crm] synced directly: ${stats.shown} in-stock designs (${stats.designs} designs, ${stats.piecesInStock} pieces in stock)`);
    return catalog;
  } catch (err) {
    // Keep the last good product list if the CRM is unreachable right now.
    console.error('[crm] direct sync failed:', err.message);
    const catalog = { ...previous, error: err.message, failedAt: new Date().toISOString() };
    save('catalog', catalog);
    return catalog;
  }
}

let timer = null;

export function scheduleSync() {
  clearInterval(timer);
  const hours = Math.max(0.25, Number(load('settings').syncIntervalHours) || 1);
  timer = setInterval(() => syncCatalog().catch((e) => console.error('[crm]', e)), hours * 3600_000);
  timer.unref();
}

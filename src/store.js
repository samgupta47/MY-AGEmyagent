// Tiny JSON-file persistence. Each collection lives in data/<name>.json and is
// written atomically (tmp file + rename) after a short debounce.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import config from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Where training, chats, leads, synced products and the photo model are kept.
// On a server, hosting panels replace the app folder on every deploy, so data
// lives in the account's home folder instead; on Windows (your PC) it stays in
// the project's data/ folder.
function pickDataDir() {
  const candidates = [
    config.DATA_DIR,
    process.platform === 'win32' ? path.join(here, '..', 'data') : path.join(os.homedir(), 'ittan-agent-data'),
    path.join(here, '..', 'data'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      /* not writable here - try the next place */
    }
  }
  throw new Error('No writable folder for data');
}
export const DATA_DIR = pickDataDir();

const DEFAULTS = {
  settings: {
    businessName: 'ITTAN Jewellers',
    assistantName: 'ITTAN Assistant',
    whatsappPhone: '',
    welcomeMessage: 'Namaste! 🙏 I am the ITTAN Jewellers assistant. Ask me about our designs, prices, gold & silver jewellery, or anything about the store.',
    accentColor: '#b8860b',
    model: 'claude-opus-5-5',
    effort: 'low',
    catalogueLinks: [],
    syncIntervalHours: 1,
    allowedOrigins: '',
    storeInfo: '',
    instructions: '',
  },
  faqs: [],
  catalog: { syncedAt: null, catalogues: [], products: [] },
  conversations: [],
  leads: [],
  unanswered: [],
};

const cache = {};
const timers = {};

function file(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

export function load(name) {
  if (cache[name]) return cache[name];
  let value = structuredClone(DEFAULTS[name]);
  try {
    const raw = JSON.parse(fs.readFileSync(file(name), 'utf8'));
    value = Array.isArray(value) ? raw : { ...value, ...raw };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[store] could not read ${name}.json:`, err.message);
  }
  if (name === 'settings' && !value.whatsappPhone) value.whatsappPhone = config.WHATSAPP_PHONE || '';
  cache[name] = value;
  return value;
}

export function save(name, value) {
  if (value !== undefined) cache[name] = value;
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => flush(name), 200);
}

function flush(name) {
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache[name], null, 2));
  fs.renameSync(tmp, file(name));
}

export function flushAll() {
  for (const name of Object.keys(timers)) {
    clearTimeout(timers[name]);
    if (cache[name]) flush(name);
  }
}

export function id() {
  return crypto.randomBytes(8).toString('hex');
}

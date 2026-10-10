// Builds one labelled contact sheet of all test photos (uses sharp from the project).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire('C:/Users/Sameer Gupta/Desktop/ecommerce-website/ittan-ai-agent/package.json');
const sharp = require('sharp');

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'imgs');
const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/.test(f)).sort();
const W = 220, H = 220, cols = 6, rows = Math.ceil(files.length / cols);
const tiles = await Promise.all(files.map(async (f, i) => {
  const img = await sharp(path.join(dir, f)).resize(W, H - 24, { fit: 'contain', background: '#fff' }).toBuffer();
  const label = Buffer.from(`<svg width="${W}" height="24"><rect width="100%" height="100%" fill="#222"/><text x="6" y="17" font-size="14" fill="#fff" font-family="Arial">${f}</text></svg>`);
  const tile = await sharp({ create: { width: W, height: H, channels: 3, background: '#fff' } })
    .composite([{ input: img, top: 24, left: 0 }, { input: label, top: 0, left: 0 }]).png().toBuffer();
  return { input: tile, left: (i % cols) * W, top: Math.floor(i / cols) * H };
}));
await sharp({ create: { width: cols * W, height: rows * H, channels: 3, background: '#ccc' } }).composite(tiles).jpeg({ quality: 80 }).toFile(path.join(dir, '..', 'sheet.jpg'));
console.log('sheet with', files.length, 'photos');

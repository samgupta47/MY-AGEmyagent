// Downloads a few freely-licensed test photos per jewellery type from Wikimedia Commons.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'imgs');
fs.mkdirSync(OUT, { recursive: true });
const UA = { 'user-agent': 'ittan-agent-photo-test/1.0 (test script)' };

const searches = {
  ring: 'gold ring jewellery',
  earrings: 'jhumka earrings',
  necklace: 'gold necklace indian bride',
  chain: 'gold chain necklace',
  bangle: 'gold bangles',
  mangalsutra: 'mangalsutra',
  murti: 'silver ganesha idol',
  pendant: 'gold pendant locket',
  bracelet: 'gold bracelet',
  anklet: 'silver anklet payal',
  tikka: 'maang tikka',
  notjewellery: 'domestic cat portrait',
};

for (const [label, q] of Object.entries(searches).filter(([l]) => !fs.existsSync(path.join(OUT, l + '-1.jpg')))) {
  await new Promise((r) => setTimeout(r, 4000));
  const u = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(q + ' filetype:bitmap')}&gsrlimit=4&prop=imageinfo&iiprop=url|mime&iiurlwidth=800&format=json`;
  const j = await (await fetch(u, { headers: UA })).json();
  const pages = Object.values(j.query?.pages || {}).filter((p) => /jpeg|png/.test(p.imageinfo?.[0]?.mime || ''));
  let n = 0;
  for (const p of pages.slice(0, 2)) {
    const url = p.imageinfo[0].thumburl || p.imageinfo[0].url;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) continue;
    const file = `${label}-${++n}.jpg`;
    fs.writeFileSync(path.join(OUT, file), Buffer.from(await res.arrayBuffer()));
    console.log(file.padEnd(18), p.title.slice(0, 70));
  }
}

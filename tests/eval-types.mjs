// Measures jewellery-type recognition accuracy on the labelled test photos
// for different CLIP models and prompt sets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const T = await import(pathToFileURL('C:/Users/Sameer Gupta/Desktop/ecommerce-website/ittan-ai-agent/node_modules/@huggingface/transformers/dist/transformers.node.mjs').href);
T.env.cacheDir = 'C:/Users/Sameer Gupta/Desktop/ecommerce-website/ittan-ai-agent/data/models';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'imgs');

// expected type(s) per photo; 'none' = not jewellery
const truth = {
  'anklet-1': ['anklet'], 'anklet-2': ['anklet'], 'bangle-1': ['bangle'], 'bangle-2': ['bangle'],
  'bracelet-1': ['bangle', 'bracelet'], 'bracelet-2': ['bracelet', 'bangle'], 'chain-1': ['chain', 'necklace'], 'chain-2': ['chain', 'necklace'],
  'earrings-1': ['earrings'], 'earrings-2': ['earrings'], 'mangalsutra-1': ['mangalsutra'], 'mangalsutra-2': ['mangalsutra', 'pendant'],
  'murti-1': ['murti'], 'murti-2': ['murti'], 'necklace-sample': ['necklace', 'chain'], 'notjewellery-1': ['none'], 'notjewellery-2': ['none'],
  'pendant-1': ['pendant'], 'pendant-2': ['pendant'], 'ring-1': ['ring'], 'ring-2': ['ring'], 'tikka-1': ['tikka'],
};

const PROMPTS = {
  ring: ['a finger ring', 'a gold ring', 'a diamond ring', 'a ring worn on a finger'],
  earrings: ['a pair of earrings', 'jhumka earrings', 'gold drop earrings', 'stud earrings', 'hoop earrings'],
  necklace: ['a necklace', 'a gold necklace set', 'a heavy indian bridal necklace', 'layered necklaces worn on the neck'],
  chain: ['a plain gold chain', 'a thin chain necklace', 'a link chain'],
  bracelet: ['a bracelet', 'a gold cuff bracelet', 'a link bracelet on a wrist'],
  bangle: ['bangles', 'a gold bangle', 'glass bangles on wrists', 'a kada'],
  mangalsutra: ['a mangalsutra with black beads', 'a black bead necklace with a gold pendant', 'an indian wedding mangalsutra'],
  pendant: ['a pendant locket', 'a small gold pendant', 'a pendant on a chain'],
  tikka: ['a maang tikka forehead jewellery', 'an indian head ornament with a hanging pendant'],
  murti: ['a silver idol statue of a hindu god', 'a ganesha idol', 'a religious statue', 'a lakshmi ganesh murti'],
  anklet: ['an anklet', 'silver payal anklets', 'an ankle chain'],
  none: ['a photo of an animal', 'a photo of a cat or dog', 'a photo of a person without jewellery', 'a photo of food', 'a landscape', 'a screenshot of text', 'a car', 'a building'],
};

const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s); return Float32Array.from(v, (x) => x / s); };
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

for (const MODEL of ['Xenova/clip-vit-base-patch32', 'Xenova/clip-vit-base-patch16']) {
  const t0 = Date.now();
  const processor = await T.AutoProcessor.from_pretrained(MODEL);
  const vision = await T.CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: 'q8' });
  const tokenizer = await T.AutoTokenizer.from_pretrained(MODEL);
  const text = await T.CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: 'q8' });
  // one embedding per type = mean of its prompt embeddings ("a photo of ...")
  const types = Object.keys(PROMPTS);
  const typeEmb = [];
  for (const k of types) {
    const ps = PROMPTS[k].map((p) => `a photo of ${p}`);
    const { text_embeds } = await text(tokenizer(ps, { padding: true, truncation: true }));
    const D = text_embeds.dims[1];
    const mean = new Float32Array(D);
    for (let i = 0; i < ps.length; i++) { const e = norm(text_embeds.data.slice(i * D, (i + 1) * D)); for (let j = 0; j < D; j++) mean[j] += e[j]; }
    typeEmb.push(norm(mean));
  }
  let ok = 0, n = 0, ms = 0;
  const rows = [];
  for (const [file, want] of Object.entries(truth)) {
    const img = await T.RawImage.read(path.join(dir, file + '.jpg'));
    const t = Date.now();
    const { image_embeds } = await vision(await processor(img));
    ms += Date.now() - t;
    const e = norm(image_embeds.data);
    const logits = typeEmb.map((te) => dot(e, te) * 100);
    const mx = Math.max(...logits); const ex = logits.map((l) => Math.exp(l - mx)); const sum = ex.reduce((a, b) => a + b);
    const order = types.map((k, i) => [k, ex[i] / sum]).sort((a, b) => b[1] - a[1]);
    const hit = want.includes(order[0][0]);
    ok += hit; n++;
    rows.push(`${hit ? '✔' : '✘'} ${file.padEnd(16)} -> ${order[0][0]} ${(order[0][1] * 100).toFixed(0)}%  (2nd ${order[1][0]} ${(order[1][1] * 100).toFixed(0)}%)`);
  }
  console.log(`\n### ${MODEL}: ${ok}/${n} correct, avg ${Math.round(ms / n)} ms/photo (load ${Math.round((Date.now() - t0) / 1000)}s)`);
  console.log(rows.join('\n'));
}

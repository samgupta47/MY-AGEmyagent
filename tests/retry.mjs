// Preload for live tests: when the site's per-visitor limit answers 429, wait and retry.
const realFetch = globalThis.fetch;
let waits = 0;
globalThis.fetch = async (url, opts) => {
  for (let attempt = 0; ; attempt++) {
    const res = await realFetch(url, opts);
    if (res.status !== 429 || !String(url).includes('/api/') || attempt >= 15) return res;
    waits++;
    process.stderr.write(`[rate limit hit - waiting 65s, total waits ${waits}]\n`);
    await new Promise((r) => setTimeout(r, 65_000));
  }
};

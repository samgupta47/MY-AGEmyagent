// Service questions vs shopping questions, run repeatedly during start-up.
(async () => {
  let n = 1;
  const cases = [['Do you resize rings?', 'needs'], ['Can I book a video call to see designs?', 'needs'], ['Do you clean and polish old jewellery?', 'needs'], ['mundri vaddi kar doge?', 'needs'],
    ['do you have jhumkas?', 'products'], ['gold rings under 30k', 'products'], ['show me mangalsutra', 'products'], ['ring', 'products'], ['diamond ring for engagement', 'products'],
    ['kya aapke paas payal hai', 'products'], ['something for a newborn baby', 'products'], ['ਮੁੰਦਰੀ ਦਿਖਾਓ', 'products'], ['what is the price of 22k chain', 'products']];
  let ok = 0;
  for (const [q, want] of cases) {
    const r = await fetch('http://localhost:3000/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.' + Math.floor(n / 200) + '.' + (n++ % 200) }, body: JSON.stringify({ message: q }) });
    let text = '', items = 0;
    for (const c of (await r.text()).split('\n\n')) { const ev = (c.match(/^event: (.*)$/m) || [])[1], d = (c.match(/^data: (.*)$/m) || [])[1]; if (ev === 'text') text += JSON.parse(d).delta; if (ev === 'products') items += JSON.parse(d).items.length; }
    const got = items ? 'products' : /check with our team/.test(text) ? 'needs' : 'other';
    const pass = got === want || (want === 'products' && /couldn't find/.test(text));
    ok += pass;
    if (process.argv[2] === 'v' || !pass) console.log((pass ? '✔ ' : '✘ ') + q.padEnd(44), '->', items ? items + ' products' : text.slice(0, 60));
  }
  console.log(`${ok}/${cases.length} as expected`);
})();

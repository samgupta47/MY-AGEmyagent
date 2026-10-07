// Free "basic mode": answers without any AI API, using keyword matching over the
// owner's Q&As and store information, plus the product catalogue. Used when no
// ANTHROPIC_API_KEY is configured.
import { load, save, id } from './store.js';
import { searchProducts, findByCode, cardOf, words, SYN, STOP, typeTerms } from './search.js';
import { scoresByMeaning, romanize } from './meaning.js';
import { findProducts, vectorSearchProducts } from './vectordb.js';

const EXTRA_STOP = new Set([
  'is', 'are', 'was', 'be', 'i', 'my', 'your', 'we', 'our', 'it', 'this', 'that', 'what', 'how', 'can', 'please', 'pls',
  'to', 'on', 'at', 'is', 'kya', 'aap', 'apka', 'apke', 'aapka', 'aapke', 'mujhe', 'hain', 'ho', 'se', 'ko', 'me', 'mein',
  'bhi', 'koi', 'kuch', 'batao', 'bataiye', 'tell', 'about', 'there', 'hello', 'hi', 'sir', 'madam', 'ji',
  'karte', 'karti', 'karta', 'karo', 'kar', 'hota', 'hoti', 'milta', 'milti', 'wala', 'wali', 'hum', 'tum', 'ye', 'yeh', 'vo', 'woh',
]);

// Generic words that appear in many questions; they count much less, so
// "store timing" matches the timings line, not "Where is your store?".
const LOW_WEIGHT = new Set(['store', 'shop', 'showroom', 'jewellers', 'jeweller', 'ittan', 'today', 'aaj', 'please', 'want', 'know', 'where', 'when', 'which', 'any', 'give', 'get', 'do', 'does']);
const weight = (w) => (LOW_WEIGHT.has(w) ? 0.25 : 1);

// Words that point to the catalogue rather than to store policy.
const PRODUCT_WORDS = new Set();
for (const [w, group] of SYN) if (!['gents', 'ladies', 'baby'].includes(group[0])) PRODUCT_WORDS.add(w);
for (const w of ['design', 'designs', 'jewellery', 'jewelry', 'collection', 'karat', 'carat', 'k22', 'k18', 'k14', 's999', 's925', 'diamond', 'kundan', 'pendant']) PRODUCT_WORDS.add(w);

export const PAGE_SIZE = 10;

const GREETING = /^(hi+|hello+|hey+|namaste|namaskar|hii+|good (morning|afternoon|evening)|ram ram|sat sri akal)[\s!.🙏]*$/i;
const THANKS = /^(thanks?|thank you|thx|ok(ay)?|dhanyavaad|shukriya|great|nice|👍)[\s!.]*$/i;

function keyTerms(text) {
  return words(text).filter((w) => !STOP.has(w) && !EXTRA_STOP.has(w) && w.length > 1);
}

function stem(w) {
  return w.replace(/(ings|ing|es|s)$/, '');
}

// Overlap score between a customer message and a stored question/line (0..1).
function similarity(msgTerms, text) {
  const target = keyTerms(text);
  if (!msgTerms.length || !target.length) return 0;
  const tset = new Set(target.flatMap((w) => [stem(w), ...(SYN.get(w) || []).map(stem)]));
  let hit = 0, total = 0;
  for (const w of msgTerms) {
    total += weight(w);
    if (tset.has(stem(w)) || (SYN.get(w) || []).some((s) => tset.has(stem(s)))) hit += weight(w);
  }
  return hit / total;
}

function toRupees(numStr, unit) {
  let n = parseFloat(numStr.replace(/,/g, ''));
  const u = (unit || '').toLowerCase();
  if (u.startsWith('k') || u === 'hazar' || u === 'hajar' || u === 'thousand') n *= 1000;
  else if (u.startsWith('l')) n *= 100000;
  return n;
}

// Pulls budget and weight filters out of messages like "rings under 30k",
// "50,000 se kam", "between 1 lakh and 2 lakh", "5 gram chain".
export function parseFilters(text) {
  const t = text.toLowerCase();
  const f = {};
  const money = [...t.matchAll(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|hazar|hajar|lakh|lac|l)?\b(?!\s*(?:g|gm|gms|gram|grams)\b)/g)]
    .filter((m) => !(m[2] === 'k' && ['14', '18', '22', '24'].includes(m[1]))) // "22k" is karat, not ₹22,000
    .filter((m) => m[2] || /₹|rs|inr/.test(m[0]) || parseFloat(m[1].replace(/,/g, '')) >= 1000)
    .map((m) => toRupees(m[1], m[2]));
  const weight = t.match(/(\d+(?:\.\d+)?)\s*(?:g|gm|gms|gram|grams)\b/);

  if (money.length >= 2) {
    f.min_price = Math.min(money[0], money[1]);
    f.max_price = Math.max(money[0], money[1]);
  } else if (money.length === 1) {
    const v = money[0];
    if (/(above|over|more than|upar|zyada|jyada|minimum|min|starting)/.test(t)) f.min_price = v;
    else if (/(under|below|less than|kam|tak|upto|up to|within|max|maximum|budget|andar)/.test(t)) f.max_price = v;
    else { f.min_price = Math.round(v * 0.8); f.max_price = Math.round(v * 1.2); }
  }
  if (weight) {
    const g = parseFloat(weight[1]);
    f.min_weight = +(g * 0.85).toFixed(2);
    f.max_weight = +(g * 1.15).toFixed(2);
  }
  if (/\b(gold|sona|sone)\b/.test(t) && !/\b(silver|chandi)\b/.test(t) && !/gold plated/.test(t)) f.metal = 'gold';
  if (/\b(silver|chandi|chaandi)\b/.test(t) && !/\bgold\b/.test(t)) f.metal = 'silver';
  const purity = t.match(/\b(22|18|14)\s*(?:k|kt|karat|carat|ct)\b/);
  if (purity) f.purity = `K${purity[1]}`;
  return f;
}

function storeLines() {
  return (load('settings').storeInfo || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function inr(n) {
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

function budgetText(f) {
  if (f.min_price && f.max_price) return ` between ${inr(f.min_price)} and ${inr(f.max_price)}`;
  if (f.max_price) return ` under ${inr(f.max_price)}`;
  if (f.min_price) return ` above ${inr(f.min_price)}`;
  return '';
}

function flag(question, conv) {
  const list = load('unanswered');
  list.unshift({ id: id(), question: question.slice(0, 500), conversationId: conv.id, status: 'open', createdAt: new Date().toISOString() });
  save('unanswered', list.slice(0, 500));
}

const TYPE_NAMES = {
  ring: 'a ring 💍', earrings: 'earrings', jhumka: 'jhumkas', necklace: 'a necklace', chain: 'a chain', bracelet: 'a bracelet',
  bangle: 'bangles', mangalsutra: 'a mangalsutra', pendant: 'a pendant', 'pendant set': 'a pendant set', tikka: 'a maang tikka',
  murti: 'a murti 🙏', anklet: 'an anklet',
};

/** Customer sent a photo: show the most similar in-stock designs. */
export async function photoReply(conv, buffer, message) {
  const { similarToPhoto } = await import('./vision.js');
  const f = parseFilters(message || '');
  const filter = (p) =>
    (f.metal ? p.metal === f.metal : true) &&
    (f.max_price ? p.price != null && p.price <= f.max_price : true) &&
    (f.min_price ? p.price != null && p.price >= f.min_price : true);
  // A type typed with the photo ("similar ring under 20k") wins over the photo guess.
  const typed = typeTerms(words(message || '')).find((t) => !['gold', 'silver'].includes(t));
  try {
    const r = await similarToPhoto(buffer, { filter, typeTerm: typed });
    if (r.notJewellery) {
      return {
        text: "Hmm, this photo doesn't look like jewellery 🙂 Please send a clear photo of the piece you like (ring, earrings, necklace, bangle…), or just tell me what you're looking for.",
        products: [],
      };
    }
    if (!r.codes.length) {
      flag(`[photo] ${message || 'customer sent a photo'}`, conv);
      return { text: `Thank you for the photo! I couldn't find a close match${budgetText(f)} right now — share your phone number and our team will find similar designs for you.`, products: [] };
    }
    const first = r.codes.slice(0, PAGE_SIZE).map((c) => cardOf(findByCode(c)));
    const looks = r.type ? `This looks like ${TYPE_NAMES[r.type.key] || r.type.key}. ` : '';
    return {
      text: `${looks}Here are the most similar designs from our collection${budgetText(f)} at today's price. Tap "Enquire on WhatsApp" on any you like, or share your phone number and our team will call you.`,
      products: first,
      more: r.codes.length > first.length ? { similar: r.id, offset: first.length, total: r.codes.length } : null,
    };
  } catch (err) {
    console.error('[basic] photo search failed:', err.message);
    flag(`[photo] ${message || 'customer sent a photo'}`, conv);
    return { text: 'Thank you for the photo! Our team will look at it and suggest similar designs — please share your phone number so we can reach you.', products: [] };
  }
}

// Lowest meaning score accepted as "same question" (tested: correct matches
// scored 0.33-0.90, unrelated questions 0.10-0.17).
const MEANING_MIN = 0.3;

/** Returns { text, products: [card...] } for one customer message. */
export async function basicReply(conv, message) {
  const s = load('settings');
  // Punjabi (Gurmukhi) / Hindi (Devanagari) letters → English letters first.
  const msg = romanize(message.trim());
  const terms = keyTerms(msg);
  const wa = s.whatsappPhone ? ' You can also chat with our team on WhatsApp using the link below.' : '';

  if (GREETING.test(msg)) {
    return { text: `Namaste! 🙏 How can I help you today? You can ask about our designs (rings, necklaces, earrings, mangalsutra…), prices, or the store.`, products: [] };
  }
  if (THANKS.test(msg)) return { text: 'You are welcome! 😊 Anything else I can help you with?', products: [] };

  // 1. Phone number → lead
  const phone = msg.replace(/[\s-]/g, '').match(/(?:\+?91)?[6-9]\d{9}/);
  if (phone) {
    const leads = load('leads');
    const nameMatch = msg.match(/(?:i am|i'm|my name is|name is|naam|mera naam)\s+([a-z][a-z ]{1,30})/i);
    const lastAsk = [...conv.basicHistory].reverse().find((t) => !/\d{10}/.test(t)) || '';
    leads.unshift({
      id: id(), name: nameMatch ? nameMatch[1].trim() : '', phone: phone[0], interest: lastAsk.slice(0, 500) || msg.slice(0, 500),
      conversationId: conv.id, pageUrl: conv.pageUrl, status: 'new', createdAt: new Date().toISOString(),
    });
    save('leads', leads);
    return { text: `Thank you! 🙏 I have shared your number (${phone[0]}) with our team — they will contact you shortly.`, products: [] };
  }

  // 2. Exact design code, e.g. "D620"
  const codeWord = msg.match(/\b[A-Z]{1,3}\d{2,5}\b/i);
  const byCode = codeWord && findByCode(codeWord[0]);
  if (byCode) {
    const price = byCode.price != null ? `Today's price is ${inr(byCode.price)}.` : 'Please ask our team for the price.';
    return { text: `Here is design ${byCode.code} — ${byCode.title} (${byCode.purity}${byCode.weightG ? `, ${byCode.weightG} g` : ''}). ${price}`, products: [cardOf(byCode)] };
  }
  if (codeWord && /\d/.test(codeWord[0]) && terms.length <= 3 && !/^k?\d{2}k?$/i.test(codeWord[0])) {
    return { text: `I couldn't find design ${codeWord[0].toUpperCase()} in our online catalogue. Share your phone number and our team will check it for you.${wa}`, products: [] };
  }

  // 3. Trained Q&A
  let best = null;
  for (const f of load('faqs')) {
    const score = similarity(terms, f.question);
    if (!best || score > best.score) best = { score, f };
  }
  const filters = parseFilters(msg);
  const METALS = ['gold', 'sona', 'sone', 'silver', 'chandi', 'chaandi'];
  const typeWord = terms.some((w) => PRODUCT_WORDS.has(w) && !METALS.includes(w));
  // "gold rate today" is a rate question for the Q&As, not a product search.
  const rateQuestion = /\b(rate|rates|bhav|bhaav|bhao)\b/i.test(msg) && !typeWord;
  // A metal word alone ("old gold exchange?") is a question, not a product search;
  // that needs a jewellery type, a budget or a weight (or just "gold" / "silver chandi").
  const metalOnly = terms.some((w) => METALS.includes(w)) && terms.filter((w) => !METALS.includes(w)).length === 0;
  const productish = !rateQuestion && (typeWord || metalOnly || filters.max_price || filters.min_price || filters.min_weight);
  const browsing = Boolean(filters.max_price || filters.min_price || filters.min_weight) ||
    /\b(show|dikha\w*|vekha\w*|vikha\w*|want|chahi\w*|looking|search|find|designs?|collection|options?|buy|kharid\w*|lena|laina|lainde)\b/i.test(msg);

  // Best store-information line, compared against the best Q&A.
  let line = null;
  for (const l of storeLines()) {
    const score = similarity(terms, l);
    if (!line || score > line.score) line = { score, l };
  }
  if (best && best.score >= (productish ? 0.75 : 0.5) && best.score >= (line?.score ?? 0)) return { text: best.f.answer, products: [] };
  if (!productish && line && line.score >= 0.5) return { text: line.l, products: [] };

  // 3b. Match by meaning when the words differ ("where is the game being held"
  // ≈ "Where do I play?", "dukaan kahan hai" ≈ address). Product searches need
  // a much closer match so "show me gold rings" still shows rings.
  // Q&A questions compare question-to-question (reliable, low bar). A store-info
  // line "Address: ..." is also compared by its label ("address"); a plain
  // statement needs a stronger match, so "EMI on credit card?" doesn't get
  // answered with "We accept UPI, cards and cash". Tested: 13/17 right, 0 wrong
  // (misses go to "Needs answers" for the owner to teach).
  const faqList = load('faqs');
  const cands = faqList.map((f) => ({ text: f.question, min: MEANING_MIN, answer: f.answer }));
  for (const l of storeLines()) {
    const label = (l.match(/^([^:]{2,40}):\s*\S/) || [])[1];
    if (label) cands.push({ text: label.toLowerCase(), min: 0.35, answer: l });
    cands.push({ text: l, min: label ? 0.4 : 0.5, answer: l });
  }
  const scores = await scoresByMeaning(msg, cands.map((c) => c.text));
  if (scores) {
    // Take the closest match overall, then check it is close enough - so
    // "when do you open" picks the timings line, not a weaker Q&A.
    const pick = cands.map((c, i) => ({ ...c, score: scores[i] })).sort((a, b) => b.score - a.score)[0];
    // Browsing ("show me necklaces", "rings under 30k") needs a very close Q&A
    // to win; a question about a service that mentions an item ("can you make
    // my old necklace shine?") checks the Q&As first.
    const need = !productish ? pick?.min : browsing ? 0.6 : Math.max(pick?.min ?? 0, 0.42);
    if (pick && pick.score >= need) return { text: pick.answer, products: [] };
  }

  // 4. Products
  if (productish) {
    const query = terms.filter((w) => !/^\d/.test(w) && !['k', 'lakh', 'lac', 'rs', 'inr', 'gram', 'grams', 'gm', 'price', 'rate', 'kam', 'tak', 'upto', 'budget'].includes(w)).join(' ');
    let search = { query, ...filters };
    let r = await findProducts({ ...search, limit: PAGE_SIZE });
    if (!r.total_matches && query) {
      // Retry with just the product-type words ("gold ring for wife" → "ring").
      const core = terms.filter((w) => PRODUCT_WORDS.has(w) && !['gold', 'silver', 'sona', 'chandi'].includes(w)).join(' ');
      if (core && core !== query) {
        search = { query: core, ...filters };
        r = await findProducts({ ...search, limit: PAGE_SIZE });
      }
    }
    if (r.total_matches) {
      const cards = r.products.map((p) => cardOf(findByCode(p.code)));
      const count = r.total_matches > cards.length ? `${r.total_matches} designs` : `${r.total_matches} design${r.total_matches > 1 ? 's' : ''}`;
      return {
        text: `I found ${count}${budgetText(filters)} at today's price. Tap "Enquire on WhatsApp" on any design you like, or share your phone number and our team will call you.`,
        products: cards,
        more: r.total_matches > cards.length ? { search, offset: cards.length, total: r.total_matches } : null,
      };
    }
    flag(msg, conv);
    return { text: `Sorry, I couldn't find designs matching that${budgetText(filters)} right now. Our team can show you more options — share your phone number and we'll call you.${wa}`, products: [] };
  }

  // 5. Weaker matches on Q&As
  if (best && best.score >= 0.4) return { text: best.f.answer, products: [] };

  // 6. No Q&A or store info, but it clearly describes products by meaning
  // ("something for a newborn baby") → show them (strict, so "who won the
  // cricket match" does not turn into jewellery).
  const guess = rateQuestion ? null : await vectorSearchProducts({ query: msg, ...filters, limit: PAGE_SIZE }, { strict: true });
  if (guess?.total_matches) {
    const cards = guess.products.map((p) => cardOf(findByCode(p.code)));
    return {
      text: `Here are some designs you may like${budgetText(filters)} at today's price. Tap "Enquire on WhatsApp" on any design, or share your phone number and our team will call you.`,
      products: cards,
      more: guess.total_matches > cards.length ? { search: { query: msg, ...filters }, offset: cards.length, total: guess.total_matches } : null,
    };
  }

  // 7. Don't know → owner gets it in "Needs answers"
  flag(msg, conv);
  return { text: `That's a good question — I'll check with our team and get back to you. Please share your phone number so we can reply.${wa}`, products: [] };
}

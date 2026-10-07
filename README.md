# ITTAN AI Shopping Agent

A chat assistant for the ITTAN Jewellers website. It:

- reads your **whole in-stock inventory directly from the CRM** (designs, photos, weights, purity, today's prices) every hour, read-only;
- answers customers from what you teach it in the admin panel (store info, rules, Q&As);
- shows products as cards (photo, price, "Enquire on WhatsApp"), 10 at a time with **Load more**;
- saves leads (phone numbers) and lists questions it couldn't answer so you can teach it.

Works on any website with one `<script>` line.

## How to run

**One-time setup**

1. Install Node.js 20 or newer from https://nodejs.org (already installed on this PC).
2. Open a terminal in this folder (`ittan-ai-agent`) and run:

   ```bash
   npm install
   ```

3. Check the settings in `src/config.js` (see below).

**Start it**

```bash
npm start
```

Leave the window open. Then open:

- Admin panel (train the agent): http://localhost:3000/admin
- Test chat (what customers see): http://localhost:3000/demo

To stop it, press `Ctrl + C` in that window. After editing `src/config.js`, stop and start again.

## Settings (`src/config.js`)

| Setting | What it is |
| --- | --- |
| `CRM_EMAIL` / `CRM_PASSWORD` | CRM login (a Viewer account is enough). The agent only reads; it never changes anything in the CRM. |
| `ANTHROPIC_API_KEY` | Empty = **free basic mode** (keyword answers). With a key (starts with `sk-ant-api03-`, from https://console.anthropic.com) = full conversational AI. |
| `ADMIN_PASSWORD` | Empty = admin panel opens without login. |
| `PHOTO_SEARCH` | `true` = customers can upload a photo to find similar designs (needs ~1 GB RAM). `false` = off. |
| `SMART_ANSWERS` | `true` = free mode matches questions to Q&As and store info by meaning, not only words. |
| `VECTOR_SEARCH` | `true` = product search by meaning (lightweight vector database, Orama). `false` = keyword search only. |
| `PORT` | Default `3000`. |
| `CRM_BASE_URL` | Default `https://crm.ittanjeweller.com`. |

## Free mode vs AI mode

| | Free basic mode (no key) | AI mode (with API key) |
| --- | --- | --- |
| Cost | ₹0 | Pay per message (below) |
| Product search | Keywords, budgets ("under 30k"), weight ("5 gram") | Understands any wording, follow-ups ("show cheaper ones") |
| Store questions | Matches your Q&As / store info lines | Answers naturally from everything you taught it |
| Languages | English / Hinglish keywords | English, Hindi, Hinglish |

Choose the AI model in **Admin → Settings**. Approximate cost **per customer message** (a reply usually takes
2–3 API calls: search, show products, answer):

| Model | Per message (approx.) | 1,000 messages |
| --- | --- | --- |
| Claude Opus 5.5 (best) | $0.03–0.06 (≈ ₹2.5–5) | ≈ $30–60 |
| Claude Sonnet 5.5 (good, cheaper) | $0.015–0.03 (≈ ₹1.3–2.5) | ≈ $15–30 |
| Claude Haiku 4.5 (fastest, cheapest) | $0.005–0.012 (≈ ₹0.4–1) | ≈ $5–12 |

These are estimates (prices per million tokens: Opus 5.5 $4 in / $20 out, Sonnet 5.5 $2 / $10, Haiku 4.5 $1 / $5;
repeated instructions are cached at a fraction of the price). Real cost depends on how long your store info / Q&As are
and how long chats run. Check actual spend at https://console.anthropic.com → Usage, and set a monthly limit there.

## Adding it to the website

Host this server at a public address (e.g. `https://agent.ittanjeweller.com`), then add before `</body>`:

```html
<script src="https://agent.ittanjeweller.com/widget.js" defer></script>
```

On WordPress: "WPCode" / "Insert Headers and Footers" plugin → Footer.

## Files

| Path | What it is |
| --- | --- |
| `src/server.js` | Web server: chat API, admin API |
| `src/agent.js` | AI mode (Claude) |
| `src/basic.js` | Free basic mode |
| `src/crm-direct.js` | Reads inventory from the CRM (login + designs + pieces export) |
| `src/crm.js` | Hourly sync (falls back to public catalogue links if no CRM login is set) |
| `src/search.js` | Product search |
| `src/config.js` | **All settings** (CRM login, API key, admin password, photo search) |
| `src/vision.js` | Photo search (find similar designs from a customer photo) |
| `src/vectordb.js` | Product vector database (meaning + keyword hybrid search with price/weight/metal filters) |
| `src/meaning.js` | Small free sentence model + Hinglish word list, used for Q&A matching and product search |
| `src/store.js` | Data storage |
| `public/widget.js` | The chat bubble for the website |
| `public/admin.html` | Admin panel |
| `public/demo.html` | Test page |
| `data/` | Your data: settings, Q&As, synced products, chats, leads. **Back this folder up.** |

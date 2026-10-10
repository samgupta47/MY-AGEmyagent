# ITTAN AI Agent — Full Project Handoff

> **For a new Claude session:** read this whole file first. It is the complete
> context of the work done so far (Oct 6–10, 2026), the decisions taken, the
> problems hit, the user's preferences, and what is still pending.
> Passwords are **not** in this file — they are in `src/config.js`.

---

## 1. Who / what

- **User:** Sameer (developer/freelancer). **Client:** ITTAN Jewellers (Punjab, India).
- **Original idea:** a WordPress chat plugin (`shop-assistant-chat`, now deleted).
- **Changed requirement (client voice note, Oct 6):** *"I need a proper AI agent that I can train
  from the back end. It should answer the common questions customers ask. It should connect to the
  website and to the CRM, which already has all products and inventory. When a customer asks
  something, the agent should pick up the answer from there and reply."*
- Tech choice was left to us → built a standalone **Node.js** app (not WordPress).

## 2. What exists now

**Project folder:** `C:\Users\Sameer Gupta\Desktop\ecommerce-website\ittan-ai-agent`
**GitHub (deploy source):** https://github.com/samgupta47/MY-AGEmyagent (branch `main`)
**Live:** https://agent.ittanjeweller.com — chat test page `/demo`, admin `/admin`
**Old repo (not used for deploy):** github.com/myexampapercouk-dev/ITTAN-AGENT (git remote name `ittan-agent`)

### Features (all working, tested)
| Feature | How |
|---|---|
| Chat widget for any website | `public/widget.js`, one `<script src="https://agent.ittanjeweller.com/widget.js" defer>` line; Shadow DOM so site CSS can't break it |
| Inventory straight from the CRM | Logs into the CRM (read-only Viewer account), reads all designs + pieces every hour; only **in-stock** designs shown, priced at today's rate |
| Product search **by meaning** | Lightweight vector DB **Orama** (`src/vectordb.js`) + hybrid keyword search + filters (budget, weight, metal, purity, type); "gift for my wife under 50k", "ganesh ji ki murti", "black beads wala mangalsutra" work |
| Q&A training + matching **by meaning** | Admin → Train the agent; small sentence model matches rephrasings ("where is the game being held" ≈ "Where do I play?") |
| Hinglish + **Punjabi** | Word lists + spelling-tolerant matching + Gurmukhi/Devanagari → English letters (`src/meaning.js`) |
| **Photo search** | Customer uploads a photo → CLIP model finds visually similar in-stock designs; "not jewellery" photos rejected politely |
| Product cards | Photo, code, purity, weight, price, MRP strike, "Enquire on WhatsApp"; vertical list, 10 at a time + **Load more** |
| Leads | Phone number in chat → saved with name + interest |
| Needs answers | Unknown questions listed for the owner to teach once |
| Admin panel | Overview, Train, Needs answers, Conversations (with customer photos), Leads, CRM products, Settings, Add to website, **Download backup (.zip)** |
| AI mode (Claude) | Built in `src/agent.js` (tools: search_products, get_product, show_products, find_similar_to_photo, save_lead, flag_for_training) but **never run** — no API key yet |

### Honest status of "AI"
Right now it runs **free mode**: real ML models are used only for **matching** (MiniLM sentence model,
CLIP image model, vector search). **Replies are the owner's saved answers word-for-word or fixed
templates — nothing is generated.** True conversational AI starts only when a Claude API key is put
in `src/config.js` (then test AI mode end-to-end before going live — it has never been run).

## 3. Code map

| File | Purpose |
|---|---|
| `server.js` | Root entry (imports `src/server.js`) — Hostinger looks for it |
| `src/config.js` | **ALL settings, hardcoded** (CRM login, admin password, API key, WhatsApp, feature switches) |
| `src/server.js` | Express: `/api/chat` (SSE streaming), `/api/products` (Load more), `/api/config`, `/widget.js`, `/demo`, admin API under `/admin/api/*` (login cookie), `/admin/api/backup` |
| `src/agent.js` | Chat turn: free mode → `basic.js`; with API key → Claude tool loop |
| `src/basic.js` | Free-mode brain: greetings, leads, design codes, Q&A/store-info matching (words + meaning), service-vs-shopping intent, products, photo replies |
| `src/meaning.js` | MiniLM (`Xenova/all-MiniLM-L6-v2`) embeddings, Hinglish+Punjabi word lists, spelling skeleton, Gurmukhi/Devanagari romanizer |
| `src/vectordb.js` | Orama product vector DB (`<data>/vectors/products-v2.json`), hybrid search, `findProducts()` (falls back to keyword search) |
| `src/vision.js` | CLIP (`Xenova/clip-vit-base-patch32`) photo index + type recognition (prompt ensembles, "none" class) |
| `src/crm-direct.js` | CRM login (Auth.js credentials), designs via server action `getDesignsPaginated` (id auto-discovered from JS chunks), pieces CSV export |
| `src/crm.js` | Hourly sync; after sync → update vectors → update photo index. Fallback: public catalogue links if no CRM login |
| `src/search.js` | Keyword search + synonyms (Hinglish/Punjabi jewellery names) |
| `src/store.js` | JSON file storage; picks data folder |
| `public/` | `widget.js`, `admin.html`, `demo.html` |
| `tests/` | Test scripts (see §8) |

### Settings in `src/config.js`
`CRM_BASE_URL`, `CRM_EMAIL`, `CRM_PASSWORD`, `WHATSAPP_PHONE` (9914905216), `ADMIN_PASSWORD`,
`ANTHROPIC_API_KEY` (empty = free mode), `PHOTO_SEARCH`, `SMART_ANSWERS`, `VECTOR_SEARCH`,
`DATA_DIR` (empty = auto), `PORT` (3000; Hostinger overrides via env PORT).

### Data (no database — JSON files)
- Live: `/home/u203056290/domains/agent.ittanjeweller.com/ittan-agent-data` (outside the app folder so **redeploys don't wipe it**; verified)
- PC: `ittan-ai-agent/data/`
- Files: `settings.json`, `faqs.json`, `conversations.json`, `leads.json`, `unanswered.json`, `uploads/` (customer photos) = the owner's data; `catalog.json`, `image-index.json`, `vectors/`, `models/` rebuild themselves.
- Backup: Admin → Overview → Download backup (.zip). A PC backup zip: `ecommerce-website/ittan-agent-data-backup-2026-10-07.zip`.

## 4. Hosting / deploy

- **Hostinger Business Web Hosting** (upgraded from Single), **Node.js Web App** imported from GitHub
  `samgupta47/MY-AGEmyagent`, branch `main`, Express preset, Node 20.x, entry `server.js`, `npm install` / `npm start`, sub-domain `agent.ittanjeweller.com` (SSL by Hostinger).
- **Deploy flow:** edit code → commit → `git push origin main` → user clicks **Redeploy** in hPanel.
- Git identity is unset globally; commits were made with `git -c user.name="samgupta47" -c user.email="samgupta47@users.noreply.github.com" commit …`. GitHub credential stored for **samgupta47** (Git Credential Manager).
- First start on a fresh server downloads models (~150 MB CLIP + ~25 MB MiniLM) and indexes photos (gentle, ~15 min); later only new designs.
- **Hostinger CPU warning** (Oct 7) was caused by photo indexing at full speed → fixed: ONNX 1 thread, pauses, 1-min start delay, index persisted.
- Local run: `cd ittan-ai-agent && npm start` → http://localhost:3000/demo and /admin.
- Cloudflare quick tunnel was used once for a client demo, then dropped.
- Cheaper hosting options discussed: Oracle Cloud free, Hetzner CX22 (~€4), Hostinger VPS KVM1. Not used.

## 5. The CRM (crm.ittanjeweller.com)

- Custom app, **not ours**. Tech (observed from outside): **Next.js 16.2** (App Router, Turbopack, Server Actions), React, Tailwind + shadcn/ui (Radix), TanStack Query, react-hook-form, framer-motion, **Auth.js v5** login, very likely **Prisma** ORM (cuid ids, `_count`, decimal strings, uppercase enums) on PostgreSQL or MySQL (unconfirmed), probably **Caddy** in front.
- **Hosted on a Hostinger VPS**: `srv1736666.hstgr.cloud`, IP `77.37.44.85`, Mumbai. **It is NOT in the user's Hostinger account** (user's VPS page is empty) → belongs to the client's or the developer's account.
- **Source code is not public** (source maps 404). User's client now wants **changes to the CRM** → user needs code access: Git repo, or SSH/Hostinger access to that VPS, plus `.env` (DATABASE_URL, AUTH secret), DB backup, deploy method (PM2/Docker). A message to send the client was drafted in chat. **Pending: user waiting for access.**
- Our login `sameergpt9719@gmail.com` has role **VIEWER** (can't create catalogues). Inventory: ~1,370 designs, ~1,138 pieces in stock, ~1,064 in-stock designs shown (Oct 10).
- Agent reads: designs via `getDesignsPaginated` server action (100/page) + `/dashboard/inventory/pieces/export` CSV.
- **Incident Oct 10:** CRM password was changed → sync failed ("CRM login failed"). User updated `CRM_PASSWORD` in config.js → pushed as `a6d88cc`; **user must redeploy + "Sync now"**. Suggestion given: ask CRM admin for a dedicated Viewer login for the agent.
- CRM data issues found: some "Italian silver ring" designs entered as K22 (agent treats silver titles as silver); 22 designs have no photo file (R57–R73, R24, R25, M01, 56, 58, 59); some designs have 0 pieces; deleted chains C01–C58 were in old public catalogues.

## 6. User preferences (important)

- **No `.env` files** — hardcode everything in `src/config.js`; user accepts the risk; don't lecture about it.
- **Push to GitHub only when the user says "push"** (they sometimes want local-only testing first).
- User writes short, informal messages (Hinglish typos) — infer intent, keep replies clear and simple.
- Admin login: was off at first, now a **fixed password** in config.js (user asked).
- Prefers **free** options while testing; will buy a Claude API key later.
- Claude must **not log in to the live admin** (can't type passwords into internet sites) → the user adds Q&As on live themselves; Claude tests live via the public chat only. Local admin login (localhost) is fine.

## 7. Test results (latest, on PC; same code as live)

| Test | Result |
|---|---|
| All features (`tests/test-features.mjs`) | **41/41** (photo-view checks need a chat with a photo) |
| Train 10 Q&As, ask 50 rephrasings w/o original words — English, Hinglish, Punjabi, Gurmukhi (`tests/test-rephrase.mjs`) | **46/50 (92%), 0 wrong**, 6/6 unrelated left alone (was 60% before fixes) |
| Service vs shopping intent (`tests/svc-test.cjs`) | **13/13** |
| Meaning Q&A (`tests/test-meaning.mjs`) | correct (3 "✘" are the user's own local test Q&As: "Where is your store?"→punjaaaab, "What is my name"→navpreet) |
| Photo search, 22 real photos (`tests/test-photos.mjs`) | 15/22 right/sensible; weak: mangalsutra, tikka, plain chains with clasp, street photos with bangles; cats → "not jewellery" ✔ |
| Live checks | Latest code live; earlier live Q&A "where do i play" survived redeploys ✔ |

Remaining known misses: "my band is too tight…" / "my bangles look dull…" show products (item word looks like shopping); very indirect phrasings. Fix = add those wordings as extra Q&As.

## 8. Tests folder

Run with the agent running locally (`npm start`). Password = `ADMIN_PASSWORD` from config.js.
- `node tests/test-features.mjs http://localhost:3000 <adminPassword>` — 43 checks (chat, training, leads, admin, CORS…)
- `node tests/test-rephrase.mjs http://localhost:3000 <adminPassword>` — trains 10 Q&As, 50 rephrasings, cleans up.
  On **live without password**: `node --import ./tests/retry.mjs tests/test-rephrase.mjs https://agent.ittanjeweller.com` (learns live answers from the original questions; needs the 10 Q&As added on live; `retry.mjs` waits on rate limits).
- `node tests/test-meaning.mjs …`, `node tests/svc-test.cjs` (localhost), `SKIP_RATE=1 node tests/test-photos.mjs <url>` (needs photos: `node tests/get-images.mjs` → `tests/imgs/`, plus `necklace-sample.jpg`).
- `eval-types.mjs` / `eval-faq.mjs` = model comparisons; `sheet.mjs` = contact sheet of test photos.
- Tests change data — back up `data/*.json` before, restore after (test-rephrase cleans its own Q&As).
- Live rate limits: 40 messages / 10 min and 10 photos / 10 min per visitor.

## 9. Pending / next steps

1. **Redeploy** on Hostinger (CRM password fix `a6d88cc`) → Admin → CRM products → **Sync now** → confirm no error, ~1,064 designs.
2. **Live rephrase test:** user adds the 10 test Q&As on the **live** admin (they were last added on localhost by mistake). Questions: gift wrapping, home delivery, return policy, parking, resize rings, video call, loyalty points, clean & polish, payment methods, GST bill (with real answers). Then run the live test (§8).
3. **CRM changes for the client:** waiting for code/VPS access (see §5). Plan: run CRM locally with a DB copy, change, test, deploy with backup; make sure the agent's sync (designs list + pieces export) still works.
4. **Claude API key** (user will buy): put in config.js → **test AI mode end-to-end first** (never run yet). Cost estimate per customer message: Opus 5.5 ≈ $0.03–0.06, Sonnet 5.5 ≈ $0.015–0.03, Haiku 4.5 ≈ $0.005–0.012; suggest starting with Sonnet; set a monthly spend limit in the Anthropic console.
5. Add the chat to the WordPress site: WPCode → Footer → `<script src="https://agent.ittanjeweller.com/widget.js" defer></script>`; Admin → Settings → Allowed websites `https://ittanjeweller.com https://www.ittanjeweller.com`.
6. Delete the user's test Q&As (punjaaaab, navpreet, father's name, hinjewadi, playground) before real customers use it; enter real store info (one fact per line: `Address: …`, `Timings: …`).
7. Optional: dedicated CRM Viewer login for the agent; ask client to fix CRM data issues (§5).

## 10. Business notes (shared with user)

Suggested pricing for the Indian client: one-time ₹60,000–₹1,20,000 (freelancer level), maintenance
₹4,000–₹10,000/month, AI usage billed separately (≈ ₹1–5 per customer message), 50% advance.

## 11. Other things on this PC (not part of this project)

- `C:\Users\Sameer Gupta\Desktop\solar-website` — a separate WordPress solar theme project (from another session).
- Installed during this work: `faster-whisper` Python package + small model (used once to transcribe the voice note), `cloudflared` (Cloudflare tunnel tool).

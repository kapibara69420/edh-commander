# ⚔ EDH Commander Online

A real-time multiplayer Magic: The Gathering Commander (EDH) client.
Runs in any web browser — your friends just open a link, no installs needed.

## What's included

- **Unified battlefield** (Archidekt playtester style) — Lands / Creatures / Artifacts+Enchantments / Planeswalkers grouped in one shared play area
- **Drag and drop everything** — drag cards from hand onto the battlefield to play them, drag between battlefield/graveyard/exile/command zone/hand
- **Dynamic layout** — opponent panels automatically rearrange (sidebar for 1-2 opponents, top row for 3+) based on how many players join
- **Bigger, readable hand cards** with full card art
- **Commander Zone** — separate from your decklist, supports partner commanders, drag commander to battlefield to cast, with automatic **commander tax tracking** (+2 per cast, adjustable, shown in the sidebar)
- **Generic counter system** — click "Manage counters" on any permanent to add +1/+1, -1/-1, loyalty, or any custom counter type
- **Searchable Library / Graveyard / Exile** — open any zone and filter by card name
- **Readable color-coded numbers** — life totals, counters, commander damage, and mana pool all use distinct bright colors against the dark background
- Real-time sync — everyone sees everyone's board live (via PartyKit/WebSockets)
- Deck builder — search Scryfall, set Commander(s) separately from the 99, save/import/export `.txt`
- Hand, library, draw, scry, mulligan, mill, shuffle
- Live stack — cast spells, respond, resolve, or counter
- Tokens (Treasure + custom)
- In-game chat / log
- Keyboard shortcuts: `D` draw, `N` next turn, `U` untap all, `Esc` close popups

---

## 🆕 What changed in this update

If you already have a working setup from before, here's what's new:

1. **Commander is now separate from your 99-card deck** — the lobby has a dedicated "Commander(s)" box, and the deck builder has `+ Cmd` buttons next to search results
2. **Commander Zone** is now a real drag-and-drop zone on your board, with tax tracking (+2 every time your commander leaves the battlefield)
3. **Counters** — every permanent now has a "Manage counters" button supporting +1/+1, -1/-1, loyalty, and any custom counter
4. **Library/Graveyard/Exile search** — click the Library pile → "View / Search Library" to filter by name; Graveyard/Exile zone popups now have a search box too
5. **Drag and drop** now works everywhere: hand → battlefield, battlefield ↔ graveyard/exile/command zone, command zone → battlefield (casts commander)
6. **Layout auto-adjusts** to player count — 3+ opponents get a horizontal row instead of a tall sidebar
7. **Numbers are more readable** — life totals, counters, mana, and commander damage use brighter, color-coded text

---

## 🔁 How to update an existing install

You need to replace **5 files** and **1 folder file**, then rebuild. No need to redo PartyKit login or deployment unless noted.

### Files to replace (full contents given below / in the zip):
1. `src/app.js`
2. `src/styles.css`
3. `src/deckstore.js`
4. `party/server.js`

### Files that did NOT change (you can leave them as-is):
- `src/main.js`
- `src/scryfall.js`
- `index.html`
- `package.json`
- `vite.config.js`
- `partykit.json`
- `.env` (your existing one is fine)

### Steps:
```powershell
cd path\to\edh-app

# 1. Replace the 4 files above with the new versions (copy-paste or drag from the zip)

# 2. Re-deploy the server (it changed — adds commander tax & counters support)
npm run deploy

# 3. Rebuild the frontend
npm run build

# 4. Re-upload dist/ to Netlify Drop (drag the dist folder to app.netlify.com/drop again)
#    This gives you a NEW link - or use "Drag and drop to update site" if you kept the same Netlify site
```

> ⚠️ Because the server.js changed, **you must run `npm run deploy` again** — otherwise commander tax and counters won't sync between players (it'll still work locally for you, just not for opponents).

---

## How it works

This app has two parts:

1. **The frontend** (what players see) — a static website you host once
2. **The server** (the real-time "room" logic) — a tiny free server on **PartyKit**

Only **you** need to set up the server. After that, you build the frontend once and share the link — your friends just open it in a browser.

---

## Step-by-step setup (fresh install)

### Step 1 — Install Node.js
Download and install from **https://nodejs.org**. Use **Node 20** (not 24 — PartyKit has issues with Node 24 on Windows). Node 20 "End of Life" builds work fine for this.

Verify:
```bash
node -v
npm -v
```

### Step 2 — Unzip the project
Extract somewhere with a short path, e.g. `C:\edh-app` (avoid deep paths with spaces — some PartyKit versions choke on them on Windows).

### Step 3 — Install dependencies
Open a terminal in the project folder:
```bash
npm install
```

> If using PowerShell and you get a "running scripts is disabled" error, run as Administrator:
> ```powershell
> Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```
> or just use Command Prompt (`cmd`) instead, which isn't affected.

### Step 4 — PartyKit login
```bash
npx partykit login
```
Opens browser — sign in with GitHub (free).

### Step 5 — Set your unique server name
Edit `partykit.json`:
```json
{
  "name": "edh-yourname123",
  "main": "party/server.js",
  "compatibilityDate": "2023-11-10"
}
```

### Step 6 — Deploy
```bash
npm run deploy
```
Prints a URL like `https://edh-yourname123.yourgithub.partykit.dev`. Copy the part after `https://`.

### Step 7 — Connect frontend to server
Create `.env` in the project root:
```
VITE_PARTYKIT_HOST=edh-yourname123.yourgithub.partykit.dev
```

### Step 8 — Build
```bash
npm run build
```

### Step 9 — Host it
Drag the `dist` folder to **https://app.netlify.com/drop** → get a public URL → share with friends.

---

## Playing with friends

1. Everyone opens your hosted URL
2. Each person:
   - Types their **name** and picks a **color**
   - Pastes their **Commander(s)** in the dedicated box (one per line — supports partner commanders)
   - Pastes the rest of their **99-card deck** (or use the Deck Builder)
   - Types the **same Room Code**
   - Clicks **Join / Start Game**
3. Boards sync live!

### Sharing the room
After typing a room code, a share link appears with the code pre-filled — send that to friends.

---

## Deck list format

Standard Moxfield/Archidekt export format works:
```
1 Sol Ring
1 Command Tower
1 Arcane Signet
4 Forest
...
```
- Paste your **Commander(s)** in the separate Commander box on the lobby (one name per line)
- If your pasted deck list already includes a `// Commander` section (from an export), leave the Commander box empty — it'll be detected automatically
- Lines starting with `//` or `#` are ignored

---

## Using the Deck Builder

From the lobby, click **Open Deck Builder**:
- **+ New** — create a blank deck
- **Search Scryfall** — search any card; click **+ Cmd** to set it as your Commander, or **+ Deck** to add to the 99
- Click a card to preview it (image + oracle text)
- **Paste tab** — separate boxes for Commander(s) and the 99-card deck
- **Save** — saves to browser storage
- **Export .txt** — download deck (includes a `// Commander` section)
- **Import .txt** — load a deck, auto-detects commander section
- **Use this deck** — requires at least one Commander set

Decks are saved per-browser in local storage. Export to `.txt` to back up or transfer.

---

## Playing the game

### Drag and drop
- **Hand → Battlefield**: drag any card from your hand onto the battlefield to play/cast it
- **Battlefield → Graveyard/Exile**: drag a permanent to those mini-zones to destroy/exile it
- **Command Zone → Battlefield**: drag your commander out to cast it (commander tax starts tracking once it returns to the zone)
- **Any zone → Hand**: drag a card back to your hand area

### Commander zone & tax
- Your commander(s) start in the **👑 Command** mini-zone
- Drag to battlefield (or click → "Cast commander") to play it — goes on the stack first
- Every time it returns to the command zone from the battlefield, **tax automatically goes up by 2**
- The right sidebar shows current tax per commander, with manual +/− adjust buttons
- Click a commander in the zone → "Tax: +N (reset)" to zero it out (e.g. new game)

### Counters
- Click any permanent → **"🔵 Manage counters…"** (or right-click → same option)
- Quick-add buttons for +1/+1, -1/-1, Loyalty, Charge, Shield, Stun, Flying
- Or type any custom counter name and add it
- Counters display as a small badge on the card (e.g. "3+1" for three +1/+1 counters)

### Searching zones
- Click the **Library** pile → **"View / Search Library"** — opens a searchable grid of your whole library
- Click **Graveyard** or **Exile** mini-zones — opens a searchable grid too
- Type in the search box to filter by card name live

### Other
- **Right-click** any card for a quick action menu
- The right panel handles life, commander damage, commander tax, mana pool, and counters (poison/energy/exp/rad)
- 💬 opens chat/game log — auto-logs game actions too

---

## Local development
```bash
npm run dev
```
Runs PartyKit dev server + Vite together with hot-reload.

---

## Troubleshooting

**"Solo mode" / "Disconnected"** — `.env` isn't set correctly or server isn't deployed. Re-check `VITE_PARTYKIT_HOST` matches your deployed URL exactly (no `https://`, no trailing slash), then `npm run build` again.

**Commander tax not syncing for friends** — make sure you redeployed `party/server.js` with `npm run deploy` after this update.

**Friends see empty/different board** — room codes are case-sensitive, must match exactly.

**Card images not loading** — loads from Scryfall progressively, needs internet.

**"npm run deploy" Invalid URL error on Windows** — use Node 20, and a short path with no spaces (e.g. `C:\edh-app`).

---

## Project structure
```
edh-app/
├── .env                — your PartyKit server address (create this)
├── .env.example
├── index.html
├── partykit.json       — set your unique server name here
├── package.json
├── vite.config.js
├── party/
│   └── server.js       — real-time game server logic (UPDATED)
└── src/
    ├── main.js
    ├── app.js           — full game UI & logic (UPDATED)
    ├── styles.css        (UPDATED)
    ├── scryfall.js
    └── deckstore.js       (UPDATED)
```

Enjoy your games!

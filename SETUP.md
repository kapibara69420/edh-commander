# EDH Commander Online — Complete Setup Guide

## How it works (no server needed!)

| Part | What it does | Cost | Runs |
|------|-------------|------|------|
| **GitHub** | Stores code + hosts the website | Free forever | 24/7 automatic |
| **Supabase** | Real-time sync between players (WebSocket channels) | Free forever | 24/7 automatic |
| **Your PC** | Only needed once, for the initial setup | — | Not needed after |

**No server to run. No PartyKit. No Netlify.** Just GitHub Pages + Supabase — both 100% free forever.

---

## Prerequisites — install these once

1. **Node.js 20** from https://nodejs.org → "Other Downloads" → pick v20 LTS
   - Verify: open a terminal and run `node -v` (should show v20.x.x)
2. **Git** from https://git-scm.com/downloads
   - Verify: `git --version`
3. **GitHub account** — sign up free at https://github.com

---

## Part 1 — Supabase (real-time sync, ~5 minutes)

### 1a. Create a free Supabase account
Go to **https://supabase.com** → click **Start for free** → sign in with GitHub

### 1b. Create a project
1. Click **New project**
2. Fill in:
   - **Name**: `edh-commander` (anything)
   - **Database password**: anything (you won't need this)
   - **Region**: pick the closest to you
3. Click **Create new project** — wait ~1 minute for it to set up

### 1c. Enable Realtime
1. In your project, click **Realtime** in the left sidebar
2. Click **Enable Realtime** if it's not already on
3. That's it — no tables or SQL needed

### 1d. Get your API keys
1. In your project, click **Settings** (gear icon, bottom of left sidebar)
2. Click **API**
3. You'll see two values you need:
   - **Project URL** — looks like `https://abcdefgh.supabase.co`
   - **anon public key** — a long string starting with `eyJ...`
4. **Copy both** — you'll need them in Parts 2 and 3

---

## Part 2 — GitHub Repository + Website (free, 24/7)

### 2a. Create a GitHub repository
1. Go to **https://github.com/new**
2. Fill in:
   - **Repository name**: `edh-commander`
   - **Visibility**: ✅ **Public** (required for free GitHub Pages)
   - Leave everything else default
3. Click **Create repository**

### 2b. Add Supabase keys as GitHub Secrets
This keeps your keys out of your public code but available during the build.

1. In your new GitHub repo, click **Settings** tab (top)
2. Left sidebar → **Secrets and variables** → **Actions**
3. Click **New repository secret** and add these two secrets:

   | Secret Name | Value |
   |-------------|-------|
   | `VITE_SUPABASE_URL` | Your Supabase Project URL (e.g. `https://abcdefgh.supabase.co`) |
   | `VITE_SUPABASE_ANON` | Your Supabase anon public key (the long `eyJ...` string) |

### 2c. Enable GitHub Pages
1. Still in repo **Settings**
2. Left sidebar → **Pages**
3. Under **Source**, select **GitHub Actions**
4. Click **Save**

### 2d. Push your code to GitHub

Open a terminal inside your `edh-app` folder. Run these commands one by one:

```powershell
git init
git add .
git commit -m "Initial deploy"
git branch -M main
git remote add origin https://github.com/YOURUSERNAME/edh-commander.git
git push -u origin main
```

> Replace `YOURUSERNAME` with your actual GitHub username.
> Replace `edh-commander` if you used a different repo name.

### 2e. Wait for the build (~2 minutes)
1. Go to your repo on GitHub
2. Click the **Actions** tab
3. You'll see a workflow called **"Deploy to GitHub Pages"** running (yellow circle)
4. Wait for the green ✓ checkmark

### 2f. Get your website URL
1. Repo **Settings** → **Pages**
2. Your URL appears at the top:
   ```
   https://YOURUSERNAME.github.io/edh-commander/
   ```
3. **That's your permanent free link — share this with friends!**

---

## Part 3 — Local .env (for testing on your own PC)

If you want to test locally with `npm run dev`, create a file called `.env` in your `edh-app` folder:

```
VITE_SUPABASE_URL=https://abcdefgh.supabase.co
VITE_SUPABASE_ANON=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Then run:
```powershell
npm run dev
```

Opens at `http://localhost:1999`. Changes hot-reload.

> `.env` is in `.gitignore` so it will NEVER be uploaded to GitHub — your keys stay private.

---

## Playing with friends

1. Send the GitHub Pages URL to everyone (e.g. `https://yourusername.github.io/edh-commander/`)
2. Each person:
   - Types their **Name** and picks a **Color**
   - Pastes their **Commander(s)** in the Commander box (one name per line — supports partners)
   - Pastes their **99-card deck** in the deck list box
   - Types the **same Room Code** — agree on one in advance, e.g. `dragon42`
   - Clicks **▶ Join / Start Game**
3. Boards sync live — you see each other's permanents, life totals, counters, graveyard, exile, everything

**Sharing the room**: after typing a room code, a share link appears with the code pre-filled. Send that link to friends — they click it and the code is already filled in.

---

## Updating the app in the future

When you get new versions of the files, just replace them and push:

```powershell
# 1. Copy new files into your edh-app folder (overwrite old ones)
# 2. Then push to GitHub:
git add .
git commit -m "Update app"
git push
```

GitHub automatically rebuilds and redeploys in ~2 minutes. **No other steps needed.**

---

## Deck list format

Paste lists in Moxfield/Archidekt/standard format:
```
1 Sol Ring
1 Command Tower
1 Arcane Signet
4 Forest
...
```

- Paste your **Commander(s)** in the separate Commander box (one name per line, for partners use two lines)
- If your exported list already has a `// Commander` section at the top, leave the Commander box empty — it detects it automatically
- Lines starting with `//` or `#` are treated as comments and ignored

---

## Troubleshooting

**"Solo mode — add Supabase keys" toast**
→ Your `.env` file is missing or wrong (for local dev), or the GitHub Secrets aren't set (for the live site)
→ Re-check Part 1d and Part 2b — copy the keys again carefully

**Friends' boards don't appear**
→ Make sure everyone typed the **exact same room code** (case-sensitive)
→ Try refreshing the page and rejoining

**Build fails in GitHub Actions**
→ Click the Actions tab → click the failed run → read the red error
→ 99% of the time it's a Secret not set correctly (Step 2b)

**White screen on GitHub Pages**
→ Make sure `vite.config.js` has `base: './'` (it's already set in the included file)
→ GitHub Pages source must be set to **GitHub Actions** (Step 2c)

**Card images not loading**
→ They load from Scryfall in the background — wait a few seconds
→ Requires internet on each player's device

---

## File reference

```
edh-app/
│
├── .github/
│   └── workflows/
│       └── deploy.yml     ← Auto-builds & deploys on every git push (don't edit)
│
├── src/
│   ├── app.js             ← All game UI and logic
│   ├── styles.css         ← All styles
│   ├── deckstore.js       ← Deck save/load/import/export
│   ├── scryfall.js        ← Scryfall card image API
│   └── main.js            ← Entry point (don't edit)
│
├── index.html             ← HTML shell (don't edit)
├── package.json           ← Dependencies
├── vite.config.js         ← Build config (don't edit)
├── .env.example           ← Template — copy to .env and fill in your keys
└── .gitignore             ← Keeps .env and node_modules off GitHub
```

**Files you edit:**
- `src/app.js`, `src/styles.css`, `src/deckstore.js` — when updating the app

**Files you set up once and never touch again:**
- `src/main.js`, `index.html`, `vite.config.js`, `.gitignore`, `.github/workflows/deploy.yml`

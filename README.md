# Blue Horseshoe — bluehorseshoebet.com

NFL and college football picks built from live lines. No server and no monthly cost.

## How the lines stay fresh

| What | Source | How often |
|---|---|---|
| Spreads, totals, moneylines (open and current) | DraftKings lines via ESPN's public feed, loaded in each visitor's browser | Every minute while the page is open |
| NFL injuries | ESPN | Every minute |
| Backup copy of the above (used only if a browser can't reach ESPN) | GitHub Action → `data/espn-*.json` | Every 15 minutes |
| Line check (Hard Rock vs. other books) | The Odds API free plan, via the GitHub Action → `data/books.json` | Every 4 hours (about 360 of the 500 free monthly credits) |
| Player props | `data/props.json` (edit by hand) | When you update it |
| Public betting splits | `data/splits.json` (edit by hand) | When you update it |
| Horseshoe Model (college): our CFBD ratings blend (SP+, FPI, SRS, Elo), Bill Connelly's SP+ game projections (his public "2026 SP+" sheet, newest "FBS Week N" tab), David Sasser's model (davidsasser.com/cfb), and CFBD advanced stats for the matchup chart | `.github/workflows/model.yml` → `data/model.json` | Once a day, plus Friday and Saturday mornings (about 300 of the 1,000 free CFBD calls a month) |

Picks recalculate in the browser every time the lines change. Games drop off once they kick off.

## One-time setup (about 15 minutes)

### 1. Put the files on GitHub
1. Create a new **public** repo, e.g. `Zerex77/bluehorseshoe`. It has to be public for the 15-minute timer to stay free.
2. Upload everything in this folder with **Add file → Upload files**.
3. Mac Finder hides the `.github` folder, so it may not upload. Check that `.github/workflows/refresh.yml` shows up in the repo. If it doesn't, choose **Add file → Create new file**, type `.github/workflows/refresh.yml` as the name, and paste in the contents of `refresh.yml` (a visible copy is in `setup/refresh.yml`).

### 2. Turn on GitHub Pages
1. Repo → **Settings → Pages**.
2. Source: **Deploy from a branch**. Branch: `main`, folder `/ (root)`. Save.
3. Custom domain: `bluehorseshoebet.com` (the `CNAME` file already says this). Tick **Enforce HTTPS** once it's offered.

### 3. Point the domain at GitHub (GoDaddy → DNS for bluehorseshoebet.com)
Same as playsproutle.com:
- Four **A** records for `@`: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
- One **CNAME** for `www` → `zerex77.github.io`
- Delete any other A record for `@` (GoDaddy's "Parked" one).

### 4. Turn on Line check prices (optional, free)
1. Get a free key at https://the-odds-api.com (Starter plan, 500 credits a month).
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**. Name: `ODDS_API_KEY`. Value: your key.

### 5. Turn on the Horseshoe Model (optional, free)
1. Get a free key at https://collegefootballdata.com/key (it's emailed to you).
2. Repo → **Settings → Secrets and variables → Actions → New repository secret**. Name: `CFBD_API_KEY`. Value: your key.
3. **Actions → Horseshoe Model → Run workflow** once. After that it runs on its own every morning.

What it does to college picks: the three projections are averaged. Moneylines become 70% market, 30% model. Spreads with 3+ points of edge, and most of the models on that side, show up as **Model edge** legs; spreads 4+ points the wrong way with most models against them are held (still shown, not a Horseshoe pick). Totals work the same way against the SP+ and Sasser projected totals. Tap any college leg (or **Breakdown** on the full slate) for the matchup breakdown: projected score, every model's line, the team identity chart, matchup advantages and SP+ ratings. The model's view is in each leg's "why" note, and the tracker logs it so the record shows whether it helps.

### 6. Start the timer
Repo → **Actions** tab → enable workflows if asked → **Refresh lines → Run workflow**. After that it runs on its own every 15 minutes.

## Updating props or splits by hand
- `data/props.json`: one entry per prop (`game` uses ESPN short names like `BUF @ LV`). Props hide automatically once that game starts, or if the player is ruled out or doubtful.
- `data/splits.json`: rows are `[game, market, public side, other side, bets %, money %, open line, current line]`. Fade picks appear as soon as rows are added.

## Files
- `index.html`: the site (layout and Horseshoe pick logic)
- `lines.js`: loads the live lines and turns them into Horseshoe legs
- `runtime.js`: small page renderer
- `scripts/refresh.mjs` + `.github/workflows/refresh.yml`: the timer
- `scripts/model.mjs` + `.github/workflows/model.yml`: the Horseshoe Model
- `data/`: snapshot files the timer and you keep updated

Lines move. Confirm every price at your sportsbook. 21+ where legal. Gambling problem? Call 1-800-GAMBLER.

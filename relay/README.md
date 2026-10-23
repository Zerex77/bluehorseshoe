# Horseshoe Ticker app + relay

The phone app for the Blue Horseshoe LED ticker, and the small server ("relay") that connects
phones to tickers over the internet. Both run on one free Cloudflare account.

- **App** (`public/`): pair with a ticker using the code on its panels, then add tickets from a
  screenshot (read on the phone, free), by pasting text, or by picking game → player → stat.
  Shows each ticket grading live. Installs to the home screen like a normal app.
- **Relay** (`src/worker.js`): stores each ticker's tickets. Tickers check in every 12 seconds and
  upload how every leg is doing. Each ticker only sees its own tickets, and each phone only the
  tickers it paired with.
- **Ticker** (`../ticker/cloud.py`): registers, shows its pairing code when it has no tickets,
  pulls tickets, sends status back.

## One-time setup (about 15 minutes, on your Windows PC)

1. **Make a free Cloudflare account:** https://dash.cloudflare.com/sign-up
2. **Install Node.js** (the LTS version) from https://nodejs.org, then reopen PowerShell.
3. **Get this code:** on GitHub, open the repo, click **Code → Download ZIP**, and unzip it.
   In PowerShell, go into the `relay` folder, for example:
   ```
   cd $HOME\Downloads\bluehorseshoe-main\relay
   ```
4. **Log in to Cloudflare** (a browser window opens; click Allow):
   ```
   npx wrangler login
   ```
5. **Create the database:**
   ```
   npx wrangler d1 create bluehorseshoe-relay
   ```
   It prints a `database_id`. Open `wrangler.jsonc` in Notepad and paste it in place of
   `PASTE-DATABASE-ID-HERE`. Save.
6. **Deploy:**
   ```
   npx wrangler deploy
   ```
   It prints your app's address, like `https://bluehorseshoe-relay.yourname.workers.dev`.
   That's the address everyone opens on their phone.

To update later (new app features): download the code again, put your `database_id` back in
`wrangler.jsonc`, and run `npx wrangler deploy`.

## Connect a ticker

On the Pi, run the installer with your relay address (one line):
```
curl -sSL https://raw.githubusercontent.com/Zerex77/bluehorseshoe/main/ticker/install.sh | sed 's#https://bluehorseshoebet.com/ticker#https://raw.githubusercontent.com/Zerex77/bluehorseshoe/main/ticker#' | sudo BOARD=regular CLOUD=https://bluehorseshoe-relay.yourname.workers.dev bash
```
With no tickets on it, the ticker scrolls **PAIR THE APP · CODE XXXXXX**. The code is also on
the ticker's own page (http://bhticker.local:8080), with a link that fills it in for you.

## On each phone

1. Open your app address in Safari (iPhone) or Chrome (Android).
2. **iPhone:** Share → **Add to Home Screen**. **Android:** ⋮ → **Install app**.
3. Open it from the home screen, type the code from the ticker and your name.

Friends can pair with the same code to add their tickets to your ticker; each ticket shows who
added it. "New pairing code" on the ticker's page stops new phones from using the old code.

## Building tickers for other people

Use the same relay for every ticker you build: install each one with the same `CLOUD=` address.
Every ticker gets its own pairing code, and owners only see their own tickers in the app.

## Cost

Cloudflare's free plan allows 100,000 requests a day. A ticker that's on all day uses about
10,000, so the free plan covers roughly 8–10 tickers running around the clock (more if they're
off part of the day). Past that, Cloudflare's Workers Paid plan is $5/month.

## App Store later

The app is a standard web app, so it can be wrapped as a native iPhone/Android app with
Capacitor (https://capacitorjs.com) without rewriting it. That needs a Mac with Xcode and an
Apple Developer account ($99/year).

## Testing on a computer

```
node --no-warnings dev/server.mjs 8787
```
Runs the relay and app at http://localhost:8787 with a temporary database. Point a ticker at it
with `"cloud_url": "http://<your computer's IP>:8787"` in `/var/lib/bhticker/config.json`.

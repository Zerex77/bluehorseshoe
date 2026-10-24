// Blue Horseshoe relay: connects the phone app to LED tickers over the internet.
//
// A ticker registers once and gets an id, a secret and a 6-character pairing code that it shows
// on its panels. A phone pairs with that code and gets a token for that ticker. Phones add and
// remove slips here; the ticker checks in for them and uploads its graded status for the app.
//
// Cloudflare Workers + D1 (free plan). Static files in ../public are the app itself.
//
//   Ticker (header X-Ticker-Secret)
//     POST /api/ticker/register            {}                 -> {id, secret, code}
//     GET  /api/ticker/:id/sync?v=N                           -> {v, slips?, code, phones, label}
//     PUT  /api/ticker/:id/slips           {slips}            -> {v}         (slips edited on the ticker's own page)
//     POST /api/ticker/:id/status          {status, snap}     -> {ok}
//     POST /api/ticker/:id/code                               -> {code}      (new pairing code)
//   Phone (header Authorization: Bearer <token>)
//     POST   /api/pair                     {code, name}       -> {ticker, token, label}
//     GET    /api/t/:id                                       -> {v, slips, snap, status, seen, label, phones}
//     POST   /api/t/:id/slips              {slip}             -> {v, id}     (add or update one slip)
//     DELETE /api/t/:id/slips/:sid                            -> {v}
//     POST   /api/t/:id/label              {label}            -> {ok}
//     POST   /api/t/:id/leave                                 -> {ok}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L
const MAX_SLIPS = 30;
const MAX_BODY = 96 * 1024;
const SEEN_EVERY = 60 * 1000;      // record "last seen" at most once a minute (saves database writes)

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tickers (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, code TEXT UNIQUE, v INTEGER NOT NULL DEFAULT 1,
     slips TEXT NOT NULL DEFAULT '[]', snap TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT '', seen INTEGER NOT NULL DEFAULT 0,
     label TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS phones (token_hash TEXT PRIMARY KEY, ticker TEXT NOT NULL, name TEXT NOT NULL, added INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS phones_ticker ON phones (ticker)`,
  `CREATE TABLE IF NOT EXISTS pair_fails (ip TEXT NOT NULL, t INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS pair_fails_ip ON pair_fails (ip, t)`,
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-ticker-secret',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS },
});
const err = (status, message) => json({ error: message }, status);

function randomString(n, chars = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let out = '';
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function readJSON(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error('too big');
  return text ? JSON.parse(text) : {};
}
function cleanSlip(s, by) {
  if (!s || typeof s !== 'object' || !Array.isArray(s.legs)) return null;
  const legs = s.legs.slice(0, 25).map((l) => {
    if (!l || typeof l.text !== 'string' || !l.text.trim()) return null;
    const leg = { text: l.text.trim().slice(0, 160) };
    if (l.g) leg.g = String(l.g).slice(0, 20);
    if (l.sport === 'nfl' || l.sport === 'cfb') leg.sport = l.sport;
    if (l.odds !== null && l.odds !== '' && Number.isFinite(Number(l.odds))) leg.odds = Number(l.odds);
    return leg;
  }).filter(Boolean);
  if (!legs.length) return null;
  const odds = Number(s.odds);
  return {
    id: String(s.id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || randomString(8),
    name: String(s.name || 'Slip').slice(0, 40),
    stake: Math.max(0, Math.min(1e6, Number(s.stake) || 0)),
    odds: Number.isFinite(odds) && Math.abs(odds) >= 100 ? odds : null,
    legs,
    by: String(by || s.by || '').slice(0, 24),
    added: Number(s.added) || Date.now(),
  };
}

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch(SCHEMA.map((q) => db.prepare(q)))
      // added after launch: per-ticker settings such as on/off (fails harmlessly once the column exists)
      .then(() => db.prepare("ALTER TABLE tickers ADD COLUMN settings TEXT NOT NULL DEFAULT '{}'").run().catch(() => {}))
      .catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ---------------------------------------------------------------- entry
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : err(404, 'not found');
    try {
      await ensureSchema(env.DB);
      return await route(req, env.DB, url);
    } catch (e) {
      return err(e instanceof SyntaxError || /too big/.test(e.message) ? 400 : 500, e instanceof SyntaxError ? 'bad request' : 'Something went wrong. Try again.');
    }
  },
};

async function newCode(db, tickerId) {
  for (let i = 0; i < 20; i++) {
    const code = randomString(6, CODE_CHARS);
    const r = await db.prepare('UPDATE tickers SET code = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM tickers WHERE code = ?)').bind(code, tickerId, code).run();
    if (r.meta.changes) return code;
  }
  throw new Error('no code');
}

async function route(req, db, url) {
  const parts = url.pathname.split('/').filter(Boolean);   // ['api', ...]
  const now = Date.now();

  // ---- ticker registers itself
  if (req.method === 'POST' && parts[1] === 'ticker' && parts[2] === 'register') {
    const id = randomString(16), secret = randomString(32);
    await db.prepare('INSERT INTO tickers (id, secret_hash, created) VALUES (?, ?, ?)').bind(id, await sha256(secret), now).run();
    const code = await newCode(db, id);
    return json({ id, secret, code });
  }

  // ---- the ticker itself
  if (parts[1] === 'ticker' && parts[2]) {
    const id = parts[2], sub = parts[3] || '';
    const hash = await sha256(req.headers.get('x-ticker-secret') || '');
    const t = await db.prepare('SELECT id, v, code, label, seen, settings FROM tickers WHERE id = ? AND secret_hash = ?').bind(id, hash).first();
    if (!t) return err(401, 'unknown ticker');

    if (sub === 'sync' && req.method === 'GET') {
      const v = Number(url.searchParams.get('v'));
      const phones = await db.prepare('SELECT count(*) AS n FROM phones WHERE ticker = ?').bind(id).first();
      const out = { v: t.v, code: t.code, label: t.label, phones: phones.n, settings: JSON.parse(t.settings || '{}') };
      if (v !== t.v) out.slips = JSON.parse((await db.prepare('SELECT slips FROM tickers WHERE id = ?').bind(id).first()).slips);
      if (now - t.seen > SEEN_EVERY) await db.prepare('UPDATE tickers SET seen = ? WHERE id = ?').bind(now, id).run();
      return json(out);
    }
    if (sub === 'slips' && req.method === 'PUT') {
      const body = await readJSON(req);
      const slips = (body.slips || []).map((s) => cleanSlip(s, s && s.by ? s.by : 'Ticker')).filter(Boolean).slice(0, MAX_SLIPS);
      await db.prepare('UPDATE tickers SET slips = ?, v = v + 1, seen = ? WHERE id = ?').bind(JSON.stringify(slips), now, id).run();
      return json({ v: t.v + 1 });
    }
    if (sub === 'status' && req.method === 'POST') {
      const body = await readJSON(req);
      const snap = Array.isArray(body.snap) ? body.snap.slice(0, MAX_SLIPS) : [];
      await db.prepare('UPDATE tickers SET status = ?, snap = ?, seen = ? WHERE id = ?')
        .bind(String(body.status || '').slice(0, 80), JSON.stringify(snap), now, id).run();
      return json({ ok: true });
    }
    if (sub === 'code' && req.method === 'POST') {
      return json({ code: await newCode(db, id) });
    }
    return err(404, 'not found');
  }

  // ---- a phone pairs with the code on the ticker
  if (req.method === 'POST' && parts[1] === 'pair') {
    const ip = req.headers.get('cf-connecting-ip') || 'local';
    const fails = await db.prepare('SELECT count(*) AS n FROM pair_fails WHERE ip = ? AND t > ?').bind(ip, now - 10 * 60 * 1000).first();
    if (fails.n >= 10) return err(429, 'Too many tries. Wait a few minutes and try again.');
    const body = await readJSON(req);
    const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const t = code.length === 6 ? await db.prepare('SELECT id, label FROM tickers WHERE code = ?').bind(code).first() : null;
    if (!t) {
      await db.batch([
        db.prepare('INSERT INTO pair_fails (ip, t) VALUES (?, ?)').bind(ip, now),
        db.prepare('DELETE FROM pair_fails WHERE t < ?').bind(now - 60 * 60 * 1000),
      ]);
      return err(404, "That code doesn't match a ticker. Check the code on your ticker's panels.");
    }
    const token = randomString(32);
    await db.prepare('INSERT INTO phones (token_hash, ticker, name, added) VALUES (?, ?, ?, ?)')
      .bind(await sha256(token), t.id, String(body.name || 'Phone').trim().slice(0, 24) || 'Phone', now).run();
    return json({ ticker: t.id, token, label: t.label });
  }

  // ---- a paired phone
  if (parts[1] === 't' && parts[2]) {
    const id = parts[2], sub = parts.slice(3).join('/');
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const phone = await db.prepare('SELECT name, token_hash FROM phones WHERE token_hash = ? AND ticker = ?').bind(await sha256(token), id).first();
    if (!phone) return err(401, 'This phone is no longer paired with that ticker.');

    if (sub === '' && req.method === 'GET') {
      const t = await db.prepare('SELECT v, slips, snap, status, seen, label, settings FROM tickers WHERE id = ?').bind(id).first();
      if (!t) return err(404, 'That ticker is gone.');
      const phones = await db.prepare('SELECT name FROM phones WHERE ticker = ? ORDER BY added').bind(id).all();
      return json({ v: t.v, slips: JSON.parse(t.slips), snap: JSON.parse(t.snap), status: t.status, seen: t.seen, label: t.label,
        settings: JSON.parse(t.settings || '{}'), phones: phones.results.map((p) => p.name) });
    }
    if (sub === 'slips' && req.method === 'POST') {
      const body = await readJSON(req);
      const s = cleanSlip(body.slip, phone.name);
      if (!s) return err(400, 'A ticket needs at least one leg.');
      // read, change, write only if nobody else changed it in between (two phones at once)
      for (let tries = 0; tries < 5; tries++) {
        const t = await db.prepare('SELECT v, slips FROM tickers WHERE id = ?').bind(id).first();
        const slips = JSON.parse(t.slips);
        const ix = slips.findIndex((x) => x.id === s.id);
        if (ix === -1) {
          if (slips.length >= MAX_SLIPS) return err(400, 'This ticker is full. Remove a finished ticket first.');
          slips.push(s);
        } else {
          s.by = slips[ix].by || s.by;
          s.added = slips[ix].added || s.added;
          slips[ix] = s;
        }
        const r = await db.prepare('UPDATE tickers SET slips = ?, v = v + 1 WHERE id = ? AND v = ?').bind(JSON.stringify(slips), id, t.v).run();
        if (r.meta.changes) return json({ v: t.v + 1, id: s.id });
      }
      return err(409, 'Someone else changed the ticker at the same time. Try again.');
    }
    if (sub.startsWith('slips/') && req.method === 'DELETE') {
      const sid = decodeURIComponent(sub.slice('slips/'.length));
      for (let tries = 0; tries < 5; tries++) {
        const t = await db.prepare('SELECT v, slips FROM tickers WHERE id = ?').bind(id).first();
        const slips = JSON.parse(t.slips).filter((x) => x.id !== sid);
        const r = await db.prepare('UPDATE tickers SET slips = ?, v = v + 1 WHERE id = ? AND v = ?').bind(JSON.stringify(slips), id, t.v).run();
        if (r.meta.changes) return json({ v: t.v + 1 });
      }
      return err(409, 'Someone else changed the ticker at the same time. Try again.');
    }
    if (sub === 'settings' && req.method === 'POST') {
      // turn the ticker on or off (more settings can be added here later)
      const body = await readJSON(req);
      const t = await db.prepare('SELECT settings FROM tickers WHERE id = ?').bind(id).first();
      const cur = JSON.parse((t && t.settings) || '{}');
      if (typeof body.on === 'boolean') cur.on = body.on;
      if (body.mode === 'tickets' || body.mode === 'team') cur.mode = body.mode;
      if (typeof body.team === 'string' && /^[A-Z]{2,4}$/.test(body.team)) cur.team = body.team;
      await db.prepare('UPDATE tickers SET settings = ? WHERE id = ?').bind(JSON.stringify(cur), id).run();
      return json({ ok: true, settings: cur });
    }
    if (sub === 'label' && req.method === 'POST') {
      const body = await readJSON(req);
      await db.prepare('UPDATE tickers SET label = ? WHERE id = ?').bind(String(body.label || '').trim().slice(0, 30), id).run();
      return json({ ok: true });
    }
    if (sub === 'leave' && req.method === 'POST') {
      await db.prepare('DELETE FROM phones WHERE token_hash = ?').bind(phone.token_hash).run();
      return json({ ok: true });
    }
    return err(404, 'not found');
  }
  return err(404, 'not found');
}

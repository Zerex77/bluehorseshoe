// Horseshoe pick tracker. Runs in GitHub Actions after each refresh.
// 1) Records every pick the Horseshoe signals on (same rules as the site). Each pick keeps the line it was first
//    flagged at and follows the line until kickoff; it's graded at the closing (last pre-kickoff) line.
// 2) One pick per game per market: when both sides (or a team's ML and spread) signal, only the stronger one counts.
// 3) Closing line value: did the line keep moving our way between the first flag and kickoff?
// 4) After games go final, grades each pick against the real result and records how far it landed from the line.
import { readFile, writeFile } from 'node:fs/promises';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/';
const readJSON = async (p, f) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return f; } };
const getJSON = async (url) => { const r = await fetch(url, { headers: { 'user-agent': 'blue-horseshoe/1.0' } }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
const ymd = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replaceAll('-', '');
const dec = (o) => (o > 0 ? 1 + o / 100 : 1 + 100 / -o);
const normName = (x) => String(x || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');

// Load the site's own pick logic so the tracker grades exactly what the site shows.
(0, eval)(await readFile('lines.js', 'utf8'));
const T = globalThis.BHLines._test;

export async function track(log = console.log) {
  const [nflSb, cfbSb, inj, props, sgo, sgoCfb, store, weather, splits] = await Promise.all([
    readJSON('data/espn-nfl.json', null), readJSON('data/espn-cfb.json', null), readJSON('data/espn-injuries.json', null),
    readJSON('data/props.json', null), readJSON('data/sgo-nfl.json', null), readJSON('data/sgo-cfb.json', null),
    readJSON('data/picks.json', { picks: [] }), readJSON('data/weather.json', null), readJSON('data/splits.json', null)
  ]);
  const now = Date.now();
  const picks = store.picks || [];
  const byKey = new Map(picks.map((p) => [p.key, p]));
  const events = {};
  for (const [sport, sb] of [['nfl', nflSb], ['cfb', cfbSb]]) {
    for (const ev of (sb && sb.events) || []) { const e = T.readEvent(ev); if (e) events[sport + ':' + e.id] = e; }
  }

  // ---------- 1) record
  // Older rows were keyed by label (which changes when the line moves); re-key them to the stable form.
  const rank = (p) => (p.result ? 8 : 0) + (p.locked && p.active ? 4 : 0) + (p.active ? 2 : 0);
  const winners = new Map();
  for (const p of picks) {
    const k = stableKey(p.sport, p.g, p) || p.key;
    const cur = winners.get(k);
    if (!cur || rank(p) > rank(cur) || (rank(p) === rank(cur) && (p.lastSeen || '') > (cur.lastSeen || ''))) winners.set(k, p);
  }
  picks.length = 0;
  byKey.clear();
  for (const [k, p] of winners) {
    p.key = k;
    if (p.firstLine === undefined) {
      // flagged before this was tracked: games still to come start their closing-line clock now
      if (p.locked) { p.firstLine = null; p.firstOdds = null; } else { p.firstLine = p.line; p.firstOdds = p.odds; p.firstLabel = p.label; }
    }
    picks.push(p); byKey.set(k, p);
  }

  const seen = new Set();
  const record = (sport, l, label) => {
    const e = events[sport + ':' + l.g];
    if (!e || e.state !== 'pre') return;
    const parsed = parseLeg(sport, l, label, e);
    if (!parsed) return;
    const key = stableKey(sport, l.g, parsed);
    seen.add(key);
    const p = l.p != null ? l.p : (1 / dec(l.odds)) * 0.955;
    let row = byKey.get(key);
    if (!row) {
      row = { key, sport, g: l.g, firstSeen: new Date(now).toISOString(), firstLine: parsed.line, firstOdds: l.odds, firstLabel: label };
      byKey.set(key, row); picks.push(row);
    }
    if (row.locked) return;
    Object.assign(row, parsed, {
      label, date: e.date, game: e.short, away: e.a.shortDisplayName, home: e.h.shortDisplayName,
      odds: l.odds, p: Math.round(p * 1000) / 1000, imp: Math.round((1 / dec(l.odds)) * 1000) / 1000,
      conf: l.conf, score: l.score, top: !!l.pick, fade: !!l.fade, s: l.sOrig || l.s, held: l.held || null, note: l.note, lastSeen: new Date(now).toISOString(), active: true,
      tilt: l.tilt || 0, wind: weather && weather.games && weather.games[l.g] && !weather.games[l.g].indoor ? Math.round(weather.games[l.g].wind) : null,
      ...moveOf(parsed, e)
    });
  };
  if (nflSb) {
    const nfl = T.buildNfl(nflSb, inj, { props, sgo, weather, splits });
    for (const l of nfl.legs) {
      if (l.alt) continue;
      const s0 = l.sOrig || l.s; // held legs keep their original checks so we can see how the rules do
      const sig = s0 ? s0[0] + s0[1] + s0[2] : 0;
      if (sig >= 2) record('nfl', l, l.label);
    }
  }
  if (cfbSb) {
    const cf = T.buildCollege(cfbSb, { sgoCfb, weather, splits });
    for (const l of cf.legs) {
      if (l.alt) continue;
      const s0 = l.sOrig || l.s;
      const sig = s0[0] + s0[1] + s0[2];
      if (sig >= (l.k === 'ml' ? 2 : 1) || l.fade) record('cfb', l, l.label);
    }
  }
  for (const p of picks) {
    if (p.locked) continue;
    const e = events[p.sport + ':' + p.g];
    const started = e ? e.state !== 'pre' : now > Date.parse(p.date);
    if (started) {
      p.locked = true; p.lockedAt = new Date(now).toISOString();
      p.closeLine = p.line; p.closeOdds = p.odds; p.clv = clvOf(p);
    } else if (!seen.has(p.key)) p.active = false; // signal faded before kickoff
  }
  dedupe(picks);

  // ---------- 2) grade
  const sbCache = {}, sumCache = {};
  const scoreboard = async (sport, date) => {
    const k = sport + date;
    if (!sbCache[k]) sbCache[k] = getJSON(`${ESPN}${sport === 'nfl' ? 'nfl' : 'college-football'}/scoreboard?dates=${date}${sport === 'cfb' ? '&groups=80&limit=300' : ''}`).catch(() => null);
    return sbCache[k];
  };
  const summary = async (sport, id) => {
    const k = sport + id;
    if (!sumCache[k]) sumCache[k] = getJSON(`${ESPN}${sport === 'nfl' ? 'nfl' : 'college-football'}/summary?event=${id}`).catch(() => null);
    return sumCache[k];
  };
  let graded = 0;
  const errors = [];
  for (const p of picks) {
    if (!p.locked || !p.active || p.result) continue;
    if (now < Date.parse(p.date) + 3 * 3600e3) continue;
    try {
      const sb = await scoreboard(p.sport, ymd(p.date));
      const ev = sb && (sb.events || []).find((x) => String(x.id) === String(p.g));
      if (!ev) { if (now > Date.parse(p.date) + 4 * 864e5) { p.result = 'void'; p.why = 'Game not found'; } continue; }
      const st = ev.status?.type || {};
      if (st.name === 'STATUS_CANCELED' || st.name === 'STATUS_POSTPONED') { p.result = 'void'; p.why = 'Game ' + st.description; continue; }
      if (!st.completed) continue;
      const c = ev.competitions[0];
      const home = c.competitors.find((x) => x.homeAway === 'home'), away = c.competitors.find((x) => x.homeAway === 'away');
      const hs = Number(home.score), as = Number(away.score);
      p.final = `${away.team.abbreviation} ${as} – ${home.team.abbreviation} ${hs}`;
      if (p.market === 'ml' || p.market === 'spread') {
        const mine = p.side === 'a' ? as : hs, theirs = p.side === 'a' ? hs : as;
        const margin = mine - theirs + (p.market === 'spread' ? p.line : 0);
        p.actual = mine - theirs; p.dev = Math.round(margin * 10) / 10;
        p.result = margin > 0 ? 'win' : margin < 0 ? 'loss' : 'push';
      } else if (p.market === 'total') {
        const tot = hs + as, d = p.dir === 'Over' ? tot - p.line : p.line - tot;
        p.actual = tot; p.dev = Math.round(d * 10) / 10;
        p.result = d > 0 ? 'win' : d < 0 ? 'loss' : 'push';
      } else if (p.market === 'prop') {
        const sum = await summary(p.sport, p.g);
        const val = playerStat(sum, p.player, p.what);
        if (val == null) {
          if (sum && sum.boxscore && Array.isArray(sum.boxscore.players) && sum.boxscore.players.length) { p.result = 'void'; p.why = 'No stats for player (did not play?)'; }
          else errors.push(`no box score yet for ${p.game}`);
          continue;
        }
        p.actual = val;
        if (p.side === 'yes') { p.result = val >= 1 ? 'win' : 'loss'; p.dev = val - 0.5; }
        else { const d = val - p.line; p.dev = Math.round(d * 10) / 10; p.result = d > 0 ? 'win' : d < 0 ? 'loss' : 'push'; }
      }
      if (p.result) { p.gradedAt = new Date(now).toISOString(); graded++; }
    } catch (e) { errors.push(String(e.message || e).slice(0, 160)); }
  }

  // Keep a season's worth; drop withdrawn picks after their game.
  const keep = picks.filter((p) => p.active || !p.locked).filter((p) => now - Date.parse(p.date) < 200 * 864e5);
  await writeFile('data/picks.json', JSON.stringify({ updated: new Date(now).toISOString(), picks: keep }));
  log(`Tracker: ${keep.length} picks on file, ${graded} graded this run${errors.length ? ', ' + errors.length + ' issues: ' + errors.slice(0, 3).join(' | ') : ''}`);
  return { graded, errors };
}

// One row per pick, no matter how the line moves: game + market + side (or player + stat for props).
function stableKey(sport, g, p) {
  if (!p || !p.market) return null;
  if (p.market === 'prop') return `${sport}|${g}|prop|${normName(p.player)}|${p.what}|${p.side}`;
  if (p.market === 'total') return `${sport}|${g}|total|${p.dir}`;
  return `${sport}|${g}|${p.market}|${p.side}`;
}

// How far the market moved before we flagged it, and whether it was toward this pick.
function moveOf(p, e) {
  const o = e.odds;
  if (!o) return {};
  if (p.market === 'total' && o.tot != null && o.tOpen != null) {
    const m = o.tot - o.tOpen;
    return { move: Math.abs(m), moveToward: m === 0 ? null : (m > 0) === (p.dir === 'Over') };
  }
  if ((p.market === 'spread' || p.market === 'ml') && o.aNow != null && o.aOpen != null) {
    const m = o.aOpen - o.aNow; // + = money on the away team
    return { move: Math.abs(m), moveToward: m === 0 ? null : (m > 0) === (p.side === 'a') };
  }
  return {};
}

// Closing line value: positive pts = the line kept moving our way after we flagged it.
function clvOf(p) {
  if (p.firstLine == null || p.firstOdds == null) return null;
  const impF = 1 / dec(p.firstOdds), impC = 1 / dec(p.odds);
  let pts = null;
  if (p.market === 'spread') pts = p.firstLine - p.line;
  else if (p.market === 'total') pts = p.dir === 'Over' ? p.line - p.firstLine : p.firstLine - p.line;
  else if (p.market === 'prop' && p.side !== 'yes') pts = p.line - p.firstLine;
  const prob = Math.round((impC - impF) * 1000) / 10; // percentage points of implied win chance
  const beat = pts ? (pts > 0 ? 'yes' : 'no') : prob > 0.5 ? 'yes' : prob < -0.5 ? 'no' : 'even';
  return { pts: pts == null ? null : Math.round(pts * 10) / 10, prob, beat };
}

// One pick per game per market: a team's ML and spread, and both sides of a game, share one slot; totals have their own.
// The slot goes to the same line the site shows as the Horseshoe pick (lines.js rateLegs: l.pick / l.score).
// Picks recorded before Oct 21 have no shared verdict, so they fall back to the old rule: more signals, then bigger edge.
function dedupe(picks) {
  const slot = (p) => p.market === 'prop' ? p.key : `${p.sport}|${p.g}|${p.market === 'total' ? 'total' : 'side'}`;
  const score = (p) => p.top !== undefined
    ? (p.top ? 1e6 : 0) + (p.score || 0) * 1000
    : (p.s ? p.s[0] + p.s[1] + p.s[2] : 0) * 10 + ((p.p || 0) - (p.imp || 0)) * 100 + (p.conf || 0) / 1000;
  const best = {};
  for (const p of picks) {
    if (!p.active || p.held) continue;
    const k = slot(p);
    if (!best[k] || score(p) > score(best[k])) best[k] = p;
  }
  for (const p of picks) {
    const b = best[slot(p)];
    if (!p.active || p.held || !b || b === p) { delete p.dup; delete p.dupOf; }
    else { p.dup = true; p.dupOf = b.key; }
  }
}

function parseLeg(sport, l, label, e) {
  const A = sport === 'nfl' ? e.a.shortDisplayName : (e.a.location || e.a.shortDisplayName);
  const H = sport === 'nfl' ? e.h.shortDisplayName : (e.h.location || e.h.shortDisplayName);
  const sideOf = (team) => (team === A ? 'a' : team === H ? 'h' : null);
  let m;
  if (l.k === 'prop') {
    if ((m = /^(.*) (over) ([\d.]+) (.*)$/.exec(label))) return { market: 'prop', player: m[1], side: 'over', line: Number(m[3]), what: m[4] };
    if ((m = /^(.*) anytime TD$/.exec(label))) return { market: 'prop', player: m[1], side: 'yes', line: 0.5, what: 'TDs' };
    if ((m = /^(.*) to throw a TD$/.exec(label))) return { market: 'prop', player: m[1], side: 'yes', line: 0.5, what: 'pass TDs' };
    return null; // other yes/no props aren't graded
  }
  if ((m = /^(Over|Under) ([\d.]+)$/.exec(label))) return { market: 'total', dir: m[1], line: Number(m[2]) };
  if ((m = /^(.*) (moneyline|ML)$/.exec(label))) { const s = sideOf(m[1]); return s ? { market: 'ml', side: s, team: m[1], line: 0 } : null; }
  if ((m = /^(.*) ([+-]?\d+(\.\d+)?)$/.exec(label))) { const s = sideOf(m[1]); return s ? { market: 'spread', side: s, team: m[1], line: Number(m[2]) } : null; }
  return null;
}

// Player stat from an ESPN game summary box score.
function playerStat(sum, player, what) {
  const groups = sum && sum.boxscore && sum.boxscore.players;
  if (!Array.isArray(groups)) return null;
  const want = normName(player);
  const get = (cat, key) => {
    for (const team of groups) {
      for (const st of team.statistics || []) {
        if (st.name !== cat) continue;
        const keys = (st.keys || st.labels || []).map((k) => String(k).toLowerCase());
        for (const a of st.athletes || []) {
          const nm = normName(a.athlete && a.athlete.displayName);
          if (nm !== want && !(nm && want && (nm.startsWith(want) || want.startsWith(nm)))) continue;
          const ix = keys.findIndex((k) => key.includes(k));
          if (ix === -1) return 0;
          const raw = String(a.stats[ix] || '0');
          if (raw.includes('/')) return null;
          return Number(raw.replace(/[^\d.-]/g, '')) || 0;
        }
      }
    }
    return undefined; // player not in this category
  };
  const cAtt = (part) => {
    for (const team of groups) for (const st of team.statistics || []) {
      if (st.name !== 'passing') continue;
      const keys = (st.keys || st.labels || []).map((k) => String(k).toLowerCase());
      const ix = keys.findIndex((k) => k.includes('completions') || k === 'c/att');
      for (const a of st.athletes || []) {
        if (normName(a.athlete && a.athlete.displayName) !== want || ix === -1) continue;
        const [c, att] = String(a.stats[ix]).split('/').map(Number);
        return part === 'c' ? c : att;
      }
    }
    return undefined;
  };
  const n = (v) => (v === undefined || v === null ? 0 : v);
  const any = (...vals) => vals.some((v) => v !== undefined);
  switch (what) {
    case 'pass yds': { const v = get('passing', ['passingyards', 'yds']); return v === undefined ? null : v; }
    case 'pass TDs': { const v = get('passing', ['passingtouchdowns', 'td']); return v === undefined ? null : v; }
    case 'interceptions thrown': { const v = get('passing', ['interceptions', 'int']); return v === undefined ? null : v; }
    case 'completions': { const v = cAtt('c'); return v === undefined ? null : v; }
    case 'pass attempts': { const v = cAtt('att'); return v === undefined ? null : v; }
    case 'rush yds': { const v = get('rushing', ['rushingyards', 'yds']); return v === undefined ? null : v; }
    case 'rush attempts': { const v = get('rushing', ['rushingattempts', 'car']); return v === undefined ? null : v; }
    case 'longest rush': { const v = get('rushing', ['longrushing', 'long']); return v === undefined ? null : v; }
    case 'rec yds': { const v = get('receiving', ['receivingyards', 'yds']); return v === undefined ? null : v; }
    case 'receptions': { const v = get('receiving', ['receptions', 'rec']); return v === undefined ? null : v; }
    case 'longest reception': { const v = get('receiving', ['longreception', 'long']); return v === undefined ? null : v; }
    case 'rush + rec yds': { const r = get('rushing', ['rushingyards', 'yds']), c = get('receiving', ['receivingyards', 'yds']); return any(r, c) ? n(r) + n(c) : null; }
    case 'pass + rush yds': { const r = get('passing', ['passingyards', 'yds']), c = get('rushing', ['rushingyards', 'yds']); return any(r, c) ? n(r) + n(c) : null; }
    case 'TDs': { const r = get('rushing', ['rushingtouchdowns', 'td']), c = get('receiving', ['receivingtouchdowns', 'td']); return any(r, c) ? n(r) + n(c) : null; }
    default: return null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await track();

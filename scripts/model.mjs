// Horseshoe Model: college power ratings from CollegeFootballData.com (CFBD), turned into a projected
// score margin for every FBS game in the next 8 days. Writes data/model.json. The site compares these
// projections to the live lines in the browser, so edges stay current as the lines move.
//
// Built from what the best entries in the CFBD Model Pick'em do:
//  - blend several rating systems instead of trusting one
//  - lean on ratings with a preseason prior (SP+, FPI) early, and let in-season-only ratings (SRS) count more as weeks go by
//  - add home field, nothing for neutral sites
//
// Outside projections blended in, each matched to games by ESPN game id:
//  - Bill Connelly's SP+ game projections and team ratings (his public "2026 SP+" Google Sheet, newest "FBS Week N" tab)
//  - David Sasser's model board (davidsasser.com/cfb): projected scores and his picks
// Plus CFBD advanced team stats, turned into 0-100 percentiles for the matchup chart on the site.
//
//  - Sam's Models (samthemodelman.smmodel.workers.dev): projected scores, model line, and each game's
//    "where the margin comes from" breakdown. Sam's own testing says it tracks the market rather than beating it,
//    so it gets a smaller share of the blend. His NFL board is saved too (data/nfl-sources.json).
//
// Runs every 2 hours from the refresh loop (scripts/refresh.mjs), plus .github/workflows/model.yml once a day.
// Outside sources are re-read every run. CFBD (free key in the repo secret CFBD_API_KEY) is re-read at most every
// 12 hours and saved in data/cfbd-cache.json, about 8 calls each time, roughly 500 a month (the free tier allows 1,000).
import { writeFile, readFile } from 'node:fs/promises';
import { getSam } from './sam.mjs';

const API = 'https://api.collegefootballdata.com';
const KEY = process.env.CFBD_API_KEY;
const OUT = process.env.MODEL_OUT || 'data/model.json';

// Home field in points. Older studies put it at 4+, but in recent seasons it's closer to 2.5-3.
export const HFA = 2.5;
// Spread of real results around a projection, in points. Turns a projected margin into a win chance.
export const SD = 15.5;
// How much each rating counts. SRS only knows this season, so it ramps up from 0 to full weight by week 6.
const WEIGHTS = { sp: 0.35, fpi: 0.35, elo: 0.15, srs: 0.15 };
const ELO_PER_PT = 25; // Elo points per point of margin
// Final projected margin: our ratings blend, Connelly's SP+ game projection, Sasser's model and Sam's model, weighted.
export const BLEND = { own: 0.29, spx: 0.29, ds: 0.29, sam: 0.13 };
const CACHE = process.env.CFBD_CACHE || 'data/cfbd-cache.json';
const NFL_OUT = process.env.NFL_SOURCES_OUT || 'data/nfl-sources.json';
const CFBD_EVERY_H = 12;
const SPX_SHEET = process.env.SPX_SHEET || '1vwoVl-Dxy0es87Z9I1RTvFzr72Lb1fAkREfbLxbK-eg';
const SASSER_URL = process.env.SASSER_URL || 'https://davidsasser.com/cfb';
const UA = { 'user-agent': 'blue-horseshoe/1.0 (+https://bluehorseshoebet.com)' };

const phi = (z) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
};
const round = (x, n = 1) => Math.round(x * 10 ** n) / 10 ** n;

async function cfbd(path) {
  const r = await fetch(API + path, { headers: { authorization: 'Bearer ' + KEY, accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

// Each source becomes { team: points better than an average FBS team on a neutral field }.
function toPoints(rows, field, scale = 1, center = false) {
  const out = {};
  for (const r of rows || []) {
    const v = r[field];
    if (r.team && typeof v === 'number' && Number.isFinite(v)) out[r.team] = v / scale;
  }
  if (center) { // Elo is centered near 1500, not 0
    const vals = Object.values(out);
    const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
    for (const k of Object.keys(out)) out[k] -= mean;
  }
  return out;
}

// ---------- team names: CFBD, Connelly and ESPN spell schools differently
const ALIAS = { miamifl: 'miami', ullafayette: 'louisiana', louisianalafayette: 'louisiana', connecticut: 'uconn', ulmonroe: 'ulmonroe', louisianamonroe: 'ulmonroe',
  appstate: 'appalachianst', southernmississippi: 'southernmiss', fiu: 'floridainternational', utsa: 'utsa', sanjosest: 'sanjosest', hawaii: 'hawaii', ncstate: 'ncstate', northcarolinast: 'ncstate', miamiohio: 'miamioh', sam: 'samhouston', samhoustonst: 'samhouston' };
export function norm(x) {
  let n = String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, 'and').replace(/\bstate\b/g, 'st').replace(/\buniversity\b/g, '').replace(/[^a-z]/g, '');
  return ALIAS[n] || n;
}

// ---------- CSV (Google Sheets gviz export quotes every cell)
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const num = (x) => { const v = parseFloat(String(x).replace(/[%,]/g, '')); return Number.isFinite(v) ? v : null; };

// Connelly's weekly tab: game projections on the left, the full FBS SP+ table on the right.
// An unknown tab name quietly returns the first tab, so the header is checked.
export function parseSpx(csv) {
  const rows = parseCsv(csv);
  const hd = rows[0] || [];
  if (hd.indexOf('Proj. margin') === -1 || hd.indexOf('SP+') === -1) return null;
  const col = (name, from = 0) => hd.indexOf(name, from);
  const g = { game: col('Game'), win: col('Proj. winner'), mar: col('Proj. margin'), wp: col('Win prob.'), score: col('Proj. score (rounded)'), spread: col('Spread'), ats: col('ATS Pick'), ou: col('O/U'), oup: col('O/U pick'), oud: col('O/U diff') };
  const t0 = col('Team');
  const games = [], teams = {};
  for (const r of rows.slice(1)) {
    const txt = r[g.game] || '';
    const m = /^(.*?) (at|vs\.?) (.*)$/.exec(txt);
    if (m) {
      const away = m[1].trim(), home = m[3].trim(), winner = (r[g.win] || '').trim();
      const mar = num(r[g.mar]), ou = num(r[g.ou]), oud = num(r[g.oud]);
      if (mar != null) {
        const sc = /(\d+)\s*-\s*(\d+)/.exec(r[g.score] || '');
        const hi = sc ? Math.max(+sc[1], +sc[2]) : null, lo = sc ? Math.min(+sc[1], +sc[2]) : null;
        const homeWins = norm(winner) === norm(home);
        games.push({ away, home, neutral: m[2] !== 'at', m: homeWins ? mar : -mar, wpWin: num(r[g.wp]), winner,
          hs: sc ? (homeWins ? hi : lo) : null, as: sc ? (homeWins ? lo : hi) : null,
          total: ou != null && oud != null ? Math.round((ou + oud) * 10) / 10 : null, ats: (r[g.ats] || '').trim() || null, ou: (r[g.oup] || '').trim() || null, spread: (r[g.spread] || '').trim() || null });
      }
    }
    const team = t0 >= 0 ? (r[t0] || '').trim() : '';
    if (team) {
      teams[team] = { conf: r[t0 + 1] || '', rec: r[t0 + 2] || '', r: num(r[t0 + 3]), rk: num(r[t0 + 4]), off: num(r[t0 + 5]), offRk: num(r[t0 + 6]),
        def: num(r[t0 + 7]), defRk: num(r[t0 + 8]), st: num(r[t0 + 9]), stRk: num(r[t0 + 10]), lw: num(r[t0 + 11]) };
    }
  }
  return { games, teams };
}

async function getSpx(week) {
  for (let n = week + 2; n >= Math.max(0, week - 3); n--) {
    const url = `https://docs.google.com/spreadsheets/d/${SPX_SHEET}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('FBS Week ' + n)}`;
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) continue;
      const got = parseSpx(await r.text());
      if (got && got.games.length) return { week: n, ...got };
    } catch {}
  }
  return null;
}

// Sasser's board is server-rendered: one <article> per game, keyed by the ESPN game id, away team first.
export function parseSasser(html) {
  const out = {};
  const text = (s) => s.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/−/g, '-').trim();
  for (const art of html.split(/<article\b/).slice(1)) {
    const id = /aria-labelledby="(\d+)-title"/.exec(art);
    if (!id) continue;
    const title = /id="\d+-title"[^>]*>([\s\S]*?)<\/h3>/.exec(art);
    const rows = art.split(/class="_teamRow_/).slice(1);
    if (rows.length < 2) continue;
    const team = (r) => { const m = /_teamNameLine_[^"]*"[^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>/.exec(r); return m ? text(m[1]) : null; };
    const score = (r) => { const m = /_scoreBlock_[\s\S]*?<strong>([\s\S]*?)<\/strong>/.exec(r); return m ? num(text(m[1])) : null; };
    const dd = (label) => { const m = new RegExp('<dt>' + label + '</dt><dd>([\\s\\S]*?)</dd>').exec(art); return m ? text(m[1]) : null; };
    const pick = /_pickSelections_[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(art);
    const as = score(rows[0]), hs = score(rows[1]);
    if (as == null || hs == null) continue;
    out[id[1]] = { a: team(rows[0]), h: team(rows[1]), as, hs, m: Math.round((hs - as) * 10) / 10, total: Math.round((hs + as) * 10) / 10,
      line: num(dd('Proj. Line')), cur: dd('Current'), pick: pick ? text(pick[1].replace(/<\/strong>\s*<strong>/g, ' · ')) : null,
      neutral: title ? / vs\.? /i.test(text(title[1])) : false, url: 'https://davidsasser.com/cfb/matchups/' + id[1] };
  }
  return out;
}

async function getSasser() {
  try {
    const r = await fetch(SASSER_URL, { headers: UA });
    if (!r.ok) throw new Error(r.status);
    return parseSasser(await r.text());
  } catch (e) { console.log('Sasser board unavailable:', e.message); return {}; }
}

// ---------- matchup chart: CFBD advanced stats as 0-100 percentiles among FBS teams (garbage time excluded)
// [key, label, offense stat, higher offense value is better?]. Defense is the same stat, the other way round.
export const CATS = [
  ['eff', 'Efficiency', (s) => s.ppa, true],
  ['sr', 'Success rate', (s) => s.successRate, true],
  ['pass', 'Passing', (s) => s.passingPlays && s.passingPlays.ppa, true],
  ['rush', 'Rushing', (s) => s.rushingPlays && s.rushingPlays.ppa, true],
  ['expl', 'Explosiveness', (s) => s.explosiveness, true],
  ['havoc', 'Havoc', (s) => s.havoc && s.havoc.total, false],
  ['finish', 'Finishing drives', (s) => s.pointsPerOpportunity, true]
];
export function percentiles(adv, fbs, gamesPlayed) {
  const rows = (adv || []).filter((r) => r.team && r.offense && r.defense && (!fbs || fbs.has(r.team)));
  const rank = (vals, higherBetter) => {
    const sorted = vals.filter((v) => v != null).sort((a, b) => a - b);
    return (v) => {
      if (v == null || !sorted.length) return null;
      let lo = 0; while (lo < sorted.length && sorted[lo] < v) lo++;
      let hi = lo; while (hi < sorted.length && sorted[hi] === v) hi++;
      const p = ((lo + hi) / 2) / sorted.length * 100;
      return Math.round((higherBetter ? p : 100 - p) * 10) / 10;
    };
  };
  const out = {};
  for (const [k, , f, up] of CATS) {
    const ro = rank(rows.map((r) => f(r.offense)), up), rd = rank(rows.map((r) => f(r.defense)), !up);
    for (const r of rows) {
      const t = (out[r.team] = out[r.team] || { o: {}, d: {}, raw: {} });
      t.o[k] = ro(f(r.offense)); t.d[k] = rd(f(r.defense));
      t.raw[k] = [f(r.offense), f(r.defense)].map((v) => (v == null ? null : Math.round(v * 1000) / 1000));
    }
  }
  // Pace: offensive plays per game (faster = higher). Not better or worse, just style.
  const pace = rows.map((r) => (gamesPlayed[r.team] ? r.offense.plays / gamesPlayed[r.team] : null));
  const rp = rank(pace, true);
  rows.forEach((r, i) => { out[r.team].pace = rp(pace[i]); out[r.team].raw.pace = pace[i] == null ? null : Math.round(pace[i] * 10) / 10; });
  return out;
}

export function project(game, src, week) {
  const w = { ...WEIGHTS, srs: WEIGHTS.srs * Math.min(1, Math.max(0, (week - 1) / 5)) };
  let num = 0, den = 0;
  const parts = {};
  for (const k of Object.keys(w)) {
    const h = src[k] && src[k][game.homeTeam], a = src[k] && src[k][game.awayTeam];
    if (h == null || a == null || !w[k]) continue;
    parts[k] = round(h - a);
    num += (h - a) * w[k]; den += w[k];
  }
  // Needs both teams in at least two systems (FCS teams usually aren't), or there's no projection.
  if (Object.keys(parts).length < 2) return null;
  const hfa = game.neutralSite ? 0 : HFA;
  const margin = num / den + hfa;
  return { m: round(margin), pH: round(phi(margin / SD), 3), parts, hfa };
}

// CFBD: games, four rating systems and advanced stats, saved so the 2-hour refresh doesn't spend API calls.
async function loadCfbd(now, year) {
  let cache = null;
  try { cache = JSON.parse(await readFile(CACHE, 'utf8')); } catch {}
  const fresh = cache && cache.year === year && now - new Date(cache.fetchedAt).getTime() < CFBD_EVERY_H * 36e5;
  if (fresh && !process.env.CFBD_FORCE) return cache;
  if (!KEY) { if (cache) console.log('Model: no CFBD_API_KEY, using the saved CFBD copy.'); return cache; }
  try {
    const [games, post, sp, fpi, srs, elo, adv] = await Promise.all([
      cfbd(`/games?year=${year}&seasonType=regular&classification=fbs`),
      new Date(now).getUTCMonth() >= 10 || new Date(now).getUTCMonth() < 1 ? cfbd(`/games?year=${year}&seasonType=postseason&classification=fbs`).catch(() => []) : [],
      cfbd(`/ratings/sp?year=${year}`),
      cfbd(`/ratings/fpi?year=${year}`).catch(() => []),
      cfbd(`/ratings/srs?year=${year}`).catch(() => []),
      cfbd(`/ratings/elo?year=${year}`).catch(() => []),
      cfbd(`/stats/season/advanced?year=${year}&excludeGarbageTime=true`).catch((e) => { console.log('Advanced stats unavailable:', e.message); return []; })
    ]);
    const all = [...games, ...post].map((g) => ({ id: g.id, week: g.week, startDate: g.startDate, completed: !!g.completed, neutralSite: !!g.neutralSite, homeTeam: g.homeTeam, awayTeam: g.awayTeam }));
    const fbs = new Set(sp.map((r) => r.team));
    const played = {};
    for (const g of all) if (g.completed) { played[g.homeTeam] = (played[g.homeTeam] || 0) + 1; played[g.awayTeam] = (played[g.awayTeam] || 0) + 1; }
    cache = {
      fetchedAt: new Date(now).toISOString(), year, games: all,
      src: { sp: toPoints(sp, 'rating'), fpi: toPoints(fpi, 'fpi'), srs: toPoints(srs, 'rating'), elo: toPoints(elo, 'elo', ELO_PER_PT, true) },
      spRows: sp.map((c) => ({ team: c.team, r: round(c.rating), rk: c.ranking, off: c.offense && round(c.offense.rating), offRk: c.offense && c.offense.ranking, def: c.defense && round(c.defense.rating), defRk: c.defense && c.defense.ranking, st: c.specialTeams && round(c.specialTeams.rating), conf: c.conference })),
      pct: percentiles(adv, fbs, played)
    };
    for (const k of Object.keys(cache.src)) for (const t of Object.keys(cache.src[k])) cache.src[k][t] = round(cache.src[k][t], 2);
    await writeFile(CACHE, JSON.stringify(cache));
    console.log('Model: CFBD refreshed (' + all.length + ' games).');
  } catch (e) {
    console.log('Model: CFBD unavailable (' + e.message + '), using the saved copy.');
  }
  return cache;
}

export async function main() {
  const nowD = new Date(), now = nowD.getTime();
  const year = nowD.getUTCMonth() < 1 ? nowD.getUTCFullYear() - 1 : nowD.getUTCFullYear(); // January bowls count as last season
  let prev = {}, prevNfl = {};
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  try { prevNfl = JSON.parse(await readFile(NFL_OUT, 'utf8')); } catch {}
  const cf = await loadCfbd(now, year);
  if (!cf) { console.log('Model: no CFBD data yet (add the CFBD_API_KEY secret), skipping college.'); }
  const all = cf ? cf.games : [];
  const src = cf ? cf.src : { sp: {}, fpi: {}, srs: {}, elo: {} };
  const soon = now + 8 * 864e5;
  const upcoming = all.filter((g) => !g.completed && g.startDate && new Date(g.startDate).getTime() > now - 6 * 36e5 && new Date(g.startDate).getTime() < soon);
  const week = upcoming.length ? Math.min(...upcoming.map((g) => g.week || 1)) : 1;
  const [spx, ds, samCf, samNfl] = await Promise.all([
    upcoming.length ? getSpx(week) : null,
    upcoming.length ? getSasser() : {},
    getSam('ncaaf', prev.samBoard).catch((e) => { console.log('Sam (college) unavailable:', e.message); return prev.samBoard || null; }),
    getSam('nfl', prevNfl.sam).catch((e) => { console.log('Sam (NFL) unavailable:', e.message); return prevNfl.sam || null; })
  ]);
  // Sam's NFL board goes to its own file; the browser matches it to games by team abbreviations.
  if (samNfl) await writeFile(NFL_OUT, JSON.stringify({ updated: nowD.toISOString(), sam: samNfl }));
  if (!cf) return;

  // Connelly's games, matched to CFBD games by team names (either orientation, for neutral sites)
  const spxBy = {};
  for (const x of (spx && spx.games) || []) spxBy[norm(x.away) + '|' + norm(x.home)] = x;
  const spxFor = (g) => {
    const x = spxBy[norm(g.awayTeam) + '|' + norm(g.homeTeam)];
    if (x) return x;
    const y = spxBy[norm(g.homeTeam) + '|' + norm(g.awayTeam)];
    return y ? { ...y, m: -y.m, hs: y.as, as: y.hs } : null;
  };
  const samG = (samCf && samCf.games) || {};

  const out = {}, used = {};
  for (const g of upcoming) {
    const own = project(g, src, g.week || week);
    const x = spxFor(g), d = ds[g.id], sm = samG[g.id];
    // Sam lists the away team first; flip if his names come out the other way round
    let smM = sm && sm.m != null ? sm.m : null;
    if (sm && smM != null && norm(sm.h) === norm(g.awayTeam) && norm(sm.a) === norm(g.homeTeam)) smM = -smM;
    const parts = {};
    if (own) parts.own = own.m;
    if (x) parts.spx = x.m;
    if (d && d.m != null) parts.ds = d.m;
    if (smM != null) parts.sam = smM;
    const ks = Object.keys(parts);
    if (!ks.length) continue;
    const den = ks.reduce((a, k) => a + BLEND[k], 0);
    const m = ks.reduce((a, k) => a + parts[k] * BLEND[k], 0) / den;
    const totals = [x && x.total, d && d.total, sm && sm.as != null && sm.hs != null ? round(sm.as + sm.hs) : null].filter((v) => v != null);
    out[g.id] = {
      h: g.homeTeam, a: g.awayTeam, n: !!g.neutralSite, kick: g.startDate,
      m: round(m), pH: round(phi(m / SD), 3), t: totals.length ? round(totals.reduce((a, b) => a + b, 0) / totals.length) : null,
      own: own ? { m: own.m, parts: own.parts } : null,
      spx: x ? { m: round(x.m), wp: x.wpWin, winner: x.winner, hs: x.hs, as: x.as, total: x.total, ats: x.ats, ou: x.ou } : null,
      ds: d ? { m: d.m, hs: d.hs, as: d.as, total: d.total, pick: d.pick, url: d.url } : null,
      sam: sm ? { m: smM, hs: sm.hs, as: sm.as, total: sm.as != null && sm.hs != null ? round(sm.as + sm.hs) : null, line: sm.modelLine, pick: sm.pick, number: sm.number, bars: sm.bars, season: sm.season, url: sm.url } : null
    };
    used[g.homeTeam] = used[g.awayTeam] = 1;
  }

  // Team cards for the matchup view: SP+ table (Connelly's sheet, else CFBD) and chart percentiles.
  const pct = cf.pct || {};
  const spxTeams = {};
  for (const [name, t] of Object.entries((spx && spx.teams) || {})) spxTeams[norm(name)] = t;
  const spRow = Object.fromEntries((cf.spRows || []).map((r) => [r.team, r]));
  const teams = {};
  for (const name of Object.keys(used)) {
    const t = spxTeams[norm(name)], c = spRow[name];
    const spCard = t ? { r: t.r, rk: t.rk, off: t.off, offRk: t.offRk, def: t.def, defRk: t.defRk, st: t.st, stRk: t.stRk, rec: t.rec, conf: t.conf } : c ? { ...c } : null;
    teams[name] = { sp: spCard, pct: pct[name] || null, fpi: src.fpi[name] != null ? round(src.fpi[name]) : null, elo: src.elo[name] != null ? round(src.elo[name]) : null };
  }

  // Keep projections for games already kicked off (up to 3 days), so the tracker can grade the model later.
  for (const [id, p] of Object.entries(prev.games || {})) if (!out[id] && p.kick && new Date(p.kick).getTime() > now - 3 * 864e5) out[id] = p;
  for (const [name, t] of Object.entries(prev.teams || {})) if (!teams[name]) teams[name] = t;
  const counts = Object.fromEntries(Object.entries(src).map(([k, v]) => [k, Object.keys(v).length]));
  counts.spx = spx ? spx.games.length : 0; counts.ds = Object.keys(ds).length; counts.sam = Object.keys(samG).length; counts.chart = Object.keys(pct).length;
  const live = Object.values(out).filter((g) => upcoming.some((u) => u.startDate === g.kick && u.homeTeam === g.h));
  const matched = { spx: live.filter((g) => g.spx).length, ds: live.filter((g) => g.ds).length, sam: live.filter((g) => g.sam).length };
  // samBoard keeps Sam's stamp and game details so the next run only re-reads his game pages when he updates
  await writeFile(OUT, JSON.stringify({ updated: nowD.toISOString(), cfbdAt: cf.fetchedAt, year, week, spxWeek: spx ? spx.week : null, hfa: HFA, sd: SD, blend: BLEND,
    sources: counts, matched, cats: CATS.map((c) => [c[0], c[1]]), games: out, teams,
    samBoard: samCf ? { stamp: samCf.stamp, games: Object.fromEntries(Object.entries(samCf.games).map(([k, v]) => [k, { number: v.number, bars: v.bars, season: v.season }])) } : null }));
  console.log(`Model: week ${week}, ${Object.keys(out).length} games projected. Sources: ${JSON.stringify(counts)}. Matched: ${JSON.stringify(matched)}. Sam pages read: ${samCf ? samCf.pagesRead : 0} college, ${samNfl ? samNfl.pagesRead : 0} NFL.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('Model failed:', e.message); process.exit(1); });

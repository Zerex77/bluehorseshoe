// NFL team identity from nflverse play-by-play (free, on GitHub). Writes data/nfl-model.json.
// Same categories as the college matchup chart, built from every offensive snap this season, with
// garbage time removed (win probability under 5% or over 95%):
//   Efficiency (EPA per play), Success rate, Passing (EPA per dropback), Rushing (EPA per rush),
//   Explosiveness (share of plays gaining 20+ on a pass or 10+ on a run), Havoc (sacks, takeaways,
//   tackles for loss, passes defended), Finishing drives (points per trip inside the 40), Pace (plays a game).
// Plus a simple EPA power rating: (offense EPA/play - defense EPA/play allowed) x plays a game, in points
// against an average team, shrunk toward average early in the season (as if every team also played 8 average games). Shown on the matchup page; it doesn't change any picks.
// Runs from .github/workflows/model.yml. No key needed.
import { writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const OUT = process.env.NFL_MODEL_OUT || 'data/nfl-model.json';
export const HFA = 1.5; // NFL home field, points
const PLAYS = 62; // offensive plays a game, roughly, to turn EPA/play into points

export function parseCsvRows(text, want) {
  // nflverse quotes fields that contain commas (play descriptions). Only the wanted columns are kept.
  const lines = [];
  let i = 0, row = [], cell = '', q = false, header = null, idx = null;
  const flush = () => {
    if (!header) { header = row; idx = Object.fromEntries(want.map((w) => [w, header.indexOf(w)])); }
    else { const o = {}; for (const w of want) o[w] = idx[w] >= 0 ? row[idx[w]] : undefined; lines.push(o); }
    row = [];
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); cell = ''; flush(); }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); flush(); }
  return lines;
}

export const CATS = [['eff', 'Efficiency'], ['sr', 'Success rate'], ['pass', 'Passing'], ['rush', 'Rushing'], ['expl', 'Explosiveness'], ['havoc', 'Havoc'], ['finish', 'Finishing drives']];
const WANT = ['game_id', 'season_type', 'week', 'posteam', 'defteam', 'play_type', 'epa', 'success', 'yards_gained', 'yardline_100', 'wp', 'pass', 'rush',
  'sack', 'interception', 'fumble_lost', 'fumble_forced', 'tackled_for_loss', 'pass_defense_1_player_id', 'fixed_drive', 'fixed_drive_result', 'home_team', 'away_team'];

export function build(plays) {
  const T = {};
  const t = (k) => (T[k] = T[k] || { o: blank(), d: blank(), games: new Set() });
  function blank() { return { all: 0, n: 0, epa: 0, succ: 0, pn: 0, pepa: 0, rn: 0, repa: 0, expl: 0, havoc: 0, trips: {}, pts: 0, nTrips: 0 }; }
  const tripPts = (res) => (res === 'Touchdown' ? 7 : res === 'Field goal' ? 3 : 0);
  let week = 0;
  for (const p of plays) {
    if (p.season_type && p.season_type !== 'REG') continue;
    const off = p.posteam, def = p.defteam;
    if (!off || !def || off === 'NA') continue;
    if (p.game_id) { t(off).games.add(p.game_id); t(def).games.add(p.game_id); }
    week = Math.max(week, +p.week || 0);
    // drives that reach the opponent's 40 (counted even in garbage time; it's about cashing in)
    const yl = +p.yardline_100;
    if (p.fixed_drive && yl <= 40 && yl > 0) {
      const key = p.game_id + '|' + p.fixed_drive;
      for (const [team, side] of [[off, 'o'], [def, 'd']]) {
        const s = t(team)[side];
        if (!s.trips[key]) { s.trips[key] = 1; s.nTrips++; s.pts += tripPts(p.fixed_drive_result); }
      }
    }
    if (p.play_type !== 'pass' && p.play_type !== 'run') continue;
    t(off).o.all++;
    const wp = +p.wp;
    if (!(wp >= 0.05 && wp <= 0.95)) continue;
    const epa = +p.epa;
    if (!Number.isFinite(epa)) continue;
    const isPass = p.pass === '1', isRush = p.rush === '1' && !isPass;
    const yds = +p.yards_gained || 0;
    const big = (isPass && yds >= 20) || (isRush && yds >= 10) ? 1 : 0;
    const hv = (p.sack === '1' || p.interception === '1' || p.fumble_forced === '1' || p.tackled_for_loss === '1' || (p.pass_defense_1_player_id && p.pass_defense_1_player_id !== 'NA')) ? 1 : 0;
    for (const [team, side] of [[off, 'o'], [def, 'd']]) {
      const s = t(team)[side];
      s.n++; s.epa += epa; s.succ += p.success === '1' ? 1 : 0; s.expl += big; s.havoc += hv;
      if (isPass) { s.pn++; s.pepa += epa; }
      if (isRush) { s.rn++; s.repa += epa; }
    }
  }
  // per-team raw numbers [offense, defense]
  const raw = {};
  const offPlays = {};
  for (const [k, v] of Object.entries(T)) {
    const f = (s) => ({ eff: s.n ? s.epa / s.n : null, sr: s.n ? s.succ / s.n : null, pass: s.pn ? s.pepa / s.pn : null, rush: s.rn ? s.repa / s.rn : null,
      expl: s.n ? s.expl / s.n : null, havoc: s.n ? s.havoc / s.n : null, finish: s.nTrips ? s.pts / s.nTrips : null });
    const o = f(v.o), d = f(v.d);
    raw[k] = Object.fromEntries(CATS.map(([c]) => [c, [o[c], d[c]]]));
    offPlays[k] = v.games.size ? v.o.all / v.games.size : null;
  }
  const teams = Object.keys(raw);
  const pctl = (vals, higherBetter) => {
    const sorted = vals.filter((x) => x != null).sort((a, b) => a - b);
    return (x) => {
      if (x == null || !sorted.length) return null;
      let lo = 0; while (lo < sorted.length && sorted[lo] < x) lo++;
      let hi = lo; while (hi < sorted.length && sorted[hi] === x) hi++;
      const p = ((lo + hi) / 2) / sorted.length * 100;
      return Math.round((higherBetter ? p : 100 - p) * 10) / 10;
    };
  };
  const out = {};
  for (const k of teams) out[k] = { pct: { o: {}, d: {}, raw: {} }, games: T[k].games.size };
  for (const [c] of CATS) {
    const offUp = c !== 'havoc'; // offense: higher is better except havoc allowed
    const po = pctl(teams.map((k) => raw[k][c][0]), offUp), pd = pctl(teams.map((k) => raw[k][c][1]), !offUp);
    for (const k of teams) {
      out[k].pct.o[c] = po(raw[k][c][0]); out[k].pct.d[c] = pd(raw[k][c][1]);
      out[k].pct.raw[c] = raw[k][c].map((x) => (x == null ? null : Math.round(x * 1000) / 1000));
    }
  }
  const pp = pctl(teams.map((k) => offPlays[k]), true);
  for (const k of teams) { out[k].pct.pace = pp(offPlays[k]); out[k].pct.raw.pace = offPlays[k] == null ? null : Math.round(offPlays[k] * 10) / 10; }
  // EPA power rating, plus ranks for the ratings table
  for (const k of teams) {
    const [oe, de] = raw[k].eff;
    out[k].offEpa = oe == null ? null : Math.round(oe * 1000) / 1000;
    out[k].defEpa = de == null ? null : Math.round(de * 1000) / 1000;
    // early-season shrink: counts as if every team also played 8 average games (the NFL market leans on priors)
    const g = out[k].games;
    out[k].rating = oe == null || de == null ? null : Math.round((oe - de) * PLAYS * (g / (g + 8)) * 10) / 10;
  }
  const rankBy = (key, desc) => { teams.filter((k) => out[k][key] != null).sort((a, b) => (desc ? out[b][key] - out[a][key] : out[a][key] - out[b][key])).forEach((k, i) => { out[k][key + 'Rk'] = i + 1; }); };
  rankBy('rating', true); rankBy('offEpa', true); rankBy('defEpa', false);
  return { week, teams: out };
}

export async function main() {
  const now = new Date();
  const season = now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear(); // Jan-Feb belong to last season
  const url = process.env.NFL_PBP_URL || `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${season}.csv.gz`;
  let buf;
  if (process.env.NFL_PBP_FILE) buf = (await import('node:fs')).readFileSync(process.env.NFL_PBP_FILE);
  else {
    const r = await fetch(url, { headers: { 'user-agent': 'blue-horseshoe/1.0' } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    buf = Buffer.from(await r.arrayBuffer());
  }
  const plays = parseCsvRows(gunzipSync(buf).toString('utf8'), WANT);
  const { week, teams } = build(plays);
  await writeFile(OUT, JSON.stringify({ updated: now.toISOString(), season, week, hfa: HFA, plays: PLAYS, cats: CATS, source: 'nflverse play-by-play', teams }));
  console.log(`NFL model: through week ${week}, ${plays.length} plays, ${Object.keys(teams).length} teams.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('NFL model failed:', e.message); process.exit(1); });

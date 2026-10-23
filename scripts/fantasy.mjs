// Fantasy data for the Fantasy tab. Writes data/fantasy.json. Runs every 12 hours from the refresh loop.
//  - nflverse weekly player stats (free, GitHub): fantasy points (PPR, half, standard), usage, trends
//  - nflverse snap counts: share of offensive snaps
//  - Sleeper's player database (free, no key; Sleeper asks for at most one pull a day): Sleeper, ESPN and Yahoo ids,
//    injury status and team for every player, so leagues on any of those sites can be matched to these stats
// Defense vs position comes from the same stats: fantasy points each defense allows per game to QBs, RBs, WRs and TEs.
// Kickers and team defenses are scored from the same files with standard Sleeper scoring.
import { readFile, writeFile } from 'node:fs/promises';
import { parseCsvRows } from './nfl-model.mjs';

const OUT = process.env.FANTASY_OUT || 'data/fantasy.json';
const UA = { 'user-agent': 'blue-horseshoe/1.0 (+https://bluehorseshoebet.com)' };
const POS = ['QB', 'RB', 'WR', 'TE', 'K'];
// one team code everywhere: nflverse style (LA, WAS, JAX)
export const team = (t) => ({ LAR: 'LA', WSH: 'WAS', JAC: 'JAX', OAK: 'LV', SD: 'LAC', STL: 'LA' })[t] || t;
const nameKey = (n) => String(n || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

async function getText(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.text();
}

const STAT_COLS = ['player_id', 'player_display_name', 'position', 'season_type', 'week', 'team', 'opponent_team',
  'completions', 'attempts', 'passing_yards', 'passing_tds', 'passing_interceptions', 'sacks_suffered',
  'carries', 'rushing_yards', 'rushing_tds', 'receptions', 'targets', 'receiving_yards', 'receiving_tds', 'target_share', 'air_yards_share', 'wopr',
  'rushing_fumbles_lost', 'receiving_fumbles_lost', 'sack_fumbles_lost', 'passing_2pt_conversions', 'rushing_2pt_conversions', 'receiving_2pt_conversions',
  'fg_made_0_19', 'fg_made_20_29', 'fg_made_30_39', 'fg_made_40_49', 'fg_made_50_59', 'fg_made_60_', 'fg_missed', 'pat_made', 'pat_missed',
  'def_sacks', 'def_interceptions', 'fumble_recovery_opp', 'def_tds', 'def_safeties', 'special_teams_tds',
  'fantasy_points', 'fantasy_points_ppr'];
const n0 = (v) => { const x = +v; return Number.isFinite(x) ? x : 0; };

// Sleeper standard kicker scoring
const kPts = (r) => n0(r.fg_made_0_19) * 3 + n0(r.fg_made_20_29) * 3 + n0(r.fg_made_30_39) * 3 + n0(r.fg_made_40_49) * 4 + (n0(r.fg_made_50_59) + n0(r.fg_made_60_)) * 5 + n0(r.pat_made) - n0(r.fg_missed) - n0(r.pat_missed);
// Sleeper standard team-defense scoring, without the points-allowed tier (added below from opponents' points)
const dPts = (r) => n0(r.def_sacks) + n0(r.def_interceptions) * 2 + n0(r.fumble_recovery_opp) * 2 + n0(r.def_tds) * 6 + n0(r.def_safeties) * 2 + n0(r.special_teams_tds) * 6;
const paTier = (pa) => (pa === 0 ? 10 : pa <= 6 ? 7 : pa <= 13 ? 4 : pa <= 20 ? 1 : pa <= 27 ? 0 : pa <= 34 ? -1 : -4);

export function build(statsCsv, snapsCsv, sleeper) {
  const rows = parseCsvRows(statsCsv, STAT_COLS).filter((r) => (r.season_type || 'REG') === 'REG');
  const snaps = snapsCsv ? parseCsvRows(snapsCsv, ['week', 'game_type', 'player', 'position', 'team', 'offense_pct']).filter((r) => (r.game_type || 'REG') === 'REG') : [];
  const snapBy = {};
  for (const s of snaps) { const k = nameKey(s.player) + '|' + team(s.team); (snapBy[k] = snapBy[k] || {})[+s.week] = n0(s.offense_pct); }
  let lastWeek = 0;
  const P = {}, teamPts = {}, teamGames = {}, defRows = {};
  for (const r of rows) {
    const wk = +r.week; lastWeek = Math.max(lastWeek, wk);
    const tm = team(r.team), opp = team(r.opponent_team);
    teamGames[tm + '|' + wk] = opp;
    // team defense: a row per player, summed by team and week
    const dk = tm + '|' + wk;
    defRows[dk] = (defRows[dk] || 0) + dPts(r);
    // offensive points scored (TDs, 2pt, kicking) to grade defenses' points allowed
    // points this team scored (offensive, return and defensive TDs, 2-pt tries, kicks), to grade the other side's defense
    teamPts[dk] = (teamPts[dk] || 0) + (n0(r.rushing_tds) + n0(r.receiving_tds) + n0(r.special_teams_tds) + n0(r.def_tds)) * 6
      + (n0(r.rushing_2pt_conversions) + n0(r.receiving_2pt_conversions)) * 2 + n0(r.def_safeties) * 2
      + (n0(r.fg_made_0_19) + n0(r.fg_made_20_29) + n0(r.fg_made_30_39) + n0(r.fg_made_40_49) + n0(r.fg_made_50_59) + n0(r.fg_made_60_)) * 3 + n0(r.pat_made);
    const pos = r.position;
    if (!r.player_id || !POS.includes(pos)) continue;
    const p = (P[r.player_id] = P[r.player_id] || { id: r.player_id, n: r.player_display_name, pos, tm, wk: {}, opp: {}, s: {} });
    p.tm = tm; // latest team
    const ppr = pos === 'K' ? kPts(r) : n0(r.fantasy_points_ppr), std = pos === 'K' ? kPts(r) : n0(r.fantasy_points);
    p.wk[wk] = { ppr: r1(ppr), half: r1((ppr + std) / 2), std: r1(std) };
    p.opp[wk] = opp;
    const a = p.s;
    for (const c of ['completions', 'attempts', 'passing_yards', 'passing_tds', 'passing_interceptions', 'carries', 'rushing_yards', 'rushing_tds', 'receptions', 'targets', 'receiving_yards', 'receiving_tds'])
      a[c] = (a[c] || 0) + n0(r[c]);
    for (const c of ['target_share', 'air_yards_share', 'wopr']) if (r[c] !== '' && r[c] != null && r[c] !== 'NA') { (a[c + '_l'] = a[c + '_l'] || []).push([wk, n0(r[c])]); }
  }
  // points allowed by each defense, from the other team's offense
  const ptsAllowed = {};
  for (const [k, opp] of Object.entries(teamGames)) { const wk = k.split('|')[1]; ptsAllowed[k] = teamPts[opp + '|' + wk]; }

  // defense vs position: fantasy points (PPR) allowed per game to each position
  const dvpSum = {}, dvpGames = {};
  for (const p of Object.values(P)) {
    if (p.pos === 'K') continue;
    for (const [wk, pts] of Object.entries(p.wk)) {
      const d = p.opp[wk]; if (!d) continue;
      const k = d + '|' + p.pos; dvpSum[k] = (dvpSum[k] || 0) + pts.ppr;
      (dvpGames[d] = dvpGames[d] || new Set()).add(wk);
    }
  }
  const teams = Object.keys(dvpGames);
  const dvp = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const vals = teams.map((t) => [t, (dvpSum[t + '|' + pos] || 0) / dvpGames[t].size]);
    const avg = vals.reduce((x, v) => x + v[1], 0) / (vals.length || 1);
    vals.sort((a, b) => a[1] - b[1]).forEach(([t, v], i) => {
      (dvp[t] = dvp[t] || {})[pos] = { pg: r1(v), rk: i + 1, f: r3(avg ? v / avg : 1) }; // rk 1 = allows the fewest (toughest)
    });
    dvp._avg = dvp._avg || {}; dvp._avg[pos] = r1(avg);
  }

  // per-player summary
  const out = {};
  const wkList = (p, key) => Object.keys(p.wk).map(Number).sort((a, b) => a - b).map((w) => [w, p.wk[w][key], p.opp[w]]);
  for (const p of Object.values(P)) {
    const ws = Object.keys(p.wk).map(Number).sort((a, b) => a - b);
    const g = ws.length; if (!g) continue;
    const pts = ws.map((w) => p.wk[w].ppr), last3 = ws.slice(-3).map((w) => p.wk[w].ppr);
    const avg = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : null);
    const share = (c) => { const l = (p.s[c + '_l'] || []).slice(-3); return l.length ? r3(avg(l.map((x) => x[1]))) : null; };
    const sb = snapBy[nameKey(p.n) + '|' + p.tm] || {};
    const snapWs = Object.keys(sb).map(Number).sort((a, b) => a - b).slice(-3);
    const sd = Math.sqrt(avg(pts.map((x) => (x - avg(pts)) ** 2)) || 0);
    out[p.id] = {
      n: p.n, pos: p.pos, tm: p.tm, g,
      ppg: r1(avg(pts)), half: r1(avg(ws.map((w) => p.wk[w].half))), std: r1(avg(ws.map((w) => p.wk[w].std))), l3: r1(avg(last3)), sd: r1(sd),
      wk: wkList(p, 'ppr'),
      u: { tgt: r1(p.s.targets / g), rec: r1(p.s.receptions / g), car: r1(p.s.carries / g), ry: r1(p.s.rushing_yards / g), rcy: r1(p.s.receiving_yards / g), py: r1(p.s.passing_yards / g),
        ptd: p.s.passing_tds || 0, rtd: p.s.rushing_tds || 0, rctd: p.s.receiving_tds || 0, int: p.s.passing_interceptions || 0,
        ts: share('target_share'), ays: share('air_yards_share'), wopr: share('wopr'), snap: snapWs.length ? r3(avg(snapWs.map((w) => sb[w]))) : null }
    };
  }
  // team defenses (Sleeper DEF): turnovers, sacks, TDs plus the points-allowed tier
  const dst = {};
  for (const k of Object.keys(teamGames)) {
    const [tm, wk] = k.split('|');
    const pts = r1((defRows[k] || 0) + paTier(ptsAllowed[k] == null ? 21 : ptsAllowed[k]));
    (dst[tm] = dst[tm] || []).push([+wk, pts, teamGames[k]]);
  }
  for (const [tm, list] of Object.entries(dst)) {
    list.sort((a, b) => a[0] - b[0]);
    const pts = list.map((x) => x[1]);
    out['DEF_' + tm] = { n: tm + ' D/ST', pos: 'DEF', tm, g: list.length, ppg: r1(pts.reduce((a, b) => a + b, 0) / pts.length), l3: r1(pts.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, pts.length)), wk: list, u: {} };
  }

  // Sleeper ids (and ESPN / Yahoo ids, injury status) for matching leagues
  const sl = {}, byGsis = {};
  for (const [id, x] of Object.entries(sleeper || {})) {
    if (!x) continue;
    const pos = x.position;
    if (pos === 'DEF') { const tm = team(id); if (out['DEF_' + tm]) { sl[id] = 'DEF_' + tm; } continue; }
    if (!POS.includes(pos)) continue;
    let key = x.gsis_id && out[String(x.gsis_id).trim()] ? String(x.gsis_id).trim() : null;
    if (!key) { // fall back to name + team
      const want = nameKey(x.full_name || (x.first_name + ' ' + x.last_name)), tm = team(x.team || '');
      key = Object.keys(out).find((k) => out[k].tm === tm && nameKey(out[k].n) === want) || null;
    }
    const info = { sl: id, espn: x.espn_id ? String(x.espn_id) : null, yahoo: x.yahoo_id ? String(x.yahoo_id) : null, inj: x.injury_status || null, injBody: x.injury_body_part || null, team: x.team ? team(x.team) : null, age: x.age || null, rank: x.search_rank || null };
    if (key) { Object.assign(out[key], { sl: id, espn: info.espn, yahoo: info.yahoo, inj: info.inj, injBody: info.injBody, age: info.age, tm: info.team || out[key].tm }); sl[id] = key; byGsis[key] = 1; }
    else if (x.active && x.team && (x.search_rank || 9999) < 600) {
      // on a roster but no stats yet (rookie, injured all year): keep a stub so league rosters still show them
      const stub = 'SL_' + id;
      out[stub] = { n: x.full_name || (x.first_name + ' ' + x.last_name), pos, tm: team(x.team), g: 0, ppg: null, l3: null, wk: [], u: {}, sl: id, espn: info.espn, yahoo: info.yahoo, inj: info.inj, injBody: info.injBody, age: info.age };
      sl[id] = stub;
    }
  }
  return { week: lastWeek, players: out, sleeper: sl, dvp };
}

export async function main() {
  const now = new Date();
  const season = now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const base = 'https://github.com/nflverse/nflverse-data/releases/download/';
  const [stats, snaps, sleeper] = await Promise.all([
    process.env.FF_STATS_FILE ? readFile(process.env.FF_STATS_FILE, 'utf8') : getText(`${base}stats_player/stats_player_week_${season}.csv`),
    (process.env.FF_SNAPS_FILE ? readFile(process.env.FF_SNAPS_FILE, 'utf8') : getText(`${base}snap_counts/snap_counts_${season}.csv`)).catch(() => null),
    (process.env.FF_SLEEPER_FILE ? readFile(process.env.FF_SLEEPER_FILE, 'utf8') : getText('https://api.sleeper.app/v1/players/nfl')).then((t) => JSON.parse(t)).catch((e) => { console.log('Sleeper players unavailable:', e.message); return null; })
  ]);
  let prevSleeper = null;
  if (!sleeper) { try { prevSleeper = JSON.parse(await readFile(OUT, 'utf8')).sleeper; } catch {} }
  const b = build(stats, snaps, sleeper || {});
  if (!sleeper && prevSleeper) b.sleeper = prevSleeper;
  await writeFile(OUT, JSON.stringify({ updated: now.toISOString(), season, ...b }));
  console.log(`Fantasy: through week ${b.week}, ${Object.keys(b.players).length} players, ${Object.keys(b.sleeper).length} Sleeper ids.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('Fantasy failed:', e.message); process.exit(1); });

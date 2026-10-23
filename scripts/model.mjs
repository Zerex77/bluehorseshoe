// Horseshoe Model: college power ratings from CollegeFootballData.com (CFBD), turned into a projected
// score margin for every FBS game in the next 8 days. Writes data/model.json. The site compares these
// projections to the live lines in the browser, so edges stay current as the lines move.
//
// Built from what the best entries in the CFBD Model Pick'em do:
//  - blend several rating systems instead of trusting one
//  - lean on ratings with a preseason prior (SP+, FPI) early, and let in-season-only ratings (SRS) count more as weeks go by
//  - add home field, nothing for neutral sites
//
// Runs once a day from .github/workflows/model.yml. Needs a free CFBD key in the repo secret CFBD_API_KEY.
// About 6 API calls a run, roughly 180 a month (the free tier allows 1,000).
import { writeFile, readFile } from 'node:fs/promises';

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

export async function main() {
  if (!KEY) { console.log('Model: no CFBD_API_KEY secret yet, skipping.'); return; }
  const now = new Date();
  const year = now.getUTCMonth() < 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear(); // January bowls count as last season
  const [games, post, sp, fpi, srs, elo] = await Promise.all([
    cfbd(`/games?year=${year}&seasonType=regular&classification=fbs`),
    now.getUTCMonth() >= 10 || now.getUTCMonth() < 1 ? cfbd(`/games?year=${year}&seasonType=postseason&classification=fbs`).catch(() => []) : [],
    cfbd(`/ratings/sp?year=${year}`),
    cfbd(`/ratings/fpi?year=${year}`).catch(() => []),
    cfbd(`/ratings/srs?year=${year}`).catch(() => []),
    cfbd(`/ratings/elo?year=${year}`).catch(() => [])
  ]);
  const src = {
    sp: toPoints(sp, 'rating'),
    fpi: toPoints(fpi, 'fpi'),
    srs: toPoints(srs, 'rating'),
    elo: toPoints(elo, 'elo', ELO_PER_PT, true)
  };
  const soon = now.getTime() + 8 * 864e5;
  const upcoming = [...games, ...post].filter((g) => !g.completed && g.startDate && new Date(g.startDate).getTime() > now.getTime() - 6 * 36e5 && new Date(g.startDate).getTime() < soon);
  const week = upcoming.length ? Math.min(...upcoming.map((g) => g.week || 1)) : 1;
  const out = {};
  for (const g of upcoming) {
    const p = project(g, src, g.week || week);
    if (p) out[g.id] = { h: g.homeTeam, a: g.awayTeam, n: !!g.neutralSite, ...p };
  }
  // Keep yesterday's projections for games already kicked off, so the tracker can grade the model later.
  let prev = {};
  try { prev = JSON.parse(await readFile(OUT, 'utf8')).games || {}; } catch {}
  for (const [id, p] of Object.entries(prev)) if (!out[id] && p.kick && new Date(p.kick).getTime() > now.getTime() - 3 * 864e5) out[id] = p;
  for (const g of upcoming) if (out[g.id]) out[g.id].kick = g.startDate;
  const counts = Object.fromEntries(Object.entries(src).map(([k, v]) => [k, Object.keys(v).length]));
  await writeFile(OUT, JSON.stringify({ updated: now.toISOString(), year, week, hfa: HFA, sd: SD, sources: counts, games: out }));
  console.log(`Model: week ${week}, ${Object.keys(out).length} games projected. Ratings loaded: ${JSON.stringify(counts)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error('Model failed:', e.message); process.exit(1); });

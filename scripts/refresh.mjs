// Runs in GitHub Actions. Writes data/espn-*.json (backup copies of ESPN's feeds),
// data/meta.json, and every 4 hours data/books.json from The Odds API.
import { readFile, writeFile } from 'node:fs/promises';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/';
const BOOKS_EVERY_MIN = 235; // ~4 hours (cron can run a few minutes late)
const BOOKMAKERS = ['hardrockbet_fl', 'draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'fanatics', 'betrivers', 'espnbet'];

const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replaceAll('-', '');

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'blue-horseshoe/1.0' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return { json: await r.json(), headers: r.headers };
}
async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}
// Keep backup files small: drop logos, links and other fields the site never reads.
function slim(scoreboard) {
  const team = (t) => t && ({ id: t.id, abbreviation: t.abbreviation, displayName: t.displayName, shortDisplayName: t.shortDisplayName, location: t.location, conferenceId: t.conferenceId });
  const side = (s) => s && ({ close: s.close && { line: s.close.line, odds: s.close.odds }, open: s.open && { line: s.open.line, odds: s.open.odds } });
  return {
    week: scoreboard.week && { number: scoreboard.week.number },
    events: (scoreboard.events || []).map((ev) => ({
      id: ev.id, date: ev.date, shortName: ev.shortName,
      status: { type: { state: ev.status?.type?.state } },
      competitions: (ev.competitions || []).slice(0, 1).map((c) => ({
        neutralSite: c.neutralSite,
        competitors: (c.competitors || []).map((x) => ({ homeAway: x.homeAway, curatedRank: x.curatedRank, team: team(x.team) })),
        odds: (c.odds || []).slice(0, 1).map((o) => ({
          provider: { name: o.provider?.name }, spread: o.spread, overUnder: o.overUnder,
          homeTeamOdds: { favorite: o.homeTeamOdds?.favorite },
          moneyline: o.moneyline && { home: side(o.moneyline.home), away: side(o.moneyline.away) },
          pointSpread: o.pointSpread && { home: side(o.pointSpread.home), away: side(o.pointSpread.away) },
          total: o.total && { over: side(o.total.over), under: side(o.total.under) }
        }))
      }))
    }))
  };
}
function slimInjuries(j) {
  return {
    injuries: (j.injuries || []).map((t) => ({
      displayName: t.displayName,
      injuries: (t.injuries || []).filter((i) => ['Out', 'Doubtful', 'Questionable'].includes(i.status)).map((i) => ({
        status: i.status,
        athlete: { displayName: i.athlete?.displayName, position: { abbreviation: i.athlete?.position?.abbreviation } },
        details: { type: i.details?.type, detail: i.details?.detail }
      }))
    }))
  };
}

async function espnBackup(meta) {
  const now = new Date();
  const [nfl, cfb, inj] = await Promise.allSettled([
    getJSON(ESPN + 'nfl/scoreboard'),
    (async () => {
      // ESPN rejects date ranges here, so pull each of the next 7 days.
      const days = await Promise.allSettled([...Array(7)].map((_, i) => getJSON(`${ESPN}college-football/scoreboard?groups=80&limit=300&dates=${ymd(new Date(now.getTime() + i * 864e5))}`)));
      const ok = days.filter((d) => d.status === 'fulfilled');
      if (!ok.length) throw days[0].reason;
      const seen = new Set(), events = [];
      for (const d of ok) for (const e of d.value.json.events || []) if (!seen.has(e.id)) { seen.add(e.id); events.push(e); }
      return { json: { events } };
    })(),
    getJSON(ESPN + 'nfl/injuries')
  ]);
  const errs = [];
  if (nfl.status === 'fulfilled') await writeFile('data/espn-nfl.json', JSON.stringify(slim(nfl.value.json))); else errs.push('nfl: ' + nfl.reason?.message);
  if (cfb.status === 'fulfilled') await writeFile('data/espn-cfb.json', JSON.stringify(slim(cfb.value.json))); else errs.push('cfb: ' + cfb.reason?.message);
  if (inj.status === 'fulfilled') await writeFile('data/espn-injuries.json', JSON.stringify(slimInjuries(inj.value.json))); else errs.push('injuries: ' + inj.reason?.message);
  meta.espnErrors = errs;
  if (nfl.status === 'fulfilled' || cfb.status === 'fulfilled') meta.espn = now.toISOString();
  console.log(`ESPN backup: ${nfl.value?.json.events?.length ?? 0} NFL, ${cfb.value?.json.events?.length ?? 0} college games`, errs);
}

async function oddsApi(meta) {
  const key = process.env.ODDS_API_KEY;
  if (!key) { console.log('No ODDS_API_KEY secret set; skipping Line check prices.'); return; }
  const books = await readJSON('data/books.json', { updated: null, games: [] });
  const age = books.updated ? (Date.now() - Date.parse(books.updated)) / 60000 : Infinity;
  if (age < BOOKS_EVERY_MIN) { console.log(`Book prices are ${Math.round(age)} min old; next pull after ${BOOKS_EVERY_MIN}.`); return; }
  const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds?apiKey=${key}&markets=spreads,totals&oddsFormat=american&bookmakers=${BOOKMAKERS.join(',')}`;
  const { json, headers } = await getJSON(url);
  const games = json.map((ev) => {
    const out = { away: ev.away_team, home: ev.home_team, commence: ev.commence_time, books: {} };
    for (const bk of ev.bookmakers || []) {
      const row = {};
      for (const m of bk.markets || []) {
        if (m.key === 'spreads') {
          const a = m.outcomes.find((o) => o.name === ev.away_team);
          if (a) row.spread = [a.point, a.price];
        } else if (m.key === 'totals') {
          const o = m.outcomes.find((x) => x.name === 'Over');
          if (o) row.total = [o.point, o.price];
        }
      }
      if (row.spread || row.total) out.books[bk.key] = row;
    }
    return out;
  });
  await writeFile('data/books.json', JSON.stringify({ updated: new Date().toISOString(), games }));
  meta.oddsRemaining = Number(headers.get('x-requests-remaining'));
  console.log(`Odds API: ${games.length} NFL games, ${meta.oddsRemaining} credits left this month`);
}

// ---------- SportsGameOdds (free plan: 2,500 events a month). NFL player props + alternate lines, every 6 hours.
const SGO_EVERY_MIN = 475; // ~8 hours
const SGO_MONTHLY_CAP = 2300; // stay under the 2,500 free events
const PREF_BOOKS = ['draftkings', 'fanduel', 'espnbet', 'betmgm', 'caesars', 'williamhill'];
const STAT = {
  passing_yards: ['pass', 'pass yds'], rushing_yards: ['rush', 'rush yds'], receiving_yards: ['rec', 'rec yds'],
  receptions: ['recp', 'receptions'], passing_touchdowns: ['td', 'pass TDs'], passing_completions: ['pass', 'completions'],
  passing_attempts: ['pass', 'pass attempts'], rushing_attempts: ['rush', 'rush attempts'], passing_interceptions: ['pass', 'interceptions thrown'],
  passing_longestCompletion: ['pass', 'longest completion'], rushing_longestRush: ['rush', 'longest rush'], receiving_longestReception: ['rec', 'longest reception'],
  rushing_receiving_yards: ['rush', 'rush + rec yds'], passing_rushing_yards: ['pass', 'pass + rush yds'], touchdowns: ['td', 'TDs'],
  defense_sacks: ['def', 'sacks'], defense_combinedTackles: ['def', 'tackles + assists'], kicking_totalPoints: ['kick', 'kicking points'],
  fieldGoals_made: ['kick', 'field goals made']
};
const num = (x) => (x == null || x === '' ? null : Number(String(x).replace('+', '')));
function bestBook(odd) {
  const bb = odd.byBookmaker || {};
  for (const k of PREF_BOOKS) if (bb[k] && bb[k].available !== false && bb[k].odds != null) return [k, bb[k]];
  return null;
}
function slimSgoEvent(ev) {
  const players = ev.players || {};
  const out = {
    home: ev.teams?.home?.names?.long, away: ev.teams?.away?.names?.long, startsAt: ev.status?.startsAt,
    props: [], alts: []
  };
  for (const odd of Object.values(ev.odds || {})) {
    if (odd.periodID !== 'game' || odd.cancelled) continue;
    const b = bestBook(odd);
    // Player props: over/under, plus anytime TD (yes side only)
    if (odd.playerID && (odd.betTypeID === 'ou' || (odd.betTypeID === 'yn' && odd.sideID === 'yes'))) {
      const st = STAT[odd.statID];
      if (!st) continue;
      const pl = players[odd.playerID] || {};
      const name = pl.name || [pl.firstName, pl.lastName].filter(Boolean).join(' ') || odd.playerID;
      const line = num(b ? b[1].overUnder : null) ?? num(odd.bookOverUnder);
      const price = num(b ? b[1].odds : null) ?? num(odd.bookOdds);
      if (price == null || (odd.betTypeID === 'ou' && line == null)) continue;
      // Every book's line and price on the main over, for the prop Line check
      let books;
      if (odd.betTypeID === 'ou' && odd.sideID === 'over') {
        books = {};
        for (const [bk, v] of Object.entries(odd.byBookmaker || {})) {
          const bl = num(v.overUnder), bo = num(v.odds);
          if (v.available !== false && bl != null && bo != null) books[bk] = [bl, bo];
        }
        if (Object.keys(books).length < 2) books = undefined;
      }
      out.props.push({
        player: name, team: pl.teamID || null, stat: odd.statID, c: st[0], what: st[1],
        side: odd.betTypeID === 'yn' ? 'yes' : odd.sideID, line, odds: price,
        fair: num(odd.fairOdds), book: b ? b[0] : 'consensus', books
      });
      // Alternate prop lines (overs only), used to feather big parlays
      if (b && odd.betTypeID === 'ou' && odd.sideID === 'over' && Array.isArray(b[1].altLines)) {
        for (const a of b[1].altLines) {
          if (a.available === false || a.odds == null || a.overUnder == null) continue;
          const al = num(a.overUnder), ao = num(a.odds);
          if (al == null || ao == null || al === line) continue;
          out.props.push({ player: name, team: pl.teamID || null, stat: odd.statID, c: st[0], what: st[1], side: 'over', line: al, odds: ao, fair: null, book: b[0], alt: true });
        }
      }
      continue;
    }
    // Alternate game lines (spreads + totals) from the preferred book
    if (odd.statID === 'points' && !odd.playerID && (odd.betTypeID === 'sp' || (odd.betTypeID === 'ou' && odd.statEntityID === 'all')) && b && Array.isArray(b[1].altLines)) {
      for (const a of b[1].altLines) {
        if (a.available === false || a.odds == null) continue;
        const line = odd.betTypeID === 'sp' ? num(a.spread) : num(a.overUnder);
        if (line == null) continue;
        out.alts.push({ type: odd.betTypeID, side: odd.sideID, entity: odd.statEntityID, line, odds: num(a.odds), book: b[0] });
      }
    }
  }
  return out;
}
async function sgoLeague(meta, league, file, everyMin, maxEvents) {
  const key = process.env.SGO_API_KEY;
  if (!key) { console.log('No SGO_API_KEY secret set; skipping props and alt lines.'); return; }
  const month = new Date().toISOString().slice(0, 7);
  if (meta.sgoMonth !== month) { meta.sgoMonth = month; meta.sgoUsed = 0; }
  const cur = await readJSON(file, { updated: null, events: [] });
  const age = cur.updated ? (Date.now() - Date.parse(cur.updated)) / 60000 : Infinity;
  if (age < everyMin && !process.env.SGO_FORCE) { console.log(`${league}: ${Math.round(age)} min old; next pull after ${everyMin}.`); return; }
  if (meta.sgoUsed >= SGO_MONTHLY_CAP) { console.log(`SportsGameOdds: ${meta.sgoUsed} events used this month; holding until next month.`); return; }
  const now = new Date();
  const before = new Date(now.getTime() + 6.5 * 864e5).toISOString();
  const events = [];
  let cursor = null;
  for (let page = 0; page < 5 && events.length < maxEvents; page++) {
    const q = new URLSearchParams({ leagueID: league, oddsAvailable: 'true', includeAltLines: 'true', startsAfter: now.toISOString(), startsBefore: before, limit: '30' });
    if (cursor) q.set('cursor', cursor);
    const r = await fetch('https://api.sportsgameodds.com/v2/events?' + q, { headers: { 'x-api-key': key } });
    if (!r.ok) throw new Error(`SportsGameOdds ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const data = j.data || [];
    meta.sgoUsed += data.length;
    for (const ev of data) {
      const t = Date.parse(ev.status?.startsAt);
      if (!isNaN(t) && t > Date.parse(before)) continue; // in case the date filter isn't applied server-side
      events.push(slimSgoEvent(ev));
    }
    cursor = j.nextCursor;
    if (!cursor || !data.length) break;
  }
  await writeFile(file, JSON.stringify({ updated: now.toISOString(), events }));
  console.log(`SportsGameOdds: ${events.length} ${league} games, ${events.reduce((a, e) => a + e.props.length, 0)} props, ${events.reduce((a, e) => a + e.alts.length, 0)} alt lines; ${meta.sgoUsed} events used this month`);
}

const meta = await readJSON('data/meta.json', {});
// College alt lines: one pull Friday and one Saturday (Eastern), to stay inside the free 2,500 events a month.
async function sgo(meta) {
  await sgoLeague(meta, 'NFL', 'data/sgo-nfl.json', SGO_EVERY_MIN, 30);
  const day = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  if (['Fri', 'Sat'].includes(day)) await sgoLeague(meta, 'NCAAF', 'data/sgo-cfb.json', 20 * 60, 70);
}
const results = await Promise.allSettled([espnBackup(meta), oddsApi(meta), sgo(meta)]);
results.forEach((r) => { if (r.status === 'rejected') { console.error(r.reason); meta.lastError = String(r.reason?.stack || r.reason).slice(0, 500); } });
await writeFile('data/meta.json', JSON.stringify(meta));
// Record and grade Horseshoe picks (scripts/track.mjs)
try {
  const { track } = await import('./track.mjs');
  const t = await track();
  if (t.errors.length) console.log('Tracker notes:', t.errors.slice(0, 5));
} catch (e) { console.error('Tracker failed:', e); }
if (results.every((r) => r.status === 'rejected')) process.exit(1);

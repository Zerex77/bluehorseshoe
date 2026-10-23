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
  const team = (t) => t && ({ id: t.id, abbreviation: t.abbreviation, displayName: t.displayName, shortDisplayName: t.shortDisplayName, location: t.location, conferenceId: t.conferenceId, logo: t.logo, color: t.color, alternateColor: t.alternateColor });
  const side = (s) => s && ({ close: s.close && { line: s.close.line, odds: s.close.odds }, open: s.open && { line: s.open.line, odds: s.open.odds } });
  return {
    week: scoreboard.week && { number: scoreboard.week.number },
    events: (scoreboard.events || []).map((ev) => ({
      id: ev.id, date: ev.date, shortName: ev.shortName,
      status: { type: { state: ev.status?.type?.state } },
      competitions: (ev.competitions || []).slice(0, 1).map((c) => ({
        neutralSite: c.neutralSite,
        venue: c.venue && { fullName: c.venue.fullName, address: c.venue.address && { city: c.venue.address.city, state: c.venue.address.state } },
        broadcasts: (c.broadcasts || []).slice(0, 1).map((b) => ({ names: (b.names || []).slice(0, 1) })),
        competitors: (c.competitors || []).map((x) => ({ homeAway: x.homeAway, curatedRank: x.curatedRank, team: team(x.team), records: (x.records || []).slice(0, 1).map((r) => ({ summary: r.summary })) })),
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
      injuries: (t.injuries || []).filter((i) => ['Out', 'Doubtful', 'Questionable'].includes(i.status) || /injured reserve|physically unable|pup|suspend|non-football|reserve/i.test(i.status || '')).map((i) => ({
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
  // Venues for the kickoff-wind check (weather() below).
  meta._venues = [];
  for (const [sport, r] of [['nfl', nfl], ['cfb', cfb]]) {
    if (r.status !== 'fulfilled') continue;
    for (const ev of r.value.json.events || []) {
      const c = (ev.competitions || [])[0] || {};
      const v = c.venue || {};
      if ((ev.status?.type?.state || 'pre') !== 'pre') continue;
      meta._venues.push({ id: ev.id, sport, date: ev.date, venueId: v.id, venue: v.fullName, city: v.address?.city, state: v.address?.state, country: v.address?.country, indoor: !!v.indoor });
    }
  }
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

// ---------- Kickoff weather (Open-Meteo, free, no key). Wind matters for totals; domes are skipped.
// Updates every hour for games kicking off in the next 48 hours. Stadium coordinates are cached in data/venues.json.
const WX_EVERY_MIN = 55;
const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
async function weather(meta) {
  if (meta.wxAt && Date.now() - Date.parse(meta.wxAt) < WX_EVERY_MIN * 60e3) return;
  const venues = (meta._venues || []).filter((v) => Date.parse(v.date) - Date.now() < 48 * 3600e3 && Date.parse(v.date) > Date.now() - 3600e3);
  const cache = await readJSON('data/venues.json', {});
  const out = { updated: new Date().toISOString(), games: {} };
  const fx = {};
  for (const v of venues) {
    if (v.indoor) { out.games[v.id] = { indoor: true, venue: v.venue }; continue; }
    const us = !v.country || /^(usa?|united states)/i.test(v.country);
    const key = (v.venueId || `${v.city}|${v.state}`) + (us ? '' : ':' + v.country); // London, Mexico City, etc.
    if (!cache[key] && v.city) {
      try {
        const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(v.city)}&count=10${us ? '&country_code=US' : ''}`).then((r) => r.json());
        const want = STATES[v.state] || v.state;
        const res = g.results || [];
        const hit = us ? (res.find((x) => x.admin1 === want) || res[0]) : (res.slice().sort((a, b) => (b.population || 0) - (a.population || 0))[0]);
        if (hit) cache[key] = { lat: hit.latitude, lon: hit.longitude, city: v.city, state: v.state };
      } catch {}
    }
    const c = cache[key];
    if (!c) continue;
    const fk = `${c.lat},${c.lon}`;
    if (!fx[fk]) {
      fx[fk] = fetch(`https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&hourly=wind_speed_10m,wind_gusts_10m,precipitation,temperature_2m&wind_speed_unit=mph&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=UTC&forecast_days=3`)
        .then((r) => r.json()).catch(() => null);
    }
    const f = await fx[fk];
    const times = f?.hourly?.time || [];
    // middle of the game: kickoff + 1.5h, rounded to the hour
    const mid = new Date(Date.parse(v.date) + 90 * 60e3); mid.setUTCMinutes(0, 0, 0);
    const ix = times.indexOf(mid.toISOString().slice(0, 13) + ':00');
    if (ix === -1) continue;
    const h = f.hourly;
    out.games[v.id] = { wind: h.wind_speed_10m[ix], gust: h.wind_gusts_10m[ix], precip: h.precipitation[ix], temp: h.temperature_2m[ix], venue: v.venue };
  }
  await writeFile('data/venues.json', JSON.stringify(cache));
  await writeFile('data/weather.json', JSON.stringify(out));
  meta.wxAt = out.updated;
  const windy = Object.values(out.games).filter((g) => g.wind >= 15).length;
  console.log(`Weather: ${Object.keys(out.games).length} games, ${windy} with 15+ mph wind`);
}

// College alt lines: one pull Friday and one Saturday (Eastern), to stay inside the free 2,500 events a month.
async function sgo(meta) {
  await sgoLeague(meta, 'NFL', 'data/sgo-nfl.json', SGO_EVERY_MIN, 30);
  const day = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
  if (['Fri', 'Sat'].includes(day)) await sgoLeague(meta, 'NCAAF', 'data/sgo-cfb.json', 20 * 60, 70);
}
const results = await Promise.allSettled([espnBackup(meta), oddsApi(meta), sgo(meta)]);
try { await weather(meta); } catch (e) { console.error('Weather failed:', e.message); }
delete meta._venues;
results.forEach((r) => { if (r.status === 'rejected') { console.error(r.reason); meta.lastError = String(r.reason?.stack || r.reason).slice(0, 500); } });
await writeFile('data/meta.json', JSON.stringify(meta));
// Record and grade Horseshoe picks (scripts/track.mjs)
try {
  const { track } = await import('./track.mjs');
  const t = await track();
  if (t.errors.length) console.log('Tracker notes:', t.errors.slice(0, 5));
} catch (e) { console.error('Tracker failed:', e); }
if (results.every((r) => r.status === 'rejected')) process.exit(1);

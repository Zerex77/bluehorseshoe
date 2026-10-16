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
  const end = new Date(now.getTime() + 6 * 864e5);
  const [nfl, cfb, inj] = await Promise.all([
    getJSON(ESPN + 'nfl/scoreboard'),
    getJSON(`${ESPN}college-football/scoreboard?groups=80&limit=400&dates=${ymd(now)}-${ymd(end)}`),
    getJSON(ESPN + 'nfl/injuries').catch(() => null)
  ]);
  await writeFile('data/espn-nfl.json', JSON.stringify(slim(nfl.json)));
  await writeFile('data/espn-cfb.json', JSON.stringify(slim(cfb.json)));
  if (inj) await writeFile('data/espn-injuries.json', JSON.stringify(slimInjuries(inj.json)));
  meta.espn = now.toISOString();
  console.log(`ESPN backup: ${nfl.json.events?.length ?? 0} NFL, ${cfb.json.events?.length ?? 0} college games`);
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

const meta = await readJSON('data/meta.json', {});
const results = await Promise.allSettled([espnBackup(meta), oddsApi(meta)]);
results.forEach((r) => { if (r.status === 'rejected') console.error(r.reason); });
await writeFile('data/meta.json', JSON.stringify(meta));
if (results.every((r) => r.status === 'rejected')) process.exit(1);

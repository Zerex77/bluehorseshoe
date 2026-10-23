// Sam's Models (samthemodelman.smmodel.workers.dev): projected scores, model line and pick for every college and NFL
// game, plus each game's "where the margin comes from" breakdown and the season so far.
// The board is read every refresh; game pages are re-read only when the board's "Updated" stamp changes (or a game
// is new), so a refresh is usually 2 requests, not 70.
// Sam's own note: tested against closing lines, the college model tracks the market rather than beating it.
const BASE = process.env.SAM_URL || 'https://samthemodelman.smmodel.workers.dev';
const UA = { 'user-agent': 'blue-horseshoe/1.0 (+https://bluehorseshoebet.com)' };

const text = (s) => String(s || '').replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/−/g, '-').replace(/\s+/g, ' ').trim();
const num = (x) => { const v = parseFloat(String(x).replace(/[^\d.+-]/g, '')); return Number.isFinite(v) ? v : null; };

// "Virginia -3.8" -> { team: 'Virginia', line: -3.8 }
function teamLine(s) {
  const m = /^(.*?)\s*([+-]\d+(?:\.\d+)?|PK|EVEN)$/i.exec(text(s));
  if (!m) return null;
  return { team: m[1].trim(), line: /^(PK|EVEN)$/i.test(m[2]) ? 0 : parseFloat(m[2]) };
}

// Board: one <article class="game"> per game, away team first.
export function parseBoard(html) {
  const stamp = (/class="stamp">([\s\S]*?)<\/div>/.exec(html) || [])[1];
  const games = [];
  for (const art of html.split(/<article class="game"/).slice(1)) {
    const body = art.split('</article>')[0];
    const href = /href="game\/([^"]+)\.html"/.exec(body);
    if (!href) continue;
    const teams = [...body.matchAll(/<div class="team[^"]*">[\s\S]*?<span class="nm">([\s\S]*?)<\/span>(?:<span class="rec">([\s\S]*?)<\/span>)?[\s\S]*?<div class="pts">([\s\S]*?)<\/div>/g)];
    if (teams.length < 2) continue;
    const val = (lbl) => { const m = new RegExp('<span class="lbl">' + lbl + '</span><span class="val[^"]*">([\\s\\S]*?)</span>').exec(body); return m ? text(m[1]) : null; };
    const pick = (/<span class="pickval">([\s\S]*?)<\/span>/.exec(body) || [])[1];
    const a = { name: text(teams[0][1]), rec: text(teams[0][2]), pts: num(text(teams[0][3])) };
    const h = { name: text(teams[1][1]), rec: text(teams[1][2]), pts: num(text(teams[1][3])) };
    games.push({ key: href[1], a: a.name, h: h.name, aRec: a.rec, hRec: h.rec, as: a.pts, hs: h.pts,
      m: a.pts != null && h.pts != null ? Math.round((h.pts - a.pts) * 10) / 10 : null,
      vegas: val('Vegas line'), modelLine: val('Model line'), pick: pick ? text(pick) : null,
      gap: num((/data-gap="([\d.]+)"/.exec(art) || [])[1]) });
  }
  return { stamp: stamp ? text(stamp) : null, games };
}

// Game page: "01 / The number" sentence, the margin bars (left of the center line = away team), and the season so far.
export function parseGame(html) {
  const out = { number: null, bars: [], season: [] };
  const n = /01 \/ <b>THE NUMBER<\/b><\/h3>\s*<p[^>]*>([\s\S]*?)<\/p>/i.exec(html) || /01 \/ <b>THE NUMBER<\/b>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  if (n) out.number = text(n[1]);
  const sec = /WHERE THE MARGIN COMES FROM<\/b><\/h3>\s*(<svg[\s\S]*?<\/svg>)/i.exec(html);
  if (sec) {
    const svg = sec[1];
    const cx = num((/<line x1="([\d.]+)"/.exec(svg) || [])[1]);
    const re = /<text[^>]*font-family="Inter,sans-serif"[^>]*>([^<]+)<\/text>\s*<rect x="([\d.]+)"[^>]*width="([\d.]+)"[^>]*\/?>(?:<\/rect>)?\s*<text[^>]*>([^<]+)<\/text>/g;
    let m;
    while ((m = re.exec(svg))) {
      const x = +m[2], pts = num(m[4]);
      if (pts == null || cx == null) continue;
      out.bars.push({ label: text(m[1]), pts, toward: x + 0.05 < cx ? 'a' : 'h' });
    }
  }
  const ss = /SEASON SO FAR<\/b><\/h3>([\s\S]*?)<\/div><\/div><\/div>/i.exec(html) || /SEASON SO FAR<\/b><\/h3>([\s\S]*)$/i.exec(html);
  if (ss) {
    for (const team of ss[1].split(/<h4/).slice(1)) {
      const name = text((/^[^>]*>([\s\S]*?)<span/.exec(team) || [])[1]);
      const games = [...team.matchAll(/<tr><td>([\s\S]*?)<\/td><td class="(pos|neg)">([\s\S]*?)<\/td><\/tr>/g)].map((r) => ({ opp: text(r[1]), score: text(r[3]), w: r[2] === 'pos' }));
      if (name) out.season.push({ team: name, games });
    }
  }
  return out;
}

async function get(path) {
  const r = await fetch(BASE + path, { headers: UA });
  if (!r.ok) throw new Error(r.status + ' ' + path);
  return r.text();
}

// sport: 'ncaaf' | 'nfl'. prev: what we saved last time ({ stamp, games: { key: game } }).
export async function getSam(sport, prev) {
  const board = parseBoard(await get('/' + sport + '/index.html'));
  const old = (prev && prev.games) || {};
  const same = prev && prev.stamp && prev.stamp === board.stamp;
  const games = {};
  let fetched = 0;
  for (const g of board.games) {
    const keep = old[g.key];
    let detail = same && keep && keep.bars ? { number: keep.number, bars: keep.bars, season: keep.season } : null;
    if (!detail) {
      try { detail = parseGame(await get('/' + sport + '/game/' + g.key + '.html')); fetched++; }
      catch (e) { detail = keep ? { number: keep.number, bars: keep.bars, season: keep.season } : { number: null, bars: [], season: [] }; }
    }
    games[g.key] = { ...g, ...detail, url: BASE + '/' + sport + '/game/' + g.key + '.html' };
  }
  return { stamp: board.stamp, fetchedAt: new Date().toISOString(), pagesRead: fetched, games };
}

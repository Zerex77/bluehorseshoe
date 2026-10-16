/* Blue Horseshoe — live lines.
   Pulls DraftKings lines (open + current) and injuries from ESPN's public feeds straight from the
   visitor's browser, refreshed every minute. Multi-book Line check, props and public splits come
   from small JSON files in /data that the GitHub Action keeps up to date.
   Everything is turned into the same shapes the pick logic in index.html expects. */
(function (root) {
  'use strict';
  var ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/';
  var REFRESH_MS = 60 * 1000;

  // ---------- small helpers
  function g(o, path) { return path.split('.').reduce(function (a, k) { return a == null ? a : a[k]; }, o); }
  function oddsNum(x) {
    if (x == null) return null;
    if (typeof x === 'number') return x;
    var s = String(x).trim().toLowerCase();
    if (s === 'even' || s === 'ev') return 100;
    var n = parseFloat(s.replace('+', ''));
    return isNaN(n) || n === 0 ? null : n;
  }
  function lineNum(x) {
    if (x == null) return null;
    if (typeof x === 'number') return x;
    var s = String(x).trim().toLowerCase();
    if (s === 'pk' || s === 'pick' || s === "pick'em" || s === 'even') return 0;
    var n = parseFloat(s.replace(/^[ou]/, '').replace('+', ''));
    return isNaN(n) ? null : n;
  }
  function imp(o) { return o > 0 ? 100 / (o + 100) : -o / (-o + 100); }
  function signed(x) { return (x > 0 ? '+' : '') + x; }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function phi(z) { // normal CDF
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989423 * Math.exp(-z * z / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  // Moneyline from a spread when the feed has no moneyline (labelled "est." on the site).
  function mlFromSpread(favSpread, sd) {
    var p = phi(Math.abs(favSpread) / sd);
    var pf = Math.min(0.985, p * 1.024), pd = Math.max(0.02, (1 - p) * 1.024);
    var toAm = function (q) { return q >= 0.5 ? -Math.round(q / (1 - q) * 100 / 5) * 5 : Math.round((1 - q) / q * 100 / 5) * 5; };
    return [toAm(pf), toAm(pd)];
  }
  function etDay(iso) {
    try { return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }); } catch (e) { return ''; }
  }
  function etDate(iso) {
    try { return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }); } catch (e) { return ''; }
  }
  function etTime(d) {
    try { return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }); } catch (e) { return ''; }
  }
  function ymd(d) {
    var s = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
    return s.replace(/-/g, '');
  }

  // ---------- read one ESPN event into a flat game record
  function readEvent(ev) {
    var c = g(ev, 'competitions.0');
    if (!c || !c.competitors) return null;
    var home = c.competitors.filter(function (x) { return x.homeAway === 'home'; })[0];
    var away = c.competitors.filter(function (x) { return x.homeAway === 'away'; })[0];
    if (!home || !away) return null;
    var o = (c.odds || [])[0];
    var rec = {
      id: String(ev.id), date: ev.date, state: g(ev, 'status.type.state') || 'pre',
      short: ev.shortName || (away.team.abbreviation + ' @ ' + home.team.abbreviation),
      neutral: !!c.neutralSite,
      a: away.team, h: home.team,
      aRank: g(away, 'curatedRank.current'), hRank: g(home, 'curatedRank.current'),
      odds: null
    };
    if (!o) return rec;
    var aNow = lineNum(g(o, 'pointSpread.away.close.line'));
    var aOpen = lineNum(g(o, 'pointSpread.away.open.line'));
    if (aNow == null && typeof o.spread === 'number') aNow = -o.spread; // ESPN's spread field is the home team's number
    if (aOpen == null) aOpen = aNow;
    var tot = lineNum(g(o, 'total.over.close.line'));
    if (tot == null && typeof o.overUnder === 'number') tot = o.overUnder;
    var tOpen = lineNum(g(o, 'total.over.open.line'));
    if (tOpen == null) tOpen = tot;
    rec.odds = {
      book: g(o, 'provider.name') || 'DraftKings',
      aNow: aNow, aOpen: aOpen,
      aSpOdds: oddsNum(g(o, 'pointSpread.away.close.odds')) || -110,
      hSpOdds: oddsNum(g(o, 'pointSpread.home.close.odds')) || -110,
      tot: tot, tOpen: tOpen,
      oOdds: oddsNum(g(o, 'total.over.close.odds')) || -110,
      uOdds: oddsNum(g(o, 'total.under.close.odds')) || -110,
      aml: oddsNum(g(o, 'moneyline.away.close.odds')),
      hml: oddsNum(g(o, 'moneyline.home.close.odds')),
      amlOpen: oddsNum(g(o, 'moneyline.away.open.odds')),
      hmlOpen: oddsNum(g(o, 'moneyline.home.open.odds'))
    };
    return rec;
  }

  // ---------- injuries
  var KEYPOS = { QB: 4, RB: 3, WR: 2, TE: 2 };
  var STATUS_RANK = { Out: 3, Doubtful: 2, Questionable: 1 };
  function readInjuries(json) {
    var byTeam = {}, byName = {};
    (g(json, 'injuries') || []).forEach(function (t) {
      var list = [];
      (t.injuries || []).forEach(function (i) {
        var st = i.status || '';
        if (!STATUS_RANK[st]) return;
        var pos = g(i, 'athlete.position.abbreviation') || '';
        var name = g(i, 'athlete.displayName') || '';
        var det = [g(i, 'details.type'), g(i, 'details.detail')].filter(Boolean).join(', ');
        var row = { name: name, pos: pos, status: st, note: det || '' };
        byName[name] = row;
        if (KEYPOS[pos]) list.push(row);
      });
      list.sort(function (x, y) { return (KEYPOS[y.pos] * 10 + STATUS_RANK[y.status]) - (KEYPOS[x.pos] * 10 + STATUS_RANK[x.status]); });
      byTeam[t.displayName] = list;
    });
    return { byTeam: byTeam, byName: byName };
  }
  function injEntry(row, team) {
    if (!row) return [team, 'No designation', 'No key injuries listed'];
    return [row.name, row.status, row.pos + (row.note ? ' · ' + row.note : '') + (team ? ' (' + team + ')' : '')];
  }

  // ---------- NFL
  function buildNfl(json, injJson, extra) {
    var inj = readInjuries(injJson || {});
    var events = (g(json, 'events') || []).map(readEvent).filter(Boolean);
    var games = [], legs = [], injMap = {}, liveIds = {}, shortToId = {};
    var firstDate = null;
    events.forEach(function (e) {
      if (e.state !== 'pre' || !e.odds || e.odds.aNow == null) return;
      var day = etDay(e.date);
      var label = e.short + (day && day !== 'Sun' ? ' (' + day + ')' : '');
      games.push({ id: e.id, label: label, date: e.date });
      liveIds[e.id] = 1; shortToId[e.short] = e.id;
      if (!firstDate || e.date < firstDate) firstDate = e.date;
      var o = e.odds;
      var A = e.a.shortDisplayName, H = e.h.shortDisplayName;
      var est = false;
      var aml = o.aml, hml = o.hml;
      if (aml == null || hml == null) {
        var pair = mlFromSpread(o.aNow, 13.5);
        if (o.aNow < 0) { aml = pair[0]; hml = pair[1]; } else { aml = pair[1]; hml = pair[0]; }
        est = true;
      }
      var iA = imp(aml), iH = imp(hml), pA = iA / (iA + iH), pH = 1 - pA;
      var favA = pA >= pH, fav = favA ? A : H, favP = Math.max(pA, pH);
      var favOdds = favA ? aml : hml;
      var mv = o.aOpen - o.aNow; // + means money came in on the away team
      var steam = Math.abs(mv) >= 1 ? (mv > 0 ? 'a' : 'h') : null;
      var steamFav = steam && ((steam === 'a') === favA);
      var favSpread = favA ? o.aNow : -o.aNow;
      var favTeamFull = favA ? e.a.displayName : e.h.displayName;
      var favInj = (inj.byTeam[favTeamFull] || [])[0];
      var bump = Math.min(0.03, Math.abs(mv) * 0.01);
      var fp = clamp(favP + (steamFav ? bump : steam ? -bump : 0), 0.05, 0.97);
      var qbHit = favInj && favInj.pos === 'QB';
      var conf = clamp(Math.round(fp * 100) - (qbHit ? 8 : 0), 40, 92);
      var mvTxt = steam ? 'line moved ' + Math.abs(mv) + ' toward ' + (steam === 'a' ? A : H) : '';
      if (favOdds >= -650 && favOdds <= -125) {
        legs.push({ g: e.id, k: 'line', mk: 'ml', label: fav + ' moneyline', odds: favOdds, conf: conf,
          s: [fp >= 0.66 ? 1 : 0, favA ? 0 : 1, steamFav ? 1 : 0],
          note: fav + ' ' + signed(favSpread) + ', no-vig ' + pct(favP) + (steamFav ? ', ' + mvTxt : '') + (est ? '; price est. from spread' : '') });
        injMap[fav + ' moneyline'] = injEntry(favInj, fav);
      }
      if (steam) {
        var side = steam === 'a' ? A : H, line = steam === 'a' ? o.aNow : -o.aNow;
        var crossKey = [3, 7].some(function (k) { var lo = Math.min(Math.abs(o.aOpen), Math.abs(o.aNow)), hi = Math.max(Math.abs(o.aOpen), Math.abs(o.aNow)); return lo < k && hi >= k; });
        var spLabel = side + ' ' + signed(line);
        legs.push({ g: e.id, k: 'line', mk: 'spread', label: spLabel, odds: steam === 'a' ? o.aSpOdds : o.hSpOdds,
          conf: clamp(56 + Math.round(Math.abs(mv) * 4) + (crossKey ? 3 : 0), 50, 74),
          s: [Math.abs(mv) >= 1.5 ? 1 : 0, steam === 'h' ? 1 : 0, 1],
          note: 'Opened ' + signed(steam === 'a' ? o.aOpen : -o.aOpen) + ', now ' + signed(line) + (crossKey ? ', moved through a key number' : '') });
        injMap[spLabel] = injEntry((inj.byTeam[steam === 'a' ? e.a.displayName : e.h.displayName] || [])[0], side);
      }
      if (o.tot != null) {
        var tMove = o.tot - o.tOpen;
        var juice = o.oOdds < o.uOdds - 7 ? 'Over' : o.uOdds < o.oOdds - 7 ? 'Under' : null;
        var dir = tMove >= 1 ? 'Over' : tMove <= -1 ? 'Under' : juice;
        if (dir) {
          var moved = (dir === 'Over' && tMove >= 1) || (dir === 'Under' && tMove <= -1);
          var tl = dir + ' ' + o.tot;
          legs.push({ g: e.id, k: 'line', mk: 'total', label: tl, odds: dir === 'Over' ? o.oOdds : o.uOdds,
            conf: clamp(55 + (moved ? Math.round(Math.abs(tMove) * 3) : 0) + (juice === dir ? 4 : 0), 50, 72),
            s: [moved ? 1 : 0, juice === dir ? 1 : 0, moved && Math.abs(tMove) >= 2 ? 1 : 0],
            note: (moved ? 'Total moved ' + o.tOpen + ' → ' + o.tot : 'Total steady at ' + o.tot) + (juice === dir ? ', books shading the ' + dir + ' (' + signed(dir === 'Over' ? o.oOdds : o.uOdds) + ')' : '') });
          var both = (inj.byTeam[e.a.displayName] || []).concat(inj.byTeam[e.h.displayName] || []);
          both.sort(function (x, y) { return (KEYPOS[y.pos] * 10 + STATUS_RANK[y.status]) - (KEYPOS[x.pos] * 10 + STATUS_RANK[x.status]); });
          injMap[tl] = injEntry(both[0], '');
        }
      }
    });
    // Player props from the snapshot file, only for games that haven't kicked off.
    var props = extra.props || {};
    (props.legs || []).forEach(function (p) {
      var gid = shortToId[p.game];
      if (!gid) return;
      var who = inj.byName[p.player];
      if (who && (who.status === 'Out' || who.status === 'Doubtful')) return;
      legs.push({ g: gid, k: 'prop', c: p.c, label: p.label, odds: p.odds, conf: p.conf, s: p.s, note: p.note + (props.asOf ? ' · prop line as of ' + props.asOf : '') });
      injMap[p.label] = who ? [who.name, who.status, who.pos + (who.note ? ' · ' + who.note : '')] : [p.player, 'No designation', ''];
    });
    // Public splits (if posted) for live games only.
    var publicBoard = ((extra.splits || {}).nfl || []).filter(function (r) { return shortToId[r[0]]; });
    // Multi-book Line check from the Odds API snapshot.
    var lc = buildLineCheck(extra.books, events);
    var wk = g(json, 'week.number');
    return {
      games: games, legs: legs, mu: {}, inj: injMap, screen: [], publicBoard: publicBoard,
      lineCheck: lc.rows, books: lc.books, bookShort: lc.bookShort, bookDefault: lc.def, booksAsOf: lc.asOf,
      chip: 'NFL' + (wk ? ' · Week ' + wk : '') + (firstDate ? ' · from ' + etDate(firstDate) : ''),
      count: games.length
    };
  }

  var BOOKS = {
    hardrockbet_fl: ['Hard Rock', 'HR'], hardrockbet: ['Hard Rock', 'HR'], draftkings: ['DraftKings', 'DK'], fanduel: ['FanDuel', 'FD'],
    betmgm: ['BetMGM', 'MGM'], williamhill_us: ['Caesars', 'CZR'], fanatics: ['Fanatics', 'FAN'], betrivers: ['BetRivers', 'RIV'], espnbet: ['ESPN Bet', 'ESPN']
  };
  function buildLineCheck(books, events) {
    var out = { rows: [], books: [], bookShort: [], def: 0, asOf: null };
    if (!books || !books.games || !books.games.length) return out;
    var keys = [];
    books.games.forEach(function (gm) { Object.keys(gm.books || {}).forEach(function (k) { if (keys.indexOf(k) === -1 && BOOKS[k]) keys.push(k); }); });
    keys.sort(function (x, y) { return (x.indexOf('hardrock') === 0 ? -1 : 0) - (y.indexOf('hardrock') === 0 ? -1 : 0); });
    out.books = keys.map(function (k) { return BOOKS[k][0]; });
    out.bookShort = keys.map(function (k) { return BOOKS[k][1]; });
    out.def = 0;
    out.asOf = books.updated;
    var byName = {};
    events.forEach(function (e) { if (e.state === 'pre') byName[e.a.displayName + '|' + e.h.displayName] = e; });
    books.games.forEach(function (gm) {
      var e = byName[gm.away + '|' + gm.home];
      if (!e) return;
      var A = e.a.shortDisplayName, H = e.h.shortDisplayName;
      var sp = keys.map(function (k) { var b = gm.books[k]; return b && b.spread ? [b.spread[0], b.spread[1]] : null; });
      if (sp.filter(Boolean).length >= 3) out.rows.push([A + ' spread', e.short, 'spread', sp, A, H]);
      var tt = keys.map(function (k) { var b = gm.books[k]; return b && b.total ? [b.total[0], b.total[1]] : null; });
      if (tt.filter(Boolean).length >= 3) out.rows.push([e.short + ' total', e.short, 'total', tt]);
    });
    return out;
  }

  // ---------- College
  var CONF = { '1': 'ACC', '4': 'Big 12', '5': 'Big Ten', '8': 'SEC', '9': 'Pac-12', '18': 'Independent' };
  function confOf(e) {
    var hc = CONF[e.h.conferenceId], ac = CONF[e.a.conferenceId];
    return hc || ac || 'Group of 5';
  }
  function buildCollege(json, extra) {
    var events = (g(json, 'events') || []).map(readEvent).filter(Boolean);
    var slate = [], legs = [];
    var firstDate = null, lastDate = null;
    events.forEach(function (e) {
      if (e.state !== 'pre' || !e.odds || e.odds.aNow == null) return;
      var o = e.odds;
      if (!firstDate || e.date < firstDate) firstDate = e.date;
      if (!lastDate || e.date > lastDate) lastDate = e.date;
      var away = e.a.location || e.a.shortDisplayName, home = e.h.location || e.h.shortDisplayName;
      var est = false, aml = o.aml, hml = o.hml;
      if (aml == null || hml == null) {
        var pair = mlFromSpread(o.aNow, 15.5);
        if (o.aNow < 0) { aml = pair[0]; hml = pair[1]; } else { aml = pair[1]; hml = pair[0]; }
        est = true;
      }
      var s = { id: e.id, a: away, h: home, n: e.neutral, cf: confOf(e), hs: -o.aNow, tot: o.tot, aml: aml, hml: hml, date: e.date };
      slate.push(s);
      var iA = imp(aml), iH = imp(hml);
      var pA = iA / (iA + iH), pH = 1 - pA;
      var move = o.aOpen - o.aNow;
      var mv = Math.abs(move) >= 1 && Math.abs(move) <= 7 ? move : 0;
      var steam = mv > 0 ? 'a' : mv < 0 ? 'h' : null;
      var nm = function (side) { return side === 'a' ? away : home; };
      var favSide = pA >= pH ? 'a' : 'h', dogSide = favSide === 'a' ? 'h' : 'a';
      var favP = Math.max(pA, pH), dogP = Math.min(pA, pH);
      var bump = Math.min(0.04, Math.abs(mv) * 0.008);
      var moveNote = mv ? 'line moved ' + Math.abs(mv) + (Math.abs(mv) === 1 ? ' pt' : ' pts') + ' toward ' + nm(steam) : '';
      var fp = Math.min(0.97, favP + (steam === favSide ? bump : steam ? -bump : 0));
      var favOdds = favSide === 'a' ? aml : hml;
      // Favorites shorter than -500 add almost nothing to a parlay price, so the Horseshoe leaves them off.
      if (favOdds >= -500) legs.push({ g: s.id, k: 'ml', label: nm(favSide) + ' ML', odds: favOdds, p: fp, conf: Math.round(fp * 100),
        s: [favP >= 0.65 ? 1 : 0, favSide === 'h' ? 1 : 0, steam === favSide ? 1 : 0],
        note: (favSide === 'h' ? 'Home favorite' : 'Road favorite') + (steam === favSide ? ', ' + moveNote : '') + (est ? ' (price est.)' : '') });
      if (steam) {
        var line = steam === 'a' ? o.aNow : -o.aNow;
        var sp = 0.524 + Math.min(0.05, Math.abs(mv) * 0.01);
        legs.push({ g: s.id, k: 'spread', label: nm(steam) + ' ' + signed(line), odds: steam === 'a' ? o.aSpOdds : o.hSpOdds, p: sp, conf: 55 + Math.min(15, Math.round(Math.abs(mv) * 3)),
          s: [Math.abs(mv) >= 2 ? 1 : 0, steam === 'h' ? 1 : 0, 1], dog: line > 0, note: 'Sharp move: ' + moveNote });
        var dogOdds = dogSide === 'a' ? aml : hml;
        if (steam === dogSide && dogOdds > 0 && dogOdds <= 450 && !est) {
          var dp = dogP + bump;
          legs.push({ g: s.id, k: 'ml', label: nm(dogSide) + ' ML', odds: dogOdds, p: dp, conf: Math.round(dp * 100),
            s: [Math.abs(mv) >= 2 ? 1 : 0, dogSide === 'h' ? 1 : 0, 1], dog: true, note: 'Money moving to the dog: ' + moveNote });
        }
      }
      if (o.tot != null) {
        var tMove = o.tot - o.tOpen;
        var juiceGap = Math.abs(o.oOdds - o.uOdds);
        var juiceSide = juiceGap >= 10 ? (o.oOdds < o.uOdds ? 'Over' : 'Under') : null;
        var dir = Math.abs(tMove) >= 1.5 ? (tMove > 0 ? 'Over' : 'Under') : juiceSide;
        if (dir) {
          var moved = Math.abs(tMove) >= 1.5 && (tMove > 0) === (dir === 'Over');
          var iO = imp(o.oOdds), iU = imp(o.uOdds);
          var tp = dir === 'Over' ? iO / (iO + iU) : iU / (iO + iU);
          tp += (moved ? Math.min(0.03, Math.abs(tMove) * 0.006) : 0) + (juiceSide === dir ? 0.01 : 0);
          legs.push({ g: s.id, k: 'total', label: dir + ' ' + o.tot, odds: dir === 'Over' ? o.oOdds : o.uOdds, p: tp, conf: Math.round(tp * 100) + 4,
            s: [moved ? 1 : 0, juiceSide === dir ? 1 : 0, moved && Math.abs(tMove) >= 3 ? 1 : 0],
            note: (moved ? 'Total moved ' + o.tOpen + ' → ' + o.tot : 'Total steady') + (juiceSide === dir ? ', books shading the ' + dir + ' (' + signed(dir === 'Over' ? o.oOdds : o.uOdds) + ')' : '') });
        }
      }
    });
    slate.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
    var names = {};
    slate.forEach(function (s) { names[s.a + (s.n ? ' vs ' : ' @ ') + s.h] = 1; });
    var publicBoard = ((extra.splits || {}).cf || []).filter(function (r) { return names[r[0]]; });
    var games = slate.map(function (s) { return { id: s.id, label: s.a + (s.n ? ' vs ' : ' @ ') + s.h }; });
    var span = firstDate ? etDate(firstDate) + (lastDate && etDate(lastDate) !== etDate(firstDate) ? ' – ' + etDate(lastDate) : '') : '';
    return { games: games, legs: legs, publicBoard: publicBoard, slate: slate, chip: 'NCAAF' + (span ? ' · ' + span : ''), count: slate.length };
  }

  // ---------- fetching
  function getJSON(url, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 9000);
    return fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error(r.status + ' ' + url); return r.json(); });
  }
  function soft(p) { return p.then(function (x) { return x; }, function () { return null; }); }

  // ESPN rejects date ranges on the college scoreboard, so ask for each of the next 7 days and merge.
  function cfbDays() {
    var out = [];
    for (var i = 0; i < 7; i++) out.push(ymd(new Date(Date.now() + i * 864e5)));
    return out;
  }
  function getCfbLive() {
    return Promise.all(cfbDays().map(function (d) {
      return soft(getJSON(ESPN + 'college-football/scoreboard?groups=80&limit=300&dates=' + d));
    })).then(function (days) {
      var seen = {}, events = [], ok = 0;
      days.forEach(function (j) {
        if (!j) return;
        ok++;
        (j.events || []).forEach(function (e) { if (!seen[e.id]) { seen[e.id] = 1; events.push(e); } });
      });
      if (!ok) throw new Error('college scoreboard unavailable');
      return { events: events };
    });
  }

  var empty = function () {
    return {
      nfl: { games: [], legs: [], mu: {}, inj: {}, screen: [], publicBoard: [], lineCheck: [], books: [], bookShort: [], bookDefault: 0, chip: 'NFL', count: 0 },
      cf: { games: [], legs: [], publicBoard: [], slate: [], chip: 'NCAAF', count: 0 },
      status: 'loading', updated: null, source: '', booksAsOf: null, propsAsOf: null
    };
  };
  root.BH = empty();

  function load() {
    var bust = '?t=' + Math.floor(Date.now() / 60000);
    // Each feed tries ESPN live first, then the 15-minute backup copy, independently.
    var pick = function (livePromise, backupPath) {
      return livePromise.then(function (j) { return { json: j, live: true }; }, function () {
        return getJSON(backupPath + bust).then(function (j) { return { json: j, live: false }; }, function () { return null; });
      });
    };
    var live = Promise.all([
      pick(getJSON(ESPN + 'nfl/scoreboard'), 'data/espn-nfl.json'),
      pick(getCfbLive(), 'data/espn-cfb.json'),
      pick(getJSON(ESPN + 'nfl/injuries'), 'data/espn-injuries.json')
    ]).then(function (r) {
      if (!r[0] && !r[1]) throw new Error('no lines from ESPN or backup');
      var allLive = (!r[0] || r[0].live) && (!r[1] || r[1].live);
      return { nfl: r[0] ? r[0].json : {}, cfb: r[1] ? r[1].json : {}, inj: r[2] ? r[2].json : null, source: allLive ? 'live' : 'snapshot' };
    });
    var fallback = function (e) { throw e; };
    var extras = Promise.all([
      soft(getJSON('data/books.json' + bust)),
      soft(getJSON('data/props.json' + bust)),
      soft(getJSON('data/splits.json' + bust)),
      soft(getJSON('data/meta.json' + bust))
    ]).then(function (r) { return { books: r[0], props: r[1], splits: r[2], meta: r[3] }; });
    return Promise.all([live.catch(fallback), extras]).then(function (res) {
      var feed = res[0], ex = res[1];
      var next = {
        nfl: buildNfl(feed.nfl, feed.inj, ex),
        cf: buildCollege(feed.cfb, ex),
        status: 'ok', source: feed.source,
        updated: feed.source === 'snapshot' && ex.meta && ex.meta.espn ? new Date(ex.meta.espn) : new Date(),
        booksAsOf: ex.books && ex.books.updated ? new Date(ex.books.updated) : null,
        propsAsOf: ex.props ? ex.props.asOf : null
      };
      root.BH = next;
      return next;
    }).catch(function (err) {
      console.error('Blue Horseshoe: could not load lines', err);
      if (root.BH.status === 'loading') root.BH.status = 'error';
      return root.BH;
    });
  }

  function stamp() {
    var b = root.BH;
    if (b.status === 'loading') return 'Loading live lines…';
    if (b.status === 'error' || !b.updated) return 'Lines unavailable right now. Retrying every minute.';
    var secs = Math.max(0, Math.round((Date.now() - b.updated.getTime()) / 1000));
    var ago = secs < 60 ? 'just now' : Math.round(secs / 60) + ' min ago';
    return (b.source === 'live' ? 'Live' : 'Snapshot') + ' · updated ' + etTime(b.updated) + ' ET (' + ago + ')';
  }

  root.BHLines = {
    load: load, stamp: stamp, REFRESH_MS: REFRESH_MS, etTime: etTime,
    _test: { readEvent: readEvent, buildNfl: buildNfl, buildCollege: buildCollege, buildLineCheck: buildLineCheck, mlFromSpread: mlFromSpread }
  };
})(typeof window !== 'undefined' ? window : globalThis);

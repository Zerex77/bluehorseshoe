// Slip reading shared with the Blue Horseshoe Live page (copied from live.html so both read
// tickets the same way): ESPN games, leg parsing, Hard Rock slip text, screenshot OCR.
(function () {
  'use strict';
  var ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/';
  var games = {};          // id -> game record
  var playerGame = {};     // squashed player -> game id (filled by the ticker; empty here)

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uid() { return Math.random().toString(36).slice(2, 9); }
  function dec(am) { am = Number(am); if (!am) return null; return am > 0 ? 1 + am / 100 : 1 + 100 / -am; }
  function amer(d) { if (!d || d <= 1) return '—'; return d >= 2 ? '+' + Math.round((d - 1) * 100) : String(Math.round(-100 / (d - 1))); }
  function money(n) { return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function ymd(d) { return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, ''); }
  var normName = function (x) { return String(x || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim(); };
  var squash = function (x) { return normName(x).replace(/ /g, ''); };

  function getJSON(u) { return fetch(u, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }

  function readGame(ev, sport) {
    var c = ev.competitions && ev.competitions[0];
    if (!c) return null;
    var h = c.competitors.filter(function (x) { return x.homeAway === 'home'; })[0];
    var a = c.competitors.filter(function (x) { return x.homeAway === 'away'; })[0];
    if (!h || !a) return null;
    var stt = c.status || ev.status || {};
    var sit = c.situation || {};
    return {
      id: String(ev.id), sport: sport, date: ev.date,
      state: (stt.type && stt.type.state) || 'pre',
      detail: (stt.type && (stt.type.shortDetail || stt.type.detail)) || '',
      period: stt.period || 0, clock: stt.displayClock || '0:00',
      a: a.team, h: h.team, as: Number(a.score) || 0, hs: Number(h.score) || 0,
      poss: sit.possession ? String(sit.possession) : null, rz: !!sit.isRedZone, dd: sit.shortDownDistanceText || sit.downDistanceText || ''
    };
  }
  function aliases(t) {
    var out = [t.displayName, t.shortDisplayName, t.location, t.name, t.nickname, t.abbreviation].filter(Boolean).map(function (x) { return String(x).toLowerCase(); });
    // "Appalachian State" also answers to "App State"; "Coastal Carolina" to "Coastal"
    out.slice().forEach(function (x) {
      if (/state$/.test(x) && x.split(' ').length > 2) out.push(x.split(' ')[0] + ' state');
      if (x === 'appalachian state') out.push('app state', 'app st');
      if (x === 'app state') out.push('appalachian state', 'appalachian st');
      if (/ st\.?$/.test(x)) out.push(x.replace(/ st\.?$/, ' state'));
    });
    // match the way leg text is cleaned: "Miami (OH)" -> "miami oh", plus "miami ohio"
    out.slice().forEach(function (x) {
      var c = x.replace(/[^a-z0-9&'. ]/g, ' ').replace(/\s+/g, ' ').trim();
      if (c !== x) out.push(c);
      var m = /^(.+?) \((oh|fl|pa)\)/.exec(x);
      if (m) out.push(m[1] + ' ' + { oh: 'ohio', fl: 'florida', pa: 'pennsylvania' }[m[2]]);
    });
    return out.filter(function (x, i, arr) { return x.length >= 2 && arr.indexOf(x) === i && !/[()]/.test(x); });
  }
  function fetchBoards() {
    var now = new Date(), days = [ymd(now)];
    var hr = Number(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
    if (hr < 6) days.push(ymd(new Date(now.getTime() - 864e5)));
    var reqs = [getJSON(ESPN + 'nfl/scoreboard').then(function (j) { return ['nfl', j]; })];
    days.forEach(function (d) {
      reqs.push(getJSON(ESPN + 'college-football/scoreboard?groups=80&limit=300&dates=' + d).then(function (j) { return ['cfb', j]; }));
      reqs.push(getJSON(ESPN + 'college-football/scoreboard?groups=81&limit=300&dates=' + d).then(function (j) { return ['cfb', j]; }));
    });
    // games named in saved slips that may be on other days (NFL week) are fetched by id below
    return Promise.allSettled(reqs).then(function (res) {
      var ok = 0;
      res.forEach(function (r) {
        if (r.status !== 'fulfilled') return;
        ok++;
        (r.value[1].events || []).forEach(function (ev) { var g = readGame(ev, r.value[0]); if (g) games[g.id] = g; });
      });
      if (!ok) throw new Error('feeds down');
    });
  }

  // ---------- parse legs
  var STATS = [
    [/\b(pass(ing)?\s*\+\s*rush(ing)?)\b/, 'pass + rush yds'],
    [/\b(rush(ing)?\s*\+\s*rec(eiving)?|scrimmage)\b/, 'rush + rec yds'],
    [/\b(pass(ing)?\s*(td|tds|touchdowns?))\b/, 'pass TDs'],
    // completions / attempts before yards: "passing completions" must not read as pass yards
    [/\b(completions?|comp|cmp)\b/, 'completions'],
    [/\b(pass(ing)?\s*att(empt)?s?)\b/, 'pass attempts'],
    [/\b(pass(ing)?\s*(yds|yards)?|py)\b(?!\s*(att|comp|cmp))/, 'pass yds'],
    [/\b(longest\s*rush|long\s*rush)\b/, 'longest rush'],
    [/\b(longest\s*(rec|reception|catch)|long\s*rec)\b/, 'longest reception'],
    [/\b(rush(ing)?\s*att(empt)?s?|carries)\b/, 'rush attempts'],
    [/\b(rush(ing)?\s*(yds|yards)?|ry)\b/, 'rush yds'],
    [/\b(receptions?|catches|recs)\b/, 'receptions'],
    [/\b(rec(eiving)?\s*(yds|yards)?)\b/, 'rec yds'],
    [/\b(ints?|interceptions?)\b/, 'interceptions thrown'],
    [/\battempts\b/, 'pass attempts']
  ];
  function statOf(s) { s = s.toLowerCase(); for (var i = 0; i < STATS.length; i++) if (STATS[i][0].test(s)) return STATS[i][1]; return null; }

  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 1; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  // ---------- read a Hard Rock slip screenshot's text into legs
  // Hard Rock lists each pick as a selection line ("Memphis", "Over 54.5") followed by an all-caps market line
  // ("TO WIN", "TOTAL POINTS"), grouped under "Away @ Home" headers.
  // "ROMEO DOUBS - TO RECORD 50+ RECEIVING YARDS" + "Over 49.5"  ->  "Romeo Doubs over 49.5 rec yds"
  function titleName(x) {
    return String(x).toLowerCase().replace(/(^|[\s\-.])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); })
      .replace(/\b([a-z]{1,2})'([a-z])/gi, function (m, a, b) { return a.charAt(0).toUpperCase() + a.slice(1) + "'" + b.toUpperCase(); })
      .replace(/\b(Ii|Iii|Iv)\b/g, function (m) { return m.toUpperCase(); });
  }
  function cleanPlayer(x) {
    return titleName(String(x).replace(/\s+[-–—]\s+.*$/, '').replace(/\b(to (record|score|have|throw)|alt(ernate)?|player|over|under|o\/u|receptions?|receiving|rushing|passing|pass|rush|yards|yds|touchdowns?|completions?|attempts|carries|longest|interceptions?|anytime)\b.*$/i, '')
      .replace(/[\d+]+.*$/, '').replace(/\s+/g, ' ').trim());
  }
  function propText(sel, mk) {
    var all = sel + ' ' + mk, what = statOf(all), m;
    if (!what) return null;
    var name = /^(over|under)\b/i.test(sel) ? cleanPlayer(mk) : cleanPlayer(sel) || cleanPlayer(mk);
    var line = null;
    if ((m = /\b(?:over|o)\s*([\d.]+)/i.exec(all))) line = Number(m[1]);
    else if ((m = /(\d+(?:\.\d+)?)\s*\+/.exec(all))) line = Number(m[1]) - 0.5;
    if (!name || line == null) return null;
    return name + ' over ' + line + ' ' + what;
  }

  function hardRockText(raw) {
    var DATE = /^.*?\b(today|tomorrow|tonight|mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s*\d{1,2}[:.]\d{2}\s*[ap]\.?m\.?\s*(e[sd]t|c[sd]t|m[sd]t|p[sd]t)?\s*/i;
    var lines = raw.split(/\n/).map(function (x) { return x.replace(/[|©®@]+\s*$/, '').trim(); }).filter(Boolean);
    var out = { legs: [], stake: null, odds: null };
    var groups = [], cur = null;
    var isMarket = function (x) { return /^[A-Z][A-Z0-9 +&.'\-\/]{3,}$/.test(x) && /[A-Z]{2,}/.test(x) && !/^(BET|HARD ROCK|SGP|SGPMAX|PARLAY)$/.test(x) && !/(^|\s)[+-]\d/.test(x); };
    var knownMarket = function (x) { return /^(TO WIN|MONEY ?LINE|(POINT )?SPREAD|TOTAL( POINTS)?|GAME TOTAL|ALT(ERNATE)? .*|.*(YARDS|RECEPTIONS|COMPLETIONS|ATTEMPTS)|ANYTIME.*|.*SCORER)$/.test(x); };
    var junk = function (x) { return /qtr|quarter|half|final|go to event|\d+(st|nd|rd|th)\s*&|extrapoint|field goal|penalt|touchdown result|kickoff|timeout|wager|payout|parlay/i.test(x) || /^\W/.test(x); };
    var isDate = function (x) { return DATE.test(x) && !x.replace(DATE, '').trim(); };
    var matchup = function (x) { var m = /^(.+?)\s+(?:vs\.?|v\.?|@|at)\s+(.+)$/i.exec(x.replace(/^[^A-Za-z]+/, '')); return m && !isMarket(x) && !/[+-]\d/.test(x) ? m[1] + ' ' + m[2] : null; };
    lines.forEach(function (x, i) {
      var m;
      if (out.odds == null && /parlay/i.test(x) && (m = /([+-]\d{3,6})\b/.exec(x))) out.odds = Number(m[1]);
      if (out.stake == null && /wager/i.test(x)) {
        // "$20  $6,989.30" sits on the next line: the wager is the first amount ($ often reads as S)
        var nx = x.replace(/.*wager/i, '') + ' ' + (lines[i + 1] || '');
        if ((m = /(?:^|\s)[$S5]?\s*(\d[\d,]*(?:\.\d+)?)/.exec(nx))) out.stake = Number(m[1].replace(/,/g, ''));
      }
      var h = x.replace(/^[^A-Za-z]*([S$5][GOQ0@]P[:.]?\s*)?/i, '').replace(/\s*[+-]\d{2,6}\s*$/, '');
      if (/\s@\s/.test(h) && !junk(h) && !(i > 0 && isMarket(lines[i - 1]))) {
        cur = { header: h, items: [] }; groups.push(cur); return;
      }
      if (isMarket(x) && i > 0) {
        var sel = lines[i - 1].replace(DATE, '').trim();   // a date line can get glued onto the pick
        if (!sel || junk(sel) || knownMarket(sel) || isDate(lines[i - 1])) return;
        if (!cur) { cur = { header: '', items: [] }; groups.push(cur); }
        var om = /\s+([+-]\d{3,6})$/.exec(sel);
        var mu = matchup(lines[i + 1] || '') || matchup(lines[i + 2] || '');
        cur.items.push({ sel: om ? sel.slice(0, om.index) : sel, odds: om ? om[1] : '', mkt: x, matchup: mu });
      }
    });
    var STATWORDS = /(passing|rushing|receiving|reception|yards|yds|completions|attempts|touchdowns?|td|longest|carries|\+)/ig;
    groups.forEach(function (g) {
      var team = '';
      g.items.forEach(function (it) { if (/TO WIN|MONEYLINE|SPREAD|HANDICAP/.test(it.mkt)) team = team || it.sel.replace(/\s+[+-]?\d+(\.\d+)?$/, ''); });
      g.items.forEach(function (it) {
        var mk = it.mkt, sel = it.sel, t;
        // each pick's own "Team vs Team" line wins; same-game slips fall back to the group's teams
        var ctx = it.matchup || (g.header ? team || g.header.split(/\s@\s/)[0] : '');
        if (/TO WIN|MONEYLINE/.test(mk)) t = sel + ' ML';
        else if (/SPREAD|HANDICAP|RUN LINE|PUCK LINE/.test(mk)) t = sel;
        else if (/^TOTAL( POINTS)?$|GAME TOTAL/.test(mk)) t = (ctx ? ctx + ' ' : '') + sel;
        else if (/ANYTIME|TOUCHDOWN SCORER|TD SCORER/.test(mk)) t = sel + ' anytime TD';
        else t = propText(sel, mk) || (sel + ' ' + mk.toLowerCase());
        out.legs.push((t + (it.odds ? ' ' + it.odds : '')).replace(/\s+/g, ' ').trim());
      });
    });
    return out;
  }

  function findTeams(text) {
    var low = ' ' + text.toLowerCase().replace(/[^a-z0-9&'. ]/g, ' ').replace(/\s+/g, ' ') + ' ';
    var hits = [];
    Object.keys(games).forEach(function (id) {
      var g = games[id];
      ['a', 'h'].forEach(function (side) {
        aliases(g[side]).forEach(function (al) {
          var short = al.length <= 4 && al === String(g[side].abbreviation || '').toLowerCase();
          var re = new RegExp('(^|[^a-z])' + al.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=$|[^a-z])');
          var m = re.exec(low);
          if (!m) return;
          if (short && !new RegExp('\\b' + al + '\\b', 'i').test(text)) return;
          hits.push({ g: id, side: side, len: al.length, at: m.index, al: al });
        });
      });
    });
    if (!hits.length) {
      // screenshots misread letters ("Woshington"), so allow a couple of typos on longer names
      var words = low.trim().split(/\s+/).filter(function (w) { return !/^(ml|moneyline|over|under|o|u|to|win|spread|total|points|pk|[\d.+-]+)$/.test(w); });
      Object.keys(games).forEach(function (id) {
        var g = games[id];
        ['a', 'h'].forEach(function (side) {
          aliases(g[side]).forEach(function (al) {
            if (al.length < 6) return;
            var n = al.split(' ').length, tol = al.length >= 10 ? 2 : 1;
            for (var i = 0; i + n <= words.length; i++) {
              if (lev(words.slice(i, i + n).join(' '), al) <= tol) { hits.push({ g: id, side: side, len: al.length, at: low.indexOf(words[i]), al: al }); break; }
            }
          });
        });
      });
    }
    hits.sort(function (x, y) { return y.len - x.len; });
    // drop hits contained inside a longer hit ("Penn" inside "Penn State")
    var keep = [];
    hits.forEach(function (h) {
      if (keep.some(function (k) { return h.at >= k.at && h.at + h.len <= k.at + k.len + 1 && k.al !== h.al; })) return;
      if (keep.some(function (k) { return k.g === h.g && k.side === h.side; })) return;
      keep.push(h);
    });
    return keep;
  }

  function parseLeg(raw, hint) {
    var text = String(raw).trim().replace(/\s+/g, ' ');
    var odds = null, m;
    // a trailing price like -110 / +350 / (−258); spreads never reach 100
    if ((m = /\s*(?:@|odds)?\s*\(?\s*([+\-−]\d{3,5})\s*\)?\s*$/i.exec(text)) && text.slice(0, m.index).trim()) {
      var pv = Number(m[1].replace('−', '-'));
      if (Math.abs(pv) >= 100) { odds = pv; text = text.slice(0, m.index).trim(); }
    }
    var leg = { raw: String(raw).trim(), text: text, odds: odds };
    if (hint && hint.odds != null && leg.odds == null) leg.odds = hint.odds;
    var low = text.toLowerCase();

    // player props
    var yes = /^(.*?)\s+(anytime\s*(td|touchdown)|atd|to score( a)?( td| touchdown)?|any time td|td scorer)$/i.exec(text);
    var thr = /^(.*?)\s+(to throw( a)? (td|touchdown)|1\+ pass(ing)? td)$/i.exec(text);
    var over = /^(.*?)\s+(?:over|o)\s*([\d.]+)\s+(.+)$/i.exec(text);
    var plus = /^(.*?)\s+(\d+(?:\.\d+)?)\+\s*(.+)$/i.exec(text);
    if (thr) { leg.market = 'prop'; leg.player = thr[1]; leg.what = 'pass TDs'; leg.line = 0.5; leg.side = 'yes'; }
    else if (yes) { leg.market = 'prop'; leg.player = yes[1]; leg.what = 'TDs'; leg.line = 0.5; leg.side = 'yes'; }
    else if (over && statOf(over[3])) { leg.market = 'prop'; leg.player = over[1]; leg.line = Number(over[2]); leg.what = statOf(over[3]); leg.side = 'over'; }
    else if (plus && statOf(plus[3])) { leg.market = 'prop'; leg.player = plus[1]; leg.line = Number(plus[2]) - 0.5; leg.what = statOf(plus[3]); leg.side = 'over'; }
    if (leg.market === 'prop') {
      leg.player = leg.player.replace(/\s*[\(\[].*?[\)\]]\s*/g, ' ').replace(/^.*?:\s*/, '').trim();
      leg.player = cleanPlayer(leg.player) || titleName(leg.player);
      var ht = findTeams(text.replace(leg.player, ' '));
      leg.g = hint && hint.g ? String(hint.g) : (ht[0] && ht[0].g) || playerGame[squash(leg.player)] || null;
      return leg;
    }

    if (hint && hint.g && !games[hint.g]) { leg.g = String(hint.g); leg.market = 'pending'; return leg; }
    var teams = hint && hint.g && games[hint.g] ? findTeams(text).filter(function (t) { return t.g === String(hint.g); }) : findTeams(text);
    if (hint && hint.g && !teams.length && games[hint.g]) teams = [{ g: String(hint.g), side: null }];
    if ((m = /(?:^|\s)(over|under|o|u)\s*([\d.]+)(?=\s|$)/i.exec(low))) {
      leg.market = 'total'; leg.dir = /^o/i.test(m[1]) ? 'over' : 'under'; leg.line = Number(m[2]);
      if (teams[0]) leg.g = teams[0].g;
      return leg;
    }
    if (!teams.length) { leg.market = null; return leg; }
    var t = teams[0];
    leg.g = t.g; leg.side = t.side;
    if ((m = /(^|\s)([+-]\s*\d+(?:\.\d+)?|pk|pick'?em|pick)(\s|$)/i.exec(text)) && !/\b(ml|moneyline)\b/i.test(low)) {
      var v = /^p/i.test(m[2]) ? 0 : Number(m[2].replace(/\s/g, ''));
      if (Math.abs(v) < 70) { leg.market = 'spread'; leg.line = v; return leg; }
    }
    leg.market = 'ml'; leg.line = 0;
    return leg;
  }

  function teamName(t) { return t.location && t.location.length <= 16 ? t.location : (t.shortDisplayName || t.abbreviation); }
  function abbr(t) { return t.abbreviation || t.shortDisplayName; }
  function scoreLine(g) { return abbr(g.a) + ' ' + g.as + '–' + g.hs + ' ' + abbr(g.h); }
  function clockStr(g) {
    if (g.state === 'pre') return new Date(g.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    if (g.state === 'post') return 'Final';
    return g.detail || ('Q' + g.period + ' ' + g.clock);
  }
  function fmt(n) { return (Math.round(n * 10) / 10).toString(); }
  function sgn(n) { n = Math.round(n * 10) / 10; return (n > 0 ? '+' : '') + n; }

  var ocrLib = null;
  function loadOcr() {
    if (ocrLib) return ocrLib;
    ocrLib = new Promise(function (res, rej) {
      var sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
      sc.onload = function () { res(window.Tesseract); }; sc.onerror = function () { ocrLib = null; rej(new Error('load')); };
      document.head.appendChild(sc);
    });
    return ocrLib;
  }
  function prepImage(file) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () {
        var k = img.width < 900 ? 2 : 1;
        var c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k;
        var x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
        var d = x.getImageData(0, 0, c.width, c.height), px = d.data, sum = 0;
        for (var i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        var dark = sum / (px.length / 4) < 128;
        for (var j = 0; j < px.length; j += 4) {
          var v = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
          if (dark) v = 255 - v;
          v = v < 150 ? 0 : 255;
          px[j] = px[j + 1] = px[j + 2] = v;
        }
        x.putImageData(d, 0, 0);
        URL.revokeObjectURL(img.src);
        res(c);
      };
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }

  window.SlipKit = {
    ESPN: ESPN, games: games, getJSON: getJSON, readGame: readGame, fetchBoards: fetchBoards,
    parseLeg: parseLeg, hardRockText: hardRockText, statOf: statOf, findTeams: findTeams,
    teamName: teamName, abbr: abbr, clockStr: clockStr, fmt: fmt, sgn: sgn, esc: esc, uid: uid,
    dec: dec, amer: amer, money: money, ymd: ymd, normName: normName, squash: squash,
    loadOcr: loadOcr, prepImage: prepImage
  };
})();

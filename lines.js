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
      aRec: g(away, 'records.0.summary') || null, hRec: g(home, 'records.0.summary') || null,
      venue: g(c, 'venue.fullName') ? g(c, 'venue.fullName') + (g(c, 'venue.address.city') ? ' · ' + g(c, 'venue.address.city') + (g(c, 'venue.address.state') ? ', ' + g(c, 'venue.address.state') : '') : '') : null,
      tv: g(c, 'broadcasts.0.names.0') || null,
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
  // ESPN also lists players as Injured Reserve, PUP, Suspended, etc. Those players are out too.
  var OUT_LIKE = /injured reserve|^ir\b|physically unable|pup|suspend|non-football|nfi|reserve|commissioner/i;
  // "Deebo Samuel Sr." and "Deebo Samuel" are the same player.
  var injKey = function (n) { return String(n || '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, ''); };
  function readInjuries(json) {
    var byTeam = {}, byName = {}, all = {};
    (g(json, 'injuries') || []).forEach(function (t) {
      var list = [];
      (t.injuries || []).forEach(function (i) {
        var st = i.status || '';
        if (!STATUS_RANK[st] && OUT_LIKE.test(st)) st = 'Out';
        if (!STATUS_RANK[st]) return;
        var pos = g(i, 'athlete.position.abbreviation') || '';
        var name = g(i, 'athlete.displayName') || '';
        var det = [g(i, 'details.type'), g(i, 'details.detail')].filter(Boolean).join(', ');
        var row = { name: name, pos: pos, status: st, note: det || '' };
        byName[name] = row;
        byName[injKey(name)] = row;
        // Team-level flags: any QB status, other skill players only when out or doubtful (questionable backups are noise).
        if (KEYPOS[pos] && (pos === 'QB' || st !== 'Questionable')) list.push(row);
        (all[t.displayName] = all[t.displayName] || []).push(row);
      });
      list.sort(function (x, y) { return (KEYPOS[y.pos] * 10 + STATUS_RANK[y.status]) - (KEYPOS[x.pos] * 10 + STATUS_RANK[x.status]); });
      byTeam[t.displayName] = list;
    });
    Object.keys(all).forEach(function (k) { all[k].sort(function (x, y) { return (STATUS_RANK[y.status] * 10 + (KEYPOS[y.pos] || 0)) - (STATUS_RANK[x.status] * 10 + (KEYPOS[x.pos] || 0)); }); });
    return { byTeam: byTeam, byName: byName, all: all };
  }
  function injEntry(row, team) {
    if (!row) return [team, 'No designation', 'No key injuries listed'];
    return [row.name, row.status, row.pos + (row.note ? ' · ' + row.note : '') + (team ? ' (' + team + ')' : '')];
  }


  // ---------- the Horseshoe verdict: one score, one rating, one pick per slot, used by every section and the track record
  // score  = value against the price (Horseshoe chance x payout) x3, plus a little credit for likelihood, signals and a public fade.
  // conf   = that score as a 5-95 rating (drives the horseshoes and confidence bars everywhere).
  // bar    = passes the Horseshoe's checks (NFL: 2 of 3 signals; college: 1, moneylines 2; or a fade-the-public spot), not held.
  // pick   = the best bar-passing line in its slot. A game has one "side" slot (both teams' moneylines and spreads),
  //          one total slot, and each player prop line is its own slot. Everything else in the slot points at the pick.
  function decOf(o) { return o > 0 ? 1 + o / 100 : 1 + 100 / -o; }
  function slotOf(l, nfl) {
    if (l.k === 'prop') return 'p|' + (l.pk || l.label);
    var kind = nfl ? l.mk : l.k;
    return l.g + '|' + (kind === 'total' ? 'total' : 'side');
  }
  function rateLegs(legs, nfl) {
    legs.forEach(function (l) {
      var sig = l.s ? l.s[0] + l.s[1] + l.s[2] : 0;
      var kind = nfl ? (l.k === 'prop' ? 'prop' : l.mk) : l.k;
      var need = nfl ? 2 : (kind === 'ml' ? 2 : 1);
      var ev = l.p * decOf(l.odds) - 1;
      var base = ev * 3 + (l.p - 0.5) * 0.6 + sig * 0.02 + (l.fade ? 0.02 : 0);
      l.ev = Math.round(ev * 10000) / 10000;
      l.bar = !l.held && !l.alt && (sig >= need || !!l.fade);
      l.score = Math.round((base - (l.bar ? 0 : 1)) * 10000) / 10000;
      l.conf = clamp(Math.round(50 + base * 100), 5, 95);
      l.slot = slotOf(l, nfl);
      delete l.pick; delete l.slotPick;
    });
    var best = {};
    legs.forEach(function (l) { if (l.bar && (!best[l.slot] || l.score > best[l.slot].score)) best[l.slot] = l; });
    legs.forEach(function (l) {
      var b = best[l.slot];
      l.pick = !!(b && b === l);
      if (b && b !== l) l.slotPick = b.label;
    });
  }

  // ---------- NFL
  // ---------- what the track record has taught us so far, plus kickoff wind
  // Small, labeled nudges to the Horseshoe chance (p). Logged on each pick as l.tilt so the record can show whether they help.
  //  - spreads where the line moved 1-2.5 pts toward the team: the "sweet spot" (+1.5%)
  //  - those spreads at 7 points or less: +1%
  //  - lines that already moved 3-4.5 pts toward us: mostly priced in (-1%)
  //  - unders after the total dropped 3-4.5 pts: priced in (-3%)
  //  - wind 15+ mph at an outdoor kickoff: unders +3% (20+ mph: +5%), overs the reverse
  // Oct 21 update, from 120 graded picks (Oct 16-20). Small samples, so these are nudges, not verdicts:
  //  - home underdogs on the spread: +1.5% (was +1%)
  //  - college dogs getting 14+: +1%; college favorites laying 14+: -1.5%
  //  - college moneyline favorites: -2%
  //  - college totals on movement alone (no book shading, no wind): held, no longer Horseshoe picks
  //  - college totals the books are shading: +1%
  function tiltLegs(legs, evById, wx, nfl) {
    var W = (wx && wx.games) || {};
    var sideOf = function (e, label) {
      var low = String(label).toLowerCase();
      var hit = null;
      ['a', 'h'].forEach(function (sd) {
        var t = sd === 'a' ? e.a : e.h;
        [t.location, t.shortDisplayName, t.displayName, t.name].forEach(function (n) { if (!hit && n && low.indexOf(String(n).toLowerCase() + ' ') === 0) hit = sd; });
      });
      return hit;
    };
    var hasTotal = {};
    // A held leg drops below the Horseshoe bar: it isn't a Horseshoe pick and isn't counted on the record,
    // but it still shows (and can fill a slip) when its game is picked. Its original checks are kept in sOrig.
    var hold = function (l, why) { l.held = why; l.sOrig = l.s; l.s = [0, 0, 0]; };
    legs.forEach(function (l) {
      if (l.alt || l.k === 'prop') return;
      var e = evById[l.g], o = e && e.odds;
      if (!o) return;
      var kind = l.mk || l.k, adj = 0, why = [];
      var sig = l.s ? l.s[0] + l.s[1] + l.s[2] : 0;
      if (kind === 'spread') {
        var sd = sideOf(e, l.label);
        if (sd && o.aOpen != null && o.aNow != null) {
          var m = o.aOpen - o.aNow, am = Math.abs(m), toward = m !== 0 && (m > 0) === (sd === 'a');
          var line = sd === 'a' ? o.aNow : -o.aNow;
          var sweet = toward && am >= 1 && am < 3;
          // Wk 1 (Oct 16-18): spreads after a 1-2.5 pt move went 17-7; after 3-4.5 pts, 6-9.
          if (sweet) { adj += 0.025; why.push('sweet-spot move'); }
          if (toward && am >= 3 && am < 5 && sig) hold(l, 'line already moved ' + am + ' pts, mostly priced in');
          // Home underdogs 9-4, home favorites 6-7. Through Oct 20: college home dogs 8-3, so the nudge goes up a notch.
          if (sd === 'h' && line > 0) { adj += 0.015; why.push('home dog'); }
          if (sd === 'h' && line < 0 && !sweet) { adj -= 0.015; why.push('home favorite tax'); }
          // Through Oct 20: college dogs getting 14+ went 4-0, college favorites laying 14+ went 4-5.
          if (!nfl && line >= 14) { adj += 0.01; why.push('big college dog'); }
          if (!nfl && line <= -14) { adj -= 0.015; why.push('laying 14+ in college'); }
        }
      }
      // Through Oct 20: college moneyline favorites hit 59% when the Horseshoe expected 71% (10-7, -$35 at $10),
      // while college dogs on the moneyline went 7-7 for a profit. Favorites pay heavy juice, so they get marked down.
      if (kind === 'ml' && !nfl && l.odds < 0) { adj -= 0.02; why.push('college ML favorite tax'); }
      if (kind === 'total') {
        hasTotal[l.g] = 1;
        var under = /^under/i.test(l.label), tm = o.tot != null && o.tOpen != null ? o.tot - o.tOpen : 0;
        var shaded = l.s && l.s[1] === 1, atm = Math.abs(tm);
        var w = W[l.g], windy = w && !w.indoor && w.wind >= 15;
        // Unders after a 3-4.5 pt drop went 4-8: the move is priced in.
        if (under && tm <= -3 && tm > -5 && !windy && sig) hold(l, 'total already dropped ' + atm);
        // College totals backed only by line movement (no book shading, move under 5, no wind) went 16-20 through Oct 20,
        // even after a markdown; with book shading, 6-3. Movement-only college totals are now held: shown, not Horseshoe picks.
        else if (!shaded && atm < 5 && !windy && !nfl) { if (sig) hold(l, 'movement only, no book shading'); else { adj -= 0.015; why.push('movement only, no book shading'); } }
        if (shaded && !nfl && !l.held) { adj += 0.01; why.push('books shading it'); }
        if (!under && tm >= 1 && tm < 3 && !shaded) { adj -= 0.01; why.push('small rise, no shading'); }
        if (windy) {
          var k = w.wind >= 20 ? 0.05 : 0.03;
          adj += under ? k : -k;
          why.push('wind ' + Math.round(w.wind) + ' mph at kickoff');
        }
      }
      if (l.held) l.note = (l.note ? l.note + '; ' : '') + 'held: ' + l.held;
      if (!adj) return;
      l.p = clamp((l.p == null ? imp(l.odds) * 0.955 : l.p) + adj, 0.01, 0.97);
      l.conf = clamp(Math.round((l.conf || 50) + adj * 100), 5, 95);
      l.tilt = Math.round(adj * 1000) / 1000;
      if (why.length) l.note = (l.note ? l.note + '; ' : '') + why.join(', ');
    });
    // Strong wind with no total on the board yet: offer the Under (below the Horseshoe bar, but there to pick).
    Object.keys(W).forEach(function (gid) {
      var w = W[gid], e = evById[gid];
      if (!w || w.indoor || w.wind < 18 || hasTotal[gid] || !e || e.state !== 'pre' || !e.odds || e.odds.tot == null) return;
      var o = e.odds, iO = imp(o.oOdds), iU = imp(o.uOdds), k = w.wind >= 20 ? 0.05 : 0.03;
      var pu = clamp(iU / (iO + iU) + k, 0.01, 0.97);
      var leg = { g: gid, label: 'Under ' + o.tot, odds: o.uOdds, p: pu, conf: Math.round(pu * 100), s: [0, 0, 0], tilt: k, wxOnly: true,
        note: 'Wind ' + Math.round(w.wind) + ' mph at kickoff' + (w.gust ? ', gusts ' + Math.round(w.gust) : '') };
      if (nfl) { leg.k = 'line'; leg.mk = 'total'; } else leg.k = 'total';
      legs.push(leg);
    });
  }

  // ---------- NFL models: Sam's Models (leads) and the Horseshoe EPA ratings (data/nfl-model.json)
  // Blend for the projected margin: Sam 60%, EPA 40%. The NFL market is sharp and EPA ratings are noisy early, so:
  //  - moneylines: the Horseshoe chance becomes 80% market, 20% model
  //  - spreads: held when Sam disagrees by 2.5+ pts AND the blend by 3+ (EPA alone can't hold a pick); a 2+ pt
  //    disagreement is a small markdown; agreement (Sam 1.5+, blend 2+) a small bump. When Sam and the blend both
  //    put a side 3+ pts past the line, that side becomes a "Model edge" leg.
  //  - totals: Sam's projected total 3+ pts the same way is a small bump, 3.5+ the other way a small markdown
  // Every touched leg logs l.model (edge in points, or model win chance on moneylines) so the record shows if it helps.
  var NFL_HFA = 1.5, NFL_SD = 13.5;
  function nflModelLegs(legs, slate, nm) {
    var T = (nm && nm.teams) || {};
    var nv = function (x) { return ({ LAR: 'LA', WSH: 'WAS' })[x] || x; };
    var add = function (l, why) { l.note = (l.note ? l.note + '; ' : '') + why; };
    var bump = function (l, d) { if (l.p == null) l.p = imp(l.odds) * 0.955; l.p = clamp(l.p + d, 0.01, 0.97); l.conf = clamp(Math.round((l.conf || 50) + d * 100), 5, 95); };
    var hold = function (l, why) { if (l.held) return; l.held = why; l.sOrig = l.s; l.s = [0, 0, 0]; add(l, 'held: ' + why); };
    slate.forEach(function (sl) {
      var tA = T[nv(sl.aAbbr)], tH = T[nv(sl.hAbbr)];
      var mE = tA && tH && tA.rating != null && tH.rating != null ? Math.round((tH.rating - tA.rating + (sl.n ? 0 : (nm.hfa || NFL_HFA))) * 10) / 10 : null;
      var sm = sl.sam && sl.sam.m != null ? sl.sam : null;
      if (mE == null && !sm) return;
      var m = mE != null && sm ? Math.round((0.4 * mE + 0.6 * sm.m) * 10) / 10 : mE != null ? mE : sm.m;
      var pH = phi(m / NFL_SD);
      sl.mx = { m: m, pH: pH, t: sm ? sm.total : null, sam: sl.sam, epa: mE };
      sl.mxSrcs = modelView(sl, { sam: sm, epa: mE != null ? { m: mE } : null });
      var o = sl.odds, edgeH = Math.round((m + sl.hs) * 10) / 10, mSide = edgeH > 0 ? 'h' : edgeH < 0 ? 'a' : null, edge = Math.abs(edgeH);
      var sEdgeH = sm ? Math.round((sm.m + sl.hs) * 10) / 10 : null;
      var fav = m >= 0 ? sl.h : sl.a, proj = 'Models: ' + fav + ' by ' + Math.abs(m).toFixed(1) + (sm ? ' (Sam ' + (sm.m >= 0 ? sl.h : sl.a) + ' by ' + Math.abs(sm.m).toFixed(1) + ')' : '');
      var sideOf = function (label) { if (label.indexOf(sl.a + ' ') === 0) return 'a'; if (label.indexOf(sl.h + ' ') === 0) return 'h'; return null; };
      var mine = legs.filter(function (l) { return l.g === sl.id && !l.alt && l.k === 'line'; });
      mine.forEach(function (l) {
        var side = sideOf(l.label);
        if (l.mk === 'ml' && side) {
          var pm = side === 'h' ? pH : 1 - pH;
          if (l.p == null) l.p = imp(l.odds) * 0.955;
          var before = l.p;
          l.p = clamp(l.p * 0.8 + pm * 0.2, 0.01, 0.97);
          l.conf = clamp(Math.round((l.conf || 50) + (l.p - before) * 100), 5, 95);
          l.model = Math.round(pm * 1000) / 1000;
          add(l, proj + ', wins ' + pct(pm));
        } else if (l.mk === 'spread' && side && mSide) {
          var agree = side === mSide, samWith = sEdgeH == null ? null : (side === 'h' ? sEdgeH : -sEdgeH);
          l.model = agree ? edge : -edge;
          if (!agree && edge >= 3 && samWith != null && samWith <= -2.5) hold(l, proj + ', models disagree by ' + edge + ' pts');
          else if (!agree && edge >= 2) { bump(l, -0.01); add(l, proj + ', models lean the other way'); }
          else if (agree && edge >= 2 && samWith != null && samWith >= 1.5) { bump(l, Math.min(0.02, edge * 0.005)); add(l, proj + ', models agree (' + edge + ' pts)'); }
        } else if (l.mk === 'total' && sm && sm.total != null && o.tot != null) {
          var dir = /^over/i.test(l.label) ? 1 : -1, te = Math.round((sm.total - o.tot) * 10) / 10;
          l.model = te * dir;
          if (te * dir >= 3) { bump(l, 0.01); add(l, 'Sam’s total ' + sm.total.toFixed(1) + ', ' + Math.abs(te) + ' pts ' + (dir > 0 ? 'over' : 'under')); }
          else if (te * dir <= -3.5) { bump(l, -0.015); add(l, 'Sam’s total ' + sm.total.toFixed(1) + ', leans the other way'); }
        }
      });
      // both models 3+ pts past the line on the same side: a Model edge spread
      var sAgree = sEdgeH != null && Math.sign(sEdgeH) === Math.sign(edgeH) && Math.abs(sEdgeH) >= 3;
      if (mSide && edge >= 3 && sAgree && o) {
        var line = mSide === 'a' ? o.aNow : -o.aNow, label = (mSide === 'a' ? sl.a : sl.h) + ' ' + signed(line);
        var ex = mine.filter(function (l) { return l.mk === 'spread' && l.label === label; })[0];
        var mp = 0.5 + Math.min(0.03, (edge - 2) * 0.006);
        var why = 'Model edge: ' + proj.replace('Models: ', '') + ' vs the ' + signed(line) + ' line';
        if (ex && !ex.held) { if (!(ex.s && ex.s[0] + ex.s[1] + ex.s[2] >= 2)) { ex.s = [1, mSide === 'h' ? 1 : 0, 1]; ex.p = Math.max(ex.p || 0, mp); ex.note = why; } ex.modelPick = true; ex.model = edge; }
        else if (!ex) legs.push({ g: sl.id, k: 'line', mk: 'spread', label: label, odds: (mSide === 'a' ? o.aSpOdds : o.hSpOdds) || -110, p: mp, conf: Math.round(mp * 100) + 8,
          s: [1, mSide === 'h' ? 1 : 0, 1], modelPick: true, model: edge, note: why });
      }
    });
  }

  function buildNfl(json, injJson, extra) {
    var inj = readInjuries(injJson || {});
    var events = (g(json, 'events') || []).map(readEvent).filter(Boolean);
    var games = [], legs = [], injMap = {}, liveIds = {}, shortToId = {}, slate = [], played = {};
    // teams whose game this week has started or finished (the Fantasy tab uses real points for them)
    events.forEach(function (e) { if (e.state && e.state !== 'pre') { played[e.a.abbreviation] = e.state; played[e.h.abbreviation] = e.state; } });
    var firstDate = null;
    events.forEach(function (e) {
      if (e.state !== 'pre' || !e.odds || e.odds.aNow == null) return;
      var day = etDay(e.date);
      var label = e.short + (day && day !== 'Sun' ? ' (' + day + ')' : '');
      games.push({ id: e.id, label: label, date: e.date });
      // for the matchup page: both teams, the line now and at open, logos, colors, records, venue
      slate.push({ id: e.id, a: e.a.shortDisplayName, h: e.h.shortDisplayName, aFull: e.a.displayName, hFull: e.h.displayName, aAbbr: e.a.abbreviation, hAbbr: e.h.abbreviation,
        n: e.neutral, short: e.short, date: e.date, hs: -e.odds.aNow, tot: e.odds.tot, odds: e.odds, cf: 'NFL',
        info: { aLogo: e.a.logo || null, hLogo: e.h.logo || null, aColor: e.a.color || null, hColor: e.h.color || null, aAlt: e.a.alternateColor || null, hAlt: e.h.alternateColor || null,
          aRec: e.aRec, hRec: e.hRec, venue: e.venue, tv: e.tv, open: e.odds.aOpen != null ? -e.odds.aOpen : null, tOpen: e.odds.tOpen } });
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
        injMap[e.id + '|' + fav + ' moneyline'] = injEntry(favInj, fav);
      }
      if (steam) {
        var side = steam === 'a' ? A : H, line = steam === 'a' ? o.aNow : -o.aNow;
        var crossKey = [3, 7].some(function (k) { var lo = Math.min(Math.abs(o.aOpen), Math.abs(o.aNow)), hi = Math.max(Math.abs(o.aOpen), Math.abs(o.aNow)); return lo < k && hi >= k; });
        var spLabel = side + ' ' + signed(line);
        legs.push({ g: e.id, k: 'line', mk: 'spread', label: spLabel, odds: steam === 'a' ? o.aSpOdds : o.hSpOdds,
          conf: clamp(56 + Math.round(Math.abs(mv) * 4) + (crossKey ? 3 : 0), 50, 74),
          s: [Math.abs(mv) >= 1.5 ? 1 : 0, steam === 'h' ? 1 : 0, 1],
          note: 'Opened ' + signed(steam === 'a' ? o.aOpen : -o.aOpen) + ', now ' + signed(line) + (crossKey ? ', moved through a key number' : '') });
        injMap[e.id + '|' + spLabel] = injEntry((inj.byTeam[steam === 'a' ? e.a.displayName : e.h.displayName] || [])[0], side);
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
          injMap[e.id + '|' + tl] = injEntry(both[0], '');
        }
      }
      // Every other side of this game, so picking a game shows all of its legs.
      // These carry honest signals, so most fall below the Horseshoe bar and only appear when the game is picked.
      var have = {};
      legs.forEach(function (l) { if (l.g === e.id) have[l.label] = 1; });
      var teamInj = function (side) { return (inj.byTeam[side === 'a' ? e.a.displayName : e.h.displayName] || [])[0]; };
      ['a', 'h'].forEach(function (side) {
        var T = side === 'a' ? A : H, p = side === 'a' ? pA : pH, ml = side === 'a' ? aml : hml;
        var toward = steam === side, ti = teamInj(side);
        var lab = T + ' moneyline';
        if (!have[lab]) {
          var pp = clamp(p + (toward ? bump : steam ? -bump : 0), 0.03, 0.97);
          legs.push({ g: e.id, k: 'line', mk: 'ml', label: lab, odds: ml, conf: clamp(Math.round(pp * 100) - (ti && ti.pos === 'QB' ? 8 : 0), 5, 92),
            s: [pp >= 0.66 && ml >= -650 ? 1 : 0, side === 'h' ? 1 : 0, toward ? 1 : 0],
            note: T + ' ' + signed(side === 'a' ? o.aNow : -o.aNow) + ', no-vig ' + pct(p) + (toward ? ', ' + mvTxt : steam ? ', line moving away from them' : '') + (est ? '; price est. from spread' : '') });
          injMap[e.id + '|' + lab] = injEntry(ti, T);
        }
        var ln = side === 'a' ? o.aNow : -o.aNow;
        var slab = T + ' ' + signed(ln);
        if (!have[slab]) {
          legs.push({ g: e.id, k: 'line', mk: 'spread', label: slab, odds: side === 'a' ? o.aSpOdds : o.hSpOdds,
            conf: clamp(52 + (toward ? Math.round(Math.abs(mv) * 4) : steam ? -Math.round(Math.abs(mv) * 2) : 0) + (side === 'h' ? 1 : 0), 40, 74),
            s: [toward && Math.abs(mv) >= 1.5 ? 1 : 0, side === 'h' ? 1 : 0, toward ? 1 : 0],
            note: 'Opened ' + signed(side === 'a' ? o.aOpen : -o.aOpen) + ', now ' + signed(ln) + (steam && !toward ? ', money on the other side' : '') });
          injMap[e.id + '|' + slab] = injEntry(ti, T);
        }
      });
      if (o.tot != null) {
        var tm = o.tot - o.tOpen;
        var jz = o.oOdds < o.uOdds - 7 ? 'Over' : o.uOdds < o.oOdds - 7 ? 'Under' : null;
        ['Over', 'Under'].forEach(function (d) {
          var lab = d + ' ' + o.tot;
          if (have[lab]) return;
          var mvd = (d === 'Over' && tm >= 1) || (d === 'Under' && tm <= -1);
          var against = (d === 'Over' && tm <= -1) || (d === 'Under' && tm >= 1);
          legs.push({ g: e.id, k: 'line', mk: 'total', label: lab, odds: d === 'Over' ? o.oOdds : o.uOdds,
            conf: clamp(52 + (mvd ? Math.round(Math.abs(tm) * 3) : against ? -Math.round(Math.abs(tm) * 2) : 0) + (jz === d ? 4 : jz ? -2 : 0), 40, 72),
            s: [mvd ? 1 : 0, jz === d ? 1 : 0, mvd && Math.abs(tm) >= 2 ? 1 : 0],
            note: (o.tOpen !== o.tot ? 'Total moved ' + o.tOpen + ' → ' + o.tot : 'Total steady at ' + o.tot) + (jz === d ? ', books shading the ' + d : '') });
          var b2 = (inj.byTeam[e.a.displayName] || []).concat(inj.byTeam[e.h.displayName] || []);
          b2.sort(function (x, y) { return (KEYPOS[y.pos] * 10 + STATUS_RANK[y.status]) - (KEYPOS[x.pos] * 10 + STATUS_RANK[x.status]); });
          injMap[e.id + '|' + lab] = injEntry(b2[0], '');
        });
      }
    });
    // Full prop and alternate-line menu from SportsGameOdds (refreshed every 6 hours by the GitHub Action).
    var sgoGames = {}, propRows = [];
    var byTeams = {};
    events.forEach(function (e) { if (liveIds[e.id]) byTeams[e.a.displayName + '|' + e.h.displayName] = e; });
    var sgoAsOf = extra.sgo && extra.sgo.updated ? new Date(extra.sgo.updated) : null;
    var sgoStamp = sgoAsOf ? ' · line as of ' + etTime(sgoAsOf) + ' ET' : '';
    // Use the vig-free consensus only when it belongs to the same line we're showing; otherwise strip a typical cut from the price.
    var fairP = function (fair, odds) {
      var base = imp(odds) * 0.955;
      if (fair != null && isFinite(fair) && fair !== 0 && Math.abs(imp(fair) - imp(odds)) < 0.03) return imp(fair);
      return base;
    };
    // Horseshoe prop leans from props.json carry over onto the live prop lines (same player, stat and side).
    var leanMap = {};
    ((extra.props || {}).legs || []).forEach(function (p) {
      var m = /^(.*) (over|under) ([\d.]+) (.*)$/.exec(p.label);
      if (m && p.s && p.s[0] + p.s[1] + p.s[2] >= 2) leanMap[m[1] + '|' + m[4] + '|' + m[2]] = { s: p.s, conf: p.conf, note: p.note, line: Number(m[3]), game: p.game };
    });
    ((extra.sgo || {}).events || []).forEach(function (ev) {
      var e = byTeams[ev.away + '|' + ev.home];
      if (!e) return;
      sgoGames[e.id] = 1;
      var A = e.a.shortDisplayName, H = e.h.shortDisplayName;
      (ev.props || []).forEach(function (pr) {
        // Skip lines no one would parlay: near-locks shorter than -400 and lottery tickets longer than +2500.
        if (pr.odds < -400 || pr.odds > 2500) return;
        if (pr.side === 'under') return; // player props: overs (and yes props like anytime TD) only
        if (pr.c === 'kick' || pr.c === 'def') return; // no kicking or defense props (field goals, sacks, tackles)
        // Line check works on yardage and count props priced near even money; TD props and long prices don't compare cleanly.
        if (pr.books && !pr.alt && !/TD|interception/i.test(pr.what)) {
          var pb = {}, lines = [];
          Object.keys(pr.books).forEach(function (bk) {
            var key = SGO_BOOK[bk] || bk, v = pr.books[bk];
            if (BOOKS[key] && v[1] >= -250 && v[1] <= 200) { pb[key] = v; lines.push(v[0]); }
          });
          lines.sort(function (x, y) { return x - y; });
          var med = lines.length ? lines[Math.floor(lines.length / 2)] : 0;
          Object.keys(pb).forEach(function (k) { if (Math.abs(pb[k][0] - med) > Math.max(2.5, med * 0.2)) delete pb[k]; }); // drop alt-line outliers
          propRows.push({ label: pr.player + ' ' + pr.what, game: e.short, kind: /yds|longest/.test(pr.what) ? 'yds' : 'rec', books: pb });
        }
        var who = inj.byName[pr.player] || inj.byName[injKey(pr.player)];
        if (who && (who.status === 'Out' || who.status === 'Doubtful')) return;
        var YES = { touchdowns: 'anytime TD', defense_sacks: 'to record a sack', passing_interceptions: 'to throw an interception', passing_touchdowns: 'to throw a TD', fieldGoals_made: 'to make a field goal', receiving_yards: 'to record a catch', rushing_attempts: 'to record a rush' };
        if (pr.side === 'yes' && !YES[pr.stat]) return;
        var label = pr.side === 'yes' ? pr.player + ' ' + YES[pr.stat] : pr.player + ' ' + pr.side + ' ' + pr.line + ' ' + pr.what;
        // Hard Rock doesn't offer alternate lines on longest reception/rush/completion or completions, so only the main line is used.
        if (pr.alt && (/longest/i.test(pr.stat) || pr.stat === 'passing_completions')) return;
        if (pr.alt) {
          // Alternate prop line: only used to feather a parlay toward its target price.
          var ap = imp(pr.odds) * 0.955;
          legs.push({ g: e.id, k: 'prop', c: pr.c, pk: e.id + '|' + pr.player + '|' + pr.stat, alt: true, label: label + ' (alt)', odds: pr.odds, p: ap,
            conf: clamp(Math.round(ap * 100) - 20, 3, 80), s: [0, 0, 0], note: 'Alternate line' + sgoStamp });
          injMap[e.id + '|' + label + ' (alt)'] = who ? [who.name, who.status, who.pos + (who.note ? ' · ' + who.note : '')] : [pr.player, 'No designation', ''];
          return;
        }
        var p = fairP(pr.fair, pr.odds);
        var lean = leanMap[pr.player + '|' + pr.what + '|' + pr.side];
        if (lean && lean.game && lean.game !== e.short) lean = null; // a lean is for one matchup, not the player's next game
        if (lean && Math.abs(lean.line - pr.line) > Math.max(1.5, lean.line * 0.1)) lean = null; // line moved too far from the lean
        var qd = who && who.status === 'Questionable' ? -6 : 0;
        // Questionable players can still be picked, but never as a Horseshoe pick, and their chance is marked down.
        var qHold = who && who.status === 'Questionable';
        var pq = qHold ? Math.max(0.01, p - 0.04) : p;
        legs.push({ g: e.id, k: 'prop', c: pr.c, pk: e.id + '|' + pr.player + '|' + pr.stat, label: label, odds: pr.odds, p: pq, // narrative leans went 2-5 in Wk 1: they still flag the prop, but no longer raise its chance
          conf: clamp((lean ? Math.max(lean.conf, Math.round(pq * 100)) : Math.round(pq * 100)) + qd, 5, 90),
          s: qHold ? [0, 0, 0] : lean ? lean.s : [p >= 0.58 ? 1 : 0, 0, 0], held: qHold ? 'questionable' : undefined,
          note: (qHold ? 'Questionable' + (who.note ? ' (' + who.note + ')' : '') + '; ' : '') + (lean ? lean.note + '; ' : '') + 'books give it ' + pct(pq) + ' (vig removed)' + sgoStamp });
        injMap[e.id + '|' + label] = who ? [who.name, who.status, who.pos + (who.note ? ' · ' + who.note : '')] : [pr.player, 'No designation', ''];
      });
      var seenAlt = {};
      legs.forEach(function (l) { if (l.g === e.id) seenAlt[l.label] = 1; });
      (ev.alts || []).forEach(function (al) {
        if (al.odds == null || al.odds < -400 || al.odds > 600) return;
        if (al.type === 'ou' && al.entity && al.entity !== 'all') return; // team totals aren't game totals
        var label, mk;
        if (al.type === 'sp') { var T = al.side === 'away' ? A : H; label = T + ' ' + signed(al.line); mk = 'spread'; }
        else { label = (al.side === 'over' ? 'Over ' : 'Under ') + al.line; mk = 'total'; }
        if (seenAlt[label]) return;
        seenAlt[label] = 1;
        var p = imp(al.odds) * 0.955;
        // Alternate lines rank below main lines so they only fill a game's spread/total slot when nothing better is there.
        legs.push({ g: e.id, k: 'line', mk: mk, alt: true, label: label + ' (alt)', odds: al.odds, conf: clamp(Math.round(p * 100) - 20, 3, 80),
          s: [0, 0, 0], note: 'Alternate line, ' + (al.book === 'draftkings' ? 'DraftKings' : al.book === 'fanduel' ? 'FanDuel' : al.book) + ' price' + sgoStamp });
      });
    });
    // Player props from the snapshot file, only for games that haven't kicked off and have no fresh prop feed.
    var props = extra.props || {};
    (props.legs || []).forEach(function (p) {
      var gid = shortToId[p.game];
      if (!gid || sgoGames[gid]) return;
      if (/ under /.test(p.label)) return; // overs only
      var who = inj.byName[p.player];
      if (who && (who.status === 'Out' || who.status === 'Doubtful')) return;
      var asOf = props.asOf ? ' · prop line as of ' + props.asOf : '';
      var whoRow = who ? [who.name, who.status, who.pos + (who.note ? ' · ' + who.note : '')] : [p.player, 'No designation', ''];
      var qDrop = who && who.status === 'Questionable' ? 6 : 0;
      legs.push({ g: gid, k: 'prop', c: p.c, pk: gid + '|' + p.player + '|' + p.label.replace(/^.* (over|under) [\d.]+ /, ''), label: p.label, odds: p.odds, conf: p.conf - qDrop, s: p.s, note: p.note + asOf });
      injMap[gid + '|' + p.label] = whoRow;
      // The other side of the prop, when its price is known.
      if (p.alt && p.alt.label && p.alt.odds != null && !/ under /.test(p.alt.label)) {
        legs.push({ g: gid, k: 'prop', c: p.c, pk: gid + '|' + p.player + '|' + p.label.replace(/^.* (over|under) [\d.]+ /, ''), label: p.alt.label, odds: p.alt.odds, conf: Math.max(30, 100 - p.conf - 8), s: [0, 0, 0], note: 'Other side of the Horseshoe lean' + asOf });
        injMap[gid + '|' + p.alt.label] = whoRow;
      }
    });
    // Horseshoe chance for every leg: the price with the book's cut removed, plus a small nudge for each signal it passes.
    legs.forEach(function (l) {
      if (l.p != null) return;
      var sig = l.s ? l.s[0] + l.s[1] + l.s[2] : 0;
      l.p = clamp(imp(l.odds) * 0.955 + sig * 0.012, 0.01, 0.97);
    });
    var nflById = {};
    events.forEach(function (e) { nflById[e.id] = e; });
    // Sam's Models NFL board (data/nfl-sources.json): keys look like 2026_07_NE_CHI (season_week_away_home, nflverse abbreviations)
    var samG = (((extra.nflSources || {}).sam) || {}).games || {};
    var nv = function (x) { return ({ LAR: 'LA', WSH: 'WAS' })[x] || x; };
    var samBy = {};
    Object.keys(samG).forEach(function (k) { var m = /_([A-Z]+)_([A-Z]+)$/.exec(k); if (m) samBy[m[1] + '|' + m[2]] = samG[k]; });
    slate.forEach(function (sl) {
      var x = samBy[nv(sl.aAbbr) + '|' + nv(sl.hAbbr)], flip = false;
      if (!x) { x = samBy[nv(sl.hAbbr) + '|' + nv(sl.aAbbr)]; flip = !!x; }
      if (!x) return;
      sl.sam = { m: x.m == null ? null : (flip ? -x.m : x.m), hs: flip ? x.as : x.hs, as: flip ? x.hs : x.as, total: x.as != null && x.hs != null ? Math.round((x.as + x.hs) * 10) / 10 : null,
        line: x.modelLine, pick: x.pick, number: x.number, bars: (x.bars || []).map(function (b) { return { label: b.label, pts: b.pts, toward: flip ? (b.toward === 'a' ? 'h' : 'a') : b.toward }; }),
        season: x.season, url: x.url, flip: flip };
    });
    tiltLegs(legs, nflById, extra.weather, true);
    nflModelLegs(legs, slate, extra.nflModel);
    rateLegs(legs, true);
    // Public splits (if posted) for live games only.
    var publicBoard = ((extra.splits || {}).nfl || []).filter(function (r) { return shortToId[r[0]]; });
    // Multi-book Line check from the Odds API snapshot.
    var lc = buildLineCheck(extra.books, events, propRows);
    var wk = g(json, 'week.number');
    return {
      games: games, legs: legs, mu: {}, inj: injMap, screen: [], publicBoard: publicBoard,
      slate: slate, played: played, injTeams: inj.byTeam, injAll: inj.all || null, weather: extra.weather || null, model: extra.nflModel || null,
      lineCheck: lc.rows, books: lc.books, bookShort: lc.bookShort, bookDefault: lc.def, booksAsOf: lc.asOf,
      chip: 'NFL' + (wk ? ' · Week ' + wk : '') + (firstDate ? ' · from ' + etDate(firstDate) : ''),
      count: games.length
    };
  }

  var BOOKS = {
    hardrockbet_fl: ['Hard Rock', 'HR'], bovada: ['Bovada', 'BOV'], unibet: ['Unibet', 'UNI'], pointsbet: ['PointsBet', 'PB'], hardrockbet: ['Hard Rock', 'HR'], draftkings: ['DraftKings', 'DK'], fanduel: ['FanDuel', 'FD'],
    betmgm: ['BetMGM', 'MGM'], williamhill_us: ['Caesars', 'CZR'], fanatics: ['Fanatics', 'FAN'], betrivers: ['BetRivers', 'RIV'], espnbet: ['ESPN Bet', 'ESPN']
  };
  var SGO_BOOK = { caesars: 'williamhill_us', williamhill: 'williamhill_us' };
  function buildLineCheck(books, events, propRows) {
    var out = { rows: [], books: [], bookShort: [], def: 0, asOf: null };
    propRows = propRows || [];
    var hasBooks = books && books.games && books.games.length;
    if (!hasBooks && !propRows.length) return out;
    var keys = [];
    var addKey = function (k) { if (keys.indexOf(k) === -1 && BOOKS[k]) keys.push(k); };
    if (hasBooks) books.games.forEach(function (gm) { Object.keys(gm.books || {}).forEach(addKey); });
    propRows.forEach(function (r) { Object.keys(r.books).forEach(addKey); });
    var rank = function (k) { return k.indexOf('hardrock') === 0 ? 0 : k === 'draftkings' ? 1 : k === 'fanduel' ? 2 : 3; };
    keys.sort(function (x, y) { return rank(x) - rank(y); });
    out.books = keys.map(function (k) { return BOOKS[k][0]; });
    out.bookShort = keys.map(function (k) { return BOOKS[k][1]; });
    out.def = 0;
    out.asOf = hasBooks ? books.updated : null;
    if (hasBooks) {
      var byName = {};
      events.forEach(function (e) { if (e.state === 'pre') byName[e.a.displayName + '|' + e.h.displayName] = e; });
      books.games.forEach(function (gm) {
        var e = byName[gm.away + '|' + gm.home];
        if (!e) return;
        var A = e.a.shortDisplayName, H = e.h.shortDisplayName;
        var sp = keys.map(function (k) { var b = gm.books[k]; return b && b.spread ? [b.spread[0], b.spread[1]] : null; });
        if (sp.filter(Boolean).length >= 3) out.rows.push([A + ' spread', e.short, 'spread', sp, A, H, 'line']);
        var tt = keys.map(function (k) { var b = gm.books[k]; return b && b.total ? [b.total[0], b.total[1]] : null; });
        if (tt.filter(Boolean).length >= 3) out.rows.push([e.short + ' total', e.short, 'total', tt, null, null, 'line']);
      });
    }
    propRows.forEach(function (r) {
      var arr = keys.map(function (k) { return r.books[k] || null; });
      if (arr.filter(Boolean).length >= 3) out.rows.push([r.label, r.game, r.kind, arr, null, null, 'prop']);
    });
    return out;
  }

  // ---------- College
  var CONF = { '1': 'ACC', '4': 'Big 12', '5': 'Big Ten', '8': 'SEC', '9': 'Pac-12', '18': 'Independent' };
  function confOf(e) {
    var hc = CONF[e.h.conferenceId], ac = CONF[e.a.conferenceId];
    return hc || ac || 'Group of 5';
  }
  // ---------- Horseshoe Model (data/model.json)
  // Three projections per game: our CFBD ratings blend, Bill Connelly's SP+ and David Sasser's model, averaged into one
  // projected margin (and a projected total from SP+ and Sasser). The top CFBD Pick'em models hit about 75% straight up
  // but only about 52-56% against the spread, so the model gets a real say on moneylines and a small one elsewhere:
  //  - moneylines: the Horseshoe chance becomes 70% market, 30% model
  //  - spreads: a "Model edge" leg needs 3+ pts of edge AND most of the models on that side; spreads that 4+ pts and most
  //    models disagree with are held (shown, not a Horseshoe pick); smaller agreements and disagreements are small nudges
  //  - totals: same idea against the projected total, 3+ pts to nudge, 4+ pts with both models agreeing for a leg or a hold
  // Every touched leg logs l.model (edge in points, or model win chance on MLs) so the tracker can show whether it helps.
  var MODEL_EDGE = 3, MODEL_HOLD = 4, MODEL_ML_W = 0.3, MODEL_T_EDGE = 3, MODEL_T_HOLD = 4;
  var MODEL_NAMES = { own: 'Horseshoe ratings', spx: 'SP+', ds: 'Sasser', sam: 'Sam’s Models', epa: 'Horseshoe EPA ratings' };
  function modelView(s, mp) {
    // Each model's projected margin (home minus away) and its side against the current spread and total.
    var hs = s.hs, srcs = [];
    if (mp.own && mp.own.m != null) srcs.push({ k: 'own', m: mp.own.m, t: null });
    if (mp.spx && mp.spx.m != null) srcs.push({ k: 'spx', m: mp.spx.m, t: mp.spx.total });
    if (mp.ds && mp.ds.m != null) srcs.push({ k: 'ds', m: mp.ds.m, t: mp.ds.total });
    if (mp.sam && mp.sam.m != null) srcs.push({ k: 'sam', m: mp.sam.m, t: mp.sam.total });
    if (mp.epa && mp.epa.m != null) srcs.push({ k: 'epa', m: mp.epa.m, t: null });
    if (!srcs.length && mp.m != null) srcs.push({ k: 'own', m: mp.m, t: mp.t });
    srcs.forEach(function (x) {
      x.edge = Math.round((x.m + hs) * 10) / 10;
      x.side = x.edge > 0 ? 'h' : x.edge < 0 ? 'a' : null;
      x.tSide = x.t != null && s.tot != null ? (x.t > s.tot ? 'Over' : x.t < s.tot ? 'Under' : null) : null;
      x.name = MODEL_NAMES[x.k];
    });
    return srcs;
  }
  function modelLegs(legs, slate, byId, model) {
    var G = (model && model.games) || {};
    var sd = (model && model.sd) || 15.5;
    var nmOf = function (s, side) { return side === 'a' ? s.a : s.h; };
    var sideOfLabel = function (s, label) {
      if (label.indexOf(s.a + ' ') === 0) return 'a';
      if (label.indexOf(s.h + ' ') === 0) return 'h';
      return null;
    };
    var hold = function (l, why) { if (l.held) return; l.held = why; l.sOrig = l.s; l.s = [0, 0, 0]; l.note = (l.note ? l.note + '; ' : '') + 'held: ' + why; };
    var add = function (l, why) { l.note = (l.note ? l.note + '; ' : '') + why; };
    var bump = function (l, d) { l.p = clamp(l.p + d, 0.01, 0.97); l.conf = clamp(Math.round((l.conf || 50) + d * 100), 5, 95); };
    slate.forEach(function (s) {
      var mp = G[s.id], e = byId[s.id];
      if (!mp || typeof mp.m !== 'number' || !e) return;
      var m = mp.m, o = e.odds;
      var srcs = modelView(s, mp);
      s.mp = m; s.mx = mp; s.mxSrcs = srcs;
      var fav = m >= 0 ? s.h : s.a;
      var proj = 'Model: ' + fav + ' by ' + Math.abs(m).toFixed(1);
      var edgeH = Math.round((m + s.hs) * 10) / 10; // > 0 means the blend likes the home side vs the spread
      var mSide = edgeH > 0 ? 'h' : edgeH < 0 ? 'a' : null, edge = Math.abs(edgeH);
      var withM = srcs.filter(function (x) { return x.side === mSide; }).length, nS = srcs.length;
      var most = nS < 2 || withM * 2 > nS;
      var agreeTxt = nS > 1 ? withM + ' of ' + nS + ' models' : '';
      var pH = phi(m / sd);
      var mine = legs.filter(function (l) { return l.g === s.id && !l.alt; });
      var tProj = mp.t, tEdge = tProj != null && s.tot != null ? Math.round((tProj - s.tot) * 10) / 10 : null;
      var tSide = tEdge > 0 ? 'Over' : tEdge < 0 ? 'Under' : null;
      var tSrcs = srcs.filter(function (x) { return x.tSide; });
      var tWith = tSrcs.filter(function (x) { return x.tSide === tSide; }).length;
      var tAll = tSrcs.length && tWith === tSrcs.length;
      mine.forEach(function (l) {
        var side = sideOfLabel(s, l.label);
        if (l.k === 'ml' && side) {
          var pm = side === 'h' ? pH : 1 - pH;
          l.model = Math.round(pm * 1000) / 1000;
          var before = l.p;
          l.p = clamp(l.p * (1 - MODEL_ML_W) + pm * MODEL_ML_W, 0.01, 0.97);
          l.conf = clamp(Math.round((l.conf || 50) + (l.p - before) * 100), 5, 95);
          add(l, proj + ', wins ' + pct(pm));
        } else if (l.k === 'spread' && side && mSide) {
          var agree = side === mSide;
          l.model = agree ? edge : -edge;
          if (agree && edge >= 2) { bump(l, Math.min(0.03, (edge - 1) * 0.006) * (most ? 1 : 0.5)); add(l, proj + ', ' + edge + ' pts of edge' + (agreeTxt ? ' (' + agreeTxt + ' agree)' : '')); }
          else if (!agree && edge >= MODEL_HOLD && most) hold(l, proj + ', disagrees by ' + edge + ' pts' + (agreeTxt ? ' (' + agreeTxt + ' on the other side)' : ''));
          else if (!agree && edge >= 2) { bump(l, -0.01); add(l, proj + ', leans the other way'); }
        } else if (l.k === 'total' && tSide) {
          var dir = /^over/i.test(l.label) ? 'Over' : 'Under', te = Math.abs(tEdge), tAgree = dir === tSide;
          l.model = tAgree ? te : -te;
          var tTxt = 'Model total ' + tProj.toFixed(1);
          if (tAgree && te >= MODEL_T_EDGE) {
            bump(l, Math.min(0.025, (te - 2) * 0.008) * (tAll ? 1 : 0.5));
            var sig0 = l.s ? l.s[0] + l.s[1] + l.s[2] : 0;
            if (!sig0 && !l.held && tAll && te >= MODEL_T_HOLD) { l.s = [1, 0, te >= 6 ? 1 : 0]; l.modelPick = true; if (/no Horseshoe signal/.test(l.note || '')) l.note = ''; }
            add(l, tTxt + ', ' + te + ' pts ' + (dir === 'Over' ? 'over' : 'under') + ' the number');
          } else if (!tAgree && te >= MODEL_T_HOLD && tAll) hold(l, tTxt + ', ' + te + ' pts the other way');
          else if (!tAgree && te >= 2) { bump(l, -0.01); add(l, tTxt + ', leans the other way'); }
        }
      });
      // A spread most models like by 3+ pts: upgrade the plain board leg if there is one, or add it.
      if (mSide && edge >= MODEL_EDGE && most && o) {
        var line = mSide === 'a' ? o.aNow : -o.aNow;
        var label = nmOf(s, mSide) + ' ' + signed(line);
        var odds = mSide === 'a' ? o.aSpOdds : o.hSpOdds;
        if (odds == null) odds = -110;
        var mp2 = 0.5 + Math.min(0.04, (edge - 2) * 0.008) * (withM === nS ? 1 : 0.75);
        var why = 'Model edge: ' + proj.replace('Model: ', '') + ' vs the ' + signed(line) + ' line (' + edge + ' pts' + (agreeTxt ? ', ' + agreeTxt : '') + ')';
        var ex = mine.filter(function (l) { return l.k === 'spread' && l.label === label; })[0];
        var sig = [1, withM === nS && nS > 1 ? 1 : 0, edge >= 5 ? 1 : 0];
        if (ex && !ex.held) {
          var had = ex.s ? ex.s[0] + ex.s[1] + ex.s[2] : 0;
          if (!had) { ex.s = sig; ex.p = Math.max(ex.p, mp2); ex.conf = Math.round(ex.p * 100) + 5; ex.note = why; }
          ex.modelPick = true;
        } else if (!ex) {
          legs.push({ g: s.id, k: 'spread', label: label, odds: odds, p: mp2, conf: Math.round(mp2 * 100) + 5, s: sig, dog: line > 0,
            model: edge, modelPick: true, note: why });
        }
      }
      // A total both models put 4+ pts past the number, with no leg on that side yet.
      if (tSide && tAll && tSrcs.length > 1 && Math.abs(tEdge) >= MODEL_T_HOLD && o && o.tot != null) {
        var tl = tSide + ' ' + o.tot;
        if (!mine.some(function (l) { return l.k === 'total' && l.label === tl; })) {
          var iO = imp(o.oOdds), iU = imp(o.uOdds), base = (tSide === 'Over' ? iO : iU) / (iO + iU);
          var tp = clamp(base + Math.min(0.03, (Math.abs(tEdge) - 2) * 0.008), 0.01, 0.97);
          legs.push({ g: s.id, k: 'total', label: tl, odds: tSide === 'Over' ? o.oOdds : o.uOdds, p: tp, conf: Math.round(tp * 100) + 4,
            s: [1, 0, Math.abs(tEdge) >= 6 ? 1 : 0], model: Math.abs(tEdge), modelPick: true,
            note: 'Model total ' + tProj.toFixed(1) + ' vs ' + o.tot + ' (SP+ and Sasser agree)' });
        }
      }
    });
  }

  function buildCollege(json, extra) {
    var events = (g(json, 'events') || []).map(readEvent).filter(Boolean);
    var slate = [], legs = [], byId = {};
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
      // for the matchup page: logos, colors, records, venue
      s.info = { aLogo: e.a.logo || null, hLogo: e.h.logo || null, aColor: e.a.color || null, hColor: e.h.color || null,
        aAlt: e.a.alternateColor || null, hAlt: e.h.alternateColor || null, aRec: e.aRec, hRec: e.hRec, aRank: e.aRank, hRank: e.hRank,
        venue: e.venue, tv: e.tv, aFull: e.a.displayName, hFull: e.h.displayName, open: o.aOpen != null ? -o.aOpen : null, tOpen: o.tOpen };
      s.est = est;
      byId[s.id] = e;
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
    // Alternate spreads and totals from SportsGameOdds (Friday and Saturday pulls), used to feather big parlays.
    // The two feeds spell schools differently ("Appalachian State" vs "App State"), so match loosely.
    var normT = function (x) { return String(x || '').toLowerCase().replace(/\bappalachian\b/, 'app').replace(/\bstate\b/g, 'st').replace(/[^a-z]/g, ''); };
    var teamKeys = function (t) { return [t.location, t.displayName, t.shortDisplayName].map(normT).filter(Boolean); };
    var sameTeam = function (name, t) { var n = normT(name); return teamKeys(t).some(function (k) { return k === n || (n.length > 4 && k.indexOf(n) === 0); }); };
    var cfLive = events.filter(function (e) { return byId[e.id]; });
    ((extra.sgoCfb || {}).events || []).forEach(function (ev) {
      var e = cfLive.filter(function (x) { return sameTeam(ev.away, x.a) && sameTeam(ev.home, x.h); })[0];
      if (!e) return;
      var sl = slate.filter(function (x) { return x.id === e.id; })[0];
      if (!sl) return;
      (ev.alts || []).forEach(function (al) {
        if (al.odds == null || al.odds < -600 || al.odds > 600) return;
        if (al.type === 'ou' && al.entity && al.entity !== 'all') return;
        var lab = al.type === 'sp' ? (al.side === 'away' ? sl.a : sl.h) + ' ' + signed(al.line) : (al.side === 'over' ? 'Over ' : 'Under ') + al.line;
        var ap = imp(al.odds) * 0.955;
        legs.push({ g: e.id, k: al.type === 'sp' ? 'spread' : 'total', alt: true, label: lab + ' (alt)', odds: al.odds, p: ap, conf: Math.round(ap * 100), s: [0, 0, 0], note: 'Alternate line, ' + (al.book === 'draftkings' ? 'DraftKings' : al.book) + ' price' });
      });
    });
    // Every other underdog and every over on the board, with no Horseshoe signals. They never make the Horseshoe Parlay,
    // but they let the Upset Special and Horseshoe Overs fill bigger slips.
    var haveL = {};
    legs.forEach(function (l) { haveL[l.g + '|' + l.label] = 1; });
    slate.forEach(function (s) {
      var ev = byId[s.id];
      if (!ev) return;
      var o = ev.odds;
      var dogA = s.aml > 0, dogName = dogA ? s.a : s.h, dogMl = dogA ? s.aml : s.hml;
      var iA = imp(s.aml), iH = imp(s.hml), pDog = (dogA ? iA : iH) / (iA + iH);
      if (dogMl >= 100 && dogMl <= 600 && !s.est && !haveL[s.id + '|' + dogName + ' ML'])
        legs.push({ g: s.id, k: 'ml', label: dogName + ' ML', odds: dogMl, p: pDog, conf: Math.round(pDog * 100), s: [0, 0, 0], dog: true, note: 'Underdog on the board, no Horseshoe signal' });
      var dl = dogA ? o.aNow : -o.aNow;
      if (dl > 0 && !haveL[s.id + '|' + dogName + ' ' + signed(dl)])
        legs.push({ g: s.id, k: 'spread', label: dogName + ' ' + signed(dl), odds: dogA ? o.aSpOdds : o.hSpOdds, p: 0.5, conf: 50, s: [0, 0, 0], dog: true, note: 'Getting the points, no Horseshoe signal' });
      if (o.tot != null && !haveL[s.id + '|Over ' + o.tot]) {
        var iO = imp(o.oOdds), iU = imp(o.uOdds);
        legs.push({ g: s.id, k: 'total', label: 'Over ' + o.tot, odds: o.oOdds, p: iO / (iO + iU), conf: Math.round(iO / (iO + iU) * 100), s: [0, 0, 0], note: 'Over on the board, no Horseshoe signal' });
      }
    });
    tiltLegs(legs, byId, extra.weather, false);
    modelLegs(legs, slate, byId, extra.model);
    slate.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
    var names = {};
    slate.forEach(function (s) { names[s.a + (s.n ? ' vs ' : ' @ ') + s.h] = s; });
    var publicBoard = ((extra.splits || {}).cf || []).filter(function (r) { return names[r[0]]; });
    // Fade the public: 55%+ of bets on one side but at least 15 points less of the money. The other side becomes a fade spot.
    var legByKey = {};
    legs.forEach(function (l) { legByKey[l.g + '|' + l.label] = l; });
    publicBoard.forEach(function (row) {
      var gap = row[4] - row[5];
      if (!(row[4] >= 55 && gap >= 15)) return;
      var sl = names[row[0]];
      if (!sl) return;
      var side = row[3], mk = row[1], odds = -110, label;
      if (mk === 'total') label = side + ' ' + row[7];
      else if (mk === 'ml') { label = side + ' ML'; odds = side === sl.h ? sl.hml : sl.aml; }
      else {
        var mag = Math.abs(parseFloat(String(row[7]).split(' ')[1]));
        var fav = sl.hs < 0 ? sl.h : sl.a;
        label = side + ' ' + (side === fav ? '-' : '+') + mag;
      }
      if (odds == null) return;
      var why = 'Public ' + row[4] + '% on ' + row[2] + ', money only ' + row[5] + '%';
      var pf = Math.min(0.95, imp(odds) + gap / 500);
      var ex = legByKey[sl.id + '|' + label];
      if (ex) { ex.fade = true; ex.fadeWhy = why; if (!ex.held) ex.p = Math.max(ex.p, pf); ex.note = (ex.note ? ex.note + '; ' : '') + why; return; }
      var nl = { g: sl.id, k: mk, label: label, odds: odds, p: pf, s: [0, 0, 0], fade: true, fadeWhy: why, dog: odds > 0 || (mk === 'spread' && label.indexOf('+') !== -1), note: why };
      legs.push(nl); legByKey[sl.id + '|' + label] = nl;
    });
    rateLegs(legs, false);
    var games = slate.map(function (s) { return { id: s.id, label: s.a + (s.n ? ' vs ' : ' @ ') + s.h }; });
    var span = firstDate ? etDate(firstDate) + (lastDate && etDate(lastDate) !== etDate(firstDate) ? ' – ' + etDate(lastDate) : '') : '';
    return { games: games, legs: legs, publicBoard: publicBoard, slate: slate, model: extra.model || null, chip: 'NCAAF' + (span ? ' · ' + span : ''), count: slate.length };
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
      status: 'loading', updated: null, source: '', booksAsOf: null, propsAsOf: null, picks: []
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
      soft(getJSON('data/sgo-nfl.json' + bust)),
      soft(getJSON('data/sgo-cfb.json' + bust)),
      soft(getJSON('data/picks.json' + bust)),
      soft(getJSON('data/splits.json' + bust)),
      soft(getJSON('data/meta.json' + bust)),
      soft(getJSON('data/weather.json' + bust)),
      soft(getJSON('data/model.json' + bust)),
      soft(getJSON('data/nfl-model.json' + bust)),
      soft(getJSON('data/nfl-sources.json' + bust))
    ]).then(function (r) { return { books: r[0], props: r[1], sgo: r[2], sgoCfb: r[3], picks: r[4], splits: r[5], meta: r[6], weather: r[7], model: r[8], nflModel: r[9], nflSources: r[10] }; });
    return Promise.all([live.catch(fallback), extras]).then(function (res) {
      var feed = res[0], ex = res[1];
      var next = {
        nfl: buildNfl(feed.nfl, feed.inj, ex),
        cf: buildCollege(feed.cfb, ex),
        status: 'ok', source: feed.source,
        updated: feed.source === 'snapshot' && ex.meta && ex.meta.espn ? new Date(ex.meta.espn) : new Date(),
        booksAsOf: ex.books && ex.books.updated ? new Date(ex.books.updated) : null,
        picks: ex.picks && ex.picks.picks ? ex.picks.picks : [], picksAsOf: ex.picks ? ex.picks.updated : null,
        propsAsOf: ex.sgo && ex.sgo.updated && ex.sgo.events && ex.sgo.events.length ? 'sgo:' + ex.sgo.updated : ex.props ? ex.props.asOf : null
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
    rateLegs: rateLegs, modelView: modelView, phi: phi, _test: { readEvent: readEvent, buildNfl: buildNfl, buildCollege: buildCollege, buildLineCheck: buildLineCheck, mlFromSpread: mlFromSpread, modelLegs: modelLegs, modelView: modelView }
  };
})(typeof window !== 'undefined' ? window : globalThis);

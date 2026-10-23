/* Blue Horseshoe Fantasy: projections, lineups and league connections, all in the browser.
   Data: data/fantasy.json (nflverse stats, Sleeper ids, defense vs position; refreshed every 12 hours)
   plus the live NFL lines already on the site (team implied totals) and the injury report.
   Leagues: Sleeper today (public API, no login). ESPN and Yahoo plug into the same shape later. */
(function (root) {
  'use strict';
  var SL = 'https://api.sleeper.app/v1';
  var NV = function (t) { return ({ LAR: 'LA', WSH: 'WAS', JAC: 'JAX' })[t] || t; };
  function phi(z) {
    var t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2);
    var p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  var r1 = function (x) { return Math.round(x * 10) / 10; };

  // ---------- this week's games from the live NFL lines: opponent, home/away, implied team total
  function weekGames(nfl) {
    var out = {};
    ((nfl && nfl.slate) || []).forEach(function (s) {
      var a = NV(s.aAbbr), h = NV(s.hAbbr), tot = s.tot, hs = s.hs;
      var hImp = tot != null && hs != null ? tot / 2 - hs / 2 : null, aImp = tot != null && hs != null ? tot / 2 + hs / 2 : null;
      out[a] = { opp: h, home: false, imp: aImp, oppImp: hImp, date: s.date, gid: s.id, short: s.short, spread: hs != null ? -hs : null, tot: tot };
      out[h] = { opp: a, home: true, imp: hImp, oppImp: aImp, date: s.date, gid: s.id, short: s.short, spread: hs, tot: tot };
    });
    return out;
  }

  // ---------- projection: recent production x matchup x game environment x availability
  // base: 55% season average, 45% last three games (in the league's scoring), shrunk a little under 3 games.
  // matchup: 35% of how far this defense is from average against the position.
  // environment: 40% of how far the team's implied total (from the live spread and total) is from 22.5.
  // together capped at +/-30%.
  // availability: out, IR or suspended 0; doubtful 25%; questionable 92%. No game this week: 0.
  var AVG_IMP = 22.5;
  var INJ = { Out: 0, IR: 0, PUP: 0, Sus: 0, Suspended: 0, NA: 0, Doubtful: 0.25, Questionable: 0.92 };
  function project(p, ctx) {
    var fmt = ctx.rec == null ? 1 : ctx.rec; // points per reception
    var g = ctx.games[p.tm];
    var res = { pts: 0, lo: 0, hi: 0, why: [], game: g || null, has: !!g, injMult: 1 };
    if (!g) { res.why.push({ k: 'No game listed', v: 'bye week, or the game already started' }); return res; }
    if (!p.g) { res.why.push({ k: 'No stats yet', v: 'no games played this season' }); return res; }
    var season = fmt === 1 ? p.ppg : fmt === 0.5 && p.half != null ? p.half : p.std != null ? p.std : p.ppg;
    var ratio = p.ppg ? season / p.ppg : 1;
    var l3 = p.l3 != null ? p.l3 * ratio : season;
    var base = 0.55 * season + 0.45 * l3;
    if (p.g < 3) base *= 0.9;
    res.why.push({ k: 'Recent production', v: r1(base) + ' (season ' + r1(season) + ', last 3 ' + r1(l3) + ')' });
    var mult = 1;
    if (p.pos === 'DEF') {
      var env = g.oppImp != null ? 1 + 0.5 * (AVG_IMP - g.oppImp) / AVG_IMP : 1;
      mult *= env;
      if (g.oppImp != null) res.why.push({ k: 'Opponent implied total', v: r1(g.oppImp) + ' pts (' + (env >= 1 ? '+' : '') + Math.round((env - 1) * 100) + '%)' });
    } else {
      var d = ctx.dvp && ctx.dvp[g.opp] && ctx.dvp[g.opp][p.pos];
      if (d && p.pos !== 'K') {
        var m = 1 + 0.35 * (d.f - 1); mult *= m;
        res.why.push({ k: 'Matchup', v: g.opp + ' allows ' + d.pg + ' to ' + p.pos + 's (#' + d.rk + ' of 32, 1 = toughest; ' + (m >= 1 ? '+' : '') + Math.round((m - 1) * 100) + '%)' });
        res.dvp = d;
      }
      if (g.imp != null) {
        var e = 1 + 0.4 * (g.imp / AVG_IMP - 1); mult *= e;
        res.why.push({ k: 'Game environment', v: p.tm + ' implied ' + r1(g.imp) + ' pts (' + (e >= 1 ? '+' : '') + Math.round((e - 1) * 100) + '%)' });
      }
    }
    mult = Math.max(0.7, Math.min(1.3, mult)); // matchup and environment together move a projection 30% at most
    var inj = p.inj && INJ[p.inj] != null ? INJ[p.inj] : 1;
    if (inj !== 1) res.why.push({ k: 'Injury', v: p.inj + (p.injBody ? ' (' + p.injBody + ')' : '') + ' → ' + Math.round(inj * 100) + '%' });
    res.injMult = inj;
    res.pts = r1(Math.max(0, base * mult * inj));
    var sd = (p.sd != null ? p.sd : base * 0.45) * ratio * inj;
    res.lo = r1(Math.max(0, res.pts - 0.85 * sd)); res.hi = r1(res.pts + 0.85 * sd); res.sd = sd;
    return res;
  }

  // ---------- lineup: fill the league's slots with the best projections
  var ELIG = { QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'], FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'] };
  function optimize(slots, players) {
    // players: [{ key, pos, proj }]; fixed slots first, then the flexible ones from most to least restrictive
    var order = slots.map(function (s, i) { return { s: s, i: i }; }).filter(function (x) { return ELIG[x.s]; })
      .sort(function (a, b) { return ELIG[a.s].length - ELIG[b.s].length; });
    var used = {}, out = new Array(slots.length);
    order.forEach(function (x) {
      var best = null;
      players.forEach(function (p) { if (!used[p.key] && ELIG[x.s].indexOf(p.pos) !== -1 && (!best || p.proj > best.proj)) best = p; });
      if (best) { used[best.key] = 1; out[x.i] = best; }
    });
    return out;
  }
  function winChance(a, b, sdA, sdB) { var sd = Math.sqrt(sdA * sdA + sdB * sdB) || 20; return phi((a - b) / sd); }

  // ---------- Sleeper (public API, CORS-friendly)
  function getJSON(u) { return fetch(u, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); }); }
  function sleeperUser(name) {
    return Promise.all([getJSON(SL + '/state/nfl'), getJSON(SL + '/user/' + encodeURIComponent(name))]).then(function (r) {
      var state = r[0], user = r[1];
      if (!user || !user.user_id) throw new Error('No Sleeper user named ' + name);
      return getJSON(SL + '/user/' + user.user_id + '/leagues/nfl/' + state.season).then(function (leagues) { return { state: state, user: user, leagues: leagues || [] }; });
    });
  }
  function sleeperLeague(leagueId, week) {
    return Promise.all([getJSON(SL + '/league/' + leagueId), getJSON(SL + '/league/' + leagueId + '/rosters'), getJSON(SL + '/league/' + leagueId + '/users'), getJSON(SL + '/league/' + leagueId + '/matchups/' + week).catch(function () { return []; })])
      .then(function (r) { return { league: r[0], rosters: r[1], users: r[2], matchups: r[3] }; });
  }

  root.BHFantasy = { weekGames: weekGames, project: project, optimize: optimize, winChance: winChance, sleeperUser: sleeperUser, sleeperLeague: sleeperLeague, NV: NV, ELIG: ELIG };
})(typeof window !== 'undefined' ? window : globalThis);

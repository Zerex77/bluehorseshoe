// Horseshoe Ticker app: pair with a ticker, add tickets, watch them grade live.
(function () {
  'use strict';
  var K = window.SlipKit;
  var $ = function (id) { return document.getElementById(id); };
  var esc = K.esc;
  var API = location.origin + '/api';
  var STORE = 'bh.app.v1';

  // ---------------------------------------------------------------- saved state
  function loadState() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
  var S = loadState();
  S.tickers = S.tickers || [];      // [{id, token, label}]
  S.name = S.name || '';
  function saveState() { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) {} }
  function cur() { return S.tickers.filter(function (t) { return t.id === S.cur; })[0] || S.tickers[0] || null; }

  // ---------------------------------------------------------------- server
  function api(method, path, body, ticker) {
    var h = { 'content-type': 'application/json' };
    if (ticker) h.authorization = 'Bearer ' + ticker.token;
    return fetch(API + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || ('Error ' + r.status)); e.status = r.status; throw e; }
          return j;
        });
      });
  }

  // ---------------------------------------------------------------- views
  var view = '';
  function show(v) {
    view = v;
    ['vPair', 'vHome', 'vEdit', 'vSet'].forEach(function (id) { $(id).hidden = id !== v; });
    $('addBtn').hidden = v !== 'vHome';
    $('eBar').hidden = v !== 'vEdit';
    $('backBtn').hidden = !(v === 'vEdit' || v === 'vSet' || (v === 'vPair' && S.tickers.length));
    $('setBtn').hidden = v !== 'vHome';
    window.scrollTo(0, 0);
    setTitle();
  }
  function setTitle() {
    var t = cur();
    var titles = { vPair: 'Pair a ticker', vEdit: editing ? 'Edit ticket' : 'Add a ticket', vSet: 'Settings' };
    var name = titles[view] || (t && (data.label || t.label)) || 'Horseshoe Ticker';
    var sub = '', on = false;
    if (view === 'vHome' && t) {
      var age = data.seen ? (Date.now() - data.seen) / 1000 : Infinity;
      on = age < 90;
      sub = on ? 'Ticker online' : data.seen ? 'Ticker offline · last seen ' + ago(age) : 'Waiting for the ticker to connect';
    }
    $('title').innerHTML = esc(name) + '<small class="' + (on ? 'on' : '') + '" id="sub">' + (sub ? '<span class="dot"></span>' + esc(sub) : '') + '</small>';
  }
  function ago(s) {
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' hr ago';
    return Math.round(s / 86400) + ' days ago';
  }
  $('backBtn').onclick = function () { goHome(); };
  $('setBtn').onclick = function () { openSettings(); };

  // ---------------------------------------------------------------- pairing
  function openPair() {
    $('pName').value = S.name;
    $('pCode').value = new URLSearchParams(location.search).get('code') || '';
    $('pMsg').textContent = ''; $('pMsg').className = 'msg';
    show('vPair');
  }
  $('pCode').addEventListener('input', function () { this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
  $('pGo').onclick = function () {
    var code = $('pCode').value.trim(), name = $('pName').value.trim();
    var msg = $('pMsg');
    if (code.length !== 6) { msg.className = 'msg err'; msg.textContent = 'The code is 6 letters and numbers, shown on your ticker.'; return; }
    if (!name) { msg.className = 'msg err'; msg.textContent = 'Add your name so friends know who added a ticket.'; $('pName').focus(); return; }
    this.disabled = true; msg.className = 'msg'; msg.textContent = 'Pairing…';
    var btn = this;
    api('POST', '/pair', { code: code, name: name }).then(function (r) {
      S.name = name;
      S.tickers = S.tickers.filter(function (t) { return t.id !== r.ticker; });
      S.tickers.push({ id: r.ticker, token: r.token, label: r.label || '' });
      S.cur = r.ticker;
      saveState();
      if (location.search) history.replaceState(null, '', location.pathname);
      data = {}; goHome();
    }).catch(function (e) {
      msg.className = 'msg err'; msg.textContent = e.message || "Couldn't pair. Check your connection and try again.";
    }).finally(function () { btn.disabled = false; });
  };

  // ---------------------------------------------------------------- home: the ticker's slips
  var data = {};
  var refreshing = false;
  function refresh() {
    var t = cur();
    if (!t || refreshing) return Promise.resolve();
    refreshing = true;
    return api('GET', '/t/' + t.id, null, t).then(function (d) {
      data = d;
      if (d.label && d.label !== t.label) { t.label = d.label; saveState(); }
      $('hMsg').textContent = ''; $('hMsg').className = 'msg';
      if (view === 'vHome') renderHome();
    }).catch(function (e) {
      if (e.status === 401) {
        S.tickers = S.tickers.filter(function (x) { return x.id !== t.id; });
        S.cur = S.tickers[0] ? S.tickers[0].id : null; saveState();
        alert(e.message);
        S.tickers.length ? goHome() : openPair();
        return;
      }
      $('hMsg').className = 'msg err'; $('hMsg').textContent = "Can't reach the server right now. Retrying…";
    }).finally(function () { refreshing = false; });
  }
  function goHome() {
    if (!cur()) return openPair();
    S.cur = cur().id; saveState();
    show('vHome');
    renderHome();
    refresh();
  }
  var CLS = { win: 'c-win', good: 'c-good', close: 'c-close', bad: 'c-bad', lost: 'c-lost', push: 'c-push', pre: 'c-pre', unk: 'c-unk' };
  function renderHome() {
    setTitle();
    var slips = data.slips || [];
    var snapBy = {};
    (data.snap || []).forEach(function (s) { snapBy[s.id] = s; });
    if (!slips.length) {
      $('slips').innerHTML = '<div class="empty"><svg viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#15213A"/><path d="M18 12 v16 a14 14 0 0 0 28 0 v-16" stroke="#3B82F6" stroke-width="9" fill="none" stroke-linecap="round"/></svg>' +
        '<div><b>No tickets on the ticker yet.</b><br>Tap <b>Add ticket</b> to put one on.</div></div>';
      return;
    }
    $('slips').innerHTML = slips.map(function (sl) {
      var sn = snapBy[sl.id];
      var st = sn ? sn.status : 'pre';
      var tag = { live: 'LIVE', busted: 'BUSTED', cashed: 'CASHED', pre: 'UPCOMING' }[st] || 'UPCOMING';
      var d = sl.odds ? K.dec(sl.odds) : null;
      var pay = sn && sn.pay ? sn.pay : (d && sl.stake ? sl.stake * d : null);
      var price = sl.odds ? (sl.odds > 0 ? '+' : '') + sl.odds : (sn && sn.price) || '';
      var rows = sn ? sn.legs : sl.legs.map(function (l) { return { label: l.text, cls: 'pre', right: '', sub: 'Waiting for the ticker' }; });
      var won = sn ? sn.won : 0;
      return '<section class="slip ' + st + '">' +
        '<div class="sh"><span class="tag ' + st + '">' + tag + '</span><span class="nm">' + esc(sl.name) + '</span>' +
        '<span class="pay">' + (pay ? K.money(pay) : esc(price)) + (sl.stake ? '<small>' + K.money(sl.stake) + (price ? ' at ' + esc(price) : '') + '</small>' : '') + '</span></div>' +
        '<div class="seg">' + rows.map(function (r) { return '<i class="' + (CLS[r.cls] || '') + '"></i>'; }).join('') + '</div>' +
        '<div class="legs">' + rows.map(function (r) {
          var c = CLS[r.cls] || 'c-pre';
          var inj = r.inj ? '<span class="inj r' + (r.inj.rank || 3) + '">' + esc(r.inj.tag) + '</span>' : '';
          var prog = r.prog != null && r.cls !== 'win' && r.cls !== 'lost' ? '<span class="prog ' + c + '"><i style="width:' + Math.round(Math.max(0, Math.min(1, r.prog)) * 100) + '%"></i></span>' : '';
          var sub = [r.sub, r.inj && r.inj.rank >= 1 ? r.inj.text : ''].filter(Boolean).join(' · ');
          return '<div class="leg"><span class="pip ' + c + '"></span><span class="lb">' + esc(r.label) + inj + '</span><span class="rt ' + c + '">' + esc(r.right || '') + '</span>' +
            (sub || prog ? '<span class="sub">' + prog + '<span>' + esc(sub) + '</span></span>' : '') + '</div>';
        }).join('') + '</div>' +
        '<div class="sf"><span>' + won + ' of ' + rows.length + ' in' + (sl.by ? ' · added by ' + esc(sl.by) : '') + '</span>' +
        '<button type="button" data-edit="' + esc(sl.id) + '">Edit</button><button type="button" data-rm="' + esc(sl.id) + '">Remove</button></div></section>';
    }).join('');
  }
  $('slips').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var sl = (data.slips || []).filter(function (s) { return s.id === (b.dataset.edit || b.dataset.rm); })[0];
    if (!sl) return;
    if (b.dataset.edit) openEditor(sl);
    if (b.dataset.rm && confirm('Remove "' + sl.name + '" from the ticker?')) removeSlip(sl.id);
  });
  function removeSlip(id) {
    var t = cur();
    return api('DELETE', '/t/' + t.id + '/slips/' + encodeURIComponent(id), null, t).then(function () {
      data.slips = (data.slips || []).filter(function (s) { return s.id !== id; });
      renderHome(); goHome();
    }).catch(function (e) { alert(e.message); });
  }
  $('addBtn').onclick = function () { openEditor(null); };

  // install tip
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredPrompt = e; installTip(); });
  function standalone() { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
  function installTip() {
    var el = $('installTip');
    if (standalone() || S.hideInstall) { el.hidden = true; return; }
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (deferredPrompt) el.innerHTML = '<span><b>Install the app</b> for one-tap access.</span><button class="btn primary" id="instGo" type="button">Install</button>';
    else if (ios) el.innerHTML = '<span><b>Add to your home screen:</b> tap Share, then Add to Home Screen.</span><button class="btn" id="instNo" type="button">OK</button>';
    else { el.hidden = true; return; }
    el.hidden = false;
    if ($('instGo')) $('instGo').onclick = function () { deferredPrompt.prompt(); deferredPrompt = null; el.hidden = true; };
    if ($('instNo')) $('instNo').onclick = function () { S.hideInstall = true; saveState(); el.hidden = true; };
  }

  // ---------------------------------------------------------------- games (for checking and picking legs)
  var gamesReady = null;
  function loadGames() {
    if (gamesReady) return gamesReady;
    var now = new Date(), end = new Date(now.getTime() + 7 * 864e5);
    var range = K.ymd(now) + '-' + K.ymd(end);
    var extra = ['80', '81'].map(function (grp) {
      return K.getJSON(K.ESPN + 'college-football/scoreboard?groups=' + grp + '&limit=400&dates=' + range).then(function (j) {
        (j.events || []).forEach(function (ev) { var g = K.readGame(ev, 'cfb'); if (g) K.games[g.id] = g; });
      }).catch(function () {});
    });
    gamesReady = Promise.allSettled([K.fetchBoards()].concat(extra)).then(function () {
      setTimeout(function () { gamesReady = null; }, 10 * 60 * 1000);   // refresh the list every 10 minutes
    });
    return gamesReady;
  }

  // ---------------------------------------------------------------- editor
  var editing = null;   // slip being edited (null = new)
  var legs = [];        // [{text, g, sport, odds}]
  function openEditor(sl) {
    editing = sl;
    $('eName').value = sl ? sl.name : '';
    $('eStake').value = sl && sl.stake ? sl.stake : (S.lastStake || '');
    $('eOdds').value = sl && sl.odds ? (sl.odds > 0 ? '+' : '') + sl.odds : '';
    legs = sl ? sl.legs.map(function (l) { return Object.assign({}, l); }) : [];
    $('eDel').hidden = !sl;
    $('eMsg').textContent = ''; $('eMsg').className = 'msg';
    setWay(sl ? '' : 'build');
    show('vEdit');
    renderLegs();
    loadGames().then(function () { renderLegs(); fillGames(); });
  }
  function setWay(w) {
    $('pasteCard').hidden = w !== 'paste';
    $('buildCard').hidden = w !== 'build';
    $('wPaste').classList.toggle('on', w === 'paste');
    $('wBuild').classList.toggle('on', w === 'build');
    if (w === 'build') fillGames();
  }
  $('wPaste').onclick = function () { setWay($('pasteCard').hidden ? 'paste' : ''); if (!$('pasteCard').hidden) $('pasteText').focus(); };
  $('wBuild').onclick = function () { setWay($('buildCard').hidden ? 'build' : ''); };
  $('wShot').onclick = function () { $('shotFile').click(); };
  $('eCancel').onclick = function () { goHome(); };
  $('eDel').onclick = function () { if (editing && confirm('Remove "' + editing.name + '" from the ticker?')) removeSlip(editing.id); };

  function describe(l) {
    var p = K.parseLeg(l.text, l);
    var g = p.g && K.games[p.g];
    var ok = p.market && (g || p.market === 'prop');
    var where = g ? ' · ' + K.abbr(g.a) + ' @ ' + K.abbr(g.h) : '';
    var what = !p.market ? "Can't read this leg. Check the spelling." :
      p.market === 'prop' ? p.player + ' ' + (p.side === 'yes' ? (p.what === 'TDs' ? 'anytime TD' : 'throws a TD') : 'over ' + p.line + ' ' + p.what) + (g ? where : ' · game found at kickoff') :
      !g ? 'No game found for this team this week' :
      (p.market === 'total' ? p.dir + ' ' + p.line : p.market === 'ml' ? K.teamName(g[p.side]) + ' moneyline' : K.teamName(g[p.side]) + ' ' + K.sgn(p.line)) + where;
    return { ok: !!ok, what: what };
  }
  function renderLegs() {
    $('legsTitle').textContent = legs.length ? 'Legs (' + legs.length + ')' : 'Legs';
    if (!legs.length) { $('eLegs').innerHTML = '<p class="hint">No legs yet. Add them from a screenshot, by pasting, or by picking them above.</p>'; return; }
    $('eLegs').innerHTML = legs.map(function (l, i) {
      var d = describe(l);
      return '<div class="eleg"><span class="ic ' + (d.ok ? 'ok' : 'no') + '">' + (d.ok ? '✓' : '!') + '</span>' +
        '<div><input data-i="' + i + '" value="' + esc(l.text) + '" spellcheck="false" aria-label="Leg ' + (i + 1) + '"><div class="what ' + (d.ok ? '' : 'no') + '">' + esc(d.what) + '</div></div>' +
        '<button class="x" type="button" data-x="' + i + '" aria-label="Remove leg">✕</button></div>';
    }).join('');
  }
  $('eLegs').addEventListener('change', function (e) {
    var i = e.target.dataset.i;
    if (i == null) return;
    var text = e.target.value.trim();
    if (!text) { legs.splice(i, 1); } else if (text !== legs[i].text) { legs[i] = { text: text }; }   // edited: drop the old game link
    renderLegs();
  });
  $('eLegs').addEventListener('click', function (e) {
    var x = e.target.closest('[data-x]');
    if (x) { legs.splice(Number(x.dataset.x), 1); renderLegs(); }
  });

  function parseOdds(v) {
    var n = Number(String(v || '').replace(/[^\d+-]/g, ''));
    return n && Math.abs(n) >= 100 ? n : null;
  }
  $('eSave').onclick = function () {
    var msg = $('eMsg');
    if (!legs.length) { msg.className = 'msg err'; msg.textContent = 'Add at least one leg first.'; window.scrollTo(0, 0); return; }
    var bad = legs.filter(function (l) { return !describe(l).ok; }).length;
    if (bad && !confirm(bad + ' leg' + (bad > 1 ? 's' : '') + " couldn't be matched to a game yet. The ticker will keep trying. Send anyway?")) return;
    var stake = Number(String($('eStake').value).replace(/[^\d.]/g, '')) || 0;
    if (stake) S.lastStake = stake;
    var slip = {
      id: editing ? editing.id : K.uid(), name: $('eName').value.trim() || legs.length + '-leg parlay',
      stake: stake, odds: parseOdds($('eOdds').value), legs: legs,
    };
    var t = cur(), btn = this;
    btn.disabled = true; btn.textContent = 'Sending…';
    api('POST', '/t/' + t.id + '/slips', { slip: slip }, t).then(function () {
      saveState();
      goHome();
    }).catch(function (e) {
      msg.className = 'msg err'; msg.textContent = e.message || "Couldn't send. Check your connection.";
    }).finally(function () { btn.disabled = false; btn.textContent = 'Send to ticker'; });
  };

  // paste / type
  $('pasteAdd').onclick = function () {
    var raw = $('pasteText').value;
    if (!raw.trim()) return;
    var got = /\n[A-Z][A-Z0-9 +&.'\-\/]{3,}\n/.test('\n' + raw + '\n') ? K.hardRockText(raw) : { legs: [] };
    var lines = got.legs.length ? got.legs : raw.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
    lines.forEach(function (t) { legs.push({ text: t }); });
    if (got.stake && !$('eStake').value) $('eStake').value = got.stake;
    if (got.odds && !$('eOdds').value) $('eOdds').value = (got.odds > 0 ? '+' : '') + got.odds;
    $('pasteText').value = '';
    setWay('');
    renderLegs();
  };

  // screenshot
  $('shotFile').onchange = function () { readShot(this.files[0]); this.value = ''; };
  function readShot(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var msg = $('eMsg');
    msg.className = 'msg'; msg.innerHTML = '<span class="spin" style="display:inline-block;vertical-align:-4px;margin-right:8px"></span>Reading the slip… (the first time takes a few seconds)';
    Promise.all([K.loadOcr(), K.prepImage(file), loadGames()]).then(function (r) {
      return r[0].createWorker('eng').then(function (w) {
        return w.setParameters({ tessedit_pageseg_mode: '4' }).then(function () { return w.recognize(r[1]); })
          .then(function (out) { w.terminate(); return out.data.text; });
      });
    }).then(function (text) {
      var got = K.hardRockText(text);
      if (!got.legs.length) { msg.className = 'msg err'; msg.textContent = "Couldn't find any picks in that image. Try a sharper screenshot, or add the legs another way."; return; }
      got.legs.forEach(function (t) { legs.push({ text: t }); });
      if (got.stake && !$('eStake').value) $('eStake').value = got.stake;
      if (got.odds && !$('eOdds').value) $('eOdds').value = (got.odds > 0 ? '+' : '') + got.odds;
      if (!$('eName').value) $('eName').value = got.legs.length + '-leg parlay';
      msg.className = 'msg ok'; msg.textContent = 'Found ' + got.legs.length + ' legs. Check each one below (! means it needs a look), fix anything misread, then send.';
      renderLegs();
    }).catch(function () { msg.className = 'msg err'; msg.textContent = "Couldn't read that image right now. Add the legs another way."; });
  }

  // ---------------------------------------------------------------- leg builder
  var B = { game: '', type: 'prop', side: '', player: null, stat: '', ou: 'over' };
  var rosters = {};   // team id -> promise of [{name, pos}]
  var TYPES = [['prop', 'Player prop'], ['ml', 'Moneyline'], ['spread', 'Spread'], ['total', 'Total']];
  var STATS = {   // label, leg text, line needed
    pass: ['Pass yds', 'pass yds'], patt: ['Pass att.', 'pass attempts'], comp: ['Completions', 'completions'], ptd: ['Throws a TD', 'to throw a TD', false],
    rush: ['Rush yds', 'rush yds'], car: ['Carries', 'carries'], rec: ['Rec yds', 'rec yds'], recs: ['Receptions', 'receptions'],
    rr: ['Rush + rec yds', 'rush + rec yds'], pr: ['Pass + rush yds', 'pass + rush yds'], lrush: ['Longest rush', 'longest rush'],
    lrec: ['Longest catch', 'longest reception'], atd: ['Anytime TD', 'anytime TD', false],
  };
  var BY_POS = { QB: ['pass', 'patt', 'comp', 'ptd', 'rush', 'pr', 'atd'], RB: ['rush', 'car', 'rec', 'recs', 'rr', 'lrush', 'atd'],
    FB: ['rush', 'car', 'rec', 'recs', 'atd'], WR: ['rec', 'recs', 'lrec', 'rr', 'atd'], TE: ['rec', 'recs', 'lrec', 'atd'] };
  var ALL_STATS = ['pass', 'rush', 'rec', 'recs', 'rr', 'car', 'patt', 'comp', 'atd', 'ptd'];

  function gameLabel(g) {
    var d = new Date(g.date);
    var day = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' });
    var when = g.state === 'in' ? 'LIVE' : day + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
    return when + ' · ' + K.abbr(g.a) + ' @ ' + K.abbr(g.h);
  }
  function fillGames() {
    var list = Object.keys(K.games).map(function (id) { return K.games[id]; }).filter(function (g) { return g.state !== 'post'; })
      .sort(function (x, y) { return new Date(x.date) - new Date(y.date); });
    var sel = $('bGame');
    if (!list.length) { sel.innerHTML = '<option value="">' + (gamesReady ? 'Loading games…' : 'No upcoming games found') + '</option>'; return; }
    var grp = function (sport, title) {
      var gs = list.filter(function (g) { return g.sport === sport; });
      return gs.length ? '<optgroup label="' + title + '">' + gs.map(function (g) { return '<option value="' + g.id + '">' + esc(gameLabel(g)) + '</option>'; }).join('') + '</optgroup>' : '';
    };
    sel.innerHTML = '<option value="">Choose a game</option>' + grp('nfl', 'NFL') + grp('cfb', 'College');
    if (B.game && K.games[B.game]) sel.value = B.game;
    renderBuilder();
  }
  $('bGame').onchange = function () { B.game = this.value; B.side = ''; B.player = null; B.stat = ''; renderBuilder(); };
  function chips(el, items, on, attr) {
    el.innerHTML = items.map(function (it) { return '<button type="button" class="chip' + (it[0] === on ? ' on' : '') + '" data-' + attr + '="' + esc(it[0]) + '">' + esc(it[1]) + '</button>'; }).join('');
  }
  function renderBuilder() {
    var g = K.games[B.game];
    chips($('bTypes'), TYPES, B.type, 'type');
    $('bTeamWrap').hidden = !g || B.type === 'total';
    $('bPropWrap').hidden = !g || B.type !== 'prop';
    $('bTotWrap').hidden = !g || B.type !== 'total';
    if (g) chips($('bTeams'), [['a', K.teamName(g.a)], ['h', K.teamName(g.h)]], B.side, 'side');
    chips($('bOU'), [['over', 'Over'], ['under', 'Under']], B.ou, 'ou');
    var stat = STATS[B.stat];
    var needLine = B.type === 'spread' || B.type === 'total' || (B.type === 'prop' && (!stat || stat[2] !== false));
    $('bLineWrap').querySelector('#bLineLbl').hidden = !needLine;
    $('bLine').placeholder = B.type === 'spread' ? '-3.5' : B.type === 'total' ? '47.5' : '69.5 or 70+';
    if (B.type === 'prop' && g && B.side) loadRoster(g, B.side);
    if (B.type === 'prop' && g && !B.side) { rosterKey = ''; rosterNow = []; $('bPlayers').innerHTML = '<div class="hint" style="padding:12px">Pick the player\'s team above.</div>'; }
    if (B.type === 'prop') {
      var pos = B.player && B.player.pos;
      chips($('bStats'), (BY_POS[pos] || ALL_STATS).map(function (k) { return [k, STATS[k][0]]; }), B.stat, 'stat');
    }
    $('bPreview').textContent = legText() || 'Your leg will show here';
    $('bAdd').disabled = !legText();
  }
  function lineVal() {
    var v = $('bLine').value.trim();
    var plus = /^(\d+(?:\.\d+)?)\s*\+$/.exec(v);
    if (plus) return Number(plus[1]) - 0.5;            // Hard Rock "70+" = over 69.5
    var n = Number(v.replace(/[^\d.+-]/g, ''));
    return v && isFinite(n) ? n : null;
  }
  function legText() {
    var g = K.games[B.game];
    if (!g) return '';
    var line = lineVal();
    if (B.type === 'total') return line ? g.a.shortDisplayName + ' ' + g.h.shortDisplayName + ' ' + (B.ou === 'over' ? 'Over' : 'Under') + ' ' + Math.abs(line) : '';
    if (!B.side) return '';
    var team = g[B.side].displayName || K.teamName(g[B.side]);
    if (B.type === 'ml') return team + ' ML';
    if (B.type === 'spread') return line != null && line !== 0 ? team + ' ' + (line > 0 ? '+' : '') + line : '';
    if (!B.player || !B.stat) return '';
    var st = STATS[B.stat];
    if (st[2] === false) return B.player.name + ' ' + st[1];
    return line ? B.player.name + ' over ' + line + ' ' + st[1] : '';
  }
  $('buildCard').addEventListener('click', function (e) {
    var c = e.target.closest('button');
    if (!c) return;
    if (c.dataset.type) { B.type = c.dataset.type; }
    else if (c.dataset.side) { B.side = c.dataset.side; B.player = null; B.stat = ''; $('bSearch').value = ''; }
    else if (c.dataset.stat) { B.stat = c.dataset.stat; }
    else if (c.dataset.ou) { B.ou = c.dataset.ou; }
    else if (c.dataset.p != null) { B.player = rosterNow[Number(c.dataset.p)]; B.stat = ''; renderPlayers(); }
    else return;
    renderBuilder();
  });
  $('bLine').addEventListener('input', renderBuilder);
  $('bSearch').addEventListener('input', renderPlayers);
  $('bAdd').onclick = function () {
    var text = legText();
    if (!text) return;
    var g = K.games[B.game];
    var odds = parseOdds($('bOdds').value);
    var leg = { text: text + (odds ? ' ' + (odds > 0 ? '+' : '') + odds : ''), g: g.id, sport: g.sport };
    if (odds) leg.odds = odds;
    legs.push(leg);
    $('bLine').value = ''; $('bOdds').value = '';
    B.stat = '';
    renderLegs(); renderBuilder();
    $('eMsg').className = 'msg ok'; $('eMsg').textContent = 'Added: ' + text;
  };

  var rosterNow = [], rosterKey = '';
  function loadRoster(g, side) {
    var team = g[side], key = g.sport + ':' + team.id;
    if (rosterKey === key) return;
    rosterKey = key; rosterNow = [];
    $('bPlayers').innerHTML = '<div class="hint" style="padding:12px">Loading players…</div>';
    if (!rosters[key]) {
      var path = (g.sport === 'nfl' ? 'nfl' : 'college-football') + '/teams/' + team.id + '/roster';
      rosters[key] = K.getJSON(K.ESPN + path).then(readRoster).catch(function () { delete rosters[key]; return []; });
    }
    rosters[key].then(function (list) {
      if (rosterKey !== key) return;
      rosterNow = list;
      renderPlayers();
    });
  }
  function readRoster(j) {
    var out = [];
    var add = function (a) {
      var pos = a.position && (a.position.abbreviation || a.position.name) || '';
      var name = a.displayName || a.fullName;
      if (name) out.push({ name: name, pos: String(pos).toUpperCase(), jersey: a.jersey || '' });
    };
    (j.athletes || []).forEach(function (grp) { if (grp.items) grp.items.forEach(add); else add(grp); });
    var rank = { QB: 0, RB: 1, FB: 2, WR: 3, TE: 4 };
    var skill = out.filter(function (p) { return p.pos in rank; });
    return (skill.length ? skill : out).sort(function (a, b) { return ((rank[a.pos] ?? 9) - (rank[b.pos] ?? 9)) || a.name.localeCompare(b.name); });
  }
  function renderPlayers() {
    var typed = $('bSearch').value.trim(), q = K.normName(typed);
    var el = $('bPlayers');
    var roster = rosterNow.filter(function (p) { return !p.typed; });
    var list = roster.map(function (p, i) { return [p, i]; }).filter(function (x) { return !q || K.normName(x[0].name).indexOf(q) !== -1; });
    var html = list.slice(0, 60).map(function (x) {
      var on = B.player && B.player.name === x[0].name;
      return '<button type="button" class="' + (on ? 'on' : '') + '" data-p="' + x[1] + '"><span class="pos">' + esc(x[0].pos) + '</span>' + esc(x[0].name) + '</button>';
    }).join('');
    // a typed name always works, for players missing from the roster (or when it won't load)
    rosterNow = roster;
    if (typed.split(' ').length >= 2 && !list.some(function (x) { return K.normName(x[0].name) === q; })) {
      rosterNow = roster.concat([{ name: typed.replace(/\b\w/g, function (c) { return c.toUpperCase(); }), pos: '', typed: true }]);
      html += '<button type="button" data-p="' + roster.length + '"><span class="pos">+</span>Use "' + esc(typed) + '"</button>';
    }
    if (!html) html = '<div class="hint" style="padding:12px">' + (roster.length ? 'No player by that name.' : "Couldn't load this team's players. Type the player's full name above.") + '</div>';
    el.innerHTML = html;
  }

  // ---------------------------------------------------------------- settings
  function openSettings() {
    var t = cur();
    $('sName').value = S.name;
    $('sLabel').value = data.label || t.label || '';
    $('sPhones').textContent = (data.phones || []).join(', ') || 'Just you so far. Give friends the pairing code on the ticker so they can add tickets too.';
    $('sTickers').innerHTML = S.tickers.map(function (x) {
      return '<div class="item"><span>' + esc(x.label || 'Ticker') + '<small>' + (x.id === t.id ? 'Showing now' : '') + '</small></span>' +
        (x.id === t.id ? '' : '<button class="btn" type="button" data-use="' + x.id + '">Switch</button>') + '</div>';
    }).join('');
    show('vSet');
  }
  $('sName').onchange = function () { S.name = this.value.trim(); saveState(); };
  $('sLabel').onchange = function () {
    var t = cur(), label = this.value.trim();
    t.label = label; data.label = label; saveState();
    api('POST', '/t/' + t.id + '/label', { label: label }, t).catch(function () {});
  };
  $('sTickers').addEventListener('click', function (e) {
    var b = e.target.closest('[data-use]');
    if (b) { S.cur = b.dataset.use; saveState(); data = {}; goHome(); }
  });
  $('sPair').onclick = function () { openPair(); };
  $('sLeave').onclick = function () {
    var t = cur();
    if (!confirm('Remove this ticker from your phone? You can pair again with its code.')) return;
    api('POST', '/t/' + t.id + '/leave', null, t).catch(function () {}).finally(function () {
      S.tickers = S.tickers.filter(function (x) { return x.id !== t.id; });
      S.cur = S.tickers[0] ? S.tickers[0].id : null; saveState();
      data = {}; S.tickers.length ? goHome() : openPair();
    });
  };

  // ---------------------------------------------------------------- start
  setInterval(function () { if (view === 'vHome' && !document.hidden) refresh(); }, 8000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && view === 'vHome') refresh(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  if (new URLSearchParams(location.search).get('code') || !cur()) openPair(); else goHome();
  installTip();
})();

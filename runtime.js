/* Blue Horseshoe — tiny template runtime.
   Renders the {{hole}} / <sc-for> / <sc-if> template in index.html against Component.renderVals(),
   and patches the page in place on every state change so scroll and focus stay put. */
(function (root) {
  'use strict';
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };

  function decode(s) {
    return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, function (m, e) {
      return { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }[e];
    });
  }

  // ---- parse the template string into a light tree
  function parse(src) {
    var rootNode = { tag: '#root', attrs: [], kids: [] }, stack = [rootNode];
    var re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
    var attrRe = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    var m;
    while ((m = re.exec(src))) {
      var top = stack[stack.length - 1];
      if (m[0].indexOf('<!--') === 0) continue;
      if (m[1]) {
        var close = m[1].toLowerCase();
        for (var i = stack.length - 1; i > 0; i--) {
          if (stack[i].tag === close) { stack.length = i; break; }
        }
      } else if (m[2]) {
        var tag = m[2], attrs = [], am;
        attrRe.lastIndex = 0;
        while ((am = attrRe.exec(m[3] || ''))) {
          var v = am[2] != null ? am[2] : am[3] != null ? am[3] : am[4] != null ? am[4] : '';
          attrs.push([am[1], decode(v)]);
        }
        var node = { tag: tag.toLowerCase(), rawTag: tag, attrs: attrs, kids: [] };
        top.kids.push(node);
        if (!VOID[node.tag] && !m[4]) stack.push(node);
      } else if (m[5] != null) {
        top.kids.push({ text: decode(m[5]) });
      }
    }
    return rootNode;
  }

  // ---- evaluate holes
  var HOLE = /\{\{\s*([^}]*?)\s*\}\}/g;
  function lookup(expr, scope) {
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    var parts = expr.split('.'), cur;
    for (var i = scope.length - 1; i >= 0; i--) {
      if (scope[i] && Object.prototype.hasOwnProperty.call(scope[i], parts[0])) { cur = scope[i][parts[0]]; break; }
    }
    for (var j = 1; j < parts.length && cur != null; j++) cur = cur[parts[j]];
    return cur;
  }
  function single(str) {
    var m = /^\s*\{\{\s*([^}]*?)\s*\}\}\s*$/.exec(str);
    return m ? m[1] : null;
  }
  function interp(str, scope) {
    return str.replace(HOLE, function (_, e) { var v = lookup(e, scope); return v == null ? '' : String(v); });
  }

  // ---- build virtual nodes
  function build(node, scope, out, svg) {
    if (node.text != null) { out.push({ text: interp(node.text, scope) }); return; }
    var a = {};
    node.attrs.forEach(function (p) { a[p[0]] = p[1]; });
    if (node.tag === 'sc-for') {
      var list = lookup(single(a.list) || '', scope) || [];
      var as = a.as || 'item';
      list.forEach(function (item, ix) {
        var s = {}; s[as] = item; if (a.index) s[a.index] = ix;
        var sc = scope.concat([s]);
        node.kids.forEach(function (k) { build(k, sc, out, svg); });
      });
      return;
    }
    if (node.tag === 'sc-if') {
      var ok = lookup(single(a.value) || '', scope);
      if (ok) node.kids.forEach(function (k) { build(k, scope, out, svg); });
      return;
    }
    var isSvg = svg || node.tag === 'svg';
    var v = { tag: node.tag, rawTag: node.rawTag, svg: isSvg, attrs: {}, on: {}, kids: [] };
    node.attrs.forEach(function (p) {
      var name = p[0], val = p[1];
      if (name.indexOf('hint-') === 0) return;
      if (/^on[A-Z]/.test(name)) {
        var fn = lookup(single(val) || '', scope);
        if (typeof fn === 'function') v.on[name.slice(2).toLowerCase()] = fn;
        return;
      }
      var e = single(val);
      if (e != null) {
        var r = lookup(e, scope);
        if (r === false || r == null) { if (/^aria-/.test(name)) v.attrs[name] = 'false'; return; }
        v.attrs[name] = r === true ? (/^aria-/.test(name) ? 'true' : '') : String(r);
      } else {
        v.attrs[name] = interp(val, scope);
      }
    });
    node.kids.forEach(function (k) { build(k, scope, v.kids, isSvg); });
    out.push(v);
  }

  // ---- create / patch real DOM
  function create(v) {
    if (v.text != null) return document.createTextNode(v.text);
    var el = v.svg ? document.createElementNS(SVG_NS, v.rawTag) : document.createElement(v.tag);
    Object.keys(v.attrs).forEach(function (k) { el.setAttribute(k, v.attrs[k]); });
    el.__on = v.on;
    v.kids.forEach(function (k) { el.appendChild(create(k)); });
    if (v.tag === 'select' && v.attrs.value != null) el.value = v.attrs.value;
    return el;
  }
  function same(el, v) {
    if (v.text != null) return el.nodeType === 3;
    return el.nodeType === 1 && el.localName === (v.svg ? v.rawTag : v.tag);
  }
  function patchKids(parent, kids) {
    var cur = parent.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var v = kids[i], el = cur[i];
      if (!el) { parent.appendChild(create(v)); continue; }
      if (!same(el, v)) { parent.replaceChild(create(v), el); continue; }
      if (v.text != null) { if (el.nodeValue !== v.text) el.nodeValue = v.text; continue; }
      var old = el.attributes;
      for (var j = old.length - 1; j >= 0; j--) { var n = old[j].name; if (!(n in v.attrs)) el.removeAttribute(n); }
      Object.keys(v.attrs).forEach(function (k) { if (el.getAttribute(k) !== v.attrs[k]) el.setAttribute(k, v.attrs[k]); });
      el.__on = v.on;
      patchKids(el, v.kids);
      if (v.tag === 'select' && v.attrs.value != null && el.value !== v.attrs.value) el.value = v.attrs.value;
    }
    while (cur.length > kids.length) parent.removeChild(parent.lastChild);
  }

  function mount(Comp, templateSrc, host) {
    var tree = parse(templateSrc);
    var inst = new Comp({});
    var queued = false;
    inst._render = function () {
      if (queued) return;
      queued = true;
      (root.requestAnimationFrame || setTimeout)(function () { queued = false; draw(); });
    };
    function draw() {
      var vals;
      try { vals = inst.renderVals(); } catch (e) { console.error(e); return; }
      var out = [];
      tree.kids.forEach(function (k) { build(k, [vals], out, false); });
      patchKids(host, out);
    }
    ['click', 'change', 'input'].forEach(function (type) {
      host.addEventListener(type, function (ev) {
        var el = ev.target;
        while (el && el !== host) {
          if (el.__on && el.__on[type]) { el.__on[type](ev); return; }
          el = el.parentNode;
        }
      });
    });
    draw();
    return inst;
  }

  root.DCLogic = function DCLogic(props) { this.props = props || {}; this.state = {}; };
  root.DCLogic.prototype.setState = function (patch) {
    var p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = Object.assign({}, this.state, p);
    if (this._render) this._render();
  };
  root.DCLogic.prototype.forceUpdate = function () { if (this._render) this._render(); };
  root.BHRuntime = { mount: mount, parse: parse };
})(typeof window !== 'undefined' ? window : globalThis);

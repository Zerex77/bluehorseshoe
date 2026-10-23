// Run the relay on your own computer without Cloudflare (for testing):
//   node --no-warnings dev/server.mjs [port] [database file]
// Cloudflare D1 is stood in for by Node's built-in SQLite (in memory unless you name a file).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const port = Number(process.argv[2] || 8787);
const sqlite = new DatabaseSync(process.argv[3] || ':memory:');

// the parts of the D1 API the relay uses
class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.sql, args); }
  _run() {
    const st = sqlite.prepare(this.sql);
    if (/^\s*(select|with)/i.test(this.sql)) return { rows: st.all(...this.args).map((r) => ({ ...r })) };
    const r = st.run(...this.args);
    return { rows: [], changes: Number(r.changes) };
  }
  async first() { return this._run().rows[0] || null; }
  async all() { return { results: this._run().rows, success: true }; }
  async run() { const r = this._run(); return { success: true, meta: { changes: r.changes || 0 } }; }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  async batch(stmts) {
    sqlite.exec('BEGIN');
    try {
      const out = stmts.map((s) => { const r = s._run(); return { results: r.rows, meta: { changes: r.changes || 0 } }; });
      sqlite.exec('COMMIT');
      return out;
    } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.ico': 'image/x-icon' };
const env = {
  DB,
  ASSETS: {
    async fetch(req) {
      let p = decodeURIComponent(new URL(req.url).pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      try {
        return new Response(await readFile(file), { headers: { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' } });
      } catch {
        return new Response(await readFile(path.join(PUBLIC, 'index.html')), { headers: { 'content-type': TYPES['.html'] } });
      }
    },
  },
};

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request('http://localhost:' + port + req.url, {
    method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const r = await worker.fetch(request, env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log('relay dev server on http://localhost:' + port));

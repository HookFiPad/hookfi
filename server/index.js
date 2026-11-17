// HookFi node: the hook index, the REST API, the MCP endpoint and the site, in one process.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { makeApi } from './api.js';
import { ApiError, tokens } from './chain.js';
import { TOOLS, mcp } from './mcp.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// a git-ignored .env next to package.json is read on start
try { for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l); if (m && process.env[m[1]] == null) process.env[m[1]] = m[2]; } } catch {}

const cfg = {
  name: process.env.BRAND_NAME || 'HookFi', ticker: process.env.BRAND_TICKER || '$HOOK',
  site: (process.env.SITE_URL || '').replace(/\/$/, ''), x: process.env.X_URL || 'https://x.com/HookFiFun', github: process.env.GH_URL || 'https://github.com/HookFiPad/hookfi',
  token: process.env.TOKEN_ADDR || '0xf3511AfF2A4a5a13e3e464635EE01382b8881D20', buybackWallet: process.env.BUYBACK_WALLET || '',
};
const PORT = Number(process.env.PORT || 8296);
const store = openStore(process.env.DATA_PATH || path.join(ROOT, 'hookfi.db'));
const api = makeApi(store, cfg);

const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => { const b = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id', 'access-control-allow-methods': 'GET, POST, OPTIONS', ...extra }); res.end(b); };
const fail = (res, e) => (e instanceof ApiError ? send(res, e.status, { error: { code: e.code, message: e.message } }) : (console.error(e), send(res, 502, { error: { code: 'upstream_error', message: 'Robinhood Chain RPC did not answer: ' + (e.message || 'error') } })));
const body = (req) => new Promise((ok, no) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 2e6) { no(new ApiError(400, 'bad_request', 'body too large')); req.destroy(); } });
  req.on('end', () => { if (!s) return ok({}); try { ok(JSON.parse(s)); } catch { no(new ApiError(400, 'bad_request', 'body must be JSON')); } }); });

// REST: [method, pattern, operation, where the input comes from]
const R = [
  ['GET', /^\/v1\/chain$/, 'chain'], ['GET', /^\/v1\/stats$/, 'stats'], ['GET', /^\/v1\/token$/, 'token'],
  ['GET', /^\/v1\/hooks$/, 'listHooks'], ['GET', /^\/v1\/hooks\/flags$/, 'flagTable'], ['GET', /^\/v1\/hooks\/census$/, 'census'], ['POST', /^\/v1\/hooks\/mine$/, 'mine'],
  ['GET', /^\/v1\/hooks\/(0x[0-9a-fA-F]{40})\/flags$/, 'decodeHook', 'address'], ['GET', /^\/v1\/hooks\/(0x[0-9a-fA-F]{40})$/, 'inspectHook', 'address'],
  ['GET', /^\/v1\/pools$/, 'listPools'], ['POST', /^\/v1\/pools\/id$/, 'poolId'], ['POST', /^\/v1\/pools\/state$/, 'getPool'], ['POST', /^\/v1\/pools\/check$/, 'checkPool'],
  ['GET', /^\/v1\/pools\/(0x[0-9a-fA-F]{64})\/check$/, 'checkPool', 'poolId'], ['GET', /^\/v1\/pools\/(0x[0-9a-fA-F]{64})$/, 'getPool', 'poolId'],
  ['GET', /^\/v1\/launch\/chains$/, 'launchChains'], ['POST', /^\/v1\/launch\/build$/, 'launchBuild'], ['GET', /^\/v1\/launch\/list$/, 'launchList'], ['GET', /^\/v1\/launch\/token$/, 'launchToken'],
  ['GET', /^\/v1\/launch\/quote$/, 'launchQuote'], ['POST', /^\/v1\/launch\/swap$/, 'launchSwap'], ['POST', /^\/v1\/launch\/claim$/, 'launchClaim'],
  ['GET', /^\/v1\/quote\/best$/, 'bestQuote'], ['GET', /^\/v1\/quote$/, 'quote'], ['POST', /^\/v1\/quote$/, 'quote'], ['POST', /^\/v1\/swap\/build$/, 'buildSwap'],
];
const PAGES = { '/': 'index.html', '/hooks': 'hooks.html', '/burn': 'burn.html', '/docs': 'docs.html', '/launch': 'launch.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const fill = (html, origin) => html.replace(/\{\{NAME\}\}/g, cfg.name).replace(/\{\{TICKER\}\}/g, cfg.ticker).replace(/\{\{ORIGIN\}\}/g, cfg.site || origin).replace(/\{\{X_URL\}\}/g, cfg.x || '#').replace(/\{\{GH_URL\}\}/g, cfg.github || '#').replace(/\{\{TOKEN\}\}/g, cfg.token);
function file(res, f, origin) { fs.readFile(f, (err, buf) => { if (err) return send(res, 404, fill(fs.existsSync(path.join(ROOT, 'client', '404.html')) ? fs.readFileSync(path.join(ROOT, 'client', '404.html'), 'utf8') : 'Not found', origin), 'text/html; charset=utf-8');
  const ext = path.extname(f); send(res, 200, ext === '.html' || ext === '.js' ? fill(buf.toString('utf8'), origin) : buf, MIME[ext] || 'application/octet-stream', { 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300' }); }); }

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname.replace(/\/+$/, '') || '/', origin = (req.headers['x-forwarded-proto'] || 'http') + '://' + req.headers.host;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (p === '/mcp') { if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use POST. This server answers with JSON; GET (SSE) is not supported.' } }, undefined, { allow: 'POST' });
      const out = await mcp(await body(req), api, cfg); return out === null ? send(res, 202, '') : send(res, 200, JSON.stringify(out)); }
    if (p === '/v1/config') return send(res, 200, { name: cfg.name, ticker: cfg.ticker, site: cfg.site || origin, x: cfg.x, github: cfg.github, token: cfg.token, tools: TOOLS.length });
    if (p.startsWith('/v1/') || p === '/v1') {
      for (const [m, re, op, arg] of R) { const hit = re.exec(p); if (!hit || m !== req.method) continue;
        const input = req.method === 'POST' ? await body(req) : Object.fromEntries(u.searchParams); if (arg) input[arg] = hit[1];
        return send(res, 200, await api[op](input)); }
      return send(res, 404, { error: { code: 'not_found', message: 'Unknown route ' + req.method + ' ' + p } });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    if (PAGES[p]) return file(res, path.join(ROOT, 'client', PAGES[p]), origin);
    if (p.startsWith('/lib/')) return file(res, path.join(ROOT, 'lib', path.basename(p)), origin);
    if (p.startsWith('/sdk/')) return file(res, path.join(ROOT, 'sdk', path.basename(p)), origin);
    const f = path.normalize(path.join(ROOT, 'client', p)); if (!f.startsWith(path.join(ROOT, 'client'))) return send(res, 403, 'Forbidden', 'text/plain');
    return file(res, f, origin);
  } catch (e) { fail(res, e); }
}).on('connection', (s) => s.setKeepAlive(true)).listen(PORT, function () { this.keepAliveTimeout = 65000; this.headersTimeout = 70000; console.log(cfg.name + ' node · :' + PORT + ' · Robinhood Chain 4663 · index at block ' + Math.max(0, store.sync.through)); if (process.env.NO_INDEX !== '1') store.start(); });

// read symbols and decimals for tokens the index has seen but not read yet, a few at a time
setInterval(() => { if (store.sync.running) return; const a = store.unreadTokens(80); if (a.length) tokens(a, store).catch(() => {}); }, 5000).unref();

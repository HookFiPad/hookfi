// The index: every Uniswap v4 pool on one chain, from the PoolManager's Initialize events, in one SQLite file per chain.
// Kept compact on purpose: ids and addresses are stored as bytes, and each token and hook address is stored once
// and referred to by a small integer, so a million pools fit in a couple of hundred megabytes.
//
// It follows the chain head forward, and walks history backward from where it started, so the newest pools are
// there first. `lo` and `hi` are the lowest and highest blocks covered; the index is complete once lo reaches the
// block the PoolManager was deployed at. Where a public RPC will not serve old logs, the walk stops and says so.
import { DatabaseSync } from 'node:sqlite';
import { MAIN } from './chain.js';
import { topic, words, toUint, toInt, checksum } from './evm.js';
import { ZERO, DYNAMIC_FEE, MASK, decodeFlags, hex4, warningFlags, FLAG_NAMES, FLAG_BITS } from '../lib/hooks.js';

// Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)
const INIT = topic('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const Z = ZERO.slice(2), bin = (h) => Buffer.from(String(h).toLowerCase().replace(/^0x/, ''), 'hex'), hx = (u8) => Buffer.from(u8).toString('hex'), addr = (u8) => checksum('0x' + hx(u8));
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));

// x: the chain context (rpc client, contracts, name). opts: { start: first block worth reading, span: widest eth_getLogs range, pace: ms between history requests }
export function openStore(file, x = MAIN, opts = {}) {
  const START = opts.start || 0, MAXSPAN = opts.span || 1000000, PACE = opts.pace == null ? 40 : opts.pace;
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-${Number(process.env.DB_CACHE_MB || (x.main ? 96 : 24)) * 1024}; PRAGMA temp_store=MEMORY; PRAGMA wal_autocheckpoint=8000;
    CREATE TABLE IF NOT EXISTS tokens (n INTEGER PRIMARY KEY, addr BLOB NOT NULL UNIQUE, symbol TEXT, name TEXT, decimals INTEGER, read INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS tokens_unread ON tokens (read) WHERE read=0;
    CREATE TABLE IF NOT EXISTS hooks (n INTEGER PRIMARY KEY, addr BLOB NOT NULL UNIQUE, pools INTEGER NOT NULL DEFAULT 0, first INTEGER NOT NULL, last INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS hooks_pools ON hooks (pools DESC);
    CREATE INDEX IF NOT EXISTS hooks_last ON hooks (last DESC);
    CREATE TABLE IF NOT EXISTS pools (n INTEGER PRIMARY KEY, id BLOB NOT NULL UNIQUE, c0 INTEGER NOT NULL, c1 INTEGER NOT NULL, fee INTEGER NOT NULL, ts INTEGER NOT NULL, hook INTEGER NOT NULL, blk INTEGER NOT NULL, tx BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS pools_blk ON pools (blk);
    CREATE INDEX IF NOT EXISTS pools_hook_blk ON pools (hook, blk);
    CREATE INDEX IF NOT EXISTS pools_c0_blk ON pools (c0, blk);
    CREATE INDEX IF NOT EXISTS pools_c1_blk ON pools (c1, blk);
    DROP INDEX IF EXISTS pools_hook; DROP INDEX IF EXISTS pools_c0; DROP INDEX IF EXISTS pools_c1;
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID;`);
  const S = new Map(), q = (sql) => { let s = S.get(sql); if (!s) { s = db.prepare(sql); S.set(sql, s); } return s; };
  const meta = { get: (k, d = null) => { const r = q('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : d; }, set: (k, v) => q('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)) };
  const one = (sql, ...a) => q(sql).get(...a).n;
  const counts = { pools: one('SELECT COUNT(*) n FROM pools'), hooked: one('SELECT COALESCE(SUM(pools),0) n FROM hooks'), hooks: one('SELECT COUNT(*) n FROM hooks'), tokens: one('SELECT COUNT(*) n FROM tokens') };

  // an address -> its small integer, creating the row the first time it is seen (a short-lived cache covers bursts)
  const tokIds = new Map(), hookIds = new Map(), trim = (m) => { if (m.size > 200000) m.clear(); };
  function tokenId(h, create) { let n = tokIds.get(h); if (n) return n; const b = bin(h); let r = q('SELECT n FROM tokens WHERE addr=?').get(b);
    if (!r && create) { r = { n: Number((h === Z ? q("INSERT INTO tokens (addr,symbol,name,decimals,read) VALUES (?,?,?,18,1)") : q('INSERT INTO tokens (addr) VALUES (?)')).run(...(h === Z ? [b, x.native.symbol, x.native.name] : [b])).lastInsertRowid) }; counts.tokens++; } if (!r) return 0; trim(tokIds); tokIds.set(h, r.n); return r.n; }
  function hookId(h, blk) { if (h === Z) return 0; let n = hookIds.get(h); if (!n) { const b = bin(h); let r = q('SELECT n FROM hooks WHERE addr=?').get(b);
      if (!r && blk != null) { r = { n: Number(q('INSERT INTO hooks (addr,first,last) VALUES (?,?,?)').run(b, blk, blk).lastInsertRowid) }; counts.hooks++; } if (!r) return -1; n = r.n; trim(hookIds); hookIds.set(h, n); }
    return n; }

  // written in slices so the API keeps answering while a dense range lands
  async function addLogs(all, mark) { for (let i = 0; i < all.length || i === 0; i += 1000) { addSlice(all.slice(i, i + 1000), i + 1000 >= all.length ? mark : null); if (i + 1000 < all.length) await new Promise((z) => setImmediate(z)); } }
  function addSlice(logs, mark) {
    db.exec('BEGIN'); const before = { ...counts };
    try {
      for (const l of logs) { const w = words(l.data), hooks = w[2].slice(24), blk = Number(l.blockNumber), id = bin(l.topics[1]);
        if (q('SELECT 1 x FROM pools WHERE id=?').get(id)) continue;
        const h = hookId(hooks, blk); q('INSERT INTO pools (id,c0,c1,fee,ts,hook,blk,tx) VALUES (?,?,?,?,?,?,?,?)').run(id, tokenId(l.topics[2].slice(26), true), tokenId(l.topics[3].slice(26), true), Number(toUint(w[0])), Number(toInt(w[1], 24)), h, blk, bin(l.transactionHash));
        counts.pools++; if (h) { counts.hooked++; q('UPDATE hooks SET pools=pools+1, last=MAX(last,?), first=MIN(first,?) WHERE n=?').run(blk, blk, h); } }
      if (mark) meta.set(mark[0], mark[1]); db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); Object.assign(counts, before); tokIds.clear(); hookIds.clear(); throw e; }
  }

  // ---- follow the chain forward, and fill history backward ----
  // an index built by the first version (forward from block 0) carries 'through': it is complete below that
  const legacy = meta.get('through');
  const sync = { hi: Number(meta.get('hi', legacy == null ? -1 : legacy)), lo: Number(meta.get('lo', legacy == null ? -1 : START)), head: 0, running: false, error: null, blocked: meta.get('blocked') || null };
  const logsOf = (from, to) => x.rpc.one('eth_getLogs', [{ address: x.C.poolManager, topics: [INIT], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
  const archive = (e) => /archive|personal token|pruned|missing trie|not available|history/i.test(e.message || '');
  let span = Math.min(MAXSPAN, 250000), blockedAt = 0;
  async function step() {
    if (sync.running) return; sync.running = true;
    try {
      sync.head = Number(await x.rpc.one('eth_blockNumber'));
      if (sync.hi < 0) { sync.hi = sync.head; sync.lo = sync.head + 1; meta.set('hi', sync.hi); meta.set('lo', sync.lo); } // a fresh index starts at the head
      // 1. forward: everything new since last time
      while (sync.hi < sync.head) { const from = sync.hi + 1, to = Math.min(sync.head, from + span - 1);
        let logs; try { logs = await logsOf(from, to); } catch (e) { if (span > 50) { span = Math.max(50, Math.floor(span / 2)); continue; } throw e; }
        await addLogs(logs, ['hi', to]); sync.hi = to; }
      // 2. backward: a budget of history per tick, newest first, until the deployment block
      const until = Date.now() + 6000;
      while (sync.lo > START && Date.now() < until) {
        if (sync.blocked && Date.now() - blockedAt < 30 * 60e3) break; // the RPC would not serve this depth: look again in half an hour
        const to = sync.lo - 1, from = Math.max(START, to - span + 1);
        let logs; try { logs = await logsOf(from, to); }
        catch (e) { if (archive(e)) { sync.blocked = 'This RPC does not serve logs older than block ' + sync.lo + '. Set RPC_' + x.id + ' to an archive endpoint to index the rest.'; blockedAt = Date.now(); meta.set('blocked', sync.blocked); break; }
          if (span > 50) { span = Math.max(50, Math.floor(span / 2)); continue; } throw e; }
        if (sync.blocked) { sync.blocked = null; meta.set('blocked', ''); }
        await addLogs(logs, ['lo', from]); sync.lo = from; if (logs.length < 4000 && span < MAXSPAN) span = Math.min(MAXSPAN, span * 2);
        await sleep(PACE);
      }
      sync.error = null;
    } catch (e) { sync.error = e.message; } finally { sync.running = false; }
  }
  const start = () => { step(); setInterval(step, 8000).unref(); };

  // ---- reads ----
  const POOL = 'SELECT p.n, p.id, p.fee, p.ts, p.blk, p.tx, a.addr a0, a.symbol s0, a.decimals d0, a.read r0, b.addr a1, b.symbol s1, b.decimals d1, b.read r1, h.addr ha FROM pools p JOIN tokens a ON a.n=p.c0 JOIN tokens b ON b.n=p.c1 LEFT JOIN hooks h ON h.n=p.hook';
  const rowKey = (r) => ({ currency0: addr(r.a0), currency1: addr(r.a1), fee: r.fee, tickSpacing: r.ts, hooks: r.ha ? addr(r.ha) : ZERO });
  const tok = (a, s, d, read) => (hx(a) === Z ? { address: ZERO, symbol: x.native.symbol, decimals: 18 } : { address: addr(a), symbol: read ? s : null, decimals: read ? d : null });
  const poolRow = (r) => { const t0 = tok(r.a0, r.s0, r.d0, r.r0), t1 = tok(r.a1, r.s1, r.d1, r.r1); return { poolId: '0x' + hx(r.id), key: rowKey(r), pair: (t0.symbol || '?') + '/' + (t1.symbol || '?'), currency0: t0, currency1: t1, hooked: !!r.ha, dynamicFee: r.fee === DYNAMIC_FEE, createdBlock: r.blk, txHash: '0x' + hx(r.tx) }; };
  const lc = (a) => a.toLowerCase().replace(/^0x/, '');
  function listPools({ hook, token, tokenA, tokenB, hooked, limit, offset }) {
    const wh = [], args = []; let none = false;
    if (hook) { const h = hookId(lc(hook)); if (h <= 0 && lc(hook) !== Z) none = true; wh.push('p.hook=?'); args.push(Math.max(0, h)); }
    if (token) { const t = tokenId(lc(token)); if (!t) none = true; wh.push('(p.c0=? OR p.c1=?)'); args.push(t, t); }
    if (tokenA && tokenB) { const [u, v] = BigInt(tokenA) < BigInt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA], a = tokenId(lc(u)), b = tokenId(lc(v)); if (!a || !b) none = true; wh.push('p.c0=? AND p.c1=?'); args.push(a, b); }
    if (hooked === true) wh.push('p.hook<>0'); else if (hooked === false) wh.push('p.hook=0');
    if (none) return { total: 0, pools: [], limit, offset };
    const W = wh.length ? ' WHERE ' + wh.join(' AND ') : '', simple = wh.length === 1 && hooked !== undefined;
    const total = !wh.length ? counts.pools : simple ? (hooked ? counts.hooked : counts.pools - counts.hooked) : one('SELECT COUNT(*) n FROM pools p' + W, ...args);
    return { total, pools: q(POOL + W + ' ORDER BY p.blk DESC LIMIT ? OFFSET ?').all(...args, limit, offset).map(poolRow), limit, offset };
  }
  const getPool = (id) => { const r = q(POOL + ' WHERE p.id=?').get(bin(id)); return r ? { key: rowKey(r), block: r.blk, txHash: '0x' + hx(r.tx) } : null; };
  function pairPools(a, b, max = 1500) { const [u, v] = BigInt(a) < BigInt(b) ? [a, b] : [b, a], i = tokenId(lc(u)), j = tokenId(lc(v)); if (!i || !j) return { total: 0, rows: [] };
    return { total: one('SELECT COUNT(*) n FROM pools p WHERE p.c0=? AND p.c1=?', i, j), rows: q(POOL + ' WHERE p.c0=? AND p.c1=? ORDER BY p.blk DESC LIMIT ?').all(i, j, max).map((r) => ({ poolId: '0x' + hx(r.id), key: rowKey(r) })) }; }
  const flagsOf = (u8) => ((u8[18] << 8) | u8[19]) & MASK;
  const hookRow = (r) => { const f = flagsOf(r.addr); return { address: addr(r.addr), flags: hex4(f), enabled: decodeFlags(f).enabled, pools: r.pools, firstSeenBlock: r.first, lastPoolBlock: r.last, warnings: warningFlags(f) }; };
  const listHooks = ({ sort, limit, offset }) => ({ total: counts.hooks, limit, offset, hooks: q('SELECT * FROM hooks ORDER BY ' + (sort === 'recent' ? 'last' : 'pools') + ' DESC LIMIT ? OFFSET ?').all(limit, offset).map(hookRow) });
  const hookPools = (a) => { const h = hookId(lc(a)); if (h <= 0) return { total: 0, recent: [] }; return { total: one('SELECT pools n FROM hooks WHERE n=?', h), recent: q(POOL + ' WHERE p.hook=? ORDER BY p.blk DESC LIMIT 25').all(h).map(poolRow) }; };
  // how many indexed hooks carry each permission, and how many can move tokens: the shape of the hooks meta
  let census = null;
  function flagCensus() {
    if (census && Date.now() - census.at < 60e3) return census.v;
    const by = Object.fromEntries(FLAG_NAMES.map((n) => [n, { hooks: 0, pools: 0 }])); let pricing = 0, fees = 0, lockable = 0;
    for (const r of q('SELECT addr,pools FROM hooks').all()) { const f = flagsOf(r.addr);
      for (const n of FLAG_NAMES) if (f & FLAG_BITS[n]) { by[n].hooks++; by[n].pools += r.pools; }
      if (f & FLAG_BITS.beforeSwapReturnDelta) pricing++; if (f & FLAG_BITS.afterSwapReturnDelta) fees++; if (f & FLAG_BITS.beforeRemoveLiquidity) lockable++; }
    census = { at: Date.now(), v: { hooks: counts.hooks, byFlag: by, canSetPrice: pricing, canChargeAfterSwap: fees, canBlockWithdrawals: lockable } }; return census.v;
  }
  const getToken = (a) => { const t = q('SELECT addr,symbol,name,decimals,read FROM tokens WHERE addr=?').get(bin(a)); return t && t.read ? { address: addr(t.addr), symbol: t.symbol, name: t.name, decimals: t.decimals } : null; };
  const putToken = (a, t) => q('INSERT INTO tokens (addr,symbol,name,decimals,read) VALUES (?,?,?,?,1) ON CONFLICT(addr) DO UPDATE SET symbol=excluded.symbol,name=excluded.name,decimals=excluded.decimals,read=1').run(bin(a), t.symbol, t.name, t.decimals);
  // newest first: the tokens of the latest pools are the ones people look at
  const unreadTokens = (n) => q('SELECT addr FROM tokens WHERE read=0 ORDER BY n DESC LIMIT ?').all(n).map((r) => '0x' + hx(r.addr)).filter((a) => a !== ZERO);
  // indexedFromBlock..indexedThroughBlock is what the index covers; complete means it reaches back to the PoolManager's deployment
  const stats = () => ({ pools: counts.pools, hookedPools: counts.hooked, uniqueHooks: counts.hooks, tokens: counts.tokens, indexedFromBlock: Math.max(START, Math.min(sync.lo, Math.max(0, sync.hi))), indexedThroughBlock: Math.max(0, sync.hi), headBlock: sync.head,
    complete: sync.hi >= 0 && sync.lo <= START, ...(sync.blocked ? { history: sync.blocked } : {}) });
  return { start, sync, stats, listPools, getPool, pairPools, listHooks, hookPools, flagCensus, getToken, putToken, unreadTokens, meta, x };
}

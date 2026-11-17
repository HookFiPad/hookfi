// The API. Each operation is one function taking plain input; REST routes and MCP tools both call these.
import { CHAIN, CREATE2_DEPLOYER, ApiError, rpc, normalizeKey, poolIdOf, poolState, quote, buildSwap, hookCode, profileWarnings, slot0Many, spotPrice, tokens, blockTimes, feeLabel } from './chain.js';
import { keccak, checksum, hex, bytes, call, words, toUint, toAddr, topic, formatUnits } from './evm.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { makeLaunch } from './launch.js';
import { ZERO, MASK, DYNAMIC_FEE, FLAG_TABLE, FLAG_BITS, decodeHookAddress, decodeFlags, flagsFor, flagErrors, hex4, isAddress, capabilities } from '../lib/hooks.js';

const bad = (m) => new ApiError(400, 'bad_request', m);
const int = (v, d, lo, hi, name) => { if (v == null || v === '') return d; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(name + ' must be ' + lo + ' to ' + hi); return n; };
const bool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : undefined);
const isId = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const addrOf = (v, name) => { if (!isAddress(v)) throw bad(name + ' must be an address'); return checksum(v); };

export function makeApi(store, cfg) {
  // a pool named by poolId (must be indexed, to recover its key) or by its key (any pool)
  function resolve(input) {
    if (input.poolId != null && input.poolId !== '') { if (!isId(input.poolId)) throw bad('poolId must be a 32-byte hex id');
      const p = store.getPool(input.poolId); if (!p) throw new ApiError(404, 'not_found', 'Pool ' + input.poolId + ' is not in the index. Pass its key (currency0, currency1, fee, tickSpacing, hooks) instead.'); return p; }
    if (input.currency0 == null || input.currency1 == null) throw bad('pass poolId, or the pool key: currency0, currency1, fee, tickSpacing, hooks');
    const { key } = normalizeKey(input), hit = store.getPool(poolIdOf(key)); return { key, block: hit ? hit.block : null, txHash: hit ? hit.txHash : null };
  }
  const created = async (p) => (p.block == null ? null : { block: p.block, txHash: p.txHash, at: (await blockTimes([p.block]))[0] });
  const warmTokens = (rows) => { tokens(rows.flatMap((r) => [r.key.currency0, r.key.currency1]), store).catch(() => {}); };
  const stamp = async (rows) => { const at = await blockTimes(rows.map((r) => r.createdBlock)).catch(() => rows.map(() => null)); rows.forEach((r, i) => { r.createdAt = at[i]; }); return rows; };

  const L = makeLaunch();
  const api = {
    // ---- launchpad (every chain with Uniswap v4) ----
    launchChains: () => L.chains(), launchBuild: (i) => L.build(i), launchList: (i) => L.list(i), launchToken: (i) => L.token(i), launchQuote: (i) => L.quote(i), launchSwap: (i) => L.swap(i), launchClaim: (i) => L.claim(i),

    chain: async () => ({ id: CHAIN.id, name: CHAIN.name, rpc: CHAIN.rpc, explorer: CHAIN.explorer, contracts: CHAIN.contracts, create2Deployer: CREATE2_DEPLOYER }),
    stats: async () => ({ chain: { id: CHAIN.id, name: CHAIN.name, explorer: CHAIN.explorer, contracts: CHAIN.contracts }, index: store.stats() }),
    census: async () => store.flagCensus(),

    // ---- hooks ----
    flagTable: async () => ({ mask: hex4(MASK), flags: FLAG_TABLE }),
    decodeHook: async ({ address }) => decodeHookAddress(addrOf(address, 'address')),
    listHooks: async (i) => store.listHooks({ sort: i.sort === 'recent' ? 'recent' : 'pools', limit: int(i.limit, 25, 1, 100, 'limit'), offset: int(i.offset, 0, 0, 1e9, 'offset') }),
    inspectHook: async ({ address }) => {
      const a = addrOf(address, 'address'), d = decodeHookAddress(a), code = await hookCode(a), pools = store.hookPools(a);
      await stamp(pools.recent); warmTokens(pools.recent);
      return { ...d, chain: CHAIN.name, explorer: CHAIN.explorer + '/address/' + a, code, warnings: profileWarnings(d, code), pools };
    },
    mine: async (i) => {
      let flags; try { flags = flagsFor(i.flags); } catch (e) { throw bad(e.message); }
      const errs = flagErrors(flags); if (errs.length) throw new ApiError(422, 'invalid_flags', errs.join('; '));
      let initCodeHash = i.initCodeHash;
      if (i.initCode != null && i.initCode !== '') { if (!/^0x([0-9a-fA-F]{2})+$/.test(i.initCode)) throw bad('initCode must be hex bytes'); initCodeHash = keccak(i.initCode); }
      if (!isId(initCodeHash)) throw bad('pass initCodeHash (32 bytes) or initCode');
      const deployer = i.deployer ? addrOf(i.deployer, 'deployer') : CREATE2_DEPLOYER, max = int(i.maxIterations, 200000, 1, 400000, 'maxIterations');
      let start; try { start = BigInt(i.startSalt == null || i.startSalt === '' ? 0 : i.startSalt); } catch { throw bad('startSalt must be an integer'); } if (start < 0n) throw bad('startSalt must not be negative');
      // CREATE2: address = keccak256(0xff ++ deployer ++ salt ++ initCodeHash)[12:]
      const buf = Buffer.alloc(85); buf[0] = 0xff; bytes(deployer).copy(buf, 1); bytes(initCodeHash).copy(buf, 53);
      const t0 = Date.now(), saltAt = (s) => { const h = s.toString(16).padStart(64, '0'); buf.write(h, 21, 'hex'); return h; };
      for (let n = 0; n < max; n++) { const s = start + BigInt(n), h = saltAt(s), d = keccak_256(buf);
        if ((((d[30] << 8) | d[31]) & MASK) === flags) { const address = checksum('0x' + hex(d.subarray(12)));
          buf.write(h, 21, 'hex'); const again = checksum('0x' + hex(keccak_256(buf).subarray(12)));
          return { found: true, salt: '0x' + h, address, iterations: n + 1, flags, flagsHex: hex4(flags), permissions: decodeFlags(flags).permissions, deployer, initCodeHash, ms: Date.now() - t0, verify: again === address && (parseInt(address.slice(-4), 16) & MASK) === flags,
            note: 'Deploy via the CREATE2 deployer: send salt ++ initCode as calldata to ' + deployer + ', or `new Hook{salt: salt}(...)` from a Foundry script.' }; } }
      return { found: false, iterations: max, nextSalt: (start + BigInt(max)).toString(), flags, flagsHex: hex4(flags), ms: Date.now() - t0, note: 'No match within maxIterations; retry with startSalt = nextSalt.' };
    },

    // ---- pools ----
    poolId: async (i) => { const { key, sorted } = normalizeKey(i); return { poolId: poolIdOf(key), key, sorted }; },
    listPools: async (i) => {
      for (const k of ['hook', 'token', 'tokenA', 'tokenB']) if (i[k] != null && i[k] !== '' && !isAddress(i[k])) throw bad(k + ' must be an address');
      if (!!i.tokenA !== !!i.tokenB) throw bad('pass tokenA and tokenB together');
      const r = store.listPools({ hook: i.hook, token: i.token, tokenA: i.tokenA, tokenB: i.tokenB, hooked: bool(i.hooked), limit: int(i.limit, 25, 1, 100, 'limit'), offset: int(i.offset, 0, 0, 1e9, 'offset') });
      await stamp(r.pools); warmTokens(r.pools); return r;
    },
    getPool: async (i) => { const p = resolve(i); return poolState(p.key, await created(p), store); },
    checkPool: async (i) => {
      const p = resolve(i), s = await poolState(p.key, null, store), hooked = p.key.hooks !== ZERO, reasons = { high: [], medium: [] };
      let hook = null;
      if (hooked) { const d = decodeHookAddress(p.key.hooks), code = await hookCode(p.key.hooks), f = d.flags; hook = { address: p.key.hooks, enabled: d.enabled, code: { deployed: code.deployed, codeSize: code.codeSize, proxy: code.proxy } };
        if (d.errors.length) reasons.high.push('Invalid hook address: ' + d.errors.join('; '));
        if (!code.deployed) reasons.high.push('No contract code at the hook address');
        if (code.proxy && code.proxy.upgradeable) reasons.high.push('Hook is an upgradeable proxy: its logic can be changed after you trade or deposit');
        if (f & FLAG_BITS.beforeRemoveLiquidity) reasons.high.push('Hook can block LP withdrawals (beforeRemoveLiquidity)');
        if (f & FLAG_BITS.beforeSwapReturnDelta) reasons.medium.push('Hook can set its own swap price (beforeSwapReturnDelta)');
        if (f & FLAG_BITS.afterSwapReturnDelta) reasons.medium.push('Hook can charge or rebate tokens after each swap (afterSwapReturnDelta)');
        if (f & (FLAG_BITS.afterAddLiquidityReturnDelta | FLAG_BITS.afterRemoveLiquidityReturnDelta)) reasons.medium.push('Hook can take or add tokens when liquidity moves');
        if (s.dynamicFee && (f & FLAG_BITS.beforeSwap)) reasons.medium.push('Dynamic-fee pool: the hook can change the LP fee on every swap'); }
      let quoteCheck = null;
      if (i.amount != null && i.amount !== '') {
        try { const q = await quote(p.key, { tokenIn: i.tokenIn, zeroForOne: i.zeroForOne, amount: i.amount }, store), d0 = s.currency0.decimals, d1 = s.currency1.decimals;
          const p10 = spotPrice(BigInt(s.state.sqrtPriceX96), d0, d1), spot = Number(q.amountIn) * (q.zeroForOne ? p10 : 1 / p10), vs = spot ? Number((((Number(q.amountOut) - spot) / spot) * 100).toFixed(2)) : null;
          quoteCheck = { tokenIn: q.tokenIn.symbol, tokenOut: q.tokenOut.symbol, amountIn: q.amountIn, amountOut: q.amountOut, spotAmountOut: spot, vsSpotPct: vs };
          if (vs != null && Math.abs(vs) > 1) reasons.medium.push("Quote is " + Math.abs(vs) + "% " + (vs < 0 ? 'below' : 'above') + " the pool's own spot price");
        } catch (e) { if (!(e instanceof ApiError)) throw e; quoteCheck = { error: e.message }; reasons.medium.push('The quote for this amount reverted'); }
      }
      const level = reasons.high.length ? 'high' : reasons.medium.length ? 'medium' : 'low';
      return { poolId: s.poolId, pair: (s.currency0.symbol || '?') + '/' + (s.currency1.symbol || '?'), fee: feeLabel(p.key.fee), currentLpFee: s.state.lpFeePercent + '%', hook, quoteCheck, risk: { level, reasons: [...reasons.high, ...reasons.medium] },
        note: 'Heuristic from on-chain permissions, bytecode, and a live quote. Not an audit: a hook can behave in ways these checks do not see.' };
    },

    // ---- quotes and swaps ----
    quote: async (i) => quote(resolve(i).key, i, store),
    bestQuote: async (i) => {
      const tokenIn = addrOf(i.tokenIn, 'tokenIn'), tokenOut = addrOf(i.tokenOut, 'tokenOut'), limit = int(i.limit, 8, 1, 15, 'limit');
      if (tokenIn === tokenOut) throw bad('tokenIn and tokenOut must differ'); if (i.amount == null) throw bad('amount is required');
      const pair = store.pairPools(tokenIn, tokenOut); if (!pair.total) throw new ApiError(404, 'not_found', 'No indexed v4 pool for this pair');
      const states = await slot0Many(pair.rows.map((r) => r.poolId)), live = pair.rows.map((r, k) => ({ ...r, s: states[k] })).filter((r) => r.s && r.s.initialized);
      // the deepest pools, plus pools whose hook prices swaps itself (those can fill with no pool liquidity)
      const deep = [...live].sort((a, b) => (b.s.liquidity > a.s.liquidity ? 1 : b.s.liquidity < a.s.liquidity ? -1 : 0)).slice(0, limit);
      const own = live.filter((r) => !deep.includes(r) && r.key.hooks !== ZERO && (parseInt(r.key.hooks.slice(-4), 16) & FLAG_BITS.beforeSwapReturnDelta)).slice(0, 4);
      const [tIn, tOut] = await tokens([tokenIn, tokenOut], store); let failed = 0; const routes = [];
      await Promise.all([...deep, ...own].map(async (r) => { try { const q = await quote(r.key, { tokenIn, amount: i.amount }, store), zf = q.zeroForOne;
        const p10 = tIn.decimals != null && tOut.decimals != null ? spotPrice(r.s.sqrtPriceX96, zf ? tIn.decimals : tOut.decimals, zf ? tOut.decimals : tIn.decimals) : 0, spot = p10 ? Number(q.amountIn) * (zf ? p10 : 1 / p10) : null;
        const d = r.key.hooks !== ZERO ? decodeHookAddress(r.key.hooks) : null;
        routes.push({ poolId: r.poolId, fee: feeLabel(r.key.fee), currentLpFee: Number((r.s.lpFee / 10000).toFixed(6)) + '%', hook: d ? { address: r.key.hooks, enabled: d.enabled, warnings: d.capabilities.filter((c) => c.level === 'warning').map((c) => c.note) } : null,
          amountOut: q.amountOut, spotAmountOut: spot == null ? null : Number(spot.toPrecision(12)), vsSpotPct: spot ? Number((((Number(q.amountOut) - spot) / spot) * 100).toFixed(2)) : null, gasEstimate: q.gasEstimate, _raw: BigInt(q.amountOutRaw) });
      } catch (e) { if (e instanceof ApiError && e.code === 'no_route') failed++; else throw e; } }));
      if (!routes.length) throw new ApiError(422, 'no_route', 'Every pool for this pair reverted the quote for this amount');
      routes.sort((a, b) => (b._raw > a._raw ? 1 : b._raw < a._raw ? -1 : 0)); routes.forEach((r) => delete r._raw);
      return { tokenIn: tIn, tokenOut: tOut, amountIn: String(i.amount), best: routes[0], routes, considered: { pairPools: pair.total, initialized: live.length, quoted: routes.length, failed } };
    },
    buildSwap: async (i) => { const out = await buildSwap(resolve(i).key, i, store); out.note = out.note.replace('HookFi', cfg.name); return out; },

    // ---- the token: supply and burns, read from the chain on each request (cached for 60 seconds) ----
    token: async () => {
      if (!isAddress(cfg.token)) return { symbol: cfg.ticker, chain: CHAIN.name, chainId: CHAIN.id, address: null, live: false };
      if (api._tok && Date.now() - api._tok.at < 60e3) return api._tok.v;
      const DEAD = '0x000000000000000000000000000000000000dEaD', T = cfg.token;
      const [sup, dead, dec] = await rpc.batch([['eth_call', [{ to: T, data: call('totalSupply()') }, 'latest']], ['eth_call', [{ to: T, data: call('balanceOf(address)', ['address'], [DEAD]) }, 'latest']], ['eth_call', [{ to: T, data: call('decimals()') }, 'latest']]]);
      const d = dec.result ? Number(toUint(dec.result.slice(2))) : 18, supply = sup.result ? toUint(sup.result.slice(2)) : 0n, burned = dead.result ? toUint(dead.result.slice(2)) : 0n;
      const logs = await rpc.one('eth_getLogs', [{ address: T, topics: [topic('Transfer(address,address,uint256)'), null, '0x' + DEAD.slice(2).toLowerCase().padStart(64, '0')], fromBlock: '0x0', toBlock: 'latest' }]).catch(() => []);
      const at = await blockTimes(logs.map((l) => Number(l.blockNumber))).catch(() => []), bb = (cfg.buybackWallet || '').toLowerCase();
      const burns = logs.map((l, k) => { const from = toAddr(l.topics[1].slice(2)); return { amount: formatUnits(toUint(l.data.slice(2)), d), from, kind: bb && from.toLowerCase() === bb ? 'buyback' : 'burn', txHash: l.transactionHash, block: Number(l.blockNumber), at: at[k] || null }; }).reverse();
      const v = { symbol: cfg.ticker, chain: CHAIN.name, chainId: CHAIN.id, address: checksum(T), live: true, decimals: d, totalSupply: formatUnits(supply, d), burned: formatUnits(burned, d), burnedPct: supply ? Number(((Number(burned) / Number(supply)) * 100).toFixed(4)) : 0, buybackWallet: cfg.buybackWallet || null, buybacks: burns.filter((b) => b.kind === 'buyback').length, burns };
      api._tok = { at: Date.now(), v }; return v;
    },
  };
  return api;
}
export { capabilities };

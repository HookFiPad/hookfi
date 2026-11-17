// Everything that reads Robinhood Chain: token metadata, pool state, quotes, swap calldata, hook bytecode.
import { rpcClient, call, encode, words, toUint, toInt, toAddr, toString, keccak, checksum, parseUnits, formatUnits, selector, bytes } from './evm.js';
import { ZERO, DYNAMIC_FEE, decodeHookAddress, isAddress } from '../lib/hooks.js';

export const CHAIN = {
  id: 4663, name: 'Robinhood Chain',
  rpc: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  explorer: process.env.EXPLORER_URL || 'https://robinhoodchain.blockscout.com',
  contracts: {
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951', positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
    stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b', quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
    universalRouter: '0x204FAca1764B154221e35c0d20aBb3c525710498', permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  },
};
export const CREATE2_DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
export const rpc = rpcClient(CHAIN.rpc);
const C = CHAIN.contracts;
// the chain a call reads: its RPC client, its v4 contracts, its native coin. MAIN is Robinhood Chain.
export const MAIN = { id: CHAIN.id, name: CHAIN.name, rpc, C, native: { symbol: 'ETH', name: 'Ether' }, main: true };

// Multicall3: hundreds of contract reads in one eth_call. Returns [{ ok, data }] in order.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export async function multi(calls, x = MAIN) {
  const out = [];
  for (let i = 0; i < calls.length; i += 250) {
    const part = calls.slice(i, i + 250), res = await x.rpc.ethCall(MULTICALL3, call('aggregate3((address,bool,bytes)[])', [{ array: { tuple: ['address', 'bool', 'bytes'] } }], [part.map(([to, data]) => [to, true, data])]));
    const s = res.slice(2), base = Number(toUint(s.slice(0, 64))) * 2 + 64, n = Number(toUint(s.slice(base - 64, base)));
    for (let k = 0; k < n; k++) { const el = base + Number(toUint(s.slice(base + k * 64, base + k * 64 + 64))) * 2, ok = toUint(s.slice(el, el + 64)) === 1n, b = el + Number(toUint(s.slice(el + 64, el + 128))) * 2, len = Number(toUint(s.slice(b, b + 64)));
      out.push({ ok, data: '0x' + s.slice(b + 64, b + 64 + len * 2) }); }
  }
  return out;
}

export class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const bad = (m) => new ApiError(400, 'bad_request', m);

// ---- pool keys ----
const KEY_T = { tuple: ['address', 'address', 'uint', 'int', 'address'] };
const keyVals = (k) => [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];
export const poolIdOf = (k) => keccak(encode(KEY_T.tuple, keyVals(k)));
// accepts currencies in either order; returns the canonical key and whether it had to swap them
export function normalizeKey(input) {
  const { currency0, currency1 } = input, hooks = input.hooks || ZERO, fee = Number(input.fee), tickSpacing = Number(input.tickSpacing);
  if (!isAddress(currency0) || !isAddress(currency1)) throw bad('currency0 and currency1 must be addresses (native ETH is the zero address)');
  if (currency0.toLowerCase() === currency1.toLowerCase()) throw bad('currency0 and currency1 must differ');
  if (!isAddress(hooks)) throw bad('hooks must be an address');
  if (!Number.isInteger(fee) || fee < 0 || (fee > 1000000 && fee !== DYNAMIC_FEE)) throw bad('fee must be 0 to 1000000 (hundredths of a bip), or 8388608 for a dynamic-fee pool');
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1 || tickSpacing > 32767) throw bad('tickSpacing must be 1 to 32767');
  const sorted = BigInt(currency0) > BigInt(currency1), [a, b] = sorted ? [currency1, currency0] : [currency0, currency1];
  return { key: { currency0: checksum(a), currency1: checksum(b), fee, tickSpacing, hooks: checksum(hooks) }, sorted };
}

// ---- token metadata (cached; native ETH is the zero address) ----
const ETH = { address: ZERO, symbol: 'ETH', name: 'Ether', decimals: 18 };
const tokenCache = new Map();
export async function tokens(addrs, store, x = MAIN) {
  if (!x.main) store = null; // the index only holds Robinhood Chain tokens
  const K = (a) => x.id + ':' + a.toLowerCase();
  const want = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => a !== ZERO && !tokenCache.has(K(a)));
  for (const a of want) { const row = store && store.getToken(a); if (row) tokenCache.set(K(a), row); }
  const miss = want.filter((a) => !tokenCache.has(K(a)));
  if (miss.length) {
    const res = await multi(miss.flatMap((a) => [[a, selector('symbol()')], [a, selector('name()')], [a, selector('decimals()')]]), x);
    miss.forEach((a, i) => { const [s, n, d] = res.slice(i * 3, i * 3 + 3), dec = d.ok && d.data.length >= 66 ? Number(toUint(d.data.slice(2, 66))) : null;
      const t = { address: checksum(a), symbol: s.ok ? toString(s.data) : null, name: n.ok ? toString(n.data) : null, decimals: dec != null && dec <= 255 ? dec : null };
      tokenCache.set(K(a), t); if (store) store.putToken(a, t); });
  }
  return addrs.map((a) => (a.toLowerCase() === ZERO ? { ...ETH, ...x.native } : tokenCache.get(K(a))));
}
const needDecimals = (t) => { if (t.decimals == null) throw new ApiError(422, 'no_route', 'Token ' + t.address + ' does not report decimals(), so amounts cannot be scaled'); return t; };

// ---- live pool state (StateView reads the PoolManager's storage) ----
export async function slot0Many(poolIds, x = MAIN) {
  const res = await multi(poolIds.flatMap((id) => [[x.C.stateView, call('getSlot0(bytes32)', ['bytes32'], [id])], [x.C.stateView, call('getLiquidity(bytes32)', ['bytes32'], [id])]]), x);
  return poolIds.map((id, i) => { const a = res[i * 2], b = res[i * 2 + 1]; if (!a.ok || a.data.length < 258) return null; const w = words(a.data), sqrt = toUint(w[0]);
    return { initialized: sqrt > 0n, sqrtPriceX96: sqrt, tick: Number(toInt(w[1], 24)), protocolFee: Number(toUint(w[2])), lpFee: Number(toUint(w[3])), liquidity: b.ok && b.data.length >= 66 ? toUint(words(b.data)[0]) : 0n }; });
}
// currency1 per currency0, adjusted for decimals
export function spotPrice(sqrtPriceX96, d0, d1) {
  const Q = 2n ** 192n, sq = sqrtPriceX96 * sqrtPriceX96, scale = 10n ** 18n;
  const raw = Number((sq * scale) / Q) / 1e18 || Number(sq) / Number(Q);
  return raw * 10 ** (d0 - d1);
}
const pct = (fee) => Number((fee / 10000).toFixed(6));
export const feeLabel = (fee) => (fee === DYNAMIC_FEE ? 'dynamic' : pct(fee) + '%');
const hookBrief = (addr) => { if (addr === ZERO) return null; const d = decodeHookAddress(addr); return { address: addr, enabled: d.enabled, capabilities: d.capabilities }; };

export async function poolState(key, created, store, x = MAIN) {
  const poolId = poolIdOf(key), [s] = await slot0Many([poolId], x);
  if (!s || !s.initialized) throw new ApiError(404, 'not_found', 'Pool ' + poolId + ' is not initialized on ' + x.name);
  const [t0, t1] = await tokens([key.currency0, key.currency1], store, x), sym = (t) => t.symbol || t.address.slice(0, 8);
  let price = null; if (t0.decimals != null && t1.decimals != null) { const p = spotPrice(s.sqrtPriceX96, t0.decimals, t1.decimals); price = { [sym(t0) + '/' + sym(t1)]: p, [sym(t1) + '/' + sym(t0)]: p ? 1 / p : null }; }
  return { poolId, key, currency0: t0, currency1: t1, dynamicFee: key.fee === DYNAMIC_FEE, hooked: key.hooks !== ZERO,
    state: { initialized: true, sqrtPriceX96: s.sqrtPriceX96.toString(), tick: s.tick, liquidity: s.liquidity.toString(), lpFee: s.lpFee, lpFeePercent: pct(s.lpFee), protocolFee: s.protocolFee },
    price, hook: hookBrief(key.hooks), created: created || null };
}

// ---- quotes: the on-chain V4Quoter simulates the real swap, so the pool's hook runs ----
const QUOTE_T = [{ tuple: [KEY_T, 'bool', 'uint', 'bytes'] }];
const hexData = (h) => { const v = h == null || h === '' ? '0x' : String(h); if (!/^0x([0-9a-fA-F]{2})*$/.test(v)) throw bad('hookData must be hex bytes'); return v; };
export function direction(key, input) {
  if (input.tokenIn != null && input.tokenIn !== '') { if (!isAddress(input.tokenIn)) throw bad('tokenIn must be an address');
    const t = input.tokenIn.toLowerCase(); if (t === key.currency0.toLowerCase()) return true; if (t === key.currency1.toLowerCase()) return false; throw bad("tokenIn must be one of the pool's currencies"); }
  if (input.zeroForOne == null) return true; return input.zeroForOne === true || input.zeroForOne === 'true';
}
export async function quote(key, input, store, x = MAIN) {
  const zeroForOne = direction(key, input), exactOut = input.exactOut === true || input.exactOut === 'true', hookData = hexData(input.hookData);
  const [tIn, tOut] = await tokens(zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0], store, x);
  if (input.amount == null) throw bad('amount is required');
  let amount; try { amount = parseUnits(input.amount, needDecimals(exactOut ? tOut : tIn).decimals); } catch (e) { if (e instanceof ApiError) throw e; throw bad(e.message); }
  if (amount <= 0n || amount >= 1n << 128n) throw bad('amount must be greater than zero');
  const sig = (exactOut ? 'quoteExactOutputSingle' : 'quoteExactInputSingle') + '(((address,address,uint24,int24,address),bool,uint128,bytes))';
  let res; try { res = await x.rpc.ethCall(x.C.quoter, call(sig, QUOTE_T, [[keyVals(key), zeroForOne, amount, hookData]])); }
  catch (e) { if (!e.rpc) throw e; const d = typeof e.data === 'string' ? e.data : ''; throw new ApiError(422, 'no_route', 'Quote reverted: no liquidity in range, the hook rejected the swap, or the amount exceeds the pool' + (d.length >= 10 ? ' (revert ' + d.slice(0, 10) + ')' : '')); }
  const w = words(res), other = toUint(w[0]), inRaw = exactOut ? other : amount, outRaw = exactOut ? amount : other;
  needDecimals(tIn); needDecimals(tOut);
  const amountIn = formatUnits(inRaw, tIn.decimals), amountOut = formatUnits(outRaw, tOut.decimals);
  return { poolId: poolIdOf(key), zeroForOne, exactOut, tokenIn: tIn, tokenOut: tOut, amountIn, amountOut, amountInRaw: inRaw.toString(), amountOutRaw: outRaw.toString(),
    executionPrice: Number(amountIn) ? Number(amountOut) / Number(amountIn) : null, gasEstimate: toUint(w[1]).toString(), hooked: key.hooks !== ZERO };
}

// ---- swaps: unsigned Permit2 approvals + one UniversalRouter call. Nothing here signs or sends. ----
const MAX160 = (1n << 160n) - 1n, MAX256 = (1n << 256n) - 1n;
export async function buildSwap(key, input, store, x = MAIN) {
  if (!isAddress(input.sender)) throw bad('sender is required: the wallet that signs, pays and receives the output');
  const sender = checksum(input.sender), slippageBps = input.slippageBps == null ? 50 : Number(input.slippageBps);
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 5000) throw bad('slippageBps must be 1 to 5000');
  const q = await quote(key, { ...input, exactOut: false }, store, x), amountIn = BigInt(q.amountInRaw), expected = BigInt(q.amountOutRaw), minOut = (expected * BigInt(10000 - slippageBps)) / 10000n;
  const deadline = Math.floor(Date.now() / 1000) + 20 * 60, native = q.tokenIn.address === ZERO, txs = [];
  if (!native) {
    const [a, p] = await x.rpc.batch([['eth_call', [{ to: q.tokenIn.address, data: call('allowance(address,address)', ['address', 'address'], [sender, x.C.permit2]) }, 'latest']],
      ['eth_call', [{ to: x.C.permit2, data: call('allowance(address,address,address)', ['address', 'address', 'address'], [sender, q.tokenIn.address, x.C.universalRouter]) }, 'latest']]]);
    const erc20Allow = a.result ? toUint(words(a.result)[0]) : 0n, pw = p.result ? words(p.result) : [], p2Amount = pw[0] ? toUint(pw[0]) : 0n, p2Exp = pw[1] ? Number(toUint(pw[1])) : 0;
    if (erc20Allow < amountIn) txs.push({ to: q.tokenIn.address, data: call('approve(address,uint256)', ['address', 'uint'], [x.C.permit2, MAX256]), value: '0', description: 'Approve Permit2 to spend the input token (one-time)' });
    if (p2Amount < amountIn || p2Exp < deadline) txs.push({ to: x.C.permit2, data: call('approve(address,address,uint160,uint48)', ['address', 'address', 'uint', 'uint'], [q.tokenIn.address, x.C.universalRouter, MAX160, Math.floor(Date.now() / 1000) + 30 * 86400]), value: '0', description: 'Allow the Universal Router to pull the input token via Permit2 (30 days)' });
  }
  // V4_SWAP (0x10): SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f)
  const swapParams = encode([{ tuple: [KEY_T, 'bool', 'uint', 'uint', 'bytes'] }], [[keyVals(key), q.zeroForOne, amountIn, minOut, hexData(input.hookData)]]);
  const v4 = encode(['bytes', { array: 'bytes' }], ['0x060c0f', [swapParams, encode(['address', 'uint'], [q.tokenIn.address, amountIn]), encode(['address', 'uint'], [q.tokenOut.address, minOut])]]);
  txs.push({ to: x.C.universalRouter, data: call('execute(bytes,bytes[],uint256)', ['bytes', { array: 'bytes' }, 'uint'], ['0x10', [v4], deadline]), value: native ? amountIn.toString() : '0', description: 'Swap through the Uniswap v4 Universal Router' });
  return { chainId: x.id, poolId: q.poolId, sender, tokenIn: q.tokenIn, tokenOut: q.tokenOut, amountIn: q.amountIn, expectedAmountOut: q.amountOut, minAmountOut: formatUnits(minOut, q.tokenOut.decimals), slippageBps, deadline, transactions: txs,
    note: 'Unsigned. Send the transactions in order from `sender`; HookFi never signs or holds funds.' };
}

// ---- hook bytecode: is anything deployed, and can its logic be swapped out? ----
const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', SLOT_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8dee1178d6a717850b5d6103', SLOT_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const codeCache = new Map();
export async function hookCode(address) {
  const k = address.toLowerCase(), hit = codeCache.get(k); if (hit && Date.now() - hit.at < 5 * 60e3) return hit.v;
  const [code, impl, admin, beacon] = await rpc.batch([['eth_getCode', [address, 'latest']], ['eth_getStorageAt', [address, SLOT_IMPL, 'latest']], ['eth_getStorageAt', [address, SLOT_ADMIN, 'latest']], ['eth_getStorageAt', [address, SLOT_BEACON, 'latest']]]);
  const c = code.result || '0x', size = (c.length - 2) / 2, nz = (r) => (r.result && toUint(r.result.slice(2)) > 0n ? toAddr(r.result.slice(2).padStart(64, '0')) : null);
  let proxy = null; const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i.exec(c);
  if (m) proxy = { kind: 'eip1167', implementation: checksum('0x' + m[1]), admin: null, upgradeable: false };
  else if (size && (nz(impl) || nz(beacon))) proxy = { kind: 'eip1967', implementation: nz(impl), admin: nz(admin), ...(nz(beacon) ? { beacon: nz(beacon) } : {}), upgradeable: true };
  const v = { deployed: size > 0, codeSize: size, codeHash: size ? keccak(bytes(c)) : null, proxy }; codeCache.set(k, { at: Date.now(), v }); return v;
}
export function profileWarnings(decoded, code) {
  const w = decoded.errors.map((e) => 'Invalid hook address: ' + e);
  if (!code.deployed) w.push('No contract code at this address');
  if (code.proxy && code.proxy.upgradeable) w.push("Upgradeable proxy: the hook's logic can be changed by its admin after you trade or provide liquidity");
  if (decoded.flags === 0) w.push('No permission bits set: only valid on dynamic-fee pools, where the hook can set the LP fee');
  return w;
}

export const headBlock = async () => Number(await rpc.one('eth_blockNumber'));
const tsCache = new Map();
export async function blockTimes(blocks) {
  const miss = [...new Set(blocks)].filter((b) => !tsCache.has(b));
  if (miss.length) { const res = await rpc.batch(miss.map((b) => ['eth_getBlockByNumber', ['0x' + b.toString(16), false]])); miss.forEach((b, i) => { const r = res[i].result; if (r) tsCache.set(b, new Date(Number(r.timestamp) * 1000).toISOString()); }); if (tsCache.size > 20000) tsCache.clear(); }
  return blocks.map((b) => tsCache.get(b) || null);
}

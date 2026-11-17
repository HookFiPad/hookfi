// The launchpad: one HookFi hook and one launchpad contract at the same address on every chain with Uniswap v4.
// This module knows the chains, builds the unsigned launch / trade / claim transactions, and reads launches back.
import crypto from 'node:crypto';
import { MAIN, CHAIN, ApiError, multi, tokens, slot0Many, spotPrice, poolIdOf, quote, buildSwap } from './chain.js';
import { rpcClient, call, words, toUint, toInt, toAddr, checksum, parseUnits, formatUnits } from './evm.js';
import { ZERO, isAddress } from '../lib/hooks.js';

const P2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3', ETH = { symbol: 'ETH', name: 'Ether' };
// Uniswap v4 deployments, from the Uniswap docs. Robinhood Chain reuses the main context (and its full pool index).
const V4 = [
  { id: 4663, key: 'robinhood', name: 'Robinhood Chain', native: ETH, explorer: CHAIN.explorer },
  { id: 8453, key: 'base', name: 'Base', native: ETH, rpc: 'https://mainnet.base.org', explorer: 'https://basescan.org',
    C: { poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b', stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71', quoter: '0xE1A6C5803e3c44368b171BD680c7D32dfc92CA47', universalRouter: '0x6ff5693b99212da76ad316178a184ab56d299b43' } },
  { id: 130, key: 'unichain', name: 'Unichain', native: ETH, rpc: 'https://mainnet.unichain.org', explorer: 'https://uniscan.xyz',
    C: { poolManager: '0x1f98400000000000000000000000000000000004', stateView: '0x86e8631a016f9068c3f085faf484ee3f5fdee8f2', quoter: '0xF885781cB68A0BE66AA2AC7eDa5Fe72Bde7dA907', universalRouter: '0xef740bf23acae26f6492b10de645d6b98dc8eaf3' } },
  { id: 1, key: 'ethereum', name: 'Ethereum', native: ETH, rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io',
    C: { poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90', stateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227', quoter: '0x99bd42B2B22e531f283b7F8a86dFf631EB16A9D1', universalRouter: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af' } },
  { id: 42161, key: 'arbitrum', name: 'Arbitrum One', native: ETH, rpc: 'https://arb1.arbitrum.io/rpc', explorer: 'https://arbiscan.io',
    C: { poolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32', stateView: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990', quoter: '0x8928074CA1b241D8Ec02815881c1Af11E8bC5219', universalRouter: '0xa51afafe0263b40edaef0df8781ea9aa03e381a3' } },
  { id: 10, key: 'optimism', name: 'Optimism', native: ETH, rpc: 'https://mainnet.optimism.io', explorer: 'https://optimistic.etherscan.io',
    C: { poolManager: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3', stateView: '0xc18a3169788f4f75a170290584eca6395c75ecdb', quoter: '0xd673F731EDFe5AaF1bDa7FD43D13Bbb5150B87Ca', universalRouter: '0x851116d9223fabed8e56c0e6b8ad0c31d98b3507' } },
  { id: 56, key: 'bnb', name: 'BNB Smart Chain', native: { symbol: 'BNB', name: 'BNB' }, rpc: 'https://bsc-dataseed.bnbchain.org', explorer: 'https://bscscan.com',
    C: { poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df', stateView: '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4', quoter: '0x95C086d7fE28AdD842ee220fef225a777474d781', universalRouter: '0x1906c1d672b88cd1b9ac7593301ca990f94eae07' } },
  { id: 137, key: 'polygon', name: 'Polygon', native: { symbol: 'POL', name: 'POL' }, rpc: 'https://polygon-rpc.com', explorer: 'https://polygonscan.com',
    C: { poolManager: '0x67366782805870060151383f4bbff9dab53e5cd6', stateView: '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a', quoter: '0x31AB0Dea31FC0ad5A54F03cD59C896eCD067447B', universalRouter: '0x1095692a6237d83c6a72f3f5efedb9a670c49223' } },
];
const SUPPLY = 1_000_000_000, LP_FEE = 3000, TICK_SPACING = 200;
// named fee setups. feeBps is the lasting fee; snipeBps is the fee at launch, falling to feeBps over snipeSecs
export const PRESETS = {
  standard: { label: 'Standard', feeBps: 100, snipeBps: 100, snipeSecs: 0, about: 'A flat 1% on every swap from the first block.' },
  antisnipe: { label: 'Anti-snipe', feeBps: 100, snipeBps: 8000, snipeSecs: 300, about: 'Opens at 80% and falls to 1% over five minutes, so first-block bots pay the creator.' },
  creator: { label: 'Creator max', feeBps: 300, snipeBps: 5000, snipeSecs: 120, about: 'A lasting 3%, opening at 50% for the first two minutes.' },
};
const bad = (m) => new ApiError(400, 'bad_request', m);
const str = (s) => '0x' + Buffer.from(String(s), 'utf8').toString('hex');
const u = (h) => toUint(String(h).slice(2, 66));

// the deployed contracts: the same two addresses on every chain they are live on (Robinhood Chain since 17 Nov 2026)
const DEPLOYED = { launchpad: '0xC5AD0cA1a1CCC387765C2D2746863B4fCAf35fA3', hook: '0x0426D6130e15310a7e19dBccc42f1CBd82d2a044' };

export function makeLaunch(env = process.env) {
  const LAUNCHPAD = checksum(isAddress(env.LAUNCHPAD_ADDR) ? env.LAUNCHPAD_ADDR : DEPLOYED.launchpad), HOOK = checksum(isAddress(env.HOOK_ADDR) ? env.HOOK_ADDR : DEPLOYED.hook);
  const ctx = new Map(V4.map((c) => { const rpcUrl = env['RPC_' + c.id] || c.rpc;
    const x = c.id === MAIN.id && !env['RPC_' + c.id] ? { ...MAIN, native: c.native } : { id: c.id, name: c.name, rpc: rpcClient(rpcUrl || CHAIN.rpc), C: { ...(c.C || MAIN.C), permit2: P2 }, native: c.native, main: false };
    return [c.id, { ...c, x, state: null, at: 0 }]; }));
  const chainOf = (id) => { const c = ctx.get(Number(id)); if (!c) throw bad('chainId must be one of ' + V4.map((v) => v.id).join(', ')); return c; };
  const keyOf = (token) => ({ currency0: ZERO, currency1: checksum(token), fee: LP_FEE, tickSpacing: TICK_SPACING, hooks: HOOK });

  // is the launchpad live on this chain, and at what opening tick? (checked once, re-checked every minute until it is)
  async function status(c) {
    if (!LAUNCHPAD || !HOOK) return { deployed: false };
    if (c.state && (c.state.deployed || Date.now() - c.at < 60e3)) return c.state;
    try { const [code, tick, n] = await Promise.race([new Promise((_, no) => setTimeout(() => no(new Error('slow')), 5000)), c.x.rpc.batch([['eth_getCode', [LAUNCHPAD, 'latest']], ['eth_call', [{ to: LAUNCHPAD, data: call('startTick()') }, 'latest']], ['eth_call', [{ to: LAUNCHPAD, data: call('poolManager()') }, 'latest']]])]);
      const live = !!code.result && code.result.length > 2 && !!n.result && u(n.result) > 0n, st = live ? Number(toInt(tick.result.slice(2), 24)) : null;
      c.state = live ? { deployed: true, startTick: st, openingMarketCap: Number((SUPPLY / 1.0001 ** st).toPrecision(4)) } : { deployed: false };
    } catch { c.state = { deployed: false, unreachable: true }; }
    c.at = Date.now(); return c.state;
  }
  const live = async (id) => { const c = chainOf(id), s = await status(c); if (!s.deployed) throw new ApiError(404, 'not_found', 'The HookFi launchpad is not deployed on ' + c.name + ' yet'); return c; };

  async function describe(c, rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => poolIdOf(keyOf(r.token)));
    const [meta, slots, fees] = await Promise.all([tokens(rows.map((r) => r.token), null, c.x), slot0Many(ids, c.x), multi(ids.map((id) => [HOOK, call('currentFeeBps(bytes32)', ['bytes32'], [id])]), c.x)]);
    return rows.map((r, i) => { const s = slots[i], p = s && s.initialized ? spotPrice(s.sqrtPriceX96, 18, 18) : 0; // tokens per native coin
      return { chainId: c.id, token: r.token, name: meta[i].name, symbol: meta[i].symbol, creator: r.creator, launchedAt: new Date(r.time * 1000).toISOString(), poolId: ids[i],
        price: p ? 1 / p : null, marketCap: p ? SUPPLY / p : null, native: c.native.symbol, feeBps: fees[i].ok ? Number(u(fees[i].data)) : null, explorer: c.explorer + '/token/' + r.token }; });
  }

  return {
    chains: async () => ({ launchpad: LAUNCHPAD, hook: HOOK, supply: SUPPLY, presets: PRESETS,
      chains: await Promise.all([...ctx.values()].map(async (c) => ({ id: c.id, key: c.key, name: c.name, native: c.native.symbol, explorer: c.explorer, poolManager: c.x.C.poolManager, ...(await status(c)) }))) }),

    // the one transaction that deploys the token, opens the pool with the hook, locks the supply in it and makes the opening buy
    build: async (i) => {
      const c = await live(i.chainId), p = PRESETS[i.preset || 'standard']; if (i.preset && !p) throw bad('preset must be one of ' + Object.keys(PRESETS).join(', '));
      const name = String(i.name || '').trim(), symbol = String(i.symbol || '').trim().replace(/^\$/, '');
      if (!name || Buffer.byteLength(name) > 64) throw bad('name is required, up to 64 bytes'); if (!symbol || Buffer.byteLength(symbol) > 16) throw bad('symbol is required, up to 16 bytes');
      if (!isAddress(i.creator)) throw bad('creator is required: the wallet that signs and earns the fees');
      const num = (v, d, max, n) => { const k = v == null || v === '' ? d : Number(v); if (!Number.isInteger(k) || k < 0 || k > max) throw bad(n + ' must be 0 to ' + max); return k; };
      const feeBps = num(i.feeBps, p.feeBps, 500, 'feeBps'), snipeBps = Math.max(feeBps, num(i.snipeBps, p.snipeBps, 9000, 'snipeBps')), snipeSecs = num(i.snipeSecs, p.snipeSecs, 3600, 'snipeSecs');
      let value; try { value = parseUnits(i.buy == null || i.buy === '' ? '0' : i.buy, 18); } catch (e) { throw bad('buy: ' + e.message); }
      const salt = /^0x[0-9a-fA-F]{64}$/.test(i.salt || '') ? i.salt : '0x' + crypto.randomBytes(32).toString('hex'), creator = checksum(i.creator);
      const token = toAddr((await c.x.rpc.ethCall(LAUNCHPAD, call('predict(address,string,string,bytes32)', ['address', 'bytes', 'bytes', 'bytes32'], [creator, str(name), str(symbol), salt]))).slice(2, 66));
      return { chainId: c.id, chain: c.name, creator, name, symbol, supply: String(SUPPLY), token, poolId: poolIdOf(keyOf(token)), key: keyOf(token), feeBps, snipeBps, snipeSecs, openingBuy: formatUnits(value, 18) + ' ' + c.native.symbol,
        transactions: [{ to: LAUNCHPAD, data: call('launch(string,string,uint16,uint16,uint32,bytes32)', ['bytes', 'bytes', 'uint', 'uint', 'uint', 'bytes32'], [str(name), str(symbol), feeBps, snipeBps, snipeSecs, salt]), value: value.toString(), description: 'Launch ' + symbol + ' on ' + c.name + ': deploy the token, open the pool with the HookFi hook, lock the whole supply in it' + (value > 0n ? ', and buy with ' + formatUnits(value, 18) + ' ' + c.native.symbol : '') }],
        note: 'Unsigned. The creator signs it; HookFi never holds keys or funds. The token address is fixed by the creator, name, symbol and salt.' };
    },

    list: async (i) => {
      const c = await live(i.chainId), limit = Math.min(50, Math.max(1, Number(i.limit) || 20)), offset = Math.max(0, Number(i.offset) || 0);
      const total = Number(u(await c.x.rpc.ethCall(LAUNCHPAD, call('launchCount()')))), idx = []; for (let k = total - 1 - offset; k >= 0 && idx.length < limit; k--) idx.push(k);
      const raw = await multi(idx.map((k) => [LAUNCHPAD, call('launches(uint256)', ['uint'], [k])]), c.x);
      const rows = raw.filter((r) => r.ok).map((r) => { const w = words(r.data); return { token: toAddr(w[0]), creator: toAddr(w[1]), time: Number(toUint(w[2])) }; });
      return { chainId: c.id, chain: c.name, total, limit, offset, launches: await describe(c, rows) };
    },

    token: async (i) => {
      const c = await live(i.chainId); if (!isAddress(i.token)) throw bad('token must be an address'); const token = checksum(i.token), id = poolIdOf(keyOf(token));
      const cfg = words(await c.x.rpc.ethCall(HOOK, call('configOf(bytes32)', ['bytes32'], [id]))), creator = toAddr(cfg[0]);
      if (creator === ZERO) throw new ApiError(404, 'not_found', 'This token was not launched through HookFi on ' + c.name);
      const [d] = await describe(c, [{ token, creator, time: Number(toUint(cfg[4])) }]);
      const owed = await multi([[HOOK, call('owed(address,address)', ['address', 'address'], [creator, ZERO])], [HOOK, call('owed(address,address)', ['address', 'address'], [creator, token])]], c.x);
      return { ...d, key: keyOf(token), config: { feeBps: Number(toUint(cfg[1])), snipeBps: Number(toUint(cfg[2])), snipeSecs: Number(toUint(cfg[3])) },
        creatorUnclaimed: { [c.native.symbol]: formatUnits(owed[0].ok ? u(owed[0].data) : 0n, 18), [d.symbol || 'token']: formatUnits(owed[1].ok ? u(owed[1].data) : 0n, 18) } };
    },

    // buy or sell a launched token: quoted through the hook, built as unsigned Universal Router transactions
    quote: async (i) => { const c = await live(i.chainId); if (!isAddress(i.token)) throw bad('token must be an address'); return quote(keyOf(i.token), { tokenIn: i.side === 'sell' ? i.token : ZERO, amount: i.amount }, null, c.x); },
    swap: async (i) => { const c = await live(i.chainId); if (!isAddress(i.token)) throw bad('token must be an address');
      const out = await buildSwap(keyOf(i.token), { tokenIn: i.side === 'sell' ? i.token : ZERO, amount: i.amount, sender: i.sender, slippageBps: i.slippageBps }, null, c.x); out.note = out.note.replace('BARB', 'HookFi'); return out; },
    // the creator (or the treasury) collecting what the hook has credited to them
    claim: async (i) => { const c = await live(i.chainId), cur = i.currency == null || i.currency === '' ? ZERO : i.currency; if (!isAddress(cur)) throw bad('currency must be an address (the zero address for the native coin)');
      return { chainId: c.id, transactions: [{ to: HOOK, data: call('claim(address)', ['address'], [cur]), value: '0', description: 'Claim your HookFi hook fees in ' + (cur === ZERO ? c.native.symbol : 'the token') }] }; },
  };
}

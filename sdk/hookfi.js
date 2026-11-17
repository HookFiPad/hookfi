// HookFi SDK. One file, no dependencies. Works in Node 18+ and in the browser.
//   import { HookFi, decodeHookAddress, flagsFor } from "./hookfi.js"
export * from '../lib/hooks.js';

export class HookFiError extends Error { constructor(status, code, message) { super(message); this.name = 'HookFiError'; this.status = status; this.code = code; } }

export class HookFi {
  constructor({ baseUrl = '{{ORIGIN}}', fetch: f } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); const doFetch = f || globalThis.fetch.bind(globalThis);
    const send = async (path, body) => {
      const r = await doFetch(this.baseUrl + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined), j = await r.json();
      if (!r.ok || (j && j.error)) throw new HookFiError(r.status, j.error ? j.error.code : 'error', j.error ? j.error.message : 'request failed'); return j;
    };
    const qs = (o = {}) => { const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString(); return p ? '?' + p : ''; };
    this.hooks = {
      list: (o) => send('/v1/hooks' + qs(o)),                       // { sort: "pools" | "recent", limit, offset }
      get: (address) => send('/v1/hooks/' + address),               // full profile: bytecode, proxy, warnings, pools
      decode: (address) => send('/v1/hooks/' + address + '/flags'), // permissions in the address (pure)
      flags: () => send('/v1/hooks/flags'),
      census: () => send('/v1/hooks/census'),
      mine: (o) => send('/v1/hooks/mine', o),                       // { flags, initCodeHash | initCode, deployer?, startSalt?, maxIterations? }
    };
    this.pools = {
      list: (o) => send('/v1/pools' + qs(o)),                       // { hook, token, tokenA, tokenB, hooked, limit, offset }
      get: (o) => (o.poolId ? send('/v1/pools/' + o.poolId) : send('/v1/pools/state', o)),
      id: (key) => send('/v1/pools/id', key),
      check: (o) => send('/v1/pools/check', o),
    };
    this.quote = (o) => send('/v1/quote', o);                       // { poolId | key, tokenIn | zeroForOne, amount, exactOut?, hookData? }
    this.bestQuote = (o) => send('/v1/quote/best' + qs(o));         // { tokenIn, tokenOut, amount, limit? }
    this.swap = { build: (o) => send('/v1/swap/build', o) };        // { poolId | key, tokenIn, amount, sender, slippageBps?, hookData? }
    this.stats = () => send('/v1/stats');
    this.token = () => send('/v1/token');
  }
}

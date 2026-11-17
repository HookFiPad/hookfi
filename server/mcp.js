// MCP over streamable HTTP: JSON-RPC on POST, JSON responses, no sessions. Every tool is read-only.
import { ApiError } from './chain.js';

const S = { type: 'string' }, N = { type: 'number' }, B = { type: 'boolean' }, ADDR = { type: 'string', description: '20-byte address, 0x-prefixed. Native ETH is the zero address.' };
const KEY = { poolId: { type: 'string', description: '32-byte PoolId of an indexed pool' }, currency0: ADDR, currency1: ADDR, fee: { type: 'number', description: 'LP fee in hundredths of a bip, or 8388608 for a dynamic-fee pool' }, tickSpacing: N, hooks: ADDR };
const tool = (name, op, description, properties = {}, required = []) => ({ name, op, description, inputSchema: { type: 'object', properties, required }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } });

export const TOOLS = [
  tool('decode_hook', 'decodeHook', 'Permissions encoded in a Uniswap v4 hook address, with capability notes. Pure, no chain call.', { address: ADDR }, ['address']),
  tool('inspect_hook', 'inspectHook', 'Full profile of a deployed hook on Robinhood Chain: permissions, bytecode, proxy and upgradeability, warnings, and the pools that use it.', { address: ADDR }, ['address']),
  tool('list_hooks', 'listHooks', 'Every hook used by a v4 pool on Robinhood Chain, by pool count or recency.', { sort: { type: 'string', enum: ['pools', 'recent'] }, limit: N, offset: N }),
  tool('mine_hook_salt', 'mine', 'Find a CREATE2 salt that deploys a hook to an address with exactly the requested permission bits.', { flags: { description: 'Permission names, e.g. ["beforeSwap","afterSwap"], or a 14-bit mask', anyOf: [{ type: 'array', items: S }, N, S] }, initCodeHash: S, initCode: S, deployer: ADDR, startSalt: { anyOf: [N, S] }, maxIterations: N }, ['flags']),
  tool('list_pools', 'listPools', 'Indexed v4 pools, newest first. Filter by hook, token, exact pair, or hooked/unhooked.', { hook: ADDR, token: ADDR, tokenA: ADDR, tokenB: ADDR, hooked: B, limit: N, offset: N }),
  tool('get_pool', 'getPool', 'Live pool state: price, tick, liquidity, current LP fee, and the hook\'s permissions. Pass poolId, or the pool key.', KEY),
  tool('compute_pool_id', 'poolId', 'PoolId for a pool key. Pure, no chain call. Currencies may be passed in either order.', { currency0: ADDR, currency1: ADDR, fee: N, tickSpacing: N, hooks: ADDR }, ['currency0', 'currency1', 'fee', 'tickSpacing']),
  tool('quote', 'quote', 'Quote a swap through the pool\'s hook with the on-chain V4Quoter. Amounts are decimal strings in token units.', { ...KEY, tokenIn: ADDR, zeroForOne: B, amount: S, exactOut: B, hookData: S }, ['amount']),
  tool('build_swap', 'buildSwap', 'Unsigned approval and Universal Router transactions for an exact-input swap. Returns calldata only: the user signs with their own wallet.', { ...KEY, tokenIn: ADDR, zeroForOne: B, amount: S, sender: ADDR, slippageBps: N, hookData: S }, ['amount', 'sender']),
  tool('best_quote', 'bestQuote', 'Best pool for a pair: quotes the deepest pools through their hooks and ranks them.', { tokenIn: ADDR, tokenOut: ADDR, amount: S, limit: N }, ['tokenIn', 'tokenOut', 'amount']),
  tool('check_pool', 'checkPool', 'Risk level and plain-English reasons before trading through a pool or providing liquidity to it.', { ...KEY, tokenIn: ADDR, amount: S }),
  tool('get_stats', 'stats', 'Uniswap v4 contract addresses on Robinhood Chain and index totals.'),
  tool('list_launch_chains', 'launchChains', 'Chains the HookFi launchpad runs on, whether it is live on each, the opening market cap, and the fee presets.'),
  tool('list_launches', 'launchList', 'Tokens launched through HookFi on a chain, newest first, with price, market cap and the current hook fee.', { chainId: N, limit: N, offset: N }, ['chainId']),
  tool('build_launch', 'launchBuild', 'Unsigned transaction that launches a token on any supported chain: deploys it, opens a Uniswap v4 pool with the HookFi hook, locks the whole supply as liquidity, and optionally makes the creator\'s opening buy.', { chainId: N, name: S, symbol: S, creator: ADDR, preset: { type: 'string', enum: ['standard', 'antisnipe', 'creator'] }, feeBps: N, snipeBps: N, snipeSecs: N, buy: { type: 'string', description: 'Native coin to spend on the opening buy, e.g. "0.1"' } }, ['chainId', 'name', 'symbol', 'creator']),
];
const BY = new Map(TOOLS.map((t) => [t.name, t]));
const INSTRUCTIONS = `Tools for Uniswap v4 hooks on Robinhood Chain (chain ID 4663). Every tool is read-only.
1. The user names tokens, not a pool: call best_quote. Show the best route and any hook warnings on it.
2. Before trading or providing liquidity through a hooked pool: call check_pool with the trade size. Relay the risk level and every reason.
3. Only after the user confirms: call build_swap with the chosen poolId and the user's wallet as sender, and hand the transactions back to sign.
build_swap returns unsigned transactions. Nothing moves until the user's own wallet signs.`;

async function one(msg, api, cfg) {
  const id = msg && msg.id, err = (code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(-32600, 'Invalid request');
  if (id === undefined) return null; // a notification: nothing to answer
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (msg.method === 'initialize') return ok({ protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: cfg.name.toLowerCase(), version: '0.1.0' }, instructions: INSTRUCTIONS });
  if (msg.method === 'ping') return ok({});
  if (msg.method === 'tools/list') return ok({ tools: TOOLS.map(({ op, ...t }) => t) });
  if (msg.method === 'tools/call') {
    const t = BY.get(msg.params && msg.params.name); if (!t) return err(-32602, 'Unknown tool: ' + (msg.params && msg.params.name));
    try { return ok({ content: [{ type: 'text', text: JSON.stringify(await api[t.op](msg.params.arguments || {}), null, 2) }] }); }
    catch (e) { return ok({ isError: true, content: [{ type: 'text', text: e instanceof ApiError ? e.code + ': ' + e.message : 'upstream_error: ' + (e.message || 'error') }] }); }
  }
  return err(-32601, 'Method not found: ' + msg.method);
}
export async function mcp(payload, api, cfg) {
  if (Array.isArray(payload)) { const out = (await Promise.all(payload.map((m) => one(m, api, cfg)))).filter((x) => x !== null); return out.length ? out : null; }
  return one(payload, api, cfg);
}

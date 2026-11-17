// End-to-end checks against Robinhood Chain. Starts a node on a scratch index unless BASE is set.
//   npm test                         boots its own node on :8397
//   BASE=http://localhost:8296 npm test   uses a running one (whose index may be further along)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeHookAddress, flagsFor, FLAG_BITS, flagErrors, capabilities } from '../lib/hooks.js';
import { rpcClient } from '../server/evm.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let BASE = process.env.BASE, child = null, pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); } };
const again = async (f) => { try { return await f(); } catch (e) { await new Promise((z) => setTimeout(z, 500)); return f(); } }; // one retry if a kept-alive socket was closed under us
const get = (p) => again(async () => { const r = await fetch(BASE + p); return { status: r.status, j: await r.json() }; });
const post = (p, body) => again(async () => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, j: r.status === 202 ? null : await r.json() }; });
const ETH = '0x0000000000000000000000000000000000000000', USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', HOOK = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544';
const POOL = '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982', KEY = { currency0: ETH, currency1: USDG, fee: 500, tickSpacing: 10 };
const AB = '0x' + 'ab'.repeat(32);

async function main() {
  if (!BASE) { const db = path.join(os.tmpdir(), 'hookfi-test-' + Date.now() + '.db'); BASE = 'http://localhost:8397';
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'index.js')], { env: { ...process.env, PORT: '8397', DATA_PATH: db }, stdio: 'ignore' });
    process.on('exit', () => { try { child.kill(); } catch {} for (const s of ['', '-wal', '-shm']) try { fs.rmSync(db + s); } catch {} });
    for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/v1/chain'); break; } catch { await new Promise((z) => setTimeout(z, 250)); } } }

  console.log('\npermissions (pure)');
  const d = decodeHookAddress(HOOK);
  ok('0x…a544 decodes to 0x2544', d.flagsHex === '0x2544' && d.flags === 9540);
  ok('five permissions enabled', d.enabled.join() === 'beforeInitialize,afterAddLiquidity,afterRemoveLiquidity,afterSwap,afterSwapReturnDelta');
  ok('capability notes ordered warning first', d.capabilities[0].level === 'warning' && d.capabilities[0].flag === 'afterSwapReturnDelta' && d.capabilities.length === 3);
  ok('flagsFor names = 0xc0', flagsFor(['beforeSwap', 'afterSwap']) === 0xc0 && flagsFor('0x00c0') === 192 && flagsFor(192) === 192);
  ok('beforeInitialize is bit 13', FLAG_BITS.beforeInitialize === 0x2000 && FLAG_BITS.afterRemoveLiquidityReturnDelta === 1);
  ok('ReturnDelta without base flag is an error', flagErrors(FLAG_BITS.afterSwapReturnDelta)[0] === 'afterSwapReturnDelta requires afterSwap' && flagErrors(0x44).length === 0);
  ok('withdrawal block is a caution', capabilities(FLAG_BITS.beforeRemoveLiquidity)[0].level === 'caution');

  console.log('\nhook api');
  let r = await get('/v1/hooks/' + HOOK + '/flags'); ok('GET flags', r.status === 200 && r.j.flagsHex === '0x2544' && r.j.permissions.afterSwap === true);
  r = await get('/v1/hooks/flags'); ok('flag table has 14 rows, mask 0x3fff', r.j.mask === '0x3fff' && r.j.flags.length === 14 && r.j.flags[0].hex === '0x2000');
  r = await get('/v1/hooks/' + HOOK); ok('profile reads bytecode from the chain', r.j.code.deployed === true && r.j.code.codeSize > 1000 && /^0x[0-9a-f]{64}$/.test(r.j.code.codeHash), JSON.stringify(r.j.code));
  ok('profile is not a proxy and has no warnings', r.j.code.proxy === null && r.j.warnings.length === 0);
  r = await get('/v1/hooks/0x0000000000000000000000000000000000000004'); ok('undeployed, invalid address is flagged', r.j.warnings.some((w) => /No contract code/.test(w)) && r.j.warnings.some((w) => /Invalid hook address/.test(w)));
  r = await get('/v1/hooks/nope'); ok('unknown route is 404 not_found', r.status === 404 && r.j.error.code === 'not_found');

  console.log('\nhook miner');
  r = await post('/v1/hooks/mine', { flags: ['beforeSwap', 'afterSwap'], initCodeHash: AB });
  ok('finds the documented salt', r.j.found && r.j.salt.endsWith('1613') && r.j.address === '0x8741504Dd906BC4af41A4eC5096aBC42e0b640c0' && r.j.iterations === 5652, JSON.stringify(r.j).slice(0, 200));
  ok('mined address carries exactly the requested bits', decodeHookAddress(r.j.address).flags === 0xc0 && r.j.verify === true);
  r = await post('/v1/hooks/mine', { flags: ['afterSwapReturnDelta'], initCodeHash: AB }); ok('422 invalid_flags', r.status === 422 && r.j.error.code === 'invalid_flags');
  r = await post('/v1/hooks/mine', { flags: 0x2544, initCodeHash: AB, maxIterations: 50 }); ok('bounded search returns nextSalt', r.j.found === false && r.j.nextSalt === '50');
  r = await post('/v1/hooks/mine', { flags: ['beforeSwap'] }); ok('missing init code hash is 400', r.status === 400 && r.j.error.code === 'bad_request');

  console.log('\npool api');
  r = await post('/v1/pools/id', { currency0: USDG, currency1: ETH, fee: 500, tickSpacing: 10 }); ok('PoolId matches, currencies sorted', r.j.poolId === POOL && r.j.sorted === true && r.j.key.currency0 === ETH);
  r = await post('/v1/pools/state', KEY); const st = r.j;
  ok('live state by key', r.status === 200 && st.state.initialized && st.state.lpFee === 500 && st.currency1.symbol === 'USDG' && st.currency1.decimals === 6, JSON.stringify(st).slice(0, 200));
  ok('ETH/USDG price is sane', st.price['ETH/USDG'] > 200 && st.price['ETH/USDG'] < 50000, String(st.price && st.price['ETH/USDG']));
  r = await post('/v1/pools/state', { ...KEY, fee: 123, tickSpacing: 77 }); ok('uninitialized key is 404', r.status === 404 && r.j.error.code === 'not_found');
  r = await get('/v1/stats'); ok('stats lists the v4 contracts', r.j.chain.id === 4663 && r.j.chain.contracts.poolManager === '0x8366a39cc670b4001a1121b8f6a443a643e40951' && r.j.index.headBlock > 1e8);

  console.log('\nquote api');
  r = await post('/v1/quote', { ...KEY, tokenIn: ETH, amount: '0.01' }); const q = r.j;
  ok('exact-in quote through the V4Quoter', r.status === 200 && Number(q.amountOut) > 1 && q.zeroForOne === true && Number(q.gasEstimate) > 20000, JSON.stringify(q).slice(0, 200));
  ok('execution price is within 2% of spot', Math.abs(q.executionPrice / st.price['ETH/USDG'] - 1) < 0.02, q.executionPrice + ' vs ' + st.price['ETH/USDG']);
  r = await post('/v1/quote', { ...KEY, tokenIn: ETH, amount: q.amountOut, exactOut: true }); ok('exact-out quote inverts it', Math.abs(Number(r.j.amountIn) - 0.01) < 0.0001, r.j.amountIn);
  r = await post('/v1/quote', { ...KEY, tokenIn: ETH, amount: '900000000000', exactOut: true }); ok('an output the pool cannot fill is 422 no_route', r.status === 422 && r.j.error.code === 'no_route', JSON.stringify(r.j));
  r = await post('/v1/quote', { ...KEY, tokenIn: HOOK, amount: '1' }); ok('tokenIn outside the pool is 400', r.status === 400);

  console.log('\nswap api');
  const rpc = rpcClient('https://rpc.mainnet.chain.robinhood.com'), PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
  r = await post('/v1/swap/build', { ...KEY, tokenIn: ETH, amount: '0.01', sender: PM, slippageBps: 50 }); const sw = r.j;
  ok('native swap is one transaction with value', r.status === 200 && sw.transactions.length === 1 && sw.transactions[0].value === '10000000000000000' && sw.transactions[0].data.startsWith('0x3593564c'), JSON.stringify(sw).slice(0, 200));
  ok('minAmountOut applies the slippage bound', Math.abs(Number(sw.minAmountOut) / Number(sw.expectedAmountOut) - 0.995) < 1e-4);
  // the calldata is real: simulate it on chain from an account that holds ETH
  let sim = null; try { await rpc.one('eth_call', [{ from: PM, to: sw.transactions[0].to, data: sw.transactions[0].data, value: '0x' + BigInt(sw.transactions[0].value).toString(16) }, 'latest']); sim = 'ok'; } catch (e) { sim = e.message + ' ' + (e.data || ''); }
  ok('Universal Router accepts the built swap (eth_call simulation)', sim === 'ok', sim);
  r = await post('/v1/swap/build', { ...KEY, tokenIn: USDG, amount: '25', sender: '0x1111111111111111111111111111111111111111' });
  ok('ERC-20 swap adds Permit2 approvals first', r.j.transactions.length === 3 && r.j.transactions[0].data.startsWith('0x095ea7b3') && r.j.transactions[1].data.startsWith('0x87517c45') && r.j.transactions[2].value === '0', JSON.stringify(r.j.transactions.map((t) => t.description)));
  r = await post('/v1/swap/build', { ...KEY, tokenIn: ETH, amount: '0.01' }); ok('missing sender is 400', r.status === 400);

  console.log('\nindex');
  for (let i = 0; i < 500; i++) { r = await get('/v1/stats'); if (r.j.index.indexedThroughBlock >= r.j.index.headBlock - 5000 && r.j.index.headBlock) break; await new Promise((z) => setTimeout(z, 1000)); }
  const ix = r.j.index; ok('index caught up with the chain head', ix.indexedThroughBlock >= ix.headBlock - 5000, JSON.stringify(ix));
  ok('over a million pools, hundreds of thousands hooked', ix.pools > 1000000 && ix.hookedPools > 300000 && ix.uniqueHooks > 20000, JSON.stringify(ix));
  r = await get('/v1/hooks?sort=pools&limit=3'); ok('registry ranks hooks by pool count', r.j.hooks.length === 3 && r.j.hooks[0].pools >= r.j.hooks[1].pools && r.j.total === ix.uniqueHooks, JSON.stringify(r.j.hooks.map((h) => h.pools)));
  const top = r.j.hooks[0];
  r = await get('/v1/pools?hook=' + top.address + '&limit=5'); ok('pools filter by hook', r.j.pools.length === 5 && r.j.pools.every((p) => p.key.hooks === top.address) && r.j.total === top.pools);
  ok('listed pools carry a creation time', /^20\d\d-/.test(r.j.pools[0].createdAt || ''), r.j.pools[0].createdAt);
  r = await get('/v1/pools?hooked=false&limit=2'); ok('hooked=false returns plain pools', r.j.pools.every((p) => !p.hooked));
  r = await get('/v1/pools/' + POOL); ok('pool by id recovers its key from the index', r.status === 200 && r.j.key.fee === 500 && r.j.created && r.j.created.block > 0, JSON.stringify(r.j.created));
  r = await get('/v1/pools/0x' + '12'.repeat(32)); ok('unknown pool id is 404', r.status === 404);
  r = await get('/v1/quote/best?tokenIn=' + ETH + '&tokenOut=' + USDG + '&amount=0.1'); const b = r.j;
  ok('best quote ranks routes across pools', r.status === 200 && b.routes.length >= 2 && Number(b.best.amountOut) >= Number(b.routes[b.routes.length - 1].amountOut) && b.considered.pairPools > 50, JSON.stringify(b.considered || b));
  r = await get('/v1/pools/' + b.best.poolId + '/check?tokenIn=' + ETH + '&amount=0.1'); ok('pool check returns a level with reasons', ['low', 'medium', 'high'].includes(r.j.risk.level) && Array.isArray(r.j.risk.reasons) && r.j.quoteCheck && r.j.quoteCheck.amountOut, JSON.stringify(r.j.risk));
  r = await get('/v1/hooks/census'); ok('census counts hooks per permission', r.j.byFlag.afterSwap.hooks > 0 && r.j.hooks > 20000 && r.j.canChargeAfterSwap > 0);

  console.log('\nmcp');
  r = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }); ok('initialize', r.j.result.serverInfo && r.j.result.capabilities.tools && /best_quote/.test(r.j.result.instructions));
  r = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }); ok('fifteen read-only tools', r.j.result.tools.length === 15 && r.j.result.tools.every((t) => t.annotations.readOnlyHint === true && t.inputSchema.type === 'object'));
  r = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'decode_hook', arguments: { address: HOOK } } }); ok('tools/call returns JSON text', JSON.parse(r.j.result.content[0].text).flagsHex === '0x2544');
  r = await post('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mine_hook_salt', arguments: { flags: ['afterSwapReturnDelta'], initCodeHash: AB } } }); ok('tool errors come back as isError', r.j.result.isError === true && /invalid_flags/.test(r.j.result.content[0].text));
  r = await post('/mcp', [{ jsonrpc: '2.0', id: 5, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 6, method: 'nope' }]); ok('batches, notifications and unknown methods', r.j.length === 2 && r.j[1].error.code === -32601);
  r = await post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }); ok('a lone notification is 202', r.status === 202);

  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

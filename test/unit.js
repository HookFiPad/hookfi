// Pure checks: no network, no chain. These run in CI on every push.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { FLAG_TABLE, FLAG_BITS, MASK, decodeHookAddress, decodeFlags, flagsFor, flagErrors, capabilities, warningFlags, isAddress } from '../lib/hooks.js';
import { keccak, selector, topic, checksum, encode, call, words, toUint, toInt, parseUnits, formatUnits } from '../server/evm.js';
import { normalizeKey, poolIdOf, spotPrice, direction, profileWarnings, ApiError } from '../server/chain.js';
import { openStore } from '../server/store.js';
import { makeApi } from '../server/api.js';
import { TOOLS, mcp } from '../server/mcp.js';
import { PRESETS } from '../server/launch.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? '  ' + extra : '')); } };
const throws = async (f, code) => { try { await f(); return false; } catch (e) { return code ? e instanceof ApiError && e.code === code : true; } };
const HOOK = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544', ETH = '0x0000000000000000000000000000000000000000', USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', AB = '0x' + 'ab'.repeat(32);

console.log('\npermissions');
ok('14 flags, mask 0x3fff', FLAG_TABLE.length === 14 && MASK === 0x3fff && FLAG_TABLE[0].name === 'beforeInitialize' && FLAG_TABLE[13].value === 1);
ok('bits are distinct and cover the mask', FLAG_TABLE.reduce((m, f) => m | f.value, 0) === MASK && new Set(FLAG_TABLE.map((f) => f.value)).size === 14);
const d = decodeHookAddress(HOOK);
ok('0x…a544 decodes to 0x2544', d.flags === 0x2544 && d.flagsHex === '0x2544' && d.enabled.length === 5);
ok('notes: warning first, then info', d.capabilities.map((c) => c.level + ':' + c.flag).join() === 'warning:afterSwapReturnDelta,info:afterSwap,info:initialize');
ok('flagsFor accepts names, numbers and hex', flagsFor(['beforeSwap', 'afterSwap']) === 0xc0 && flagsFor(192) === 192 && flagsFor('0x00c0') === 192);
ok('flagsFor rejects unknown names and wide masks', (await throws(() => flagsFor(['nope']))) && (await throws(() => flagsFor(0x4000))));
ok('ReturnDelta needs its base flag', flagErrors(FLAG_BITS.beforeSwapReturnDelta)[0] === 'beforeSwapReturnDelta requires beforeSwap' && flagErrors(FLAG_BITS.beforeSwap | FLAG_BITS.beforeSwapReturnDelta).length === 0);
ok('withdrawal block is a caution, not a warning', capabilities(FLAG_BITS.beforeRemoveLiquidity)[0].level === 'caution' && warningFlags(FLAG_BITS.beforeRemoveLiquidity).length === 0);
ok('the HookFi hook is 0x2044', decodeFlags(0x2044).enabled.join() === 'beforeInitialize,afterSwap,afterSwapReturnDelta' && decodeFlags(0x2044).errors.length === 0);
ok('isAddress', isAddress(HOOK) && !isAddress('0x123') && !isAddress(null));

console.log('\nevm');
ok('keccak of empty input', keccak('0x') === '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
ok('selectors', selector('transfer(address,uint256)') === '0xa9059cbb' && selector('approve(address,uint256)') === '0x095ea7b3' && selector('execute(bytes,bytes[],uint256)') === '0x3593564c');
ok('event topic', topic('Transfer(address,address,uint256)') === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
ok('checksum address', checksum('0x5fc5360d0400a0fd4f2af552add042d716f1d168') === USDG);
ok('static encoding', encode(['address', 'uint'], [USDG, 5n]) === '0x' + USDG.slice(2).toLowerCase().padStart(64, '0') + '5'.padStart(64, '0'));
const dyn = words(encode(['bytes', 'uint'], ['0xdeadbeef', 7]));
ok('dynamic encoding: offset, value, length, data', toUint(dyn[0]) === 64n && toUint(dyn[1]) === 7n && toUint(dyn[2]) === 4n && dyn[3].startsWith('deadbeef'));
ok('negative ints are two\'s complement', toInt(words(encode(['int'], [-887200]))[0], 24) === -887200n);
ok('call = selector + arguments', call('balanceOf(address)', ['address'], [USDG]).startsWith('0x70a08231') && call('balanceOf(address)', ['address'], [USDG]).length === 74);
ok('parseUnits / formatUnits round trip', parseUnits('0.01', 18) === 10n ** 16n && formatUnits(23204353n, 6) === '23.204353' && formatUnits(parseUnits('1234.5', 6), 6) === '1234.5');
ok('parseUnits rejects junk and too many decimals', (await throws(() => parseUnits('1e5', 18))) && (await throws(() => parseUnits('0.0000001', 6))));

console.log('\npools');
const { key, sorted } = normalizeKey({ currency0: USDG, currency1: ETH, fee: 500, tickSpacing: 10 });
ok('keys are sorted into canonical order', sorted === true && key.currency0 === ETH && key.currency1 === USDG && key.hooks === ETH);
ok('PoolId of the ETH/USDG 0.05% pool', poolIdOf(key) === '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982');
ok('dynamic-fee flag is a valid fee', normalizeKey({ currency0: ETH, currency1: USDG, fee: 8388608, tickSpacing: 200, hooks: HOOK }).key.fee === 8388608);
ok('bad keys are refused', (await throws(() => normalizeKey({ currency0: ETH, currency1: ETH, fee: 500, tickSpacing: 10 }), 'bad_request')) && (await throws(() => normalizeKey({ currency0: ETH, currency1: USDG, fee: 2000000, tickSpacing: 10 }), 'bad_request')) && (await throws(() => normalizeKey({ currency0: ETH, currency1: USDG, fee: 500, tickSpacing: 0 }), 'bad_request')));
ok('direction from tokenIn', direction(key, { tokenIn: ETH }) === true && direction(key, { tokenIn: USDG }) === false && direction(key, {}) === true && (await throws(() => direction(key, { tokenIn: HOOK }), 'bad_request')));
ok('spot price from sqrtPriceX96', Math.abs(spotPrice(2n ** 96n, 18, 18) - 1) < 1e-12 && Math.abs(spotPrice(2n ** 97n, 18, 18) - 4) < 1e-12 && Math.abs(spotPrice(2n ** 96n, 18, 6) - 1e12) < 1);
ok('profile warnings', profileWarnings(decodeFlags(0x0004), { deployed: false, proxy: null }).length === 2 && profileWarnings(decodeFlags(0), { deployed: true, proxy: { upgradeable: true } }).length === 2 && profileWarnings(d, { deployed: true, proxy: null }).length === 0);

console.log('\napi (no network)');
const db = path.join(os.tmpdir(), 'hookfi-unit-' + Date.now() + '.db'), store = openStore(db), api = makeApi(store, { name: 'HookFi', ticker: '$HOOK', token: '' });
let r = await api.mine({ flags: ['beforeSwap', 'afterSwap'], initCodeHash: AB });
ok('miner finds the documented salt', r.found && r.salt.endsWith('1613') && r.address === '0x8741504Dd906BC4af41A4eC5096aBC42e0b640c0' && r.iterations === 5652 && r.verify === true);
r = await api.mine({ flags: 0x2044, initCodeHash: AB, deployer: '0x4e59b44847b379578588920cA78FbF26c0B4956C' });
ok('a mined address carries exactly the requested bits', r.found && decodeHookAddress(r.address).flags === 0x2044);
ok('miner refuses invalid flag sets', await throws(() => api.mine({ flags: ['afterSwapReturnDelta'], initCodeHash: AB }), 'invalid_flags'));
r = await api.mine({ flags: 0x3fff, initCodeHash: AB, maxIterations: 20 }); ok('bounded search reports nextSalt', r.found === false && r.nextSalt === '20');
r = await api.poolId({ currency0: USDG, currency1: ETH, fee: 500, tickSpacing: 10 }); ok('compute pool id', r.poolId === poolIdOf(key) && r.sorted);
r = await api.flagTable(); ok('flag table', r.mask === '0x3fff' && r.flags.length === 14);
r = await api.decodeHook({ address: HOOK }); ok('decode hook', r.flagsHex === '0x2544');
r = await api.listHooks({}); ok('an empty index lists nothing', r.total === 0 && r.hooks.length === 0 && (await api.listPools({})).total === 0);
ok('unknown pool id is not_found', await throws(() => api.getPool({ poolId: '0x' + '12'.repeat(32) }), 'not_found'));
ok('token endpoint before launch', (await api.token()).live === false);
ok('three launch presets within the contract limits', Object.values(PRESETS).every((p) => p.feeBps <= 500 && p.snipeBps <= 9000 && p.snipeSecs <= 3600 && p.snipeBps >= p.feeBps));

console.log('\nmcp');
const cfg = { name: 'HookFi' };
r = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, api, cfg);
ok('15 read-only tools with schemas', TOOLS.length === 15 && r.result.tools.length === 15 && r.result.tools.every((t) => t.annotations.readOnlyHint && t.inputSchema.type === 'object' && !('op' in t)));
r = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'decode_hook', arguments: { address: HOOK } } }, api, cfg);
ok('tools/call returns JSON text', JSON.parse(r.result.content[0].text).flagsHex === '0x2544');
r = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mine_hook_salt', arguments: { flags: ['afterSwapReturnDelta'], initCodeHash: AB } } }, api, cfg);
ok('tool errors are results with isError', r.result.isError === true && /invalid_flags/.test(r.result.content[0].text));
r = await mcp([{ jsonrpc: '2.0', id: 4, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 5, method: 'nope' }], api, cfg);
ok('batches, notifications, unknown methods', r.length === 2 && r[1].error.code === -32601);
ok('a lone notification has no reply', (await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, api, cfg)) === null);

for (const s of ['', '-wal', '-shm']) try { fs.rmSync(db + s); } catch {}
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);

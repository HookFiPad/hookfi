// Launchpad end-to-end, on a local fork with the contracts deployed (see contracts/README.md):
//   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8555
//   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8555 --broadcast --private-key <anvil key 0>
//   LAUNCHPAD_ADDR=0x… HOOK_ADDR=0x… node test/launch.js
// It launches a token through the API, then buys, sells and claims fees, sending every built transaction to the fork.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), FORK = process.env.FORK_RPC || 'http://127.0.0.1:8555', BASE = 'http://localhost:8398';
const CREATOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', TRADER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // anvil's unlocked accounts 1 and 2
let pass = 0, fail = 0; const ok = (n, c, x = '') => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('FAIL  ' + n + '  ' + x)); };
const rpc = async (method, params = []) => { const j = await (await fetch(FORK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, j: await r.json() }; };
const post = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, j: await r.json() }; };
const send = async (from, txs) => { for (const t of txs) { const h = await rpc('eth_sendTransaction', [{ from, to: t.to, data: t.data, value: '0x' + BigInt(t.value).toString(16) }]); const rc = await rpc('eth_getTransactionReceipt', [h]); if (!rc || rc.status !== '0x1') throw new Error('reverted: ' + t.description); } };
const bal = async (token, who) => BigInt(await rpc('eth_call', [{ to: token, data: '0x70a08231' + who.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'index.js')], { env: { ...process.env, PORT: '8398', NO_INDEX: '1', DATA_PATH: path.join(os.tmpdir(), 'hookfi-launch-' + Date.now() + '.db'), RPC_4663: FORK }, stdio: 'ignore' });
process.on('exit', () => { try { child.kill(); } catch {} });
for (let i = 0; i < 60; i++) { try { await fetch(BASE + '/v1/config'); break; } catch { await new Promise((z) => setTimeout(z, 250)); } }

let r = await get('/v1/launch/chains'); const rh = r.j.chains.find((c) => c.id === 4663);
ok('eight chains listed, launchpad live on the fork', r.j.chains.length === 8 && rh.deployed === true && rh.startTick === 200400, JSON.stringify(rh));
ok('opening market cap is about 2 ETH', rh.openingMarketCap > 1.8 && rh.openingMarketCap < 2.2, String(rh.openingMarketCap));
ok('three fee presets', Object.keys(r.j.presets).join() === 'standard,antisnipe,creator');

const sym = 'T' + Date.now().toString(36).slice(-5).toUpperCase();
r = await post('/v1/launch/build', { chainId: 4663, name: 'Fork Test ' + sym, symbol: sym, creator: CREATOR, preset: 'antisnipe', buy: '0.2' }); const b = r.j;
ok('launch builds one unsigned transaction with the opening buy as value', r.status === 200 && b.transactions.length === 1 && b.transactions[0].value === '200000000000000000' && b.snipeBps === 8000, JSON.stringify(b).slice(0, 300));
await send(CREATOR, b.transactions);
ok('token exists at the predicted address', (await rpc('eth_getCode', [b.token, 'latest'])).length > 2);
const got = await bal(b.token, CREATOR); ok('creator received the opening buy with no hook fee', got > 80_000_000n * 10n ** 18n && got < 100_000_000n * 10n ** 18n, got.toString());

r = await get('/v1/launch/list?chainId=4663'); const row = r.j.launches[0];
ok('the launch is listed with its name, price and market cap', r.j.total >= 1 && row.token === b.token && row.symbol === sym && row.marketCap > 2 && row.marketCap < 3, JSON.stringify(row));
ok('the launch fee is still high', row.feeBps > 5000 && row.feeBps <= 8000, String(row.feeBps));
r = await post('/v1/launch/build', { chainId: 8453, name: 'x', symbol: 'X', creator: CREATOR }); ok('a chain without the contracts says so', r.status === 404 && /not deployed on Base/.test(r.j.error.message), JSON.stringify(r.j));
r = await post('/v1/launch/build', { chainId: 4663, name: 'x', symbol: 'X', creator: CREATOR, feeBps: 900 }); ok('fees above the cap are refused', r.status === 400);

await rpc('evm_increaseTime', [400]); await rpc('evm_mine', []);
r = await get('/v1/launch/token?chainId=4663&token=' + b.token); ok('after the window the fee is the normal 1%', r.j.feeBps === 100 && r.j.config.snipeSecs === 300 && r.j.creator === CREATOR, JSON.stringify(r.j).slice(0, 300));
r = await get('/v1/launch/quote?chainId=4663&side=buy&amount=0.05&token=' + b.token); const q = r.j; ok('buy quote runs through the hook', r.status === 200 && Number(q.amountOut) > 1e6 && q.hooked === true, JSON.stringify(q).slice(0, 200));
r = await post('/v1/launch/swap', { chainId: 4663, token: b.token, side: 'buy', amount: '0.05', sender: TRADER }); await send(TRADER, r.j.transactions);
const tb = await bal(b.token, TRADER); ok('trader bought at least the minimum', tb >= BigInt(Math.floor(Number(r.j.minAmountOut))) * 10n ** 18n && tb > 0n, tb.toString());
r = await post('/v1/launch/swap', { chainId: 4663, token: b.token, side: 'sell', amount: String(tb / 2n / 10n ** 18n), sender: TRADER });
ok('a sell adds the two Permit2 approvals', r.j.transactions.length === 3, JSON.stringify(r.j.transactions && r.j.transactions.map((t) => t.description)));
await send(TRADER, r.j.transactions); ok('trader sold half', (await bal(b.token, TRADER)) < tb);
r = await get('/v1/launch/token?chainId=4663&token=' + b.token); const owedEth = Number(r.j.creatorUnclaimed.ETH), owedTok = Number(r.j.creatorUnclaimed[sym]);
ok('creator has fees waiting in both currencies', owedEth > 0 && owedTok > 0, JSON.stringify(r.j.creatorUnclaimed));
r = await post('/v1/launch/claim', { chainId: 4663 }); await send(CREATOR, r.j.transactions);
r = await get('/v1/launch/token?chainId=4663&token=' + b.token); ok('creator claimed the native fees: nothing left waiting', Number(r.j.creatorUnclaimed.ETH) === 0 && Number(r.j.creatorUnclaimed[sym]) === owedTok, JSON.stringify(r.j.creatorUnclaimed));
console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);

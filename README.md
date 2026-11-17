# HookFi

[![ci](https://github.com/HookFiPad/hookfi/actions/workflows/ci.yml/badge.svg)](https://github.com/HookFiPad/hookfi/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-MIT-00c805)](LICENSE) [![node](https://img.shields.io/badge/node-%E2%89%A5%2022.13-00c805)](.node-version) [![solidity](https://img.shields.io/badge/solidity-0.8.26-00c805)](contracts/foundry.toml)

**[hookfi.fun](https://hookfi.fun)** · [Docs](https://hookfi.fun/docs) · [Hook explorer](https://hookfi.fun/hooks) · [Launchpad](https://hookfi.fun/launch) · [X](https://x.com/HookFiFun)

Developer infrastructure for Uniswap v4 hooks on Robinhood Chain (chain ID 4663). One Node.js process that indexes every v4 pool from the PoolManager and serves:

- **Hook API.** Registry of every hook attached to a pool: permissions decoded from the address, bytecode size and hash, EIP-1967 / EIP-1167 proxy detection, warnings, and the pools that use it.
- **Hook Miner.** Finds the CREATE2 salt that puts a hook at an address encoding exactly the permissions it needs.
- **Pool API.** Every v4 pool, filterable by hook, token or pair, with live price, tick, liquidity and LP fee read through StateView.
- **Quote API.** Exact-in and exact-out quotes from the on-chain V4Quoter, so the pool's hook actually runs. Best-route ranking across every pool for a pair.
- **Swap API.** Unsigned Permit2 approvals and one Universal Router call. The node never signs, holds keys or submits anything.
- **Agent API.** The same operations as 15 read-only MCP tools over streamable HTTP.
- **Launchpad.** Launch a token with the HookFi hook on any chain with Uniswap v4 (Robinhood Chain, Base, Unichain, Ethereum, Arbitrum, Optimism, BNB Smart Chain, Polygon). One transaction deploys the token, opens the pool, locks the whole supply and makes the opening buy. The hook pays the creator on every swap and starts with a decaying anti-snipe fee. Contracts and the deploy script are in [`contracts/`](contracts/).
- **Permission census.** How many deployed hooks carry each permission bit.

## Run it

```bash
git clone https://github.com/HookFiPad/hookfi
cd hookfi
npm install
npm start            # http://localhost:8296
npm run test:unit    # pure checks, no network
npm test             # end-to-end checks against Robinhood Chain
```

Node 22.13 or newer (the index uses the built-in `node:sqlite`). The only dependency is `@noble/hashes` for keccak-256.

On first start the node reads the PoolManager's `Initialize` events from block 0. With the public RPC that takes roughly an hour for 116M blocks; the API serves what is indexed so far, and `/v1/stats` shows `indexedThroughBlock` against `headBlock`. After that it follows the chain head every few seconds.

## Layout

| Path | What it is |
|---|---|
| `lib/hooks.js` | Hook permissions: the 14 flags, decoding, capability notes, validity rules. Shared by the node, the browser and the SDK |
| `server/evm.js` | keccak, ABI encoder, JSON-RPC client with a rate limiter |
| `server/chain.js` | Token metadata, pool state, quotes, swap calldata, hook bytecode checks |
| `server/store.js` | The SQLite index and the chain follower |
| `server/api.js` | Every operation as a plain function |
| `server/mcp.js` | The MCP endpoint |
| `server/index.js` | HTTP routes and the static site |
| `server/launch.js` | The chain registry and the launchpad API |
| `contracts/` | Solidity: token, hook, launchpad, fork tests, deploy script |
| `sdk/hookfi.js` | One-file client for Node and the browser |
| `client/` | Landing page, hook explorer, docs, burn page |
| `test/run.js` | The test suite |

## Configuration

Environment variables, or a git-ignored `.env` next to `package.json`:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8296` | HTTP port |
| `DATA_PATH` | `./hookfi.db` | The SQLite index. Put it on a persistent disk |
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | Robinhood Chain RPC |
| `RPC_RATE` | `30` | RPC calls per second the node allows itself. Raise it with a private endpoint |
| `SITE_URL`, `X_URL`, `GH_URL` | empty | Links shown on the site |
| `BRAND_NAME`, `BRAND_TICKER` | `HookFi`, `$HOOK` | Name and ticker shown on the site |
| `LAUNCHPAD_ADDR`, `HOOK_ADDR` | Override the built-in launchpad and hook addresses (see [contracts/README.md](contracts/README.md)). The node detects which chains they are live on |
| `RPC_<chainId>` | Override the RPC for one chain, e.g. `RPC_8453` |
| `TOKEN_ADDR` | `$HOOK` on Robinhood Chain | Token contract. Once set, `/v1/token` and the burn page read supply and burns from the chain |
| `BUYBACK_WALLET` | empty | Burns sent from this wallet are labelled as buybacks |

## Uniswap v4 on Robinhood Chain

| Contract | Address |
|---|---|
| PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| V4Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| UniversalRouter | `0x204FAca1764B154221e35c0d20aBb3c525710498` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout and what a change needs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT

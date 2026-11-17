# HookFi contracts

Three contracts, built against Uniswap v4 core (vendored in `lib/v4-core`).

| Contract | What it does |
|---|---|
| `LaunchToken.sol` | Fixed-supply ERC-20 (1,000,000,000). No owner, no mint, no blocklist |
| `HookFiHook.sol` | The shared hook. Permission bits `0x2044`: `beforeInitialize`, `afterSwap`, `afterSwapReturnDelta`. Takes a per-pool fee after each swap (max 5%), credits 80% to the creator and 20% to the treasury, and starts each pool at a higher launch fee (max 90%) that falls in a straight line to the normal fee (within at most one hour). Fees are claimed with `claim(currency)` |
| `HookFiLaunchpad.sol` | `launch()` deploys the token, opens the native/token pool with the hook, places the whole supply in it as one position that the contract can never withdraw, and makes the creator's opening buy. `collectFees(token)` sends the position's 0.30% pool fees to the treasury |

Both deployable contracts take only the owner as a constructor argument and go through the deterministic CREATE2 deployer (`0x4e59b44847b379578588920cA78FbF26c0B4956C`), so one deployer account gets the **same hook and launchpad address on every chain**. `initialize` then binds each chain's PoolManager.

## Test

The tests run against a fork of a live chain, using its real PoolManager:

```bash
forge test --fork-url robinhood
forge test --fork-url base
forge test --fork-url unichain
```

## Deploy

```bash
cast wallet import deployer --interactive          # once: stores your key encrypted
forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --account deployer
```

Repeat with `--rpc-url` for each chain (Robinhood Chain, Ethereum, Unichain, Base, Arbitrum One, Optimism, BNB Smart Chain and Polygon are known to the script). Optional environment:

| Variable | Meaning |
|---|---|
| `TREASURY` | Where the protocol's share of fees goes. Default: the deployer |
| `START_TICK` | Opening tick, a multiple of 200. Tokens per native coin = 1.0001^tick. Default `200400` on ETH-native chains (the whole supply is worth about 2 ETH at launch). Required on BNB Smart Chain and Polygon |

The script prints `HOOK` and `LAUNCHPAD`. Give those to the node as `HOOK_ADDR` and `LAUNCHPAD_ADDR`; it detects by itself which chains they are live on.

## End-to-end on a local fork

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8555
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8555 --broadcast --private-key <anvil key 0>
LAUNCHPAD_ADDR=0x… HOOK_ADDR=0x… node ../test/launch.js
```

These contracts have not been audited.

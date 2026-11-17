# Changelog

All notable changes to HookFi are listed here. Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- **Contract fuzz tests** for the fee schedule, fee accounting, launch limits, round trips and claims, against a locally deployed PoolManager.
- **Contract invariant tests**: hook solvency, locked liquidity, an empty launchpad, fixed supply and bounded fees under random sequences of actions.
- **Static analysis** with Slither on every push, and a written threat model in `contracts/THREAT_MODEL.md`.
- X and GitHub buttons in the site header.
- **Multi-chain index.** One index per chain for Robinhood Chain, Base, Unichain, Ethereum, Arbitrum One, Optimism, BNB Smart Chain and Polygon. Every index-backed endpoint and MCP tool takes `chainId`; the explorer has a chain picker; `/v1/stats` reports per-chain coverage and totals.
- **Launchpad contracts deployed on Robinhood Chain.**

## [0.1.0] - 2026-11-17

First public release.

### Added

- **Index.** Every Uniswap v4 pool on Robinhood Chain, read from the PoolManager's `Initialize` events into a compact SQLite index that then follows the chain head.
- **Hook API.** Registry of every hook attached to a pool, permissions decoded from the address, capability notes, bytecode size and hash, EIP-1967 and EIP-1167 proxy detection, address-level warnings, and a census of how many hooks carry each permission.
- **Hook Miner.** CREATE2 salt search for an address with exactly the requested permission bits.
- **Pool API.** Pool listing with filters, live state through StateView, PoolId computation, and a risk check with reasons.
- **Quote API.** Exact-in and exact-out quotes from the on-chain V4Quoter, and best-route ranking across every pool for a pair.
- **Swap API.** Unsigned Permit2 approvals and one Universal Router call per swap.
- **Agent API.** 15 read-only MCP tools over streamable HTTP.
- **Launchpad contracts.** `LaunchToken`, `HookFiHook` (per-pool swap fee with a decaying launch fee, 80% to the creator) and `HookFiLaunchpad` (one-transaction launch with the whole supply locked as liquidity), deployable to the same address on every chain.
- **Launchpad API and page.** Build, list, quote, swap and claim across Robinhood Chain, Base, Unichain, Ethereum, Arbitrum One, Optimism, BNB Smart Chain and Polygon.
- **SDK.** A one-file client for Node and the browser.
- **Site.** Landing page, hook explorer, launch page, docs and burn page.
- **Tests.** Unit checks, 50 end-to-end checks against Robinhood Chain, 9 contract tests on forks of three chains, and a 17-step launch flow on a local fork.

[0.1.0]: https://github.com/HookFiPad/hookfi/releases/tag/v0.1.0

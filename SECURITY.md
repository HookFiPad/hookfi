# Security

HookFi has two parts with different risks: the node (an API that reads chains and returns unsigned transactions) and the contracts (a token, a Uniswap v4 hook and a launchpad that hold and move funds).

## Reporting a vulnerability

Please report privately, not in a public issue:

- Use **Report a vulnerability** on the repository's Security tab (GitHub private vulnerability reporting).

Include what you found, how to reproduce it, and what you think the impact is. You will get a reply within three days. Please give us a reasonable time to fix an issue before publishing it.

## Scope

In scope:

- `contracts/src`: loss or lock of funds, fees credited to the wrong account, a way to withdraw the locked liquidity position, a way to open pools on the hook without the launchpad, or to change a pool's fee settings after launch.
- `server/`: transactions built by the API that do something other than what the response describes, wrong hook permission decoding, wrong risk levels, or a way to make the node sign or hold anything (it must never do either).

Out of scope: third-party hooks indexed by the registry, the public RPC endpoints, and rate limiting on a self-hosted node.

## Design notes

- The node never holds keys. Every state-changing endpoint returns unsigned calldata for the user's wallet.
- The launchpad owns each launch's liquidity position and has no function that removes liquidity.
- Hook fees are bounded in the contract: 5% lasting, 90% at launch, falling to the lasting fee within at most one hour.
- The contracts have not had a third-party audit. What they assume, and which test checks each claim, is in [contracts/THREAT_MODEL.md](contracts/THREAT_MODEL.md).

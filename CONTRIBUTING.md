# Contributing

Thanks for looking. HookFi is one Node.js process plus three Solidity contracts.

## Getting set up

```bash
git clone https://github.com/HookFiPad/hookfi
cd hookfi
npm install
npm start            # http://localhost:8296
npm run test:unit    # pure checks, no network
npm test             # end-to-end against Robinhood Chain
```

Node 22.13 or newer. For the contracts you also need [Foundry](https://book.getfoundry.sh):

```bash
cd contracts
forge build
forge test --fork-url robinhood
```

## Where things live

- `lib/hooks.js` holds the permission rules: the 14 flags, decoding, capability notes, validity. The node, the browser and the SDK import this same file.
- `server/evm.js` is the ABI encoder, keccak and the rate-limited RPC client.
- `server/chain.js` reads a chain: tokens, pool state, quotes, swap calldata, bytecode checks.
- `server/store.js` is the SQLite pool index and the chain follower.
- `server/launch.js` is the chain registry and the launchpad API.
- `contracts/src` is the token, the hook and the launchpad.

## Ground rules

1. **The node never signs.** Anything that changes state is returned as unsigned calldata.
2. **A capability note describes what a permission makes possible**, never what a hook "is". Do not add labels like safe or scam.
3. **Numbers on the site come from the chain or the index.** Do not hard-code counts.
4. **Contract changes need a fork test** that runs against a live chain's PoolManager.
5. **Keep the node dependency-light.** It uses Node's standard library plus `@noble/hashes`.

## Branches and commits

- `main` is what the public node runs. `dev` is where work lands first; open pull requests against `dev`.
- Start the message with the area: `store: index pools in slices`, `hook: cap the launch fee`, `site: launch page`.

## Security

See [SECURITY.md](SECURITY.md). Please do not open a public issue for a vulnerability.

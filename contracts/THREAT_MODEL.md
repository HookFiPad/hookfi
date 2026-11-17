# Threat model

What the HookFi contracts hold, who can do what, what could go wrong, and what checks each claim. The contracts have not been audited by a third party; this document is the map an auditor would start from.

## What is at stake

| Asset | Where it sits | Who can move it |
|---|---|---|
| A launch's liquidity (the whole token supply, then the native coin traders pay in) | The Uniswap v4 PoolManager, as one position owned by `HookFiLaunchpad` | Traders, by swapping. Nobody can withdraw the position: the launchpad has no function that decreases liquidity |
| Hook fees not yet claimed | `HookFiHook`, as native coin and tokens | Only the account they were credited to, through `claim` |
| Pool fees earned by the locked position | The PoolManager | Anyone may call `collectFees`; the proceeds can only go to the treasury |

## Roles

| Role | Powers | Limits |
|---|---|---|
| Owner (deployer) | Call `initialize` once on each contract; change the hook's treasury address | Cannot change the PoolManager or launchpad after `initialize`. Cannot change any pool's fee settings. Cannot touch liquidity or other accounts' credited fees |
| Launchpad | Register a pool's fee settings; open pools on the hook | Settings are bounded in the hook: 5% lasting fee, 90% launch fee, one hour. A pool can be registered once |
| Creator | Choose fee settings at launch; claim their 80% of hook fees | Cannot change settings after launch. Gets no tokens for free: the opening buy pays the pool like any buy |
| Treasury | Claim 20% of hook fees; receive pool fees | Nothing else |
| Anyone | Launch, trade, call `collectFees` | |

## Invariants and where they are tested

| Claim | Test |
|---|---|
| The hook holds exactly the fees it has credited and not paid out, in both currencies | `invariant_hookIsSolvent`, `testFuzz_hookHoldsExactlyWhatItOwes` |
| The locked position's liquidity never changes | `invariant_liquidityStaysLocked` |
| The launchpad never ends a transaction holding tokens or native coin | `invariant_launchpadHoldsNothing`, `testFuzz_openingBuyNeverCharged` |
| Token supply is fixed | `invariant_supplyIsFixed` |
| A pool's fee stays between its lasting fee and its launch fee, never above 90%, and never rises over time | `invariant_feeWithinLaunchSettings`, `testFuzz_feeScheduleStaysInBounds` |
| Settings above the caps cannot be registered | `testFuzz_launchRejectsOutOfRange`, `test_limitsAndOneTimeSetup` |
| Buying and selling straight back always costs the trader | `testFuzz_noFreeRoundTrip` |
| A claim pays exactly what was owed, once | `testFuzz_claimPaysExactlyOnce`, `test_sellsPayTheFeeInNativeAndCreatorClaims` |
| Only the launchpad can open pools on the hook | `test_onlyTheLaunchpadCanOpenPoolsWithTheHook` |
| The hook's address carries exactly its three permission bits | `test_hookAddressCarriesExactlyItsPermissions` |
| The behaviour holds against the real PoolManager on Robinhood Chain, Base and Unichain | `test/Launch.t.sol`, run with `--fork-url` |

The fuzz and invariant suites deploy a real PoolManager locally and run in CI on every push. The invariant suite drives random sequences of buys, sells, waits, claims and fee collections.

## Risks considered

- **Reentrancy.** `claim` zeroes the balance before transferring. The launchpad and the hook only act inside the PoolManager's unlock callback or when called by it, and both check `msg.sender` is the PoolManager.
- **A creator that cannot receive native coin.** Fees are credited and pulled with `claim`, never pushed during a swap, so a reverting recipient cannot block trading. The opening-buy refund goes to the creator and reverts the launch if it fails, which only affects that creator's own transaction.
- **Fee settings as an attack.** A creator can set the launch fee to 90% for up to an hour. That is visible before trading: `currentFeeBps` is public and the quote already includes it.
- **Front-running a launch.** The token address depends on the creator's address and salt, so nobody else can deploy it first. The opening buy happens in the launch transaction, before any other trade is possible.
- **Hook address correctness.** The PoolManager refuses a hook whose address bits do not match its behaviour. The deploy script mines the address and the tests assert the bits.
- **Rounding.** Liquidity is rounded down when the position is created; the few wei of tokens left over are sent to the dead address, never kept by the launchpad.

## Known limits

- **Trust in the owner is narrow but not zero.** The owner can redirect future protocol fees by changing the treasury. It cannot affect creators' fees or liquidity.
- **`collectFees` is permissionless.** That is deliberate: it can only send to the treasury.
- **The same deployer account must be used on every chain** for the addresses to match. A different account gives different, equally valid addresses.
- **Uniswap v4 itself is assumed correct.** The PoolManager, quoter and router are Uniswap's deployments.
- **No third-party audit yet.**

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {HookFiHook} from "../src/HookFiHook.sol";
import {HookFiLaunchpad} from "../src/HookFiLaunchpad.sol";
import {Router} from "./Launch.t.sol";
import {LocalBase} from "./Fuzz.t.sol";

/// The actions anyone can take against a launched token, in any order: buy, sell, wait, claim, collect.
contract Handler is Test {
    Router immutable router;
    HookFiHook immutable hook;
    HookFiLaunchpad immutable pad;
    LaunchToken immutable token;
    PoolKey key;
    address immutable creator;
    address immutable treasury;

    constructor(Router r, HookFiHook h, HookFiLaunchpad p, LaunchToken t, PoolKey memory k, address creator_, address treasury_) {
        (router, hook, pad, token, key, creator, treasury) = (r, h, p, t, k, creator_, treasury_);
        token.approve(address(r), type(uint256).max);
    }

    function buy(uint96 amount) external {
        uint256 a = bound(amount, 1e12, 5 ether);
        vm.deal(address(this), a);
        router.swap{value: a}(key, true, a);
    }

    function sell(uint96 amount) external {
        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) return;
        router.swap(key, false, bound(amount, 1, bal));
    }

    function wait_(uint16 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 900));
    }

    function claim(uint8 who, bool native) external {
        vm.prank(who % 2 == 0 ? creator : treasury);
        hook.claim(native ? Currency.wrap(address(0)) : Currency.wrap(address(token)));
    }

    function collect() external {
        pad.collectFees(address(token));
    }

    receive() external payable {}
}

contract InvariantTest is LocalBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    LaunchToken token;
    PoolKey key;
    Handler handler;
    uint128 lockedLiquidity;
    bytes32 positionId;

    function setUp() public {
        _deploy();
        (token, key) = _launch(100, 8000, 300, 1 ether, 9);
        positionId = keccak256(abi.encodePacked(address(pad), pad.TICK_LOWER(), START_TICK, bytes32(0)));
        lockedLiquidity = pm.getPositionLiquidity(key.toId(), positionId);
        assertGt(lockedLiquidity, 0);
        handler = new Handler(router, hook, pad, token, key, creator, treasury);
        targetContract(address(handler));
    }

    /// The hook holds exactly the fees it has credited and not yet paid out, in both currencies.
    function invariant_hookIsSolvent() public view {
        assertEq(token.balanceOf(address(hook)), _owed(Currency.wrap(address(token))));
        assertEq(address(hook).balance, _owed(NATIVE));
    }

    /// The launchpad's liquidity position never changes: nothing can withdraw it.
    function invariant_liquidityStaysLocked() public view {
        assertEq(pm.getPositionLiquidity(key.toId(), positionId), lockedLiquidity);
    }

    /// The launchpad never ends a transaction holding tokens or native coin.
    function invariant_launchpadHoldsNothing() public view {
        assertEq(token.balanceOf(address(pad)), 0);
        assertEq(address(pad).balance, 0);
    }

    /// No path mints or burns supply.
    function invariant_supplyIsFixed() public view {
        assertEq(token.totalSupply(), 1_000_000_000e18);
    }

    /// The fee stays inside the range fixed at launch.
    function invariant_feeWithinLaunchSettings() public view {
        uint16 f = hook.currentFeeBps(key.toId());
        assertGe(f, 100);
        assertLe(f, 8000);
    }
}

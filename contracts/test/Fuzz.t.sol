// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {HookFiHook} from "../src/HookFiHook.sol";
import {HookFiLaunchpad} from "../src/HookFiLaunchpad.sol";
import {Router} from "./Launch.t.sol";

/// Deploys a real Uniswap v4 PoolManager locally, so these tests need no fork and run in CI.
abstract contract LocalBase is Test {
    using PoolIdLibrary for PoolKey;

    int24 constant START_TICK = 200400;
    Currency constant NATIVE = Currency.wrap(address(0));

    IPoolManager pm;
    HookFiHook hook;
    HookFiLaunchpad pad;
    Router router;
    address owner = address(uint160(uint256(keccak256("hookfi.local.owner"))));
    address treasury = address(uint160(uint256(keccak256("hookfi.local.treasury"))));
    address creator = address(uint160(uint256(keccak256("hookfi.local.creator"))));
    address trader = address(uint160(uint256(keccak256("hookfi.local.trader"))));

    function _deploy() internal {
        pm = IPoolManager(address(new PoolManager(address(this))));
        // any address whose low 14 bits are 0x2044: beforeInitialize | afterSwap | afterSwapReturnDelta
        address at = address((uint160(uint256(keccak256("hookfi.local.hook"))) & ~uint160(0x3fff)) | uint160(0x2044));
        deployCodeTo("HookFiHook.sol:HookFiHook", abi.encode(owner), at);
        hook = HookFiHook(payable(at));
        pad = new HookFiLaunchpad(owner);
        vm.startPrank(owner);
        pad.initialize(pm, hook, treasury, START_TICK);
        hook.initialize(pm, address(pad), treasury);
        vm.stopPrank();
        router = new Router(pm);
        vm.deal(creator, 1000 ether);
        vm.deal(trader, 1000 ether);
    }

    function _launch(uint16 fee, uint16 snipe, uint32 secs, uint256 value, uint256 salt) internal returns (LaunchToken token, PoolKey memory key) {
        vm.prank(creator);
        (address t,) = pad.launch{value: value}("Fuzz Coin", "FUZZ", fee, snipe, secs, bytes32(salt));
        token = LaunchToken(t);
        key = pad.keyOf(t);
    }

    function _owed(Currency c) internal view returns (uint256) {
        return hook.owed(creator, c) + hook.owed(treasury, c);
    }
}

contract FuzzTest is LocalBase {
    using PoolIdLibrary for PoolKey;

    function setUp() public {
        _deploy();
    }

    /// The fee is always between the lasting fee and the launch fee, never above 90%, and never rises with time.
    function testFuzz_feeScheduleStaysInBounds(uint16 fee, uint16 snipe, uint32 secs, uint32 dt1, uint32 dt2) public {
        fee = uint16(bound(fee, 0, 500));
        snipe = uint16(bound(snipe, 0, 9000));
        secs = uint32(bound(secs, 0, 3600));
        (, PoolKey memory key) = _launch(fee, snipe, secs, 0, 1);
        PoolId id = key.toId();
        uint16 top = snipe > fee ? snipe : fee;

        vm.warp(block.timestamp + bound(dt1, 0, 2 hours));
        uint16 a = hook.currentFeeBps(id);
        assertGe(a, fee);
        assertLe(a, top);
        assertLe(a, 9000);

        vm.warp(block.timestamp + bound(dt2, 0, 2 hours));
        uint16 b = hook.currentFeeBps(id);
        assertLe(b, a, "the fee never rises");
        assertGe(b, fee);

        vm.warp(block.timestamp + 1 hours + 1);
        assertEq(hook.currentFeeBps(id), fee, "after an hour it is always the lasting fee");
    }

    /// Settings above the caps can never be registered.
    function testFuzz_launchRejectsOutOfRange(uint16 fee, uint16 snipe, uint32 secs) public {
        bool tooHigh = fee > 500 || snipe > 9000 || secs > 3600;
        vm.prank(creator);
        if (tooHigh) vm.expectRevert(HookFiHook.BadConfig.selector);
        pad.launch("Fuzz Coin", "FUZZ", fee, snipe, secs, bytes32(uint256(7)));
    }

    /// Whatever is traded and whenever, the hook holds exactly the fees it has credited, in both currencies.
    function testFuzz_hookHoldsExactlyWhatItOwes(uint96 buy, uint8 sellPct, uint32 dt, uint16 fee, uint16 snipe) public {
        fee = uint16(bound(fee, 0, 500));
        snipe = uint16(bound(snipe, 0, 9000));
        (LaunchToken token, PoolKey memory key) = _launch(fee, snipe, 300, 0, 2);
        Currency tok = Currency.wrap(address(token));
        vm.warp(block.timestamp + bound(dt, 0, 600));

        vm.startPrank(trader);
        uint256 got = router.swap{value: bound(buy, 1e12, 20 ether)}(key, true, bound(buy, 1e12, 20 ether));
        assertEq(token.balanceOf(trader), got);
        uint256 sell = (got * bound(sellPct, 0, 100)) / 100;
        if (sell > 0) {
            token.approve(address(router), sell);
            router.swap(key, false, sell);
        }
        vm.stopPrank();

        assertEq(token.balanceOf(address(hook)), _owed(tok), "token: held == owed");
        assertEq(address(hook).balance, _owed(NATIVE), "native: held == owed");
        assertLe(hook.owed(treasury, tok), (_owed(tok) * 2001) / 10_000 + 1, "treasury never gets more than a fifth");
    }

    /// Buying and immediately selling everything always loses money: there is no free round trip.
    function testFuzz_noFreeRoundTrip(uint96 buy, uint16 fee) public {
        fee = uint16(bound(fee, 0, 500));
        (LaunchToken token, PoolKey memory key) = _launch(fee, fee, 0, 0, 3);
        uint256 amount = bound(buy, 1e13, 20 ether);
        uint256 before = trader.balance;
        vm.startPrank(trader);
        uint256 got = router.swap{value: amount}(key, true, amount);
        token.approve(address(router), got);
        router.swap(key, false, got);
        vm.stopPrank();
        assertLt(trader.balance, before, "round trip must cost the trader");
        assertEq(token.balanceOf(trader), 0);
    }

    /// The creator's opening buy is never charged a hook fee, the launchpad keeps nothing, and the supply is fixed.
    function testFuzz_openingBuyNeverCharged(uint96 value, uint16 snipe) public {
        snipe = uint16(bound(snipe, 0, 9000));
        uint256 v = bound(value, 0, 50 ether);
        uint256 before = creator.balance;
        (LaunchToken token,) = _launch(100, snipe, 300, v, 4);
        Currency tok = Currency.wrap(address(token));
        assertEq(_owed(tok), 0);
        assertEq(_owed(NATIVE), 0);
        assertEq(token.balanceOf(address(pad)), 0);
        assertEq(address(pad).balance, 0);
        assertEq(token.totalSupply(), 1_000_000_000e18);
        assertEq(creator.balance, before - v, "all native sent was spent on the buy");
        if (v >= 1e12) assertGt(token.balanceOf(creator), 0);
    }

    /// Claims pay exactly what was owed, once.
    function testFuzz_claimPaysExactlyOnce(uint96 buy) public {
        (LaunchToken token, PoolKey memory key) = _launch(300, 300, 0, 0, 5);
        Currency tok = Currency.wrap(address(token));
        vm.prank(trader);
        router.swap{value: bound(buy, 1e13, 20 ether)}(key, true, bound(buy, 1e13, 20 ether));
        uint256 due = hook.owed(creator, tok);
        vm.startPrank(creator);
        assertEq(hook.claim(tok), due);
        assertEq(token.balanceOf(creator), due);
        assertEq(hook.claim(tok), 0, "a second claim pays nothing");
        vm.stopPrank();
        assertEq(token.balanceOf(address(hook)), hook.owed(treasury, tok));
    }
}

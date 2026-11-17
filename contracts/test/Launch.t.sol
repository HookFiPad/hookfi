// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {HookFiHook} from "../src/HookFiHook.sol";
import {HookFiLaunchpad} from "../src/HookFiLaunchpad.sol";

/// A bare swap router for the tests: exact-input swaps settled straight against the PoolManager.
contract Router is IUnlockCallback {
    IPoolManager immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) external payable returns (uint256 out) {
        out = abi.decode(pm.unlock(abi.encode(key, zeroForOne, amountIn, msg.sender)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, bool zeroForOne, uint256 amountIn, address who) = abi.decode(data, (PoolKey, bool, uint256, address));
        BalanceDelta d = pm.swap(key, SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), "");
        if (zeroForOne) {
            pm.settle{value: uint128(-d.amount0())}();
            pm.take(key.currency1, who, uint128(d.amount1()));
            return abi.encode(uint256(uint128(d.amount1())));
        }
        pm.sync(key.currency1);
        LaunchToken(Currency.unwrap(key.currency1)).transferFrom(who, address(pm), uint128(-d.amount1()));
        pm.settle();
        pm.take(key.currency0, who, uint128(d.amount0()));
        return abi.encode(uint256(uint128(d.amount0())));
    }
}

/// Runs against a fork of a live chain:  forge test --fork-url robinhood   (or base, unichain)
contract LaunchTest is Test {
    using PoolIdLibrary for PoolKey;

    address constant CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant FLAGS = 0x2044; // beforeInitialize | afterSwap | afterSwapReturnDelta
    int24 constant START_TICK = 200400;

    IPoolManager pm;
    HookFiHook hook;
    HookFiLaunchpad pad;
    Router router;
    address owner = address(uint160(uint256(keccak256("hookfi.test.owner"))));
    address treasury = address(uint160(uint256(keccak256("hookfi.test.treasury")))); // a fresh address: well-known test names have code on some chains
    address creator = address(uint160(uint256(keccak256("hookfi.test.creator"))));
    address trader = address(uint160(uint256(keccak256("hookfi.test.trader"))));

    function setUp() public {
        // PoolManager of the forked chain
        if (block.chainid == 4663) pm = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
        else if (block.chainid == 8453) pm = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
        else if (block.chainid == 130) pm = IPoolManager(0x1F98400000000000000000000000000000000004);
        else { vm.skip(true); return; } // these tests need a fork of a chain with Uniswap v4

        // the hook goes through the deterministic deployer, at a mined address whose low 14 bits are the permissions
        bytes memory init = abi.encodePacked(type(HookFiHook).creationCode, abi.encode(owner));
        bytes32 h = keccak256(init);
        uint256 salt;
        address predicted;
        for (;; salt++) {
            predicted = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2, bytes32(salt), h)))));
            if (uint160(predicted) & 0x3fff == FLAGS) break;
        }
        (bool ok,) = CREATE2.call(abi.encodePacked(bytes32(salt), init));
        assertTrue(ok && predicted.code.length > 0, "hook deployed at the mined address");
        hook = HookFiHook(payable(predicted));

        pad = new HookFiLaunchpad(owner);
        vm.startPrank(owner);
        pad.initialize(pm, hook, treasury, START_TICK);
        hook.initialize(pm, address(pad), treasury);
        vm.stopPrank();
        router = new Router(pm);
        vm.deal(creator, 10 ether);
        vm.deal(trader, 10 ether);
    }

    function _launch(uint256 value) internal returns (LaunchToken token, PoolKey memory key) {
        vm.prank(creator);
        (address t,) = pad.launch{value: value}("Test Coin", "TEST", 100, 5000, 60, bytes32(uint256(1)));
        token = LaunchToken(t);
        key = pad.keyOf(t);
    }

    function test_hookAddressCarriesExactlyItsPermissions() public view {
        assertEq(uint160(address(hook)) & 0x3fff, FLAGS);
    }

    function test_launchPutsWholeSupplyInThePool() public {
        address predicted = pad.predict(creator, "Test Coin", "TEST", bytes32(uint256(1)));
        (LaunchToken token,) = _launch(0);
        assertEq(address(token), predicted, "token address is predictable");
        assertEq(token.totalSupply(), 1_000_000_000e18);
        assertEq(token.balanceOf(address(pad)), 0, "launchpad keeps nothing");
        assertEq(token.balanceOf(creator), 0, "creator gets nothing for free");
        uint256 inPool = token.balanceOf(address(pm));
        assertGt(inPool, 999_999_999e18, "the pool holds the supply");
        assertEq(inPool + token.balanceOf(0x000000000000000000000000000000000000dEaD), 1_000_000_000e18);
        assertEq(pad.launchCount(), 1);
    }

    function test_creatorOpeningBuyPaysNoHookFee() public {
        (LaunchToken token,) = _launch(0.5 ether);
        uint256 got = token.balanceOf(creator);
        // 2 ETH of virtual depth: 0.5 ETH buys about a fifth of the supply, less the 0.3% LP fee
        assertGt(got, 190_000_000e18);
        assertLt(got, 205_000_000e18);
        assertEq(hook.owed(creator, Currency.wrap(address(token))), 0);
        assertEq(creator.balance, 9.5 ether);
    }

    function test_snipeFeeFallsToTheNormalFee() public {
        (LaunchToken token, PoolKey memory key) = _launch(0);
        PoolId id = key.toId();
        Currency tok = Currency.wrap(address(token));
        assertEq(hook.currentFeeBps(id), 5000, "50% in the first second");

        vm.prank(trader);
        uint256 out = router.swap{value: 0.1 ether}(key, true, 0.1 ether);
        uint256 fee = hook.owed(creator, tok) + hook.owed(treasury, tok);
        assertEq(token.balanceOf(trader), out);
        assertApproxEqRel(fee, out, 0.001e18, "the sniper kept half, the hook took half");
        assertEq(hook.owed(treasury, tok), (fee * 2000) / 10_000, "protocol gets a fifth of the fee");

        vm.warp(block.timestamp + 30);
        assertEq(hook.currentFeeBps(id), 2550, "halfway down after 30 of 60 seconds");
        vm.warp(block.timestamp + 31);
        assertEq(hook.currentFeeBps(id), 100, "the normal 1% after the window");

        uint256 before = hook.owed(creator, tok) + hook.owed(treasury, tok);
        vm.prank(trader);
        uint256 out2 = router.swap{value: 0.1 ether}(key, true, 0.1 ether);
        uint256 fee2 = hook.owed(creator, tok) + hook.owed(treasury, tok) - before;
        assertApproxEqRel(fee2 * 99, out2, 0.001e18, "1% of the output");
    }

    function test_sellsPayTheFeeInNativeAndCreatorClaims() public {
        (LaunchToken token, PoolKey memory key) = _launch(0);
        vm.warp(block.timestamp + 120);
        vm.startPrank(trader);
        uint256 bought = router.swap{value: 1 ether}(key, true, 1 ether);
        token.approve(address(router), bought);
        uint256 ethOut = router.swap(key, false, bought / 2);
        vm.stopPrank();
        Currency native = Currency.wrap(address(0));
        uint256 creatorEth = hook.owed(creator, native);
        assertApproxEqRel((creatorEth + hook.owed(treasury, native)) * 99, ethOut, 0.001e18, "1% of the native output");

        uint256 bal = creator.balance;
        vm.prank(creator);
        assertEq(hook.claim(native), creatorEth);
        assertEq(creator.balance, bal + creatorEth);
        assertEq(hook.owed(creator, native), 0);
        Currency tok = Currency.wrap(address(token));
        uint256 creatorTok = hook.owed(creator, tok);
        vm.prank(creator);
        hook.claim(tok);
        assertEq(token.balanceOf(creator), creatorTok);
    }

    function test_lockedPositionFeesGoToTreasury() public {
        (LaunchToken token, PoolKey memory key) = _launch(0);
        vm.warp(block.timestamp + 120);
        vm.prank(trader);
        router.swap{value: 1 ether}(key, true, 1 ether);
        uint256 bal = treasury.balance;
        pad.collectFees(address(token));
        assertApproxEqRel(treasury.balance - bal, 0.003 ether, 0.01e18, "0.30% of the native volume");
    }

    function test_onlyTheLaunchpadCanOpenPoolsWithTheHook() public {
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(0xBEEF)), 3000, 200, IHooks(address(hook)));
        vm.expectRevert();
        pm.initialize(key, TickMath.getSqrtPriceAtTick(0));
        vm.expectRevert(HookFiHook.NotLaunchpad.selector);
        hook.register(key, creator, 100, 100, 0);
    }

    function test_limitsAndOneTimeSetup() public {
        vm.prank(creator);
        vm.expectRevert(HookFiHook.BadConfig.selector);
        pad.launch("Greedy", "GRD", 501, 501, 0, bytes32(0));
        vm.prank(owner);
        vm.expectRevert(HookFiLaunchpad.AlreadyInitialized.selector);
        pad.initialize(pm, hook, treasury, START_TICK);
        vm.prank(owner);
        vm.expectRevert(HookFiHook.AlreadyInitialized.selector);
        hook.initialize(pm, address(pad), treasury);
        vm.expectRevert(HookFiHook.NotOwner.selector);
        hook.setTreasury(address(1));
    }

    function test_sameNameAndSaltCannotLaunchTwice() public {
        _launch(0);
        vm.prank(creator);
        vm.expectRevert();
        pad.launch("Test Coin", "TEST", 100, 5000, 60, bytes32(uint256(1)));
    }
}

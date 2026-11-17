// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {HookFiHook} from "./HookFiHook.sol";

/// @title HookFiLaunchpad
/// @notice One transaction launches a token: it deploys a fixed-supply ERC-20, opens a native/token Uniswap v4
///         pool with the HookFi hook attached, and places the entire supply in that pool as liquidity.
///         The launchpad owns the liquidity position and has no function that removes it, so it is locked for good.
///         Swap fees earned by the position can be collected to the protocol treasury; the creator earns through the hook.
/// @dev    The native currency is always currency0 (the zero address), the launched token is currency1. The position
///         spans [MIN_USABLE_TICK, startTick] and the pool starts at startTick, so the position is all token and
///         the first ETH that comes in starts moving the price.
contract HookFiLaunchpad is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    uint256 public constant SUPPLY = 1_000_000_000e18;
    uint24 public constant LP_FEE = 3000; // 0.30%, earned by the locked position
    int24 public constant TICK_SPACING = 200;
    int24 public constant TICK_LOWER = -887200; // lowest tick usable at this spacing
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable owner;
    IPoolManager public poolManager;
    HookFiHook public hook;
    address public treasury;
    /// @notice The opening tick: tokens per native coin = 1.0001^startTick. Sets the opening market cap for this chain.
    int24 public startTick;

    struct Launch {
        address token;
        address creator;
        uint40 time;
    }

    Launch[] public launches;
    mapping(address => PoolId) public poolOf;

    event Launched(
        address indexed token, PoolId indexed poolId, address indexed creator, string name, string symbol, uint16 feeBps, uint16 snipeBps, uint32 snipeSecs, uint256 creatorBought
    );
    event FeesCollected(PoolId indexed poolId, uint256 native, uint256 token);

    error NotOwner();
    error NotPoolManager();
    error AlreadyInitialized();
    error BadConfig();
    error UnknownToken();
    error TransferFailed();

    constructor(address owner_) {
        owner = owner_;
    }

    /// @notice Binds this chain's PoolManager, the hook, the treasury and the opening tick. Once.
    function initialize(IPoolManager poolManager_, HookFiHook hook_, address treasury_, int24 startTick_) external {
        if (msg.sender != owner) revert NotOwner();
        if (address(poolManager) != address(0)) revert AlreadyInitialized();
        if (address(poolManager_) == address(0) || address(hook_) == address(0) || treasury_ == address(0)) revert BadConfig();
        if (startTick_ % TICK_SPACING != 0 || startTick_ <= TICK_LOWER || startTick_ > 887200) revert BadConfig();
        poolManager = poolManager_;
        hook = hook_;
        treasury = treasury_;
        startTick = startTick_;
    }

    function launchCount() external view returns (uint256) {
        return launches.length;
    }

    function keyOf(address token) public view returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(token), LP_FEE, TICK_SPACING, IHooks(address(hook)));
    }

    /// @notice The address `launch` will give the token for this creator and salt.
    function predict(address creator, string calldata name, string calldata symbol, bytes32 salt) external view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(type(LaunchToken).creationCode, abi.encode(name, symbol, SUPPLY)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encode(creator, salt)), h)))));
    }

    /// @notice Launch a token. Any native coin sent with the call buys from the new pool for the creator in the same
    ///         transaction, before anyone else can trade, and that opening buy pays no hook fee.
    /// @param feeBps    the creator-and-protocol fee on every swap, in basis points (max 500)
    /// @param snipeBps  the fee at the moment of launch (max 9000); it falls to feeBps over snipeSecs
    /// @param snipeSecs how long the launch fee takes to fall away (max 3600)
    function launch(string calldata name, string calldata symbol, uint16 feeBps, uint16 snipeBps, uint32 snipeSecs, bytes32 salt)
        external
        payable
        returns (address token, PoolId id)
    {
        if (bytes(name).length == 0 || bytes(name).length > 64 || bytes(symbol).length == 0 || bytes(symbol).length > 16) revert BadConfig();
        token = address(new LaunchToken{salt: keccak256(abi.encode(msg.sender, salt))}(name, symbol, SUPPLY));
        PoolKey memory key = keyOf(token);
        id = key.toId();
        poolOf[token] = id;
        launches.push(Launch(token, msg.sender, uint40(block.timestamp)));

        hook.register(key, msg.sender, feeBps, snipeBps, snipeSecs);
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(startTick));
        uint256 bought = abi.decode(poolManager.unlock(abi.encode(uint8(0), token, msg.sender, msg.value)), (uint256));
        emit Launched(token, id, msg.sender, name, symbol, feeBps, snipeBps, snipeSecs, bought);
    }

    /// @notice Sends the swap fees the locked position has earned to the treasury. Anyone may call it.
    function collectFees(address token) external {
        if (PoolId.unwrap(poolOf[token]) == bytes32(0)) revert UnknownToken();
        poolManager.unlock(abi.encode(uint8(1), token, address(0), uint256(0)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint8 action, address token, address creator, uint256 value) = abi.decode(data, (uint8, address, address, uint256));
        PoolKey memory key = keyOf(token);

        if (action == 1) {
            // a zero-size liquidity change pays out the position's accrued fees
            (BalanceDelta fees,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(TICK_LOWER, startTick, 0, bytes32(0)), "");
            uint256 f0 = uint256(uint128(fees.amount0()));
            uint256 f1 = uint256(uint128(fees.amount1()));
            if (f0 > 0) poolManager.take(key.currency0, treasury, f0);
            if (f1 > 0) poolManager.take(key.currency1, treasury, f1);
            emit FeesCollected(key.toId(), f0, f1);
            return "";
        }

        // 1. the whole supply goes in as one position. The pool sits at the top of the range, so it is all token.
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(startTick);
        uint256 liquidity = FullMath.mulDiv(SUPPLY, 1 << 96, sqrtUpper - sqrtLower);
        (BalanceDelta added,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams(TICK_LOWER, startTick, int256(liquidity), bytes32(0)), "");
        uint256 owe = uint256(uint128(-added.amount1()));
        poolManager.sync(key.currency1);
        if (!LaunchToken(token).transfer(address(poolManager), owe)) revert TransferFailed();
        poolManager.settle();
        // rounding leaves a few wei of token outside the position: burn it so the pool holds all that can trade
        uint256 dust = LaunchToken(token).balanceOf(address(this));
        if (dust > 0) LaunchToken(token).transfer(DEAD, dust);

        // 2. the creator's opening buy, if they sent native coin
        uint256 bought;
        if (value > 0) {
            BalanceDelta s = poolManager.swap(key, SwapParams(true, -int256(value), TickMath.MIN_SQRT_PRICE + 1), "");
            uint256 spent = uint256(uint128(-s.amount0()));
            bought = uint256(uint128(s.amount1()));
            poolManager.settle{value: spent}();
            poolManager.take(key.currency1, creator, bought);
            if (value > spent) {
                (bool ok,) = creator.call{value: value - spent}("");
                if (!ok) revert TransferFailed();
            }
        }
        return abi.encode(bought);
    }

    receive() external payable {}
}

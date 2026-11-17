// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";

/// @title HookFiHook
/// @notice One hook shared by every pool the HookFi launchpad opens. After each swap it takes a fee in the
///         currency the swapper did not specify and credits it to the pool's creator and to the protocol.
///         For a short window after launch the fee starts high and falls in a straight line to the pool's
///         normal fee, so a bot that buys in the first seconds pays most of its edge to the creator.
/// @dev    Permissions (the low 14 bits of this contract's address): beforeInitialize, afterSwap and
///         afterSwapReturnDelta = 0x2044. The constructor takes only the owner, so the init code, and therefore
///         the CREATE2 address, is the same on every chain. `initialize` then binds the chain's PoolManager.
contract HookFiHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    struct Config {
        address creator; // receives the creator share of every fee
        uint16 feeBps; // the pool's normal fee, in basis points of the unspecified amount
        uint16 snipeBps; // the fee at the moment of launch
        uint32 snipeSecs; // how long the fee takes to fall from snipeBps to feeBps
        uint40 start; // launch time
    }

    uint16 public constant MAX_FEE_BPS = 500; // 5%
    uint16 public constant MAX_SNIPE_BPS = 9000; // 90%
    uint32 public constant MAX_SNIPE_SECS = 1 hours;
    uint16 public constant PROTOCOL_SHARE_BPS = 2000; // 20% of each fee goes to the protocol

    address public immutable owner;
    IPoolManager public poolManager;
    address public launchpad;
    address public treasury;

    mapping(PoolId => Config) public configOf;
    /// @notice Fees waiting to be claimed: recipient => currency => amount
    mapping(address => mapping(Currency => uint256)) public owed;

    event Registered(PoolId indexed id, address indexed creator, uint16 feeBps, uint16 snipeBps, uint32 snipeSecs);
    event FeeTaken(PoolId indexed id, Currency indexed currency, uint256 amount, uint16 bps);
    event Claimed(address indexed recipient, Currency indexed currency, uint256 amount);

    error NotOwner();
    error NotPoolManager();
    error NotLaunchpad();
    error AlreadyInitialized();
    error BadConfig();
    error NotRegistered();
    error HookNotImplemented();
    error TransferFailed();

    constructor(address owner_) {
        owner = owner_;
    }

    /// @notice Binds this chain's PoolManager, the launchpad allowed to open pools, and the protocol treasury. Once.
    function initialize(IPoolManager poolManager_, address launchpad_, address treasury_) external {
        if (msg.sender != owner) revert NotOwner();
        if (address(poolManager) != address(0)) revert AlreadyInitialized();
        if (address(poolManager_) == address(0) || launchpad_ == address(0) || treasury_ == address(0)) revert BadConfig();
        poolManager = poolManager_;
        launchpad = launchpad_;
        treasury = treasury_;
    }

    function setTreasury(address treasury_) external {
        if (msg.sender != owner) revert NotOwner();
        if (treasury_ == address(0)) revert BadConfig();
        treasury = treasury_;
    }

    /// @notice Called by the launchpad just before it initializes a pool.
    function register(PoolKey calldata key, address creator, uint16 feeBps, uint16 snipeBps, uint32 snipeSecs) external {
        if (msg.sender != launchpad) revert NotLaunchpad();
        if (creator == address(0) || feeBps > MAX_FEE_BPS || snipeBps > MAX_SNIPE_BPS || snipeSecs > MAX_SNIPE_SECS) revert BadConfig();
        if (snipeBps < feeBps) snipeBps = feeBps;
        PoolId id = key.toId();
        if (configOf[id].creator != address(0)) revert BadConfig();
        configOf[id] = Config(creator, feeBps, snipeBps, snipeSecs, uint40(block.timestamp));
        emit Registered(id, creator, feeBps, snipeBps, snipeSecs);
    }

    /// @notice The fee a swap would pay right now, in basis points.
    function currentFeeBps(PoolId id) public view returns (uint16) {
        Config memory c = configOf[id];
        uint256 elapsed = block.timestamp - c.start;
        if (elapsed >= c.snipeSecs) return c.feeBps;
        return uint16(c.snipeBps - (uint256(c.snipeBps - c.feeBps) * elapsed) / c.snipeSecs);
    }

    /// @notice Sends the caller every fee credited to it in `currency`.
    function claim(Currency currency) external returns (uint256 amount) {
        amount = owed[msg.sender][currency];
        if (amount == 0) return 0;
        owed[msg.sender][currency] = 0;
        currency.transfer(msg.sender, amount);
        emit Claimed(msg.sender, currency, amount);
    }

    // ---- hook entry points the PoolManager calls ----

    /// @dev Only the launchpad may open a pool with this hook, and only after registering its config.
    function beforeInitialize(address sender, PoolKey calldata key, uint160) external view returns (bytes4) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        if (sender != launchpad) revert NotLaunchpad();
        if (configOf[key.toId()].creator == address(0)) revert NotRegistered();
        return IHooks.beforeInitialize.selector;
    }

    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        returns (bytes4, int128)
    {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        // the launchpad's own opening buy for the creator is not charged
        if (sender == launchpad) return (IHooks.afterSwap.selector, 0);

        PoolId id = key.toId();
        uint16 bps = currentFeeBps(id);
        if (bps == 0) return (IHooks.afterSwap.selector, 0);

        // the unspecified side: the output of an exact-input swap, the input of an exact-output swap
        bool specifiedIsZero = (params.amountSpecified < 0) == params.zeroForOne;
        (Currency currency, int128 amount) = specifiedIsZero ? (key.currency1, delta.amount1()) : (key.currency0, delta.amount0());
        uint256 abs = amount < 0 ? uint256(uint128(-amount)) : uint256(uint128(amount));
        uint256 fee = (abs * bps) / 10_000;
        if (fee == 0) return (IHooks.afterSwap.selector, 0);

        poolManager.take(currency, address(this), fee);
        uint256 toProtocol = (fee * PROTOCOL_SHARE_BPS) / 10_000;
        owed[treasury][currency] += toProtocol;
        owed[configOf[id].creator][currency] += fee - toProtocol;
        emit FeeTaken(id, currency, fee, bps);
        return (IHooks.afterSwap.selector, int128(uint128(fee)));
    }

    // ---- never called: these permission bits are not set in the hook's address ----

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, BalanceDelta)
    {
        revert HookNotImplemented();
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata) external pure returns (bytes4, BeforeSwapDelta, uint24) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    receive() external payable {}
}

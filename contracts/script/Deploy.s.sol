// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {HookFiHook} from "../src/HookFiHook.sol";
import {HookFiLaunchpad} from "../src/HookFiLaunchpad.sol";

/// Deploys the HookFi hook and launchpad to the chain you point it at, then binds them to that chain's PoolManager.
///
///   forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --account deployer
///
/// Both contracts go through the deterministic CREATE2 deployer and take only the owner as a constructor argument,
/// so the same deployer account gets the SAME hook and launchpad addresses on every chain.
///
/// Environment:
///   TREASURY     where the protocol's share of fees goes (default: the deployer)
///   START_TICK   opening tick, a multiple of 200. tokens per native coin = 1.0001^tick. Default 200400 on
///                ETH-native chains (the whole supply is worth about 2 ETH at launch). Required on BNB and Polygon.
contract Deploy is Script {
    address constant CREATE2 = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 constant FLAGS = 0x2044; // beforeInitialize | afterSwap | afterSwapReturnDelta

    function poolManager() internal view returns (address) {
        uint256 id = block.chainid;
        if (id == 4663) return 0x8366a39CC670B4001A1121B8F6A443A643e40951; // Robinhood Chain
        if (id == 1) return 0x000000000004444c5dc75cB358380D2e3dE08A90; // Ethereum
        if (id == 130) return 0x1F98400000000000000000000000000000000004; // Unichain
        if (id == 8453) return 0x498581fF718922c3f8e6A244956aF099B2652b2b; // Base
        if (id == 42161) return 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32; // Arbitrum One
        if (id == 10) return 0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3; // Optimism
        if (id == 56) return 0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF; // BNB Smart Chain
        if (id == 137) return 0x67366782805870060151383F4BbFF9daB53e5cD6; // Polygon
        revert("no Uniswap v4 PoolManager known for this chain");
    }

    function create2(bytes32 salt, bytes memory init) internal returns (address at) {
        at = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2, salt, keccak256(init))))));
        if (at.code.length > 0) return at; // already deployed on this chain
        (bool ok,) = CREATE2.call(abi.encodePacked(salt, init));
        require(ok && at.code.length > 0, "CREATE2 deployment failed");
    }

    function run() external {
        require(CREATE2.code.length > 0, "the deterministic CREATE2 deployer is not on this chain");
        address pm = poolManager();
        int24 startTick;
        if (block.chainid == 56 || block.chainid == 137) startTick = int24(vm.envInt("START_TICK"));
        else startTick = int24(vm.envOr("START_TICK", int256(200400)));

        vm.startBroadcast();
        (, address owner,) = vm.readCallers();
        address treasury = vm.envOr("TREASURY", owner);

        // mine the salt that puts the hook at an address whose low 14 bits are exactly its permissions
        bytes memory hookInit = abi.encodePacked(type(HookFiHook).creationCode, abi.encode(owner));
        bytes32 h = keccak256(hookInit);
        uint256 salt;
        for (;; salt++) {
            address a = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2, bytes32(salt), h)))));
            if (uint160(a) & 0x3fff == FLAGS) break;
        }
        HookFiHook hook = HookFiHook(payable(create2(bytes32(salt), hookInit)));
        HookFiLaunchpad pad = HookFiLaunchpad(payable(create2(bytes32(0), abi.encodePacked(type(HookFiLaunchpad).creationCode, abi.encode(owner)))));

        if (address(pad.poolManager()) == address(0)) pad.initialize(IPoolManager(pm), hook, treasury, startTick);
        if (address(hook.poolManager()) == address(0)) hook.initialize(IPoolManager(pm), address(pad), treasury);
        vm.stopBroadcast();

        console2.log("chain id   ", block.chainid);
        console2.log("owner      ", owner);
        console2.log("treasury   ", treasury);
        console2.log("hook salt  ", salt);
        console2.log("HOOK       ", address(hook));
        console2.log("LAUNCHPAD  ", address(pad));
        console2.log("start tick ", startTick);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MockFtsoV2Feed} from "../src/MockFtsoV2Feed.sol";
import {FtsoV2Adapter} from "../src/FtsoV2Adapter.sol";
import {PriceSignalAlert} from "../src/PriceSignalAlert.sol";

/// @dev Local/demo: set DEPLOY_MOCK=true to use MockFtsoV2Feed explicitly.
/// @dev Coston2: set FTSO_ADDRESS to live FtsoV2; we wrap it in FtsoV2Adapter then deploy PriceSignalAlert.
contract Deploy is Script {
    error MissingFtsoAddress();

    function run() external {
        address ftsoEnv = vm.envOr("FTSO_ADDRESS", address(0));
        bool explicitMock = vm.envOr("DEPLOY_MOCK", false);
        if (ftsoEnv == address(0) && !explicitMock) revert MissingFtsoAddress();
        vm.startBroadcast();

        address feedForAlert;
        if (ftsoEnv == address(0)) {
            MockFtsoV2Feed mock = new MockFtsoV2Feed();
            bytes21 feed = bytes21(uint168(0x015852502f55534400000000000000000000000000)); // XRP/USD
            mock.setFeed(feed, 100e6, 6, uint64(block.timestamp));
            feedForAlert = address(mock);
            console2.log("MockFtsoV2Feed", feedForAlert);
        } else {
            FtsoV2Adapter adapter = new FtsoV2Adapter(ftsoEnv);
            feedForAlert = address(adapter);
            console2.log("FtsoV2 (raw)", ftsoEnv);
            console2.log("FtsoV2Adapter", feedForAlert);
        }

        PriceSignalAlert alerts = new PriceSignalAlert(feedForAlert);
        console2.log("PriceSignalAlert", address(alerts));
        vm.stopBroadcast();
    }
}

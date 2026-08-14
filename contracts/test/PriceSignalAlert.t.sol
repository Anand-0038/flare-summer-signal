// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockFtsoV2Feed} from "../src/MockFtsoV2Feed.sol";
import {PriceSignalAlert} from "../src/PriceSignalAlert.sol";

contract PriceSignalAlertTest is Test {
    MockFtsoV2Feed internal ftso;
    PriceSignalAlert internal alerts;
    bytes21 internal constant FEED = bytes21(uint168(0x015852502f55534400000000000000000000000000)); // XRP/USD

    function setUp() public {
        ftso = new MockFtsoV2Feed();
        alerts = new PriceSignalAlert(address(ftso));
        ftso.setFeed(FEED, 100e6, 6, uint64(block.timestamp));
    }

    function test_subscribe_and_no_fire_within_threshold() public {
        uint256 id = alerts.subscribe(FEED, 100e6, 500); // 5%
        (bool fired, uint256 price) = alerts.checkSignal(id);
        assertFalse(fired);
        assertEq(price, 100e6);
    }

    function test_signal_fires_on_deviation() public {
        uint256 id = alerts.subscribe(FEED, 100e6, 100); // 1%
        ftso.setFeed(FEED, 102e6, 6, uint64(block.timestamp)); // +2%
        (bool fired, uint256 price) = alerts.checkSignal(id);
        assertTrue(fired);
        assertEq(price, 102e6);
    }

    function test_signal_fires_at_exact_threshold() public {
        uint256 id = alerts.subscribe(FEED, 100e6, 100); // 1%
        ftso.setFeed(FEED, 101e6, 6, uint64(block.timestamp));
        (bool fired, uint256 price) = alerts.checkSignal(id);
        assertTrue(fired);
        assertEq(price, 101e6);
    }

    function test_cancel() public {
        uint256 id = alerts.subscribe(FEED, 100e6, 100);
        alerts.cancel(id);
        vm.expectRevert(PriceSignalAlert.Inactive.selector);
        alerts.checkSignal(id);
    }

    function test_only_subscription_owner_can_cancel() public {
        uint256 id = alerts.subscribe(FEED, 100e6, 100);
        vm.prank(address(0xBEEF));
        vm.expectRevert(PriceSignalAlert.NotOwner.selector);
        alerts.cancel(id);
    }

    function test_rejects_invalid_subscription() public {
        vm.expectRevert(PriceSignalAlert.BadBaseline.selector);
        alerts.subscribe(FEED, 0, 100);

        vm.expectRevert(PriceSignalAlert.BadThreshold.selector);
        alerts.subscribe(FEED, 100e6, 0);

        vm.expectRevert(PriceSignalAlert.BadThreshold.selector);
        alerts.subscribe(FEED, 100e6, 10_001);
    }

    function test_rejects_zero_feed() public {
        vm.expectRevert(PriceSignalAlert.ZeroFtso.selector);
        new PriceSignalAlert(address(0));
    }
}

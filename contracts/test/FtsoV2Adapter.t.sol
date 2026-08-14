// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FtsoV2Adapter} from "../src/FtsoV2Adapter.sol";
import {MockFtsoV2Feed} from "../src/MockFtsoV2Feed.sol";

contract FtsoV2AdapterTest is Test {
    bytes21 internal constant FEED = bytes21(uint168(0x015852502f55534400000000000000000000000000));

    function test_rejects_zero_ftso_address() public {
        vm.expectRevert(FtsoV2Adapter.ZeroAddress.selector);
        new FtsoV2Adapter(address(0));
    }

    function test_forwards_feed_read_and_payment() public {
        MockFtsoV2Feed feed = new MockFtsoV2Feed();
        feed.setFeed(FEED, 103_835_600, 6, 1234);
        FtsoV2Adapter adapter = new FtsoV2Adapter(address(feed));

        (uint256 value, int8 decimals, uint64 timestamp) = adapter.getFeedById{value: 1 wei}(FEED);

        assertEq(value, 103_835_600);
        assertEq(decimals, 6);
        assertEq(timestamp, 1234);
        assertEq(address(feed).balance, 1 wei);
    }
}

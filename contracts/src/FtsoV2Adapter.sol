// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFtsoV2Feed} from "./IFtsoV2Feed.sol";

/**
 * @notice Thin adapter so PriceSignalAlert can call a Coston2 FtsoV2-style surface.
 * @dev Deploy with the live FtsoV2 address (or a custom wrapper). Local tests use MockFtsoV2Feed instead.
 *
 * Expected callee ABI (subset of FTSO V2):
 *   getFeedById(bytes21) returns (uint256, int8, uint64)
 */
contract FtsoV2Adapter is IFtsoV2Feed {
    address public immutable ftsoV2;

    error ZeroAddress();

    constructor(address ftsoV2_) {
        if (ftsoV2_ == address(0)) revert ZeroAddress();
        ftsoV2 = ftsoV2_;
    }

    function getFeedById(bytes21 feedId) external payable returns (uint256 value, int8 decimals, uint64 timestamp) {
        return IFtsoV2Feed(ftsoV2).getFeedById{value: msg.value}(feedId);
    }
}

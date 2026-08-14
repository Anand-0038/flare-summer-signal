// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFtsoV2Feed} from "./IFtsoV2Feed.sol";

/// @dev Local / Foundry mock — not a live FTSO. Demo honesty: label as mock off-chain.
contract MockFtsoV2Feed is IFtsoV2Feed {
    mapping(bytes21 => uint256) public values;
    mapping(bytes21 => int8) public decimalsOf;
    mapping(bytes21 => uint64) public timestamps;

    function setFeed(bytes21 feedId, uint256 value, int8 decimals, uint64 timestamp) external {
        values[feedId] = value;
        decimalsOf[feedId] = decimals;
        timestamps[feedId] = timestamp;
    }

    function getFeedById(bytes21 feedId) external payable returns (uint256 value, int8 decimals, uint64 timestamp) {
        return (values[feedId], decimalsOf[feedId], timestamps[feedId]);
    }
}

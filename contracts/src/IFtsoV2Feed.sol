// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal FTSO V2 feed surface used by PriceSignalAlert (mockable in tests).
interface IFtsoV2Feed {
    /// @return value Feed value scaled by 10**decimals
    /// @return decimals Number of decimals for `value`
    /// @return timestamp Seconds when the feed was last published
    function getFeedById(bytes21 feedId) external payable returns (uint256 value, int8 decimals, uint64 timestamp);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IFtsoV2Feed} from "./IFtsoV2Feed.sol";

/**
 * @title PriceSignalAlert
 * @notice Subscribe to an FTSO feed id with a baseline + max deviation (bps).
 *         Anyone can call checkSignal(); emits SignalFired when |price-baseline|/baseline >= threshold.
 * @dev On Coston2, point `ftso` at a real FtsoV2 wrapper. Locally use MockFtsoV2Feed.
 */
contract PriceSignalAlert {
    IFtsoV2Feed public immutable ftso;

    struct Subscription {
        address owner;
        bytes21 feedId;
        uint256 baseline; // same scale as FTSO value
        uint16 thresholdBps; // e.g. 100 = 1%
        bool active;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Subscription) public subscriptions;

    event Subscribed(uint256 indexed id, address indexed owner, bytes21 feedId, uint256 baseline, uint16 thresholdBps);
    event Cancelled(uint256 indexed id, address indexed owner);
    event SignalFired(
        uint256 indexed id,
        address indexed owner,
        bytes21 feedId,
        uint256 price,
        uint256 baseline,
        uint16 thresholdBps,
        uint64 feedTimestamp
    );

    error NotOwner();
    error Inactive();
    error BadThreshold();
    error BadBaseline();
    error ZeroFtso();

    constructor(address ftso_) {
        if (ftso_ == address(0)) revert ZeroFtso();
        ftso = IFtsoV2Feed(ftso_);
    }

    function subscribe(bytes21 feedId, uint256 baseline, uint16 thresholdBps) external returns (uint256 id) {
        if (thresholdBps == 0 || thresholdBps > 10_000) revert BadThreshold();
        if (baseline == 0) revert BadBaseline();
        id = nextId++;
        subscriptions[id] = Subscription({
            owner: msg.sender, feedId: feedId, baseline: baseline, thresholdBps: thresholdBps, active: true
        });
        emit Subscribed(id, msg.sender, feedId, baseline, thresholdBps);
    }

    function cancel(uint256 id) external {
        Subscription storage s = subscriptions[id];
        if (s.owner != msg.sender) revert NotOwner();
        if (!s.active) revert Inactive();
        s.active = false;
        emit Cancelled(id, msg.sender);
    }

    /// @return fired Whether a signal was emitted
    /// @return price Latest feed value
    function checkSignal(uint256 id) external returns (bool fired, uint256 price) {
        Subscription storage s = subscriptions[id];
        if (!s.active) revert Inactive();

        (uint256 value,, uint64 ts) = ftso.getFeedById(s.feedId);
        price = value;

        uint256 diff = value > s.baseline ? value - s.baseline : s.baseline - value;
        uint256 bps = (diff * 10_000) / s.baseline;
        if (bps >= s.thresholdBps) {
            emit SignalFired(id, s.owner, s.feedId, value, s.baseline, s.thresholdBps, ts);
            return (true, price);
        }
        return (false, price);
    }
}

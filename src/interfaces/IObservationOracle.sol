// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title IObservationOracle
/// @notice The read surface {CoverPool} needs from {CredailyRentOracle}. Matches the
///         auto-generated public-array getter `observations(uint256)` (flattened tuple)
///         plus `observationCount()`.
interface IObservationOracle {
    function observations(uint256 index) external view returns (uint64 t, uint32 cents, bytes32 emailId);
    function observationCount() external view returns (uint256);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CredailyRentOracle} from "./CredailyRentOracle.sol";

/// @dev Immutable STOP-prefixed data, never executable and below EIP-170's limit.
contract ObservationBodyChunk {
    constructor(bytes memory data) {
        bytes memory runtime = bytes.concat(hex"00", data);
        assembly ("memory-safe") {
            return(add(runtime, 32), mload(runtime))
        }
    }
}

/// @notice Splits large signed email bodies across transactions without changing
///         the oracle or its DKIM acceptance rules. Anyone may store/reuse chunks.
///         Only the original oracle verifies authenticity and records a print.
contract ChunkedObservationSubmitter {
    uint256 public constant MAX_CHUNK_BYTES = 24_000;
    uint256 public constant MAX_BODY_BYTES = 192_000;
    uint256 public constant MAX_CHUNKS = 8;

    event ChunkStored(address indexed chunk, bytes32 indexed contentHash, uint256 length);
    error InvalidChunk();
    error InvalidBodyLength();
    error BodyHashMismatch();
    error InvalidOracle();

    function store(bytes calldata data) external returns (address chunk) {
        if (data.length == 0 || data.length > MAX_CHUNK_BYTES) revert InvalidChunk();
        chunk = address(new ObservationBodyChunk(data));
        emit ChunkStored(chunk, sha256(data), data.length);
    }

    /// @param expectedBodyHash SHA-256 of the complete canonical body, also the
    ///        emailId from local preflight. Detects missing/reordered chunks early.
    function submit(
        CredailyRentOracle oracle,
        address[] calldata chunks,
        bytes32 expectedBodyHash,
        bytes calldata signedHeaders,
        bytes calldata sig,
        bytes calldata inlineTail
    ) external {
        if (address(oracle).code.length == 0) revert InvalidOracle();
        if (chunks.length > MAX_CHUNKS || inlineTail.length > 80_000) revert InvalidBodyLength();
        uint256 size = inlineTail.length;
        for (uint256 i; i < chunks.length; ++i) {
            uint256 codeSize = chunks[i].code.length;
            if (codeSize < 2 || codeSize > MAX_CHUNK_BYTES + 1) revert InvalidChunk();
            address chunk = chunks[i];
            uint256 firstByte;
            assembly ("memory-safe") {
                extcodecopy(chunk, 0, 0, 1)
                firstByte := byte(0, mload(0))
            }
            if (firstByte != 0) revert InvalidChunk();
            size += codeSize - 1;
        }
        if (size == 0 || size > MAX_BODY_BYTES) revert InvalidBodyLength();
        bytes memory body = new bytes(size);
        uint256 offset;
        for (uint256 i; i < chunks.length; ++i) {
            address chunk = chunks[i];
            uint256 length = chunk.code.length - 1;
            assembly ("memory-safe") {
                extcodecopy(chunk, add(add(body, 32), offset), 1, length)
            }
            offset += length;
        }
        assembly ("memory-safe") {
            calldatacopy(add(add(body, 32), offset), inlineTail.offset, inlineTail.length)
        }
        if (sha256(body) != expectedBodyHash) revert BodyHashMismatch();
        oracle.submitObservation(signedHeaders, body, sig);
    }
}

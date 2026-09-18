// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Dkim} from "../../src/lib/Dkim.sol";
import {IObservationOracle} from "../../src/interfaces/IObservationOracle.sol";

/// @notice Mintable 18-decimals ERC-20 standing in for WXDAI in tests.
contract TestERC20 is ERC20 {
    constructor() ERC20("Wrapped XDAI (test)", "WXDAI") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Oracle stand-in for CoverPool tests: observations are pushed directly,
///         with the same read surface as {CredailyRentOracle}.
contract MockObservationOracle is IObservationOracle {
    struct Obs {
        uint64 t;
        uint32 cents;
        bytes32 emailId;
    }

    Obs[] internal _obs;

    function push(uint64 t, uint32 cents, bytes32 emailId) external returns (uint256 index) {
        index = _obs.length;
        _obs.push(Obs(t, cents, emailId));
    }

    function observations(uint256 index) external view returns (uint64, uint32, bytes32) {
        Obs storage o = _obs[index];
        return (o.t, o.cents, o.emailId);
    }

    function observationCount() external view returns (uint256) {
        return _obs.length;
    }
}

/// @notice Externalizes the internal {Dkim} functions so tests can call them and
///         `forge test --gas-report` can price the extraction pass.
contract DkimHarness {
    function extractSnapshot(bytes calldata body) external pure returns (uint256 cents, uint256 anchorCount) {
        return Dkim.extractSnapshot(body);
    }

    function rsaVerify(bytes calldata sig, bytes32 digest, bytes calldata modulus) external view returns (bool) {
        return Dkim.rsaVerify(sig, digest, modulus);
    }

    function parseDkimTags(bytes calldata line) external pure returns (Dkim.DkimTags memory) {
        return Dkim.parseDkimTags(line);
    }

    function base64Encode32(bytes32 value) external pure returns (string memory) {
        return Dkim.base64Encode32(value);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reference extractor for differential testing
    // ─────────────────────────────────────────────────────────────────────────

    uint256 private constant ST_WAIT = 0;
    uint256 private constant ST_LABEL = 1;
    uint256 private constant ST_DOLLARSIGN = 2;
    uint256 private constant ST_SP1 = 3;
    uint256 private constant ST_DOLLARS = 4;
    uint256 private constant ST_C1 = 5;
    uint256 private constant ST_C2 = 6;
    uint256 private constant ST_SP2 = 7;
    uint256 private constant ST_SUF = 8;
    uint256 private constant ST_DONE = 9;
    uint256 private constant ST_FAIL = 10;

    struct RefState {
        uint256 aj;
        uint256 lj;
        uint256 stage;
        uint256 budget;
        uint256 dollars;
        uint256 cents;
        uint256 anchors;
    }

    /// @notice TEST-ONLY straightforward byte-wise port of the SPEC grammar (the
    ///         same machine as scripts/make-synthetic-fixtures.py). Used to
    ///         differential-fuzz the assembly-accelerated {Dkim.extractSnapshot}.
    function extractSnapshotReference(bytes calldata body) external pure returns (uint256 cents, uint256 anchorCount) {
        bytes memory anchor = "Manhattan Office Rent";
        bytes memory label = "Avg Effective";
        bytes memory suffix = "/ SF";
        RefState memory st; // stage = ST_WAIT
        uint256 i;
        uint256 len = body.length;
        while (i < len) {
            bytes1 b = body[i];
            if (b == "=") {
                if (i + 2 < len && body[i + 1] == "\r" && body[i + 2] == "\n") {
                    i += 3;
                    continue;
                }
                (bool okHex, uint8 v) = _hex(body, i, len);
                if (okHex) {
                    b = bytes1(v);
                    i += 3;
                } else {
                    i += 1;
                }
            } else {
                i += 1;
            }

            if (b == anchor[st.aj]) {
                if (++st.aj == anchor.length) {
                    ++st.anchors;
                    st.aj = 0;
                    if (st.stage == ST_WAIT) {
                        st.stage = ST_LABEL;
                        st.budget = 600;
                        st.lj = 0;
                        continue;
                    }
                }
            } else {
                st.aj = b == anchor[0] ? 1 : 0;
            }

            if (st.stage == ST_WAIT || st.stage >= ST_DONE) continue;
            if (st.budget == 0) {
                st.stage = ST_FAIL;
                continue;
            }
            --st.budget;

            if (st.stage == ST_LABEL) {
                if (b == label[st.lj]) {
                    if (++st.lj == label.length) (st.stage, st.budget) = (ST_DOLLARSIGN, 600);
                } else {
                    st.lj = b == label[0] ? 1 : 0;
                }
            } else if (st.stage == ST_DOLLARSIGN) {
                if (b == "$") (st.stage, st.budget) = (ST_SP1, 600);
            } else if (st.stage == ST_SP1) {
                if (b == " ") continue;
                if (b >= "0" && b <= "9") (st.dollars, st.stage) = (uint8(b) - 0x30, ST_DOLLARS);
                else st.stage = ST_FAIL;
            } else if (st.stage == ST_DOLLARS) {
                if (b >= "0" && b <= "9") {
                    st.dollars = st.dollars * 10 + (uint8(b) - 0x30);
                    if (st.dollars > 21_474_835) revert Dkim.ValueOverflow();
                } else if (b == ".") {
                    st.stage = ST_C1;
                } else {
                    st.stage = ST_FAIL;
                }
            } else if (st.stage == ST_C1) {
                if (b >= "0" && b <= "9") (st.cents, st.stage) = (st.dollars * 100 + (uint8(b) - 0x30) * 10, ST_C2);
                else st.stage = ST_FAIL;
            } else if (st.stage == ST_C2) {
                if (b >= "0" && b <= "9") {
                    st.cents += uint8(b) - 0x30;
                    st.stage = ST_SP2;
                } else {
                    st.stage = ST_FAIL;
                }
            } else if (st.stage == ST_SP2) {
                if (b == " ") continue;
                if (b == suffix[0]) (st.lj, st.stage) = (1, ST_SUF);
                else st.stage = ST_FAIL;
            } else {
                if (b == suffix[st.lj]) {
                    if (++st.lj == suffix.length) st.stage = ST_DONE;
                } else {
                    st.stage = ST_FAIL;
                }
            }
            if (st.stage == ST_FAIL) st.cents = 0;
        }
        cents = st.stage == ST_DONE ? st.cents : 0;
        anchorCount = st.anchors;
    }

    function _hex(bytes calldata body, uint256 i, uint256 len) private pure returns (bool, uint8) {
        if (i + 2 >= len) return (false, 0);
        (bool ok1, uint8 hi) = _nib(uint8(body[i + 1]));
        if (!ok1) return (false, 0);
        (bool ok2, uint8 lo) = _nib(uint8(body[i + 2]));
        if (!ok2) return (false, 0);
        return (true, (hi << 4) | lo);
    }

    function _nib(uint8 c) private pure returns (bool, uint8) {
        if (c >= 0x30 && c <= 0x39) return (true, c - 0x30);
        if (c >= 0x41 && c <= 0x46) return (true, c - 0x41 + 10);
        if (c >= 0x61 && c <= 0x66) return (true, c - 0x61 + 10);
        return (false, 0);
    }
}

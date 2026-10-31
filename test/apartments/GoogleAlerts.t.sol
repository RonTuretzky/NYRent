// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ApartmentsRentOracle} from "../../src/apartments/ApartmentsRentOracle.sol";
import {GoogleAlertParser} from "../../src/apartments/GoogleAlertParser.sol";
import {YearMonth} from "../../src/apartments/YearMonth.sol";
import {GoogleAlertKey} from "../../src/gen/GoogleAlertKey.sol";

contract YearMonthHarness {
    function bounds(uint32 yyyymm) external pure returns (uint64, uint64) {
        return YearMonth.bounds(yyyymm);
    }
}

/// @notice Oracle policy and parser attack cases over test-key-signed Google Alerts.
contract GoogleAlertsSyntheticTest is Test {
    uint64 internal constant NOV_T = 1793620800;
    bytes32 internal constant EAST_HARLEM = keccak256("east-harlem-new-york-ny");
    bytes32 internal constant MOTT_HAVEN = keccak256("mott-haven-bronx-ny");

    ApartmentsRentOracle internal oracle;

    function setUp() public {
        string memory meta = vm.readFile("fixtures/testkey/meta.json");
        bytes memory modulus = vm.parseJsonBytes(meta, ".modulus_hex");
        oracle = new ApartmentsRentOracle(modulus);
        vm.warp(NOV_T + 10 days);
    }

    function _load(string memory name) internal view returns (bytes memory h, bytes memory b, bytes memory s) {
        string memory d = string.concat("fixtures/google-alert-synthetic/", name, "/");
        h = vm.readFileBinary(string.concat(d, "signed-headers.bin"));
        b = vm.readFileBinary(string.concat(d, "canon-body.bin"));
        s = vm.readFileBinary(string.concat(d, "sig.bin"));
    }

    function _submit(string memory name) internal {
        (bytes memory h, bytes memory b, bytes memory s) = _load(name);
        oracle.submitObservation(h, b, s);
    }

    function _expectRevert(string memory name, bytes memory reason) internal {
        (bytes memory h, bytes memory b, bytes memory s) = _load(name);
        vm.expectRevert(reason);
        oracle.submitObservation(h, b, s);
    }

    function _eh() internal view returns (uint64 t, uint32 cents) {
        (t, cents,) = oracle.earliest(EAST_HARLEM, 202611);
    }

    function test_recordsSingleResult() public {
        _submit("ok-single");
        (uint64 t, uint32 cents) = _eh();
        assertEq(t, NOV_T);
        assertEq(cents, 301000);
    }

    function test_replayReverts() public {
        _submit("ok-single");
        _expectRevert("ok-single", abi.encodeWithSelector(ApartmentsRentOracle.AlreadyRecorded.selector));
    }

    function test_laterEmailCannotReplaceEarliest() public {
        _submit("ok-single");
        _submit("ok-later-different");
        (uint64 t, uint32 cents) = _eh();
        assertEq(t, NOV_T);
        assertEq(cents, 301000);
    }

    function test_earlierEmailReplacesAnyOrder() public {
        _submit("ok-later-different");
        _submit("ok-single");
        _submit("ok-earlier-different");
        (uint64 t, uint32 cents) = _eh();
        assertEq(t, NOV_T - 1 days);
        assertEq(cents, 250000);
    }

    function test_multipleWidgetsEachRecordOwnSeries() public {
        _submit("ok-multi");
        (, uint32 eh) = _eh();
        (, uint32 mh,) = oracle.earliest(MOTT_HAVEN, 202611);
        assertEq(eh, 301000);
        assertEq(mh, 280000);
    }

    function test_trailingDollarsAreIgnored() public {
        _submit("ok-extra-dollars");
        (, uint32 cents) = _eh();
        assertEq(cents, 301000);
    }

    function test_unknownWidgetKeysAreTolerated() public {
        _submit("ok-image-key");
        (, uint32 cents) = _eh();
        assertEq(cents, 301000);
    }

    /// The query carries a complete fake widget valued $9,999 into the text/plain part,
    /// the JSON title fields and the html. Only the genuine widget may count.
    function test_reflectedQueryCannotInjectAWidget() public {
        _submit("ok-query-injection");
        (, uint32 cents) = _eh();
        assertEq(cents, 301000);
    }

    function test_nonQualifyingEmailsRevert() public {
        string[8] memory cases = [
            "bad-wrong-host",
            "bad-wrong-path",
            "bad-joined-widgets",
            "bad-name-mismatch",
            "bad-month-mismatch",
            "bad-bedroom-text",
            "bad-amount-group",
            "bad-leading-zero"
        ];
        for (uint256 i = 0; i < cases.length; ++i) {
            _expectRevert(cases[i], abi.encodeWithSelector(ApartmentsRentOracle.NoQualifyingResult.selector));
        }
    }

    function test_duplicateJsonKeyReverts() public {
        _expectRevert("bad-duplicate-key", abi.encodeWithSelector(GoogleAlertParser.MalformedJson.selector));
    }

    function test_headerPolicy() public {
        _expectRevert("bad-from-display", abi.encodeWithSelector(ApartmentsRentOracle.MissingFrom.selector));
        _expectRevert("bad-selector", abi.encodeWithSelector(ApartmentsRentOracle.BadTagPolicy.selector, "s"));
        _expectRevert("bad-domain", abi.encodeWithSelector(ApartmentsRentOracle.BadTagPolicy.selector, "d"));
        _expectRevert("bad-l-tag", abi.encodeWithSelector(ApartmentsRentOracle.BadTagPolicy.selector, "l"));
        _expectRevert("bad-body-hash", abi.encodeWithSelector(ApartmentsRentOracle.BadBodyHash.selector));
        _expectRevert("bad-boundary", abi.encodeWithSelector(GoogleAlertParser.BadMimeLayout.selector));
    }

    function test_tamperedSignatureOrBodyReverts() public {
        _expectRevert("bad-tampered-sig", abi.encodeWithSelector(ApartmentsRentOracle.BadSignature.selector));
        _expectRevert("bad-tampered-body", abi.encodeWithSelector(ApartmentsRentOracle.BadBodyHash.selector));
    }

    function test_futureSignatureReverts() public {
        vm.warp(NOV_T - 2 days);
        _expectRevert("ok-single", abi.encodeWithSelector(ApartmentsRentOracle.BadTimestamp.selector));
    }

    function test_monthBounds() public {
        YearMonthHarness h = new YearMonthHarness();
        (uint64 start, uint64 end) = h.bounds(202611);
        assertEq(start, 1793491200); // 2026-11-01T00:00:00Z
        assertEq(end, 1796083199); // 2026-11-30T23:59:59Z
        (start, end) = h.bounds(202612);
        assertEq(start, 1796083200);
        assertEq(end, 1798761599);
        (start, end) = h.bounds(202802);
        assertEq(end - start + 1, 29 days);
        vm.expectRevert(abi.encodeWithSelector(YearMonth.BadMonth.selector, uint32(202613)));
        h.bounds(202613);
    }
}

/// @notice Differential test over the private archive of real Google Alerts: the real
///         pinned key must accept each email and the Solidity parser must agree with the
///         independent reading in scripts/make-google-alert-fixtures.py. Skips where the
///         archive is absent, as it is in CI.
contract GoogleAlertsRealTest is Test {
    string internal constant DIR = "fixtures/private/google-alerts/";

    function test_realArchiveMatchesIndependentParser() public {
        string memory path = string.concat(DIR, "manifest.json");
        if (!vm.exists(path)) return vm.skip(true);
        string memory manifest = vm.readFile(path);
        uint256 count = vm.parseJsonUint(manifest, ".count");
        assertGt(count, 100);

        uint256 maxGas;
        uint256 totalResults;
        for (uint256 i = 0; i < count; ++i) {
            (uint256 used, uint256 n) = _check(manifest, i);
            if (used > maxGas) maxGas = used;
            totalResults += n;
        }
        emit log_named_uint("emails", count);
        emit log_named_uint("results", totalResults);
        emit log_named_uint("max submit gas", maxGas);
        assertEq(totalResults, 30);
        assertLt(maxGas, 15_000_000);
    }

    function _check(string memory manifest, uint256 i) internal returns (uint256 used, uint256 n) {
        ApartmentsRentOracle oracle = new ApartmentsRentOracle(GoogleAlertKey.MODULUS);
        string memory e = string.concat(".emails[", vm.toString(i), "]");
        string memory d = string.concat(DIR, vm.toString(i), "/");
        bytes memory h = vm.readFileBinary(string.concat(d, "signed-headers.bin"));
        bytes memory b = vm.readFileBinary(string.concat(d, "canon-body.bin"));
        bytes memory s = vm.readFileBinary(string.concat(d, "sig.bin"));
        vm.warp(vm.parseJsonUint(manifest, string.concat(e, ".t")) + 1);

        n = _resultCount(manifest, e);
        if (n == 0) {
            vm.expectRevert(abi.encodeWithSelector(ApartmentsRentOracle.NoQualifyingResult.selector));
            oracle.submitObservation(h, b, s);
            return (0, 0);
        }
        uint256 before = gasleft();
        oracle.submitObservation(h, b, s);
        used = before - gasleft();
        for (uint256 j = 0; j < n; ++j) {
            _assertResult(oracle, manifest, e, j);
        }
    }

    function _assertResult(ApartmentsRentOracle oracle, string memory manifest, string memory e, uint256 j)
        internal
        view
    {
        string memory r = string.concat(e, ".results[", vm.toString(j), "]");
        bytes32 slugHash = keccak256(bytes(vm.parseJsonString(manifest, string.concat(r, ".slug"))));
        uint32 yyyymm = uint32(vm.parseJsonUint(manifest, string.concat(r, ".yyyymm")));
        (uint64 gotT, uint32 cents,) = oracle.earliest(slugHash, yyyymm);
        assertEq(gotT, vm.parseJsonUint(manifest, string.concat(e, ".t")));
        assertEq(cents, vm.parseJsonUint(manifest, string.concat(r, ".cents")));
    }

    function _resultCount(string memory manifest, string memory e) internal view returns (uint256) {
        return vm.parseJsonUint(manifest, string.concat(e, ".resultCount"));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {GoogleAlertParser} from "../../src/apartments/GoogleAlertParser.sol";
import {YearMonth} from "../../src/apartments/YearMonth.sol";

contract ParserHarness {
    function parse(bytes calldata h, bytes calldata b) external pure returns (GoogleAlertParser.Result[] memory) {
        return GoogleAlertParser.parse(h, b);
    }
}

contract ZZAuditDiffTest is Test {
    string internal constant DIR = "fixtures/private/audit-tmp/";
    ParserHarness internal hz;
    uint256[8] internal stats; // 0 mism,1 reverts,2 mj,3 mm,4 bq,5 bl,6 other,7 acceptedInvalid

    function test_diff() public {
        hz = new ParserHarness();
        uint256 n = vm.parseUint(vm.readFile(string.concat(DIR, "count.txt")));
        for (uint256 i = 0; i < n; ++i) {
            _case(i);
        }
        console2.log("cases", n, "reverts", stats[1]);
        console2.log("mismatches", stats[0], "acceptedButPyInvalid", stats[7]);
        console2.log("MalformedJson", stats[2], "MissingMarkup", stats[3]);
        console2.log("BadQP", stats[4], "BadMime", stats[5]);
        console2.log("other", stats[6]);
    }

    function _case(uint256 i) internal {
        string memory d = string.concat(DIR, vm.toString(i), "/");
        bytes memory h = vm.readFileBinary(string.concat(d, "signed-headers.bin"));
        bytes memory b = vm.readFileBinary(string.concat(d, "canon-body.bin"));
        string memory ej = vm.readFile(string.concat(d, "expected.json"));
        bool okjson = vm.parseJsonBool(ej, ".okjson");
        try hz.parse(h, b) returns (GoogleAlertParser.Result[] memory res) {
            if (!okjson) {
                stats[7]++;
                return;
            }
            if (!_compare(ej, res)) {
                console2.log("MISMATCH case", i);
                stats[0]++;
            }
        } catch (bytes memory reason) {
            _onRevert(i, ej, okjson, reason);
        }
    }

    function _onRevert(uint256 i, string memory ej, bool okjson, bytes memory reason) internal {
        stats[1]++;
        bytes4 sel;
        assembly {
            sel := mload(add(reason, 0x20))
        }
        if (sel == GoogleAlertParser.MalformedJson.selector) stats[2]++;
        else if (sel == GoogleAlertParser.MissingMarkup.selector) stats[3]++;
        else if (sel == GoogleAlertParser.BadQuotedPrintable.selector) stats[4]++;
        else if (sel == GoogleAlertParser.BadMimeLayout.selector) stats[5]++;
        else stats[6]++;
        if (!okjson) return;
        bool dup = vm.parseJsonBool(ej, ".meta.dup");
        uint256 nw = vm.parseJsonUint(ej, ".meta.nwidgets");
        if (!dup && nw <= 16 && _len(ej) > 0) {
            console2.log("REVERT with expected results, case", i);
            console2.logBytes4(sel);
            stats[0]++;
        } else if (!dup && nw <= 16 && stats[6] + stats[2] < 4) {
            console2.log("note: revert on clean-looking case", i);
            console2.logBytes4(sel);
        }
    }

    function _compare(string memory ej, GoogleAlertParser.Result[] memory res) internal pure returns (bool) {
        uint256 k;
        for (uint256 j = 0; j < res.length; ++j) {
            if (YearMonth.isValid(res[j].yyyymm)) k++;
        }
        if (_len(ej) != k) return false;
        uint256 jj;
        for (uint256 j = 0; j < res.length; ++j) {
            if (!YearMonth.isValid(res[j].yyyymm)) continue;
            string memory r = string.concat(".expected[", vm.toString(jj), "]");
            if (keccak256(res[j].slug) != keccak256(bytes(vm.parseJsonString(ej, string.concat(r, ".slug"))))) return false;
            if (res[j].yyyymm != vm.parseJsonUint(ej, string.concat(r, ".yyyymm"))) return false;
            if (res[j].cents != vm.parseJsonUint(ej, string.concat(r, ".cents"))) return false;
            jj++;
        }
        return true;
    }

    function _len(string memory ej) internal pure returns (uint256 c) {
        bytes memory raw = vm.parseJson(ej, ".expected");
        if (raw.length < 0x40) return 0;
        assembly {
            c := mload(add(raw, 0x40))
        }
    }
}

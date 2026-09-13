// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {RentParser} from "../contracts/RentParser.sol";
import {B} from "../contracts/Bytes.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

contract ParserPropertiesTest {
    RentParser parser = new RentParser();

    function dec(uint256 n) private pure returns (bytes memory) {
        if (n == 0) {
            return "0";
        }
        uint256 count;
        uint256 v = n;
        while (v > 0) {
            ++count;
            v /= 10;
        }
        bytes memory out = new bytes(count);
        while (n > 0) {
            out[--count] = bytes1(uint8(48 + n % 10));
            n /= 10;
        }
        return out;
    }

    function testFuzzExactPriceAndMonth(uint64 seed, uint32 periodSeed) public view {
        uint256 dollars = 100 + uint256(seed) % 99000;
        uint256 fractional = uint256(seed) % 100;
        uint256 year = 2020 + uint256(periodSeed) % 80;
        uint256 month = 1 + uint256(periodSeed) % 12;
        bytes memory mm = month < 10 ? bytes.concat("0", dec(month)) : dec(month);
        bytes memory ff = fractional < 10 ? bytes.concat("0", dec(fractional)) : dec(fractional);
        RentParser.Template memory t =
            RentParser.Template("Manhattan rental report for ", ". One-bedroom average: $", " per month.");
        bytes memory line = bytes.concat(
            t.beforeMonth, dec(year), "-", mm, t.beforePrice, dec(dollars), ".", ff, t.afterPrice
        );
        (uint32 observed, uint64 value) = parser.record(line, t);
        require(observed == year * 100 + month, "month changed");
        require(value == dollars * 100 + fractional, "price changed");
    }

    function testFuzzBase64RoundTrip(bytes memory data) public pure {
        if (data.length == 0) {
            data = hex"00";
        }
        if (data.length > 128) {
            data = B.slice(data, 0, 128);
        }
        require(B.eq(B.b64(bytes(Base64.encode(data))), data), "base64 mismatch");
    }
}

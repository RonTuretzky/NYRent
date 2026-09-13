// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ArchiveRentParser} from "../contracts/ArchiveRentParser.sol";
import {RentParser} from "../contracts/RentParser.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract ArchivePropertiesTest {
    ArchiveRentParser private parser = new ArchiveRentParser(new RentParser());

    function testFuzzArchiveDecimalCents(uint64 seed) public view {
        uint256 dollars = 100 + uint256(seed) % 99000;
        uint256 fraction = uint256(seed) % 100;
        string memory cents =
            fraction < 10 ? string.concat("0", Strings.toString(fraction)) : Strings.toString(fraction);
        bytes memory body = bytes(
            string.concat("The median rent in Manhattan was $", Strings.toString(dollars), ".", cents, " last month.")
        );
        (uint32 month, uint64 value,) = parser.parse(1, body, "text/plain", "8bit", 1770984000);
        require(month == 202601 && value == dollars * 100 + fraction, "archive cents mismatch");
    }

    function testFuzzCalendarMonthEnd(uint8 yearSeed, uint8 monthSeed) public view {
        uint32 year = 2021 + uint32(yearSeed) % 78;
        uint32 month = 1 + uint32(monthSeed) % 12;
        uint32 period = year * 100 + month;
        uint256 end = parser.monthEnd(period);
        require(parser.monthAt(end - 1) == period, "end-of-month mismatch");
        uint32 next = month == 12 ? (year + 1) * 100 + 1 : period + 1;
        require(parser.monthAt(end) == next, "next-month mismatch");
        require(parser.previous(next) == period, "previous-month mismatch");
    }
}

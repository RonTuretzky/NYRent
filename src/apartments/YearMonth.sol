// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title YearMonth
/// @notice UTC calendar bounds of a YYYYMM month, e.g. 202611 for November 2026.
library YearMonth {
    error BadMonth(uint32 yyyymm);

    function isValid(uint32 yyyymm) internal pure returns (bool) {
        uint32 year = yyyymm / 100;
        uint32 month = yyyymm % 100;
        return year >= 2000 && year < 2200 && month >= 1 && month <= 12;
    }

    /// @return start First second of the month.
    /// @return end Last second of the month.
    function bounds(uint32 yyyymm) internal pure returns (uint64 start, uint64 end) {
        if (!isValid(yyyymm)) revert BadMonth(yyyymm);
        uint32 year = yyyymm / 100;
        uint32 month = yyyymm % 100;
        start = _firstSecond(year, month);
        end = (month == 12 ? _firstSecond(year + 1, 1) : _firstSecond(year, month + 1)) - 1;
    }

    /// @dev Days-from-civil for the proleptic Gregorian calendar, year >= 2000.
    function _firstSecond(uint256 year, uint256 month) private pure returns (uint64) {
        uint256 y = month <= 2 ? year - 1 : year;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 mp = month > 2 ? month - 3 : month + 9;
        uint256 doy = (153 * mp + 2) / 5;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return uint64((era * 146097 + doe - 719468) * 1 days);
    }
}

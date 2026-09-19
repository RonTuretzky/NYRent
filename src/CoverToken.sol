// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @title CoverToken
/// @notice ERC-1155 protection claim token. `id` = seriesId; `amount` = the max claim
///         in currency wei (1 token unit = 1 wei of currency max claim). Minting and
///         burning are restricted to the immutable {CoverPool}; transfers are disabled
///         for the MVP demo (PRD rule) so positions cannot change hands.
contract CoverToken is ERC1155 {
    using Strings for uint256;

    error OnlyPool();
    error TransfersDisabled();

    /// @notice The only address allowed to mint/burn.
    address public immutable pool;

    /// @notice Decimals of the pool currency, echoed in the metadata JSON so wallets
    ///         render claim balances at the right scale (6 for USDC, 18 for WXDAI).
    uint8 public immutable currencyDecimals;

    constructor(address pool_, uint8 currencyDecimals_) ERC1155("") {
        pool = pool_;
        currencyDecimals = currencyDecimals_;
    }

    modifier onlyPool() {
        if (msg.sender != pool) revert OnlyPool();
        _;
    }

    function mint(address to, uint256 id, uint256 amount) external onlyPool {
        _mint(to, id, amount, "");
    }

    function burn(address from, uint256 id, uint256 amount) external onlyPool {
        _burn(from, id, amount);
    }

    /// @inheritdoc ERC1155
    function safeTransferFrom(address, address, uint256, uint256, bytes memory) public pure override {
        revert TransfersDisabled();
    }

    /// @inheritdoc ERC1155
    function safeBatchTransferFrom(address, address, uint256[] memory, uint256[] memory, bytes memory)
        public
        pure
        override
    {
        revert TransfersDisabled();
    }

    /// @notice data: URI with the series name, no external dependencies. The decimals
    ///         field mirrors the pool currency's decimals pinned at construction.
    function uri(uint256 id) public view override returns (string memory) {
        bytes memory json = abi.encodePacked(
            unicode'{"name":"NY Rent Cover — Series #',
            id.toString(),
            '","description":"Fully collateralized Manhattan office rent protection.',
            ' 1 unit = 1 currency-wei of max claim.","decimals":',
            uint256(currencyDecimals).toString(),
            "}"
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }
}

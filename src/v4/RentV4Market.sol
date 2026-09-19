// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IObservationOracle} from "../interfaces/IObservationOracle.sol";

/// @notice One immutable rent market, its fully funded escrow, and its transferable RENT claim token.
/// @dev Residual entitlement belongs to each collateral depositor, independently of RENT ownership.
///      No yield strategy, privileged mint, administrator, or principal-withdrawal path exists.
contract RentV4Market is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Terms {
        uint256 baseObservationIndex;
        uint32 baseRentCents;
        uint32 strikeLowCents;
        uint32 strikeHighCents;
        uint64 saleEnd;
        uint64 obsStart;
        uint64 obsEnd;
        uint64 redeemEnd;
    }

    uint64 public constant MIN_REDEEM_WINDOW = 7 days;
    address public immutable factory;
    IERC20 public immutable currency;
    IObservationOracle public immutable oracle;
    uint8 public immutable currencyDecimals;
    uint256 public immutable baseObservationIndex;
    uint64 public immutable baseObservationT;
    bytes32 public immutable baseEmailId;
    uint32 public immutable baseRentCents;
    uint32 public immutable strikeLowCents;
    uint32 public immutable strikeHighCents;
    uint64 public immutable saleEnd;
    uint64 public immutable obsStart;
    uint64 public immutable obsEnd;
    uint64 public immutable redeemEnd;
    uint64 public immutable createdAt;

    bool public settled;
    uint64 public payoutRatioWad;
    uint64 public observationT;
    bytes32 public emailId;
    uint256 public totalDeposited;
    uint256 public paidOut;
    uint256 public residualPaid;
    mapping(address insurer => uint256 amount) public residualShares;
    mapping(address insurer => bool claimed) public residualClaimed;

    error InvalidTerms();
    error ZeroAmount();
    error ZeroRecipient();
    error TradingClosed();
    error TransfersLocked();
    error UnsupportedCurrency();
    error AlreadySettled();
    error ObservationOutOfWindow();
    error ObservationInFuture();
    error NotSettled();
    error RedemptionClosed();
    error RedemptionStillOpen();
    error NoResidual();

    event CollateralDeposited(address indexed insurer, address indexed recipient, uint256 amount);
    event MarketSettled(
        uint256 indexed observationIndex, uint64 ratioWad, uint32 cents, uint64 timestamp, bytes32 emailId
    );
    event Redeemed(address indexed holder, address indexed recipient, uint256 amount, uint256 payout);
    event ResidualWithdrawn(address indexed insurer, address indexed recipient, uint256 amount);

    constructor(IERC20 currency_, IObservationOracle oracle_, uint8 decimals_, Terms memory terms_)
        ERC20("RentSafe rent claim", "RENT")
    {
        if (address(currency_).code.length == 0 || address(oracle_).code.length == 0) revert InvalidTerms();
        if (decimals_ != 6 && decimals_ != 18) revert UnsupportedCurrency();
        (uint64 baseT, uint32 baseCents, bytes32 baseId) = oracle_.observations(terms_.baseObservationIndex);
        if (baseT > block.timestamp || baseCents != terms_.baseRentCents) revert InvalidTerms();
        if (
            terms_.baseRentCents == 0 || terms_.strikeLowCents == 0 || terms_.strikeLowCents >= terms_.strikeHighCents
                || block.timestamp >= terms_.saleEnd || terms_.saleEnd > terms_.obsStart
                || terms_.obsStart >= terms_.obsEnd
                || uint256(terms_.redeemEnd) < uint256(terms_.obsEnd) + MIN_REDEEM_WINDOW
        ) {
            revert InvalidTerms();
        }
        factory = msg.sender;
        currency = currency_;
        oracle = oracle_;
        currencyDecimals = decimals_;
        baseObservationIndex = terms_.baseObservationIndex;
        baseObservationT = baseT;
        baseEmailId = baseId;
        baseRentCents = terms_.baseRentCents;
        strikeLowCents = terms_.strikeLowCents;
        strikeHighCents = terms_.strikeHighCents;
        saleEnd = terms_.saleEnd;
        obsStart = terms_.obsStart;
        obsEnd = terms_.obsEnd;
        redeemEnd = terms_.redeemEnd;
        createdAt = uint64(block.timestamp);
    }

    function decimals() public view override returns (uint8) {
        return currencyDecimals;
    }

    /// @notice Trading and issuance close at saleEnd itself. Signed dates do not prove earliest receipt.
    function tradingOpen() public view returns (bool) {
        return !settled && block.timestamp < saleEnd;
    }

    /// @notice Expiry without an observation also unlocks token/LP recovery. It never reopens trading.
    function transfersOpen() public view returns (bool) {
        return block.timestamp < obsStart || settled || block.timestamp > redeemEnd;
    }

    function liquidityRemovalOpen() external view returns (bool) {
        return transfersOpen();
    }

    /// @notice Escrow one currency base unit for each RENT base unit. The payer owns residual shares.
    /// @dev Exact balance delta rejects fee-on-transfer currencies. Rebasing currencies are unsupported.
    function depositAndMint(uint256 amount, address recipient) external nonReentrant {
        if (!tradingOpen()) revert TradingClosed();
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0) || recipient == address(this)) revert ZeroRecipient();
        uint256 beforeBalance = currency.balanceOf(address(this));
        currency.safeTransferFrom(msg.sender, address(this), amount);
        if (currency.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedCurrency();
        totalDeposited += amount;
        residualShares[msg.sender] += amount;
        _mint(recipient, amount);
        emit CollateralDeposited(msg.sender, recipient, amount);
    }

    /// @notice First qualifying verified observation wins. Late settlement cannot reopen redemption.
    function settle(uint256 observationIndex) external nonReentrant {
        if (settled) revert AlreadySettled();
        (uint64 t, uint32 cents, bytes32 id) = oracle.observations(observationIndex);
        if (t < obsStart || t > obsEnd) revert ObservationOutOfWindow();
        if (t > block.timestamp) revert ObservationInFuture();
        uint256 ratio = cents <= strikeLowCents
            ? 0
            : cents >= strikeHighCents
                ? 1e18
                : Math.mulDiv(uint256(cents - strikeLowCents), 1e18, strikeHighCents - strikeLowCents);
        settled = true;
        payoutRatioWad = uint64(ratio);
        observationT = t;
        emailId = id;
        emit MarketSettled(observationIndex, uint64(ratio), cents, t, id);
    }

    /// @notice Holder burns RENT for the fixed ratio, including on redeemEnd. Fractions round down.
    function redeem(uint256 amount, address recipient) external nonReentrant returns (uint256 payout) {
        if (!settled) revert NotSettled();
        if (block.timestamp > redeemEnd) revert RedemptionClosed();
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0) || recipient == address(this)) revert ZeroRecipient();
        _burn(msg.sender, amount);
        payout = Math.mulDiv(amount, payoutRatioWad, 1e18);
        paidOut += payout;
        if (payout != 0) currency.safeTransfer(recipient, payout);
        emit Redeemed(msg.sender, recipient, amount, payout);
    }

    /// @notice Original collateral fractions share the escrow left after redemption expires.
    /// @dev Numerator and denominator are fixed after redeemEnd. Claims cannot alter another insurer's
    ///      entitlement; donations are excluded. Division dust and unsolicited donations remain escrowed.
    function residualOf(address insurer) public view returns (uint256) {
        if (block.timestamp <= redeemEnd || residualClaimed[insurer] || totalDeposited == 0) return 0;
        return Math.mulDiv(totalDeposited - paidOut, residualShares[insurer], totalDeposited);
    }

    function withdrawResidual(address recipient) external nonReentrant returns (uint256 amount) {
        if (block.timestamp <= redeemEnd) revert RedemptionStillOpen();
        if (recipient == address(0) || recipient == address(this)) revert ZeroRecipient();
        if (residualClaimed[msg.sender] || residualShares[msg.sender] == 0) revert NoResidual();
        amount = residualOf(msg.sender);
        residualClaimed[msg.sender] = true;
        residualPaid += amount;
        if (amount != 0) currency.safeTransfer(recipient, amount);
        emit ResidualWithdrawn(msg.sender, recipient, amount);
    }

    function escrowAccounted() external view returns (uint256) {
        return totalDeposited - paidOut - residualPaid;
    }

    function _update(address from, address to, uint256 amount) internal override {
        // Only this contract can mint or burn. No privileged transfer exemption exists.
        if (from != address(0) && to != address(0) && !transfersOpen()) revert TransfersLocked();
        super._update(from, to, amount);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CoverToken} from "../CoverToken.sol";
import {GoogleAlertParser} from "./GoogleAlertParser.sol";
import {YearMonth} from "./YearMonth.sol";

interface IApartmentsRentOracle {
    function earliest(bytes32 slugHash, uint32 yyyymm) external view returns (uint64 t, uint32 cents, bytes32 emailId);
}

/// @title ApartmentsCoverPool
/// @notice Fully permissionless residential rent protection with NO roles. ANYONE opens
///         a policy on any Apartments.com rent-trends page and month by escrowing its
///         capacity 1:1 and naming a premium; buyers pay that premium for soulbound
///         {CoverToken} claim units backed by that policy's escrow alone.
///
///         Lifecycle of a policy on month M:
///         - sales close strictly before `saleEnd`, which is at most the first second
///           of M, so no purchase can share a block second with a month-M signature;
///         - any Google Alerts email signed during M and naming M can be recorded in
///           {ApartmentsRentOracle} until {SUBMISSION_GRACE} after M ends;
///         - then anyone finalizes: the earliest-signed value sets the payout, linear
///           from 0 at `strikeLowCents` to 1 at `strikeHighCents`;
///         - with no qualifying email the policy VOIDS: holders recover the premium
///           and the creator recovers the escrow. A claim never resolves to zero just
///           because data is missing;
///         - anything unclaimed at `redeemEnd` returns to the creator.
/// @dev    Conservation: Σ over policies of (escrow + premiumsAccrued − paidOut −
///         withdrawn) == currency.balanceOf(pool), absent donations. Per policy:
///         paidOut ≤ sold ≤ escrow, whether settled (ratio ≤ 1) or voided (rate ≤ 1).
contract ApartmentsCoverPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Series {
        address creator;
        uint32 strikeLowCents; // payout 0 at or below
        uint32 strikeHighCents; // payout 1 at or above
        uint16 premiumRateBps; // premium per 1e4 of max claim
        uint32 obsMonth; // YYYYMM
        bool settled;
        bool voided; // no qualifying observation: holders redeem their premium
        bool cancelled; // creator refund taken while unsold
        bool residualWithdrawn; // one-shot latch across cancel and residual
        uint64 saleEnd;
        uint64 finalizeAt; // first second finalize is allowed
        uint64 redeemEnd;
        uint64 payoutRatioWad;
        uint64 observationT;
        uint128 escrow; // zeroed by cancel
        uint128 sold;
        uint128 premiumsAccrued;
        uint128 paidOut;
        bytes32 slugHash;
        bytes32 emailId;
    }

    event SeriesCreated(
        uint256 indexed seriesId,
        address indexed creator,
        bytes32 indexed slugHash,
        string slug,
        uint32 obsMonth,
        uint32 strikeLowCents,
        uint32 strikeHighCents,
        uint16 premiumRateBps,
        uint64 saleEnd,
        uint64 finalizeAt,
        uint64 redeemEnd,
        uint128 capacity
    );
    event CapacityAdded(uint256 indexed seriesId, address indexed creator, uint256 amount, uint256 newEscrow);
    event SeriesCancelled(uint256 indexed seriesId, address indexed creator, uint256 refund);
    event SeriesPausedSet(uint256 indexed seriesId, bool paused);
    event ProtectionBought(
        uint256 indexed seriesId, address indexed buyer, address indexed recipient, uint256 maxClaim, uint256 premium
    );
    event SeriesSettled(
        uint256 indexed seriesId, uint64 payoutRatioWad, uint32 cents, uint64 observationT, bytes32 emailId
    );
    event SeriesVoided(uint256 indexed seriesId);
    event Redeemed(uint256 indexed seriesId, address indexed holder, uint256 amount, uint256 payout);
    event ResidualWithdrawn(uint256 indexed seriesId, address indexed creator, uint256 amount);

    error NotCreator();
    error ZeroAddress();
    error InvalidSeries();
    error InvalidParams(string what);
    error SaleClosed();
    error SalesArePaused();
    error SeriesClosed();
    error ZeroAmount();
    error CapacityExceeded();
    error PremiumTooHigh(uint256 premium, uint256 maxPremium);
    error PremiumRoundsToZero();
    error AlreadyFinalized();
    error TooEarly();
    error RedeemWindowClosed();
    error RedeemWindowOpen();
    error AlreadySold();
    error ResidualAlreadyWithdrawn();

    /// @notice Time after month end for anyone to record an earlier-signed email.
    uint64 public constant SUBMISSION_GRACE = 7 days;
    /// @notice Minimum time between `finalizeAt` and `redeemEnd`.
    uint64 public constant MIN_REDEEM_WINDOW = 14 days;

    IERC20 public immutable currency;
    CoverToken public immutable token;
    IApartmentsRentOracle public immutable oracle;

    Series[] internal _series;

    mapping(uint256 seriesId => string) public seriesSlug;
    mapping(uint256 seriesId => bool) public seriesPaused;

    /// @dev `currency_` MUST be a standard ERC-20. WXDAI on Gnosis complies.
    constructor(IERC20 currency_, CoverToken token_, IApartmentsRentOracle oracle_) {
        currency = currency_;
        token = token_;
        oracle = oracle_;
    }

    function seriesCount() external view returns (uint256) {
        return _series.length;
    }

    function series(uint256 seriesId) external view returns (Series memory) {
        if (seriesId >= _series.length) revert InvalidSeries();
        return _series[seriesId];
    }

    /// @notice Premium quote for `maxClaim` of protection.
    function quote(uint256 seriesId, uint256 maxClaim)
        external
        view
        returns (uint256 premium, uint16 rateBps, uint256 capacityLeft, uint256 issuableNow)
    {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        premium = (maxClaim * s.premiumRateBps) / 1e4;
        rateBps = s.premiumRateBps;
        capacityLeft = s.escrow - s.sold;
        bool open = !s.cancelled && !seriesPaused[seriesId] && block.timestamp < s.saleEnd;
        issuableNow = open ? capacityLeft : 0;
    }

    /// @notice Opens a policy, pulling `capacity` from the caller as its escrow.
    ///         Callable by anyone. Parameters are immutable afterwards.
    /// @param slug Apartments.com path segment, e.g. east-harlem-new-york-ny.
    /// @param obsMonth Settlement month as YYYYMM.
    function createSeries(
        string calldata slug,
        uint32 obsMonth,
        uint32 strikeLowCents,
        uint32 strikeHighCents,
        uint16 premiumRateBps,
        uint64 saleEnd,
        uint64 redeemEnd,
        uint128 capacity
    ) external nonReentrant returns (uint256 seriesId) {
        _checkSlug(bytes(slug));
        uint64 finalizeAt =
            _checkTerms(obsMonth, strikeLowCents, strikeHighCents, premiumRateBps, saleEnd, redeemEnd, capacity);

        seriesId = _series.length;
        Series storage n = _series.push();
        n.creator = msg.sender;
        n.strikeLowCents = strikeLowCents;
        n.strikeHighCents = strikeHighCents;
        n.premiumRateBps = premiumRateBps;
        n.obsMonth = obsMonth;
        n.saleEnd = saleEnd;
        n.finalizeAt = finalizeAt;
        n.redeemEnd = redeemEnd;
        n.escrow = capacity;
        n.slugHash = keccak256(bytes(slug));
        seriesSlug[seriesId] = slug;

        currency.safeTransferFrom(msg.sender, address(this), capacity);
        _emitCreated(seriesId, n, slug);
    }

    /// @return finalizeAt First second {finalize} is allowed.
    function _checkTerms(
        uint32 obsMonth,
        uint32 strikeLowCents,
        uint32 strikeHighCents,
        uint16 premiumRateBps,
        uint64 saleEnd,
        uint64 redeemEnd,
        uint128 capacity
    ) private view returns (uint64 finalizeAt) {
        if (!YearMonth.isValid(obsMonth)) revert InvalidParams("obsMonth");
        (uint64 obsStart, uint64 obsEnd) = YearMonth.bounds(obsMonth);
        finalizeAt = obsEnd + 1 + SUBMISSION_GRACE;
        if (strikeLowCents == 0 || strikeLowCents >= strikeHighCents) revert InvalidParams("strikes");
        if (premiumRateBps > 1e4) revert InvalidParams("premiumRate");
        if (block.timestamp >= saleEnd || saleEnd > obsStart) revert InvalidParams("saleEnd");
        if (uint256(redeemEnd) < uint256(finalizeAt) + MIN_REDEEM_WINDOW) revert InvalidParams("claimWindow");
        if (capacity == 0) revert InvalidParams("capacity");
    }

    function _checkSlug(bytes calldata slug) private pure {
        if (slug.length == 0 || slug.length > GoogleAlertParser.MAX_SLUG_BYTES) revert InvalidParams("slug");
        for (uint256 i = 0; i < slug.length; ++i) {
            if (!GoogleAlertParser.isSlugByte(slug[i])) revert InvalidParams("slug");
        }
    }

    function _emitCreated(uint256 seriesId, Series storage n, string calldata slug) private {
        emit SeriesCreated(
            seriesId,
            n.creator,
            n.slugHash,
            slug,
            n.obsMonth,
            n.strikeLowCents,
            n.strikeHighCents,
            n.premiumRateBps,
            n.saleEnd,
            n.finalizeAt,
            n.redeemEnd,
            n.escrow
        );
    }

    /// @notice Creator-only sales switch. Never blocks finalize or redeem.
    function setSeriesPaused(uint256 seriesId, bool paused) external {
        if (seriesId >= _series.length) revert InvalidSeries();
        if (msg.sender != _series[seriesId].creator) revert NotCreator();
        seriesPaused[seriesId] = paused;
        emit SeriesPausedSet(seriesId, paused);
    }

    /// @notice Adds escrow before the sale ends. Creator only.
    function addCapacity(uint256 seriesId, uint128 amount) external nonReentrant {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (msg.sender != s.creator) revert NotCreator();
        if (amount == 0) revert ZeroAmount();
        if (s.cancelled) revert SeriesClosed();
        if (block.timestamp >= s.saleEnd) revert SaleClosed();
        s.escrow += amount;
        currency.safeTransferFrom(msg.sender, address(this), amount);
        emit CapacityAdded(seriesId, msg.sender, amount, s.escrow);
    }

    /// @notice Refunds an unsold policy and closes it. Creator only.
    function cancelSeries(uint256 seriesId) external nonReentrant {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (msg.sender != s.creator) revert NotCreator();
        if (s.cancelled) revert SeriesClosed();
        if (s.settled || s.voided) revert AlreadyFinalized();
        if (s.residualWithdrawn) revert ResidualAlreadyWithdrawn();
        if (s.sold != 0) revert AlreadySold();
        s.cancelled = true;
        s.residualWithdrawn = true;
        uint256 refund = s.escrow;
        s.escrow = 0;
        currency.safeTransfer(msg.sender, refund);
        emit SeriesCancelled(seriesId, msg.sender, refund);
    }

    /// @notice Returns escrow + premiums − paidOut to the creator after `redeemEnd`.
    function withdrawResidual(uint256 seriesId) external nonReentrant {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (msg.sender != s.creator) revert NotCreator();
        if (s.cancelled) revert SeriesClosed();
        if (s.residualWithdrawn) revert ResidualAlreadyWithdrawn();
        if (block.timestamp <= s.redeemEnd) revert RedeemWindowOpen();
        s.residualWithdrawn = true;
        uint256 amount = uint256(s.escrow) + s.premiumsAccrued - s.paidOut;
        currency.safeTransfer(msg.sender, amount);
        emit ResidualWithdrawn(seriesId, msg.sender, amount);
    }

    function buyProtection(uint256 seriesId, uint256 maxClaim, uint256 maxPremium) external {
        buyProtectionFor(seriesId, maxClaim, maxPremium, msg.sender);
    }

    /// @notice Buys `maxClaim` of soulbound protection minted to `recipient`, paying at
    ///         most `maxPremium` from `msg.sender`.
    function buyProtectionFor(uint256 seriesId, uint256 maxClaim, uint256 maxPremium, address recipient)
        public
        nonReentrant
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (maxClaim == 0) revert ZeroAmount();
        if (seriesPaused[seriesId]) revert SalesArePaused();
        if (s.cancelled) revert SeriesClosed();
        if (block.timestamp >= s.saleEnd) revert SaleClosed();
        if (uint256(s.sold) + maxClaim > s.escrow) revert CapacityExceeded();

        uint256 premium = (maxClaim * s.premiumRateBps) / 1e4;
        if (premium == 0 && s.premiumRateBps > 0) revert PremiumRoundsToZero();
        if (premium > maxPremium) revert PremiumTooHigh(premium, maxPremium);

        s.sold += uint128(maxClaim);
        s.premiumsAccrued += uint128(premium);
        if (premium > 0) currency.safeTransferFrom(msg.sender, address(this), premium);

        token.mint(recipient, seriesId, maxClaim);
        emit ProtectionBought(seriesId, msg.sender, recipient, maxClaim, premium);
    }

    /// @notice Fixes the outcome from the oracle once the submission window closed.
    function finalize(uint256 seriesId) public nonReentrant {
        if (seriesId >= _series.length) revert InvalidSeries();
        _finalize(seriesId);
    }

    /// @notice Burns `amount` claim units and pays the settled ratio, or the premium
    ///         rate on a voided policy. Finalizes first if nobody has.
    function redeem(uint256 seriesId, uint256 amount) external nonReentrant {
        if (seriesId >= _series.length) revert InvalidSeries();
        Series storage s = _series[seriesId];
        if (amount == 0) revert ZeroAmount();
        if (s.cancelled) revert SeriesClosed();
        if (block.timestamp > s.redeemEnd) revert RedeemWindowClosed();
        if (!s.settled && !s.voided) _finalize(seriesId);

        token.burn(msg.sender, seriesId, amount);
        uint256 payout = s.voided ? (amount * s.premiumRateBps) / 1e4 : (amount * s.payoutRatioWad) / 1e18;
        s.paidOut += uint128(payout);
        if (payout > 0) currency.safeTransfer(msg.sender, payout);
        emit Redeemed(seriesId, msg.sender, amount, payout);
    }

    function _finalize(uint256 seriesId) private {
        Series storage s = _series[seriesId];
        if (s.cancelled) revert SeriesClosed();
        if (s.settled || s.voided) revert AlreadyFinalized();
        if (block.timestamp < s.finalizeAt) revert TooEarly();

        (uint64 t, uint32 cents, bytes32 emailId) = oracle.earliest(s.slugHash, s.obsMonth);
        if (t == 0) {
            s.voided = true;
            emit SeriesVoided(seriesId);
            return;
        }
        uint256 ratio;
        if (cents >= s.strikeHighCents) {
            ratio = 1e18;
        } else if (cents > s.strikeLowCents) {
            ratio = (uint256(cents - s.strikeLowCents) * 1e18) / (s.strikeHighCents - s.strikeLowCents);
        }
        s.settled = true;
        s.payoutRatioWad = uint64(ratio);
        s.observationT = t;
        s.emailId = emailId;
        emit SeriesSettled(seriesId, uint64(ratio), cents, t, emailId);
    }
}
